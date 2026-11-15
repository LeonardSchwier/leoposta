use std::io::Write;
use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::webview::NewWindowResponse;
use tauri::{Manager, Url, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

/// Holds the spawned bundled-node child so we can kill it on exit.
pub struct Backend {
    pub child: Option<Child>,
    pub port: Option<u16>,
    pub pid: Option<u32>,
}

impl Backend {
    pub fn kill(&mut self) {
        if let Some(c) = self.child.as_mut() {
            let _ = c.kill();
            let _ = c.wait();
        }
        self.child = None;
    }
}

fn resource_resource_dir(app: &tauri::AppHandle) -> Result<std::path::PathBuf, String> {
    app.path().resource_dir().map_err(|e| format!("resource_dir failed: {e}"))
}

fn find_free_port() -> Option<u16> {
    let listener = std::net::TcpListener::bind((IpAddr::V4(Ipv4Addr::LOCALHOST), 0)).ok()?;
    let port = listener.local_addr().ok()?.port();
    drop(listener);
    Some(port)
}

fn spawn_node(
    base: &Path,
    data_dir: &Path,
    port: u16,
    token: &str,
) -> Result<Backend, String> {
    let node = base.join("node");
    let server = base.join("server").join("index.js");
    if !node.exists() {
        return Err(format!("missing bundled node: {:?}", node));
    }
    if !server.exists() {
        return Err(format!("missing bundled server: {:?}", server));
    }

    // Make bundled runtime libraries discoverable to the node child without
    // clobbering system libraries other processes might depend on.
    let libs = base.join("libs");
    let existing = std::env::var("LD_LIBRARY_PATH").unwrap_or_default();
    let merged = if existing.is_empty() {
        libs.to_string_lossy().into_owned()
    } else {
        format!("{}:{}", libs.display(), existing)
    };

    let mut cmd = Command::new(&node);
    // Have the kernel SIGTERM node when this process dies for any reason
    // (crash, SIGKILL, logout) — the RunEvent::Exit handler only covers a
    // normal quit. setup() runs on the main thread, which lives as long as
    // the app, so the "parent thread exited" caveat of PDEATHSIG is moot.
    #[cfg(target_os = "linux")]
    unsafe {
        use std::os::unix::process::CommandExt;
        cmd.pre_exec(|| {
            if libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM) != 0 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let child = cmd
        .arg(&server)
        .env("PORT", port.to_string())
        .env("HOST", "127.0.0.1")
        .env("LD_LIBRARY_PATH", merged)
        // The server's CORS allowlist defaults to ports 3000/3001. The webview
        // loads from this random port, and Vite's `crossorigin` script/style
        // tags send an Origin header, so without this the JS/CSS bundle gets a
        // 403 and the window stays blank white.
        // Accounts, rules, PGP keys etc. The server's fallback is its own
        // directory, which is read-only once installed under /usr/lib.
        .env("LEOPOSTA_DATA_DIR", data_dir)
        // Fresh per launch; the window gets the same value injected (see run()).
        .env("LEOPOSTA_TOKEN", token)
        .env("ALLOWED_ORIGINS", format!("http://127.0.0.1:{port}"))
        .current_dir(base.join("server"))
        // Inherit rather than pipe: nothing reads the pipes, and node writes to
        // pipes synchronously on Linux, so a full 64 KB buffer would hang it.
        .stdout(std::process::Stdio::inherit())
        .stderr(std::process::Stdio::inherit())
        .spawn()
        .map_err(|e| format!("failed to spawn bundled node: {e}"))?;
    let pid = child.id();
    eprintln!("[leoposta] spawned bundled node pid={pid} on 127.0.0.1:{port}");
    Ok(Backend {
        child: Some(child),
        port: Some(port),
        pid: Some(pid),
    })
}

fn wait_for_port(port: u16, timeout: Duration) -> bool {
    let deadline = Instant::now() + timeout;
    while Instant::now() < deadline {
        use std::io::{Read, Write};
        if let Ok(mut stream) =
            TcpStream::connect_timeout(
                &SocketAddr::from((IpAddr::V4(Ipv4Addr::LOCALHOST), port)),
                Duration::from_millis(300),
            )
        {
            let _ = stream.set_read_timeout(Some(Duration::from_millis(300)));
            if stream
                .write_all(
                    b"GET /api/pgp/status HTTP/1.0\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
                )
                .is_ok()
            {
                let mut buf = [0u8; 1];
                let _ = stream.read(&mut buf);
                drop(stream);
                return true;
            }
        }
        std::thread::sleep(Duration::from_millis(150));
    }
    false
}

/// The port is chosen, released and then bound by node, so another local user
/// could bind it first and be shown in the window, which then hands it the
/// per-launch token. Only open the window if every socket that can answer on
/// 127.0.0.1:port belongs to our node child.
#[cfg(target_os = "linux")]
fn listener_owned_by(pid: u32, port: u16) -> bool {
    // /proc/net/tcp{,6}: "sl local_address rem_address st ... uid timeout inode";
    // addresses are hex, st 0A is LISTEN.
    let p = format!(":{port:04X}");
    let serves_loopback = |addr: &str| {
        matches!(
            addr.strip_suffix(p.as_str()),
            Some("0100007F")
                | Some("00000000")
                | Some("00000000000000000000000000000000")
                | Some("0000000000000000FFFF00000100007F")
        )
    };
    let mut inodes = Vec::new();
    for table in ["/proc/net/tcp", "/proc/net/tcp6"] {
        let Ok(text) = std::fs::read_to_string(table) else { continue };
        for line in text.lines().skip(1) {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.len() > 9 && f[3] == "0A" && serves_loopback(f[1]) {
                inodes.push(format!("socket:[{}]", f[9]));
            }
        }
    }
    if inodes.is_empty() {
        return false;
    }
    let Ok(fds) = std::fs::read_dir(format!("/proc/{pid}/fd")) else {
        return false;
    };
    let owned: Vec<String> = fds
        .flatten()
        .filter_map(|e| std::fs::read_link(e.path()).ok())
        .map(|l| l.to_string_lossy().into_owned())
        .collect();
    inodes.iter().all(|i| owned.contains(i))
}

#[cfg(not(target_os = "linux"))]
fn listener_owned_by(_pid: u32, _port: u16) -> bool {
    true
}

/// 32 random bytes from the kernel, hex-encoded: the per-launch API token.
fn random_token() -> Result<String, String> {
    use std::io::Read;
    let mut buf = [0u8; 32];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .map_err(|e| format!("could not read /dev/urandom: {e}"))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

/// The window may only ever show the app itself. Mail is full of links, and
/// this window has no address bar or back button: a linked page shown here
/// could pose as Leoposta and ask for passwords.
fn navigation_allowed(url: &Url, app_origin: &str) -> bool {
    url.origin().ascii_serialization() == app_origin
}

/// Links the user may follow outside the app (in the system browser / mail
/// handler). Everything else (file:, javascript:, custom schemes) is dropped.
fn external_link(url: &Url) -> bool {
    matches!(url.scheme(), "http" | "https" | "mailto")
}

fn open_external(url: &Url) {
    if !external_link(url) {
        eprintln!("[leoposta] blocked navigation to a {} URL", url.scheme());
        return;
    }
    // One argument, no shell: the URL is data, never a command line.
    match Command::new("xdg-open").arg(url.as_str()).spawn() {
        Ok(mut child) => {
            std::thread::spawn(move || {
                let _ = child.wait();
            });
        }
        Err(e) => eprintln!("[leoposta] could not open link: {e}"),
    }
}

fn build_main_window(
    app: &tauri::App,
    url: WebviewUrl,
    init_script: Option<String>,
    app_origin: Option<String>,
) -> tauri::Result<WebviewWindow> {
    let mut b = WebviewWindowBuilder::new(app, "main", url)
        .title("Leoposta")
        .inner_size(1180.0, 780.0)
        .min_inner_size(760.0, 480.0)
        .center()
        .resizable(true);
    if let Some(js) = init_script {
        b = b.initialization_script(&js);
    }
    if let Some(origin) = app_origin {
        b = b
            .on_navigation(move |url| {
                if navigation_allowed(url, &origin) {
                    return true;
                }
                open_external(url);
                false
            })
            .on_new_window(|url, _features| {
                open_external(&url);
                NewWindowResponse::Deny
            });
    }
    b.build()
}

/// Where a panic report goes: `crash.log` in the app data dir that Tauri's
/// `app_data_dir()` resolves to on Linux (`$XDG_DATA_HOME` or
/// `~/.local/share`, plus the bundle identifier). Computed from the
/// environment because the hook is installed before Tauri starts.
fn crash_log_path(xdg_data_home: Option<&str>, home: Option<&str>) -> Option<PathBuf> {
    let base = match xdg_data_home.filter(|d| Path::new(d).is_absolute()) {
        Some(d) => PathBuf::from(d),
        None => PathBuf::from(home.filter(|h| !h.is_empty())?).join(".local/share"),
    };
    Some(base.join("org.schwier.leoposta").join("crash.log"))
}

/// Release builds use `panic = "abort"`, so a panic kills the process with
/// SIGABRT and its message goes only to stderr, which is lost when the app
/// was started from the desktop. This hook also appends the message, the
/// source location and a backtrace to `path`, then runs the default hook.
fn install_panic_log(path: PathBuf) {
    let default_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |info| {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs())
            .unwrap_or(0);
        let thread = std::thread::current();
        let report = format!(
            "--- panic at unix time {secs} (leoposta {}), thread '{}'\n{info}\n{}\n",
            env!("CARGO_PKG_VERSION"),
            thread.name().unwrap_or("<unnamed>"),
            std::backtrace::Backtrace::force_capture()
        );
        let written = path
            .parent()
            .map_or(Ok(()), std::fs::create_dir_all)
            .and_then(|_| std::fs::OpenOptions::new().create(true).append(true).open(&path))
            .and_then(|mut f| f.write_all(report.as_bytes()));
        match written {
            Ok(()) => eprintln!("[leoposta] panic report appended to {:?}", path),
            Err(e) => eprintln!("[leoposta] could not write panic report to {:?}: {e}", path),
        }
        default_hook(info);
    }));
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    if let Some(path) = crash_log_path(
        std::env::var("XDG_DATA_HOME").ok().as_deref(),
        std::env::var("HOME").ok().as_deref(),
    ) {
        install_panic_log(path);
    }
    let app = tauri::Builder::default()
        .manage(Mutex::new(Option::<Backend>::None))
        .setup(move |app| {
            let handle = app.handle().clone();

            if cfg!(dev) {
                eprintln!("[leoposta] dev mode: using devUrl, not spawning bundled backend");
                build_main_window(app, WebviewUrl::default(), None, None)?;
                return Ok(());
            }

            // Production: spawn bundled node on a free loopback port.
            let rd = resource_resource_dir(&handle)?;
            let base = rd.join("backend");
            eprintln!("[leoposta] resource dir = {:?}", rd);
            let data_dir = handle
                .path()
                .app_data_dir()
                .map_err(|e| format!("app_data_dir failed: {e}"))?;
            std::fs::create_dir_all(&data_dir)
                .map_err(|e| format!("could not create {:?}: {e}", data_dir))?;
            eprintln!("[leoposta] data dir = {:?}", data_dir);
            let port = find_free_port().ok_or("could not pick a free loopback port")?;
            let token = random_token()?;
            let mut backend = spawn_node(&base, &data_dir, port, &token)
                .map_err(|e| format!("backend spawn failed: {e}"))?;

            if !wait_for_port(port, Duration::from_secs(30)) {
                backend.kill();
                return Err("bundled backend on port did not come up within 30s".into());
            }
            if !backend.pid.is_some_and(|pid| listener_owned_by(pid, port)) {
                backend.kill();
                return Err(format!("127.0.0.1:{port} is not served by the bundled backend; not opening the window").into());
            }
            eprintln!("[leoposta] backend up on 127.0.0.1:{port}");

            // Keep it in state so we can kill on exit.
            {
                let slot = handle.state::<Mutex<Option<Backend>>>();
                let mut g = slot.lock().unwrap();
                *g = Some(backend);
            }

            // Open the window straight on the backend. The token is injected
            // before any page script runs, and only for our own origin, so a
            // page this webview ever navigates elsewhere never sees it.
            let origin = format!("http://127.0.0.1:{port}");
            let init = format!(
                "if (location.origin === {origin:?}) {{ window.__LEOPOSTA_DESKTOP_TOKEN__ = {token:?}; }}"
            );
            let url = WebviewUrl::External(origin.parse().expect("loopback url"));
            build_main_window(app, url, Some(init), Some(origin.clone()))?;
            eprintln!("[leoposta] window opened on {origin}");

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build Leoposta");

    app.run(|handle, event| {
        // Without this the node child outlives the window: one orphaned
        // backend (with live IMAP connections) per launch.
        if let tauri::RunEvent::Exit = event {
            if let Some(b) = handle.state::<Mutex<Option<Backend>>>().lock().unwrap().as_mut() {
                b.kill();
                eprintln!("[leoposta] backend stopped");
            }
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_the_app_origin_may_be_shown_in_the_window() {
        let app = "http://127.0.0.1:43123";
        let ok = |u: &str| navigation_allowed(&Url::parse(u).unwrap(), app);
        assert!(ok("http://127.0.0.1:43123/"));
        assert!(ok("http://127.0.0.1:43123/inbox?x=1#y"));
        assert!(!ok("http://127.0.0.1:43124/"));
        assert!(!ok("http://localhost:43123/"));
        assert!(!ok("https://phish.example/"));
        assert!(!ok("file:///etc/passwd"));
    }

    #[test]
    fn only_web_and_mail_links_leave_the_app() {
        let ext = |u: &str| external_link(&Url::parse(u).unwrap());
        assert!(ext("https://example.test/a"));
        assert!(ext("http://example.test/a"));
        assert!(ext("mailto:a@example.test"));
        assert!(!ext("file:///home/user/.ssh/id_rsa"));
        assert!(!ext("javascript:alert(1)"));
        assert!(!ext("smb://host/share"));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn the_window_opens_only_on_a_listener_owned_by_the_backend() {
        let l = std::net::TcpListener::bind((IpAddr::V4(Ipv4Addr::LOCALHOST), 0)).unwrap();
        let port = l.local_addr().unwrap().port();
        assert!(listener_owned_by(std::process::id(), port));
        // Another process (pid 1 stands in for another user's server) does not own it.
        assert!(!listener_owned_by(1, port));
        drop(l);
        // Nothing listening: not ours either.
        assert!(!listener_owned_by(std::process::id(), port));
    }

    #[test]
    fn the_crash_log_sits_in_the_app_data_dir() {
        assert_eq!(
            crash_log_path(Some("/x/data"), Some("/home/u")),
            Some(PathBuf::from("/x/data/org.schwier.leoposta/crash.log"))
        );
        // The XDG spec says a relative or empty XDG_DATA_HOME is ignored.
        for xdg in [None, Some(""), Some("rel/data")] {
            assert_eq!(
                crash_log_path(xdg, Some("/home/u")),
                Some(PathBuf::from("/home/u/.local/share/org.schwier.leoposta/crash.log"))
            );
        }
        assert_eq!(crash_log_path(None, None), None);
        assert_eq!(crash_log_path(None, Some("")), None);
    }

    #[test]
    fn a_panic_is_appended_to_the_crash_log() {
        let dir = std::env::temp_dir().join(format!("leoposta-panic-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let log = dir.join("nested/crash.log");
        install_panic_log(log.clone());
        for n in 1..=2 {
            let r = std::thread::Builder::new()
                .name(format!("doomed-{n}"))
                .spawn(move || panic!("test panic number {n}"))
                .unwrap()
                .join();
            assert!(r.is_err());
        }
        let _ = std::panic::take_hook(); // back to the default hook
        let text = std::fs::read_to_string(&log).expect("crash.log written");
        let _ = std::fs::remove_dir_all(&dir);
        for n in 1..=2 {
            assert!(text.contains(&format!("thread 'doomed-{n}'")), "{text}");
            assert!(text.contains(&format!("test panic number {n}")), "{text}");
        }
        assert!(text.contains("src/lib.rs"), "location missing: {text}");
        assert_eq!(text.matches("--- panic at unix time").count(), 2, "{text}");
    }
}
