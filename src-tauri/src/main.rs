#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Disable WebGL and GPU compositing to fix EGL_BAD_PARAMETER on Wayland
    // (Fedora 43, GNOME 47, Mesa 25.3). Without these, WebKitGTK aborts
    // before the app can show anything -- a blank white window, with
    // WebKitWebProcess/WebKitNetworkProcess core-dumping on SIGBUS shortly
    // after launch (coredumpctl). Same root cause and same fix as
    // LeonardSchwier/leotheca's src-tauri/src/main.rs.
    std::env::set_var("WEBKIT_DISABLE_GPU", "1");
    leoposta_lib::run()
}
