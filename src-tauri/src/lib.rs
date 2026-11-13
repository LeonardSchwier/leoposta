use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::Path;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

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

/// 32 random bytes from the kernel, hex-encoded: the per-launch API token.
fn random_token() -> Result<String, String> {
    use std::io::Read;
    let mut buf = [0u8; 32];
    std::fs::File::open("/dev/urandom")
        .and_then(|mut f| f.read_exact(&mut buf))
        .map_err(|e| format!("could not read /dev/urandom: {e}"))?;
    Ok(buf.iter().map(|b| format!("{b:02x}")).collect())
}

fn build_main_window(
    app: &tauri::App,
    url: WebviewUrl,
    init_script: Option<String>,
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
    b.build()
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .manage(Mutex::new(Option::<Backend>::None))
        .setup(move |app| {
            let handle = app.handle().clone();

            if cfg!(dev) {
                eprintln!("[leoposta] dev mode: using devUrl, not spawning bundled backend");
                build_main_window(app, WebviewUrl::default(), None)?;
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
            build_main_window(app, url, Some(init))?;
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
