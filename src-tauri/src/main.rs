// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Detects the Linux setups where the WebKitGTK DMABUF renderer is known to
// fail and render a blank/white screen. Disabling that renderer makes WebKitGTK
// composite through CPU shared memory instead of zero-copy GPU buffers, which
// costs CPU in both this process and the compositor, so it is only worth paying
// where it is actually needed.
#[cfg(target_os = "linux")]
fn needs_dmabuf_workaround() -> bool {
    // Proprietary Nvidia driver.
    let nvidia = std::path::Path::new("/proc/driver/nvidia/version").exists()
        || std::path::Path::new("/sys/module/nvidia").exists();

    // Hyprland, reported independently of the GPU vendor.
    let hyprland = std::env::var_os("HYPRLAND_INSTANCE_SIGNATURE").is_some()
        || std::env::var("XDG_CURRENT_DESKTOP")
            .map(|desktop| desktop.to_ascii_lowercase().contains("hyprland"))
            .unwrap_or(false);

    nvidia || hyprland
}

fn main() {
    // Workaround for WebKitGTK rendering a blank/white screen on some Linux
    // Wayland setups (e.g. Nvidia, Hyprland) where the DMABUF renderer fails.
    // See https://github.com/derekross/onyx/issues/19. Scoped to the setups
    // that need it, since disabling the DMABUF renderer costs CPU everywhere
    // else, and never overrides a value the user has already set (so it can be
    // forced on with WEBKIT_DISABLE_DMABUF_RENDERER=1 or off with =0). Must run
    // before the webview is created, which is why it lives here at the top of
    // main().
    #[cfg(target_os = "linux")]
    {
        if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_none()
            && needs_dmabuf_workaround()
        {
            std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
        }
    }

    onyx_lib::run();
}
