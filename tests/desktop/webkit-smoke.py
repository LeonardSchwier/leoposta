#!/usr/bin/env python3
"""WebKitGTK smoke test for the Leoposta desktop app.

Playwright's chromium does not run the engine the Tauri shell ships on Linux
(WebKitGTK), so engine-specific failures slip through it. One such failure
left the desktop window blank white: the backend's CORS check answered 403 to
the `crossorigin` module script and stylesheet on the random port. This
script loads the app in a real WebKitGTK WebView, the way the shell does, and
fails on any of these:

  * an `error` event (uncaught exceptions, and resource-load errors on
    <script>/<link>/<img>, caught in the capture phase)
  * an `unhandledrejection`
  * console.error()
  * an /api/ fetch that fails or answers >= 400
  * a stylesheet <link> that never got a sheet (CSS not applied)
  * a web process crash, a failed main-frame load
  * the app not becoming ready (`--wait` selector) within `--timeout`

Optional steps after the app is ready: click the message row that contains
`--click-text`, then wait for `--expect-text` in the reading pane.

Run with `python3 -I` (system python with PyGObject; needs a display, e.g.
under `xvfb-run -a`). Exit status 0 = pass, 1 = fail, 2 = usage/setup error.
"""
import argparse
import json
import sys
import time

import gi

gi.require_version("Gtk", "3.0")
gi.require_version("WebKit2", "4.1")
from gi.repository import GLib, Gtk, WebKit2  # noqa: E402

# Runs before any page script in every document of the main frame. It keeps
# its findings in window.__smoke (polled from Python) and also posts each one
# to the "smoke" message handler as it happens, so a later crash cannot lose
# them.
CAPTURE_JS = r"""
(() => {
  if (window.__smoke) return;
  const s = window.__smoke = { errors: [] };
  const post = (kind, detail) => {
    const rec = { kind, detail: String(detail).slice(0, 2000), t: Math.round(performance.now()) };
    s.errors.push(rec);
    try { window.webkit.messageHandlers.smoke.postMessage(JSON.stringify(rec)); } catch (_) {}
  };
  addEventListener('error', (e) => {
    const t = e.target;
    if (t && t !== window && t.outerHTML) {
      // Resource-load error (<script src>, <link href>, <img>): no message,
      // only the element that failed.
      post('resource', t.outerHTML.slice(0, 500));
    } else {
      post('error', (e.message || 'error') + (e.filename ? ` at ${e.filename}:${e.lineno}:${e.colno}` : '') +
        (e.error && e.error.stack ? `\n${e.error.stack}` : ''));
    }
  }, true);
  addEventListener('unhandledrejection', (e) => {
    const r = e.reason;
    post('unhandledrejection', r && r.stack ? r.stack : (r && r.message) || String(r));
  });
  const origError = console.error.bind(console);
  console.error = (...args) => {
    post('console.error', args.map((a) => (a && a.stack) ? a.stack : (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' '));
    origError(...args);
  };
  const origFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || String(input);
    const method = (init && init.method) || (input && input.method) || 'GET';
    try {
      const res = await origFetch(input, init);
      if (url.includes('/api/') && res.status >= 400) {
        let body = '';
        try { body = (await res.clone().text()).slice(0, 300); } catch (_) {}
        post('api', `${method} ${url} -> ${res.status} ${body}`);
      }
      return res;
    } catch (err) {
      if (url.includes('/api/') && !(err && err.name === 'AbortError')) post('api', `${method} ${url} failed: ${err}`);
      throw err;
    }
  };
})();
"""

# Polled from Python: one JSON snapshot of the page.
PROBE_JS = r"""
(() => {
  const q = (sel) => { try { return document.querySelector(sel); } catch (_) { return null; } };
  const links = [...document.querySelectorAll('link[rel="stylesheet"]')];
  const app = q('#app');
  return JSON.stringify({
    href: location.href,
    readyState: document.readyState,
    hasCapture: !!window.__smoke,
    errors: window.__smoke ? window.__smoke.errors : [],
    ready: !!q(%(wait)s),
    unstyled: links.filter((l) => !l.sheet).map((l) => l.outerHTML),
    appChildren: app ? app.childElementCount : -1,
    title: document.title,
  });
})()
"""

FIND_ROW_JS = r"""
(() => {
  const want = %(text)s;
  const rows = [...document.querySelectorAll('.message-row')];
  const row = rows.find((r) => r.textContent.includes(want));
  if (!row) return JSON.stringify({ found: false, rows: rows.map((r) => r.textContent.trim().slice(0, 80)) });
  row.click();
  return JSON.stringify({ found: true });
})()
"""

FIND_TEXT_JS = r"""
(() => {
  const want = %(text)s;
  const view = document.querySelector('.message-view');
  return JSON.stringify({ found: !!view && view.textContent.includes(want), view: view ? view.textContent.trim().slice(0, 200) : null });
})()
"""

