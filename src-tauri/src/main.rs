// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

// Detects the Linux setups where the WebKitGTK DMABUF renderer is known to
// fail. Disabling that renderer makes WebKitGTK composite through CPU shared
// memory instead of zero-copy GPU buffers, which costs CPU in both this process
// and the compositor, so it is only worth paying where it is actually needed.
//
// The failure has two faces, and they are the same bug at different moments:
// the surface never receives a first frame (blank/white window, #19), or it
// stops receiving new ones (the window keeps showing a stale frame and looks
// frozen -- the cursor stops changing shape, and input appears to do nothing
// while the app is in fact running normally underneath).
#[cfg(target_os = "linux")]
fn needs_dmabuf_workaround() -> bool {
    // Proprietary Nvidia driver, including on X11.
    let nvidia = std::path::Path::new("/proc/driver/nvidia/version").exists()
        || std::path::Path::new("/sys/module/nvidia").exists();

    // Any Wayland session.
    //
    // This deliberately replaces the previous Hyprland-only check. Enumerating
    // known-broken compositors does not hold up: the reports so far are
    // Hyprland (#19) and COSMIC, the latter on Intel integrated graphics, so
    // the fault is not vendor-specific and not confined to one compositor.
    // DMABUF is the Wayland compositing path, so scope the workaround to
    // Wayland and leave X11 on the zero-copy renderer. Hyprland is a Wayland
    // compositor and stays covered by this.
    //
    // Users who want zero-copy back can set WEBKIT_DISABLE_DMABUF_RENDERER=0,
    // which main() honours over this function.
    let wayland = std::env::var_os("WAYLAND_DISPLAY").is_some()
        || std::env::var("XDG_SESSION_TYPE")
            .map(|session| session.eq_ignore_ascii_case("wayland"))
            .unwrap_or(false);

    nvidia || wayland
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
