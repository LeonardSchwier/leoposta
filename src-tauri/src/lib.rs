use std::net::{IpAddr, Ipv4Addr, SocketAddr, TcpStream};
use std::path::Path;
use std::process::{Child, Command};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use tauri::{Manager, WebviewWindow};

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
    port: u16,
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

    let child = Command::new(&node)
        .arg(&server)
        .env("PORT", port.to_string())
        .env("HOST", "127.0.0.1")
        .env("LD_LIBRARY_PATH", merged)
        .current_dir(base.join("server"))
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(Mutex::new(Option::<Backend>::None))
        .setup(move |app| {
            let handle = app.handle().clone();
            let window: WebviewWindow = app
                .get_webview_window("main")
                .expect("main window exists");

            if cfg!(dev) {
                eprintln!("[leoposta] dev mode: using devUrl, not spawning bundled backend");
                return Ok(());
            }

            // Production: spawn bundled node on a free loopback port.
            let rd = resource_resource_dir(&handle)?;
            let base = rd.join("backend");
            eprintln!("[leoposta] resource dir = {:?}", rd);
            let port = find_free_port().ok_or("could not pick a free loopback port")?;
            let mut backend = spawn_node(&base, port)
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

            // Navigate the window to the running backend.
            let url = format!("http://127.0.0.1:{port}");
            let win_clone = window.clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(120));
                match win_clone.navigate(url.parse().expect("url")) {
                    Ok(_) => eprintln!("[leoposta] window navigated to {url}"),
                    Err(e) => eprintln!("[leoposta] navigate to {url} failed: {e}"),
                }
            });

            Ok(())
        })
        .run(tauri::generate_context!())
        .expect("failed to run Leoposta")
}