DOM_JS = r"""
(() => {
  const html = document.documentElement ? document.documentElement.outerHTML : '';
  return JSON.stringify({ head: (document.head || {}).outerHTML || '', body: document.body ? document.body.outerHTML.slice(0, 3000) : '(no body)', length: html.length });
})()
"""


def token_script(origin, token):
    # Same shape as the init script src-tauri/src/lib.rs hands the webview.
    return "if (location.origin === %s) { window.__LEOPOSTA_DESKTOP_TOKEN__ = %s; }" % (
        json.dumps(origin), json.dumps(token))


class Smoke:
    def __init__(self, args):
        self.args = args
        self.errors = []          # from the message handler (push)
        self.failures = []        # smoke-level failures (not page errors)
        self.status = None
        self.phase = "load"
        self.phase_deadline = None
        self.started = time.monotonic()
        self.last_probe = None
        self.ready_at = None
        self.steps = []
        if args.click_text:
            self.steps.append(("click", args.click_text))
        if args.expect_text:
            self.steps.append(("expect", args.expect_text))

        ctx = WebKit2.WebContext.new_ephemeral()
        ctx.set_cache_model(WebKit2.CacheModel.DOCUMENT_VIEWER)
        ucm = WebKit2.UserContentManager()
        ucm.register_script_message_handler("smoke")
        ucm.connect("script-message-received::smoke", self.on_message)
        if args.token:
            origin = "/".join(args.url.split("/")[:3])
            ucm.add_script(WebKit2.UserScript.new(
                token_script(origin, args.token),
                WebKit2.UserContentInjectedFrames.TOP_FRAME,
                WebKit2.UserScriptInjectionTime.START, None, None))
        ucm.add_script(WebKit2.UserScript.new(
            CAPTURE_JS,
            WebKit2.UserContentInjectedFrames.TOP_FRAME,
            WebKit2.UserScriptInjectionTime.START, None, None))
        self.view = WebKit2.WebView(web_context=ctx, user_content_manager=ucm)
        settings = self.view.get_settings()
        settings.set_enable_write_console_messages_to_stdout(True)
        settings.set_enable_developer_extras(False)
        self.view.connect("load-failed", self.on_load_failed)
        self.view.connect("web-process-terminated", self.on_crash)
        self.win = Gtk.Window(title="leoposta webkit smoke")
        self.win.set_default_size(args.width, args.height)
        self.win.add(self.view)
        self.win.connect("destroy", lambda *_: self.finish(1, "window destroyed"))
        self.win.show_all()

    # -- signal handlers --------------------------------------------------
    def on_message(self, _ucm, result):
        try:
            value = result.get_js_value().to_string()
            self.errors.append(json.loads(value))
        except Exception as exc:  # noqa: BLE001
            self.errors.append({"kind": "smoke", "detail": "bad message: %s" % exc})

    def on_load_failed(self, _view, _event, uri, error):
        # A cancelled load (navigation superseded) is not a failure.
        if error.matches(WebKit2.NetworkError.quark(), WebKit2.NetworkError.CANCELLED):
            return False
        self.failures.append("main-frame load failed: %s (%s)" % (uri, error.message))
        self.finish(1, "load failed")
        return False

    def on_crash(self, _view, reason):
        self.failures.append("web process terminated: %s" % reason.value_nick)
        self.finish(1, "web process crashed")

    # -- driving ------------------------------------------------------------
    def eval(self, js, cb):
        def done(view, res):
            try:
                val = view.evaluate_javascript_finish(res)
                cb(json.loads(val.to_string()))
            except GLib.Error as exc:
                cb({"__error": exc.message})
        self.view.evaluate_javascript(js, -1, None, None, None, done)

    def tick(self):
        if self.status is not None:
            return False
        if time.monotonic() - self.started > self.args.timeout:
            self.failures.append("timed out after %ss in phase %r" % (self.args.timeout, self.phase))
            self.finish(1, "timeout")
            return False
        self.eval(PROBE_JS % {"wait": json.dumps(self.args.wait)}, self.on_probe)
        return True

    def on_probe(self, p):
        if self.status is not None:
            return
        if "__error" in p:
            return  # page between documents; try again next tick
        self.last_probe = p
        page_errors = p.get("errors") or []
        if page_errors and self.phase != "settle":
            # Give late errors a moment to arrive, then fail with all of them.
            self.phase = "settle"
            self.phase_deadline = time.monotonic() + 0.75
            return
        if self.phase == "settle":
            if time.monotonic() >= self.phase_deadline:
                self.finish(1 if page_errors else 0, "errors on page" if page_errors else "ok")
            return
        if self.phase == "load":
            if p.get("ready"):
                if p.get("unstyled"):
                    self.failures.append("stylesheet(s) not applied: %s" % p["unstyled"])
                    self.finish(1, "unstyled")
                    return
                self.ready_at = time.monotonic() - self.started
                print("[smoke] ready (%r) after %.2fs on %s" % (self.args.wait, self.ready_at, p.get("href")), flush=True)
                self.next_step()
            return
        if self.phase == "click":
            self.eval(FIND_ROW_JS % {"text": json.dumps(self.current[1])}, self.on_click)
            return
        if self.phase == "expect":
            self.eval(FIND_TEXT_JS % {"text": json.dumps(self.current[1])}, self.on_expect)
            return
        if self.phase == "done":
            # Quiet period: catch errors that show up just after the last step.
            if time.monotonic() >= self.phase_deadline:
                self.snapshot_then_finish()

    def next_step(self):
        if self.steps:
            self.current = self.steps.pop(0)
            self.phase = self.current[0]
            print("[smoke] step: %s %r" % self.current, flush=True)
        else:
            self.phase = "done"
            self.phase_deadline = time.monotonic() + self.args.settle

    def on_click(self, r):
        if self.phase == "click" and r.get("found"):
            self.next_step()
        else:
            self.last_rows = r.get("rows")

    def on_expect(self, r):
        if self.phase == "expect" and r.get("found"):
            self.next_step()
        else:
            self.last_view = r.get("view")

    def snapshot_then_finish(self):
        if self.phase == "snapshot":
            return
        self.phase = "snapshot"
        if not self.args.screenshot:
            self.finish(0, "ok")
            return

        def done(view, res):
            try:
                surface = view.get_snapshot_finish(res)
                surface.write_to_png(self.args.screenshot)
                print("[smoke] screenshot: %s" % self.args.screenshot, flush=True)
            except Exception as exc:  # noqa: BLE001
                print("[smoke] screenshot failed: %s" % exc, file=sys.stderr, flush=True)
            self.finish(0, "ok")
        self.view.get_snapshot(WebKit2.SnapshotRegion.VISIBLE, WebKit2.SnapshotOptions.NONE, None, done)

    def finish(self, status, why):
        if self.status is not None:
            return
        self.status = status
        self.why = why
        if status != 0:
            # Grab the DOM for the report before quitting.
            self.eval(DOM_JS, self.on_dom)
            GLib.timeout_add(1500, Gtk.main_quit)
        else:
            Gtk.main_quit()

    def on_dom(self, d):
        self.dom = d
        Gtk.main_quit()

    def report(self):
        page_errors = (self.last_probe or {}).get("errors") or []
        seen = {json.dumps(e, sort_keys=True) for e in page_errors}
        for e in self.errors:  # pushed ones a crash may have kept from the probe
            if json.dumps(e, sort_keys=True) not in seen:
                page_errors.append(e)
        if self.status == 0 and not page_errors and not self.failures:
            print("[smoke] PASS %s (ready in %.2fs)" % (self.args.url, self.ready_at or 0), flush=True)
            return 0
        print("[smoke] FAIL %s: %s" % (self.args.url, getattr(self, "why", "?")), file=sys.stderr)
        for f in self.failures:
            print("  failure: %s" % f, file=sys.stderr)
        for e in page_errors:
            print("  %s: %s" % (e.get("kind"), e.get("detail")), file=sys.stderr)
        if getattr(self, "last_rows", None) is not None:
            print("  message rows seen: %s" % self.last_rows, file=sys.stderr)
        if getattr(self, "last_view", None) is not None:
            print("  reading pane: %s" % self.last_view, file=sys.stderr)
        p = self.last_probe or {}
        print("  last probe: href=%s readyState=%s capture=%s #app children=%s title=%r" % (
            p.get("href"), p.get("readyState"), p.get("hasCapture"), p.get("appChildren"), p.get("title")), file=sys.stderr)
        dom = getattr(self, "dom", None)
        if dom and "__error" not in dom:
            print("  <head>: %s" % dom.get("head", "")[:2000], file=sys.stderr)
            print("  <body>: %s" % dom.get("body", ""), file=sys.stderr)
        return 1


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("url")
    ap.add_argument("--token", help="inject as window.__LEOPOSTA_DESKTOP_TOKEN__ (like the Tauri shell)")
    ap.add_argument("--wait", default=".sidebar", help="CSS selector that means 'app is up' (default .sidebar)")
    ap.add_argument("--timeout", type=float, default=30.0)
    ap.add_argument("--settle", type=float, default=1.5, help="quiet seconds after the last step")
    ap.add_argument("--click-text", help="click the .message-row containing this text")
    ap.add_argument("--expect-text", help="then wait for this text in .message-view")
    ap.add_argument("--screenshot", help="write a PNG of the window on success")
    ap.add_argument("--width", type=int, default=1180)
    ap.add_argument("--height", type=int, default=780)
    args = ap.parse_args()

    if not Gtk.init_check(sys.argv)[0]:
        print("[smoke] cannot open a display (run under xvfb-run -a?)", file=sys.stderr)
        return 2
    smoke = Smoke(args)
    smoke.view.load_uri(args.url)
    GLib.timeout_add(200, smoke.tick)
    Gtk.main()
    return smoke.report()


if __name__ == "__main__":
    sys.exit(main())
