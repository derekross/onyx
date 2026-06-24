// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Workaround for WebKitGTK rendering a blank/white screen on some Linux
    // Wayland setups (e.g. Nvidia, Hyprland) where the DMABUF renderer fails.
    // See https://github.com/derekross/onyx/issues/19. Only applied on Linux,
    // and never overrides a value the user has already set (allows opting out
    // with WEBKIT_DISABLE_DMABUF_RENDERER=0). Must run before the webview is
    // created, which is why it lives here at the top of main().
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none() {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    onyx_lib::run();
}
