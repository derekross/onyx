#[cfg(not(target_os = "android"))]
use keyring::Entry;
use notify::{Config, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use parking_lot::Mutex;
use percent_encoding::percent_decode_str;
#[cfg(not(target_os = "android"))]
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use serde::{Deserialize, Serialize};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command};
use std::sync::Arc;
#[cfg(not(target_os = "android"))]
use std::thread;
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};
use walkdir::WalkDir;

// OpenCode server process management
struct OpenCodeServerState {
    process: Option<Child>,
    port: Option<u16>,
}

impl Default for OpenCodeServerState {
    fn default() -> Self {
        Self {
            process: None,
            port: None,
        }
    }
}

type SharedOpenCodeServerState = Arc<Mutex<OpenCodeServerState>>;

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct AppSettings {
    #[serde(default)]
    pub vault_path: Option<String>,
    #[serde(default)]
    pub show_terminal: bool,
}

fn get_config_dir_with_app(app: &AppHandle) -> PathBuf {
    #[cfg(target_os = "android")]
    {
        // On Android, use the app's data directory
        app.path()
            .app_data_dir()
            .unwrap_or_else(|_| PathBuf::from("/data/data/com.onyxnotes.dev/files"))
            .join("config")
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app; // Unused on desktop
        // Try multiple sources for home directory to handle various launch contexts
        // This is important on Windows where HOME may not be set when launched via protocol handler
        let home = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_else(|_| {
                // Last resort: use dirs crate which handles platform-specific logic
                dirs::home_dir()
                    .map(|p| p.to_string_lossy().to_string())
                    .unwrap_or_else(|| ".".to_string())
            });
        PathBuf::from(home).join(".config").join("onyx")
    }
}



#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct PlatformInfo {
    pub platform: String,
    pub default_vault_path: Option<String>,
}

#[tauri::command]
fn get_platform_info(app: AppHandle) -> PlatformInfo {
    let platform = if cfg!(target_os = "android") {
        "android".to_string()
    } else if cfg!(target_os = "ios") {
        "ios".to_string()
    } else if cfg!(target_os = "macos") {
        "macos".to_string()
    } else if cfg!(target_os = "windows") {
        "windows".to_string()
    } else {
        "linux".to_string()
    };

    let default_vault_path = if cfg!(target_os = "android") || cfg!(target_os = "ios") {
        // On mobile, use the app's data directory
        app.path()
            .app_data_dir()
            .ok()
            .map(|p| p.join("Onyx").to_string_lossy().to_string())
    } else {
        // On desktop, use Documents/Onyx
        app.path()
            .document_dir()
            .ok()
            .map(|p| p.join("Onyx").to_string_lossy().to_string())
    };

    PlatformInfo {
        platform,
        default_vault_path,
    }
}

fn get_settings_path(app: &AppHandle) -> PathBuf {
    get_config_dir_with_app(app).join("settings.json")
}

/// Validates that a path is within the allowed vault directory.
/// Returns the canonicalized path if valid, or an error if path traversal is detected.
fn validate_vault_path(path: &str, vault_path: &str) -> Result<PathBuf, String> {
    let path = Path::new(path);
    let vault = Path::new(vault_path);
    
    // Canonicalize both paths to resolve any .. or symlinks
    // For non-existent paths (e.g., new files), canonicalize the parent
    let canonical_path = if path.exists() {
        path.canonicalize().map_err(|e| format!("Invalid path: {}", e))?
    } else {
        // For new files, the parent must exist and be within vault
        let parent = path.parent().ok_or("Invalid path: no parent directory")?;
        let canonical_parent = parent.canonicalize().map_err(|e| format!("Invalid path: {}", e))?;
        canonical_parent.join(path.file_name().ok_or("Invalid path: no filename")?)
    };
    
    let canonical_vault = vault.canonicalize().map_err(|e| format!("Invalid vault path: {}", e))?;
    
    // Check if the path starts with the vault path
    if !canonical_path.starts_with(&canonical_vault) {
        return Err(format!("Access denied: path '{}' is outside the vault directory", path.display()));
    }
    
    Ok(canonical_path)
}

/// Check if a path is within the config directory (for settings, not vault files)
#[allow(dead_code)]
fn is_config_path(path: &str, app: &AppHandle) -> bool {
    let path = Path::new(path);
    let config_dir = get_config_dir_with_app(app);
    
    if let (Ok(canonical_path), Ok(canonical_config)) = (path.canonicalize(), config_dir.canonicalize()) {
        canonical_path.starts_with(&canonical_config)
    } else {
        false
    }
}

#[tauri::command]
fn load_settings(app: AppHandle) -> Result<AppSettings, String> {
    let path = get_settings_path(&app);
    println!("[Onyx] Loading settings from: {:?}", path);
    println!("[Onyx] HOME={:?}, USERPROFILE={:?}", 
        std::env::var("HOME").ok(), 
        std::env::var("USERPROFILE").ok());
    if !path.exists() {
        println!("[Onyx] Settings file does not exist, returning defaults");
        return Ok(AppSettings::default());
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    let settings: AppSettings = serde_json::from_str(&content).map_err(|e| e.to_string())?;
    println!("[Onyx] Loaded settings: vault_path={:?}", settings.vault_path);
    Ok(settings)
}

#[tauri::command]
fn save_settings(app: AppHandle, settings: AppSettings) -> Result<(), String> {
    let config_dir = get_config_dir_with_app(&app);
    fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;

    let path = get_settings_path(&app);
    let content = serde_json::to_string_pretty(&settings).map_err(|e| e.to_string())?;
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileEntry {
    name: String,
    path: String,
    #[serde(rename = "isDirectory")]
    is_directory: bool,
    children: Option<Vec<FileEntry>>,
}

// Asset entry for embedded files (images, audio, video, PDF)
#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct AssetEntry {
    pub name: String,
    pub path: String,
    pub extension: String,
    pub relative_path: String,
}

// Supported asset extensions
const IMAGE_EXTENSIONS: &[&str] = &["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"];
const AUDIO_EXTENSIONS: &[&str] = &["flac", "m4a", "mp3", "ogg", "wav", "webm", "3gp"];
const VIDEO_EXTENSIONS: &[&str] = &["mkv", "mov", "mp4", "ogv", "webm"];
const PDF_EXTENSIONS: &[&str] = &["pdf"];

fn is_embeddable_extension(ext: &str) -> bool {
    let ext_lower = ext.to_lowercase();
    IMAGE_EXTENSIONS.contains(&ext_lower.as_str())
        || AUDIO_EXTENSIONS.contains(&ext_lower.as_str())
        || VIDEO_EXTENSIONS.contains(&ext_lower.as_str())
        || PDF_EXTENSIONS.contains(&ext_lower.as_str())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchMatch {
    line: usize,
    content: String,
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct SearchResult {
    path: String,
    name: String,
    matches: Vec<SearchMatch>,
}

fn build_file_tree(path: &Path) -> Vec<FileEntry> {
    let mut entries: Vec<FileEntry> = Vec::new();

    if let Ok(read_dir) = fs::read_dir(path) {
        let mut items: Vec<_> = read_dir.filter_map(|e| e.ok()).collect();
        items.sort_by(|a, b| {
            let a_is_dir = a.path().is_dir();
            let b_is_dir = b.path().is_dir();
            match (a_is_dir, b_is_dir) {
                (true, false) => std::cmp::Ordering::Less,
                (false, true) => std::cmp::Ordering::Greater,
                _ => a.file_name().cmp(&b.file_name()),
            }
        });

        for item in items {
            let item_path = item.path();
            let name = item.file_name().to_string_lossy().to_string();

            // Skip hidden files and folders
            if name.starts_with('.') {
                continue;
            }

            let is_dir = item_path.is_dir();

            // Only include markdown files and directories
            if !is_dir && !name.ends_with(".md") {
                continue;
            }

            let children = if is_dir {
                Some(build_file_tree(&item_path))
            } else {
                None
            };

            entries.push(FileEntry {
                name,
                path: item_path.to_string_lossy().to_string(),
                is_directory: is_dir,
                children,
            });
        }
    }

    entries
}

#[tauri::command]
fn list_files(path: String) -> Result<Vec<FileEntry>, String> {
    let path = Path::new(&path);
    if !path.exists() {
        return Err("Path does not exist".to_string());
    }
    Ok(build_file_tree(path))
}

#[tauri::command]
fn read_file(path: String, vault_path: Option<String>) -> Result<String, String> {
    // Validate path is within vault if vault_path is provided
    if let Some(ref vault) = vault_path {
        validate_vault_path(&path, vault)?;
    }
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(path: String, content: String, vault_path: Option<String>) -> Result<(), String> {
    // Validate path is within vault if vault_path is provided
    if let Some(ref vault) = vault_path {
        validate_vault_path(&path, vault)?;
    }
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_binary_file(path: String, data: Vec<u8>, vault_path: Option<String>) -> Result<(), String> {
    // Validate path is within vault if vault_path is provided
    if let Some(ref vault) = vault_path {
        validate_vault_path(&path, vault)?;
    }
    // Create parent directories if needed
    if let Some(parent) = Path::new(&path).parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(&path, data).map_err(|e| e.to_string())
}

#[tauri::command]
fn read_binary_file(path: String, vault_path: Option<String>) -> Result<Vec<u8>, String> {
    // Validate path is within vault if vault_path is provided
    if let Some(ref vault) = vault_path {
        validate_vault_path(&path, vault)?;
    }
    fs::read(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_file(path: String, vault_path: Option<String>) -> Result<(), String> {
    // Validate path is within vault if vault_path is provided
    if let Some(ref vault) = vault_path {
        validate_vault_path(&path, vault)?;
    }
    let path = Path::new(&path);
    if path.exists() {
        return Err("File already exists".to_string());
    }
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    fs::write(path, "").map_err(|e| e.to_string())
}

#[tauri::command]
fn create_folder(path: String, vault_path: Option<String>) -> Result<(), String> {
    // Validate path is within vault if vault_path is provided
    if let Some(ref vault) = vault_path {
        validate_vault_path(&path, vault)?;
    }
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn get_file_modified_time(path: String) -> Result<u64, String> {
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
    let modified = metadata.modified().map_err(|e| e.to_string())?;
    // Convert to Unix timestamp (seconds since epoch)
    let duration = modified
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?;
    Ok(duration.as_secs())
}

#[tauri::command]
fn file_exists(path: String) -> bool {
    Path::new(&path).exists()
}

#[tauri::command]
fn delete_file(path: String, vault_path: Option<String>) -> Result<(), String> {
    // Validate path is within vault if vault_path is provided
    if let Some(ref vault) = vault_path {
        validate_vault_path(&path, vault)?;
    }
    let path = Path::new(&path);
    if path.is_dir() {
        fs::remove_dir_all(path).map_err(|e| e.to_string())
    } else {
        fs::remove_file(path).map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn rename_file(old_path: String, new_path: String, vault_path: Option<String>) -> Result<(), String> {
    // Validate both paths are within vault if vault_path is provided
    if let Some(ref vault) = vault_path {
        validate_vault_path(&old_path, vault)?;
        validate_vault_path(&new_path, vault)?;
    }
    fs::rename(&old_path, &new_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn copy_file(source: String, dest: String, vault_path: Option<String>) -> Result<(), String> {
    // Validate both paths are within vault if vault_path is provided
    if let Some(ref vault) = vault_path {
        validate_vault_path(&source, vault)?;
        validate_vault_path(&dest, vault)?;
    }
    let source_path = Path::new(&source);
    let dest_path = Path::new(&dest);

    if source_path.is_dir() {
        // Copy directory recursively
        copy_dir_recursive(source_path, dest_path).map_err(|e| e.to_string())
    } else {
        fs::copy(&source, &dest)
            .map(|_| ())
            .map_err(|e| e.to_string())
    }
}

fn copy_dir_recursive(src: &Path, dst: &Path) -> std::io::Result<()> {
    fs::create_dir_all(dst)?;
    for entry in fs::read_dir(src)? {
        let entry = entry?;
        let ty = entry.file_type()?;
        let src_path = entry.path();
        let dst_path = dst.join(entry.file_name());
        if ty.is_dir() {
            copy_dir_recursive(&src_path, &dst_path)?;
        } else {
            fs::copy(&src_path, &dst_path)?;
        }
    }
    Ok(())
}

#[tauri::command]
fn open_in_default_app(path: String) -> Result<(), String> {
    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(&path)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .args(["/C", "start", "", &path])
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[tauri::command]
fn show_in_folder(path: String) -> Result<(), String> {
    let path = Path::new(&path);
    let folder = if path.is_file() {
        path.parent().unwrap_or(path)
    } else {
        path
    };

    #[cfg(target_os = "linux")]
    {
        Command::new("xdg-open")
            .arg(folder)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(folder)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(folder)
            .spawn()
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}

#[derive(Debug, Serialize, Deserialize, Clone)]
pub struct FileStats {
    pub size: u64,
    pub created: u64,
    pub modified: u64,
}

#[tauri::command]
fn get_file_stats(path: String) -> Result<FileStats, String> {
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;

    let size = metadata.len();

    let created = metadata
        .created()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    let modified = metadata
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs())
        .unwrap_or(0);

    Ok(FileStats {
        size,
        created,
        modified,
    })
}

#[tauri::command]
fn search_files(path: String, query: String) -> Result<Vec<SearchResult>, String> {
    let mut results: Vec<SearchResult> = Vec::new();
    let query_lower = query.to_lowercase();

    for entry in WalkDir::new(&path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path().is_file() && e.path().extension().map(|ext| ext == "md").unwrap_or(false)
        })
    {
        let file_path = entry.path();
        if let Ok(content) = fs::read_to_string(file_path) {
            let mut matches: Vec<SearchMatch> = Vec::new();

            for (line_num, line) in content.lines().enumerate() {
                if line.to_lowercase().contains(&query_lower) {
                    matches.push(SearchMatch {
                        line: line_num + 1,
                        content: line.chars().take(100).collect(),
                    });
                }
            }

            if !matches.is_empty() {
                results.push(SearchResult {
                    path: file_path.to_string_lossy().to_string(),
                    name: file_path
                        .file_name()
                        .unwrap_or_default()
                        .to_string_lossy()
                        .to_string(),
                    matches,
                });
            }
        }
    }

    // Limit results
    results.truncate(50);
    Ok(results)
}

#[tauri::command]
fn list_assets(path: String) -> Result<Vec<AssetEntry>, String> {
    let mut assets: Vec<AssetEntry> = Vec::new();
    let vault_path = Path::new(&path);

    if !vault_path.exists() {
        return Err("Path does not exist".to_string());
    }

    for entry in WalkDir::new(&path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().is_file())
    {
        let file_path = entry.path();

        // Skip hidden files
        if let Some(name) = file_path.file_name() {
            if name.to_string_lossy().starts_with('.') {
                continue;
            }
        }

        // Check if it's an embeddable file type
        if let Some(ext) = file_path.extension() {
            let ext_str = ext.to_string_lossy().to_string();
            if is_embeddable_extension(&ext_str) {
                let name = file_path
                    .file_name()
                    .unwrap_or_default()
                    .to_string_lossy()
                    .to_string();

                let full_path = file_path.to_string_lossy().to_string();

                // Calculate relative path from vault root
                let relative_path = file_path
                    .strip_prefix(vault_path)
                    .unwrap_or(file_path)
                    .to_string_lossy()
                    .to_string();

                assets.push(AssetEntry {
                    name,
                    path: full_path,
                    extension: ext_str.to_lowercase(),
                    relative_path,
                });
            }
        }
    }

    Ok(assets)
}

#[tauri::command]
fn run_terminal_command(command: String, cwd: Option<String>) -> Result<String, String> {
    let mut cmd = if cfg!(target_os = "windows") {
        let mut c = Command::new("cmd");
        c.args(["/C", &command]);
        c
    } else {
        let mut c = Command::new("sh");
        c.args(["-c", &command]);
        c
    };

    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }

    let output = cmd.output().map_err(|e| e.to_string())?;

    let stdout = String::from_utf8_lossy(&output.stdout).to_string();
    let stderr = String::from_utf8_lossy(&output.stderr).to_string();

    if !output.status.success() {
        return Err(format!("{}{}", stdout, stderr));
    }

    Ok(format!("{}{}", stdout, stderr))
}

/// Start the OpenCode server in the background
/// This spawns `opencode serve --port <port>` and tracks the process for cleanup
/// Works on Windows, macOS, and Linux
#[tauri::command]
fn start_opencode_server(
    state: tauri::State<'_, SharedOpenCodeServerState>,
    command: String,
    cwd: Option<String>,
    port: u16,
) -> Result<(), String> {
    use std::process::Stdio;

    // Check if we already have a running server
    {
        let mut server_state = state.lock();
        let current_port = server_state.port;

        if let Some(ref mut child) = server_state.process {
            // Check if the process is still running
            match child.try_wait() {
                Ok(Some(_)) => {
                    // Process has exited, clear it
                    server_state.process = None;
                    server_state.port = None;
                }
                Ok(None) => {
                    // Process is still running
                    if current_port == Some(port) {
                        // Same port, server already running
                        return Ok(());
                    } else {
                        // Different port, kill the old one first
                        let _ = child.kill();
                        let _ = child.wait();
                        server_state.process = None;
                        server_state.port = None;
                    }
                }
                Err(_) => {
                    // Error checking, assume it's dead
                    server_state.process = None;
                    server_state.port = None;
                }
            }
        }
    }

    // Build enhanced PATH with common user binary locations (for Unix-like systems)
    #[cfg(not(target_os = "windows"))]
    let enhanced_path = {
        if let Ok(home) = std::env::var("HOME") {
            let current_path = std::env::var("PATH").unwrap_or_default();
            let user_paths = [
                format!("{}/.local/bin", home),
                format!("{}/bin", home),
                format!("{}/.cargo/bin", home),
                format!("{}/.opencode/bin", home),
            ];
            format!("{}:{}:/usr/local/bin", user_paths.join(":"), current_path)
        } else {
            std::env::var("PATH").unwrap_or_default()
        }
    };

    #[cfg(target_os = "windows")]
    let child = {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x08000000;

        let mut cmd = Command::new(&command);
        cmd.args(["serve", "--port", &port.to_string()]);
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::null());
        cmd.creation_flags(CREATE_NO_WINDOW);
        cmd.spawn()
            .map_err(|e| format!("Failed to spawn opencode: {}", e))?
    };

    #[cfg(target_os = "macos")]
    let child = {
        let mut cmd = Command::new(&command);
        cmd.args(["serve", "--port", &port.to_string()]);
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        cmd.env("PATH", &enhanced_path);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::null());
        cmd.spawn()
            .map_err(|e| format!("Failed to spawn opencode: {}. PATH={}", e, enhanced_path))?
    };

    #[cfg(target_os = "linux")]
    let child = {
        let mut cmd = Command::new(&command);
        cmd.args(["serve", "--port", &port.to_string()]);
        if let Some(dir) = cwd {
            cmd.current_dir(dir);
        }
        cmd.env("PATH", &enhanced_path);
        cmd.stdin(Stdio::null());
        cmd.stdout(Stdio::null());
        cmd.stderr(Stdio::null());
        cmd.spawn()
            .map_err(|e| format!("Failed to spawn opencode: {}. PATH={}", e, enhanced_path))?
    };

    // OpenCode is not supported on Android
    #[cfg(target_os = "android")]
    {
        return Err("OpenCode is not supported on Android".to_string());
    }

    // Store the process for later cleanup
    #[cfg(not(target_os = "android"))]
    {
        let mut server_state = state.lock();
        server_state.process = Some(child);
        server_state.port = Some(port);
    }

    #[cfg(not(target_os = "android"))]
    Ok(())
}

/// Stop the OpenCode server if running
#[tauri::command]
fn stop_opencode_server(state: tauri::State<'_, SharedOpenCodeServerState>) -> Result<(), String> {
    let mut server_state = state.lock();
    if let Some(ref mut child) = server_state.process {
        // Try graceful kill first, then force if needed
        let _ = child.kill();
        let _ = child.wait();
    }
    server_state.process = None;
    server_state.port = None;
    Ok(())
}

/// Check if the OpenCode server is running (managed by this app)
#[tauri::command]
fn is_opencode_server_managed(state: tauri::State<'_, SharedOpenCodeServerState>) -> bool {
    let mut server_state = state.lock();
    if let Some(ref mut child) = server_state.process {
        match child.try_wait() {
            Ok(Some(_)) => {
                // Process has exited
                server_state.process = None;
                server_state.port = None;
                false
            }
            Ok(None) => true, // Still running
            Err(_) => {
                server_state.process = None;
                server_state.port = None;
                false
            }
        }
    } else {
        false
    }
}

// OpenCode Installer Module
mod opencode_installer {
    use super::*;
    use futures_util::StreamExt;
    use std::io::Write;
    use tauri::Emitter;

    /// Progress payload for install events
    #[derive(Clone, Serialize)]
    pub struct InstallProgress {
        pub stage: String,
        pub progress: u32,
        pub bytes_downloaded: Option<u64>,
        pub total_bytes: Option<u64>,
        pub message: String,
    }

    /// Get the default install path for OpenCode based on the current platform
    fn get_default_install_dir() -> PathBuf {
        #[cfg(target_os = "windows")]
        {
            if let Some(appdata) = dirs::data_dir() {
                appdata.join("opencode").join("bin")
            } else {
                PathBuf::from("C:\\opencode\\bin")
            }
        }
        #[cfg(not(target_os = "windows"))]
        {
            if let Ok(home) = std::env::var("HOME") {
                PathBuf::from(home).join(".opencode").join("bin")
            } else {
                PathBuf::from("/usr/local/bin")
            }
        }
    }

    /// Get the full path to the opencode binary
    fn get_opencode_binary_path() -> PathBuf {
        let dir = get_default_install_dir();
        #[cfg(target_os = "windows")]
        {
            dir.join("opencode.exe")
        }
        #[cfg(not(target_os = "windows"))]
        {
            dir.join("opencode")
        }
    }

    /// Check common locations for OpenCode binary
    fn find_opencode_in_path() -> Option<PathBuf> {
        // Check if 'which' or 'where' can find it
        #[cfg(target_os = "windows")]
        let result = Command::new("where").arg("opencode").output();
        #[cfg(not(target_os = "windows"))]
        let result = Command::new("which").arg("opencode").output();

        if let Ok(output) = result {
            if output.status.success() {
                let path_str = String::from_utf8_lossy(&output.stdout);
                let path = path_str.lines().next()?.trim();
                if !path.is_empty() {
                    return Some(PathBuf::from(path));
                }
            }
        }
        None
    }

    /// Check if OpenCode is installed and return its path
    #[tauri::command]
    pub fn check_opencode_installed() -> Option<String> {
        // First check our default install location
        let default_path = get_opencode_binary_path();
        if default_path.exists() {
            return Some(default_path.to_string_lossy().to_string());
        }

        // Check common locations
        let common_paths: Vec<PathBuf> = {
            #[cfg(target_os = "windows")]
            {
                vec![
                    PathBuf::from("C:\\Program Files\\opencode\\opencode.exe"),
                    PathBuf::from("C:\\opencode\\opencode.exe"),
                ]
            }
            #[cfg(not(target_os = "windows"))]
            {
                let home = std::env::var("HOME").unwrap_or_default();
                vec![
                    PathBuf::from(&home).join(".local/bin/opencode"),
                    PathBuf::from(&home).join("bin/opencode"),
                    PathBuf::from("/usr/local/bin/opencode"),
                    PathBuf::from("/usr/bin/opencode"),
                ]
            }
        };

        for path in common_paths {
            if path.exists() {
                return Some(path.to_string_lossy().to_string());
            }
        }

        // Try to find in PATH
        if let Some(path) = find_opencode_in_path() {
            return Some(path.to_string_lossy().to_string());
        }

        None
    }

    /// Get the recommended install path for OpenCode
    #[tauri::command]
    pub fn get_opencode_install_path() -> String {
        get_opencode_binary_path().to_string_lossy().to_string()
    }

    /// Get the download URL for the current platform
    fn get_download_url() -> Result<String, String> {
        let base_url = "https://github.com/anomalyco/opencode/releases/latest/download";

        #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
        let asset = "opencode-darwin-arm64.zip";

        #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
        let asset = "opencode-darwin-x64.zip";

        #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
        let asset = "opencode-windows-x64.zip";

        #[cfg(all(target_os = "linux", target_arch = "x86_64"))]
        let asset = "opencode-linux-x64.tar.gz";

        #[cfg(all(target_os = "linux", target_arch = "aarch64"))]
        let asset = "opencode-linux-arm64.tar.gz";

        #[cfg(not(any(
            all(target_os = "macos", target_arch = "aarch64"),
            all(target_os = "macos", target_arch = "x86_64"),
            all(target_os = "windows", target_arch = "x86_64"),
            all(target_os = "linux", target_arch = "x86_64"),
            all(target_os = "linux", target_arch = "aarch64"),
        )))]
        {
            return Err("Unsupported platform".to_string());
        }

        #[cfg(any(
            all(target_os = "macos", target_arch = "aarch64"),
            all(target_os = "macos", target_arch = "x86_64"),
            all(target_os = "windows", target_arch = "x86_64"),
            all(target_os = "linux", target_arch = "x86_64"),
            all(target_os = "linux", target_arch = "aarch64"),
        ))]
        Ok(format!("{}/{}", base_url, asset))
    }

    /// Extract a .tar.gz archive
    #[cfg(not(target_os = "windows"))]
    fn extract_tar_gz(archive_path: &Path, dest_dir: &Path) -> Result<(), String> {
        use flate2::read::GzDecoder;
        use tar::Archive;

        let file = fs::File::open(archive_path).map_err(|e| format!("Failed to open archive: {}", e))?;
        let decoder = GzDecoder::new(file);
        let mut archive = Archive::new(decoder);

        // Extract to destination
        archive
            .unpack(dest_dir)
            .map_err(|e| format!("Failed to extract archive: {}", e))?;

        Ok(())
    }

    /// Extract a .zip archive
    fn extract_zip(archive_path: &Path, dest_dir: &Path) -> Result<(), String> {
        let file = fs::File::open(archive_path).map_err(|e| format!("Failed to open archive: {}", e))?;
        let mut archive = zip::ZipArchive::new(file).map_err(|e| format!("Failed to read zip: {}", e))?;

        for i in 0..archive.len() {
            let mut file = archive
                .by_index(i)
                .map_err(|e| format!("Failed to read zip entry: {}", e))?;

            let outpath = match file.enclosed_name() {
                Some(path) => dest_dir.join(path),
                None => continue,
            };

            if file.name().ends_with('/') {
                fs::create_dir_all(&outpath).map_err(|e| format!("Failed to create directory: {}", e))?;
            } else {
                if let Some(parent) = outpath.parent() {
                    if !parent.exists() {
                        fs::create_dir_all(parent)
                            .map_err(|e| format!("Failed to create directory: {}", e))?;
                    }
                }
                let mut outfile = fs::File::create(&outpath)
                    .map_err(|e| format!("Failed to create file: {}", e))?;
                std::io::copy(&mut file, &mut outfile)
                    .map_err(|e| format!("Failed to write file: {}", e))?;
            }

            // Set executable permissions on Unix
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                if let Some(mode) = file.unix_mode() {
                    fs::set_permissions(&outpath, fs::Permissions::from_mode(mode)).ok();
                }
            }
        }

        Ok(())
    }

    /// Download and install OpenCode
    #[tauri::command]
    pub async fn install_opencode(app: AppHandle) -> Result<String, String> {
        let download_url = get_download_url()?;
        let install_dir = get_default_install_dir();
        let binary_path = get_opencode_binary_path();

        // Emit starting
        let _ = app.emit(
            "opencode-install-progress",
            InstallProgress {
                stage: "checking".to_string(),
                progress: 0,
                bytes_downloaded: None,
                total_bytes: None,
                message: "Preparing installation...".to_string(),
            },
        );

        // Create install directory
        fs::create_dir_all(&install_dir)
            .map_err(|e| format!("Failed to create install directory: {}", e))?;

        // Create temp file for download
        let temp_dir = std::env::temp_dir();
        let archive_name = download_url.split('/').last().unwrap_or("opencode.archive");
        let archive_path = temp_dir.join(archive_name);

        // Download the archive
        let _ = app.emit(
            "opencode-install-progress",
            InstallProgress {
                stage: "downloading".to_string(),
                progress: 0,
                bytes_downloaded: Some(0),
                total_bytes: None,
                message: format!("Connecting to GitHub..."),
            },
        );

        let client = reqwest::Client::new();
        let response = client
            .get(&download_url)
            .send()
            .await
            .map_err(|e| format!("Failed to download: {}", e))?;

        if !response.status().is_success() {
            return Err(format!("Download failed with status: {}", response.status()));
        }

        let total_size = response.content_length();
        let mut downloaded: u64 = 0;
        let mut file = fs::File::create(&archive_path)
            .map_err(|e| format!("Failed to create temp file: {}", e))?;

        let mut stream = response.bytes_stream();

        while let Some(chunk) = stream.next().await {
            let chunk = chunk.map_err(|e| format!("Download error: {}", e))?;
            file.write_all(&chunk)
                .map_err(|e| format!("Failed to write: {}", e))?;
            downloaded += chunk.len() as u64;

            let progress = if let Some(total) = total_size {
                ((downloaded as f64 / total as f64) * 100.0) as u32
            } else {
                0
            };

            let message = if let Some(total) = total_size {
                format!(
                    "Downloading... {:.1} MB / {:.1} MB",
                    downloaded as f64 / 1_000_000.0,
                    total as f64 / 1_000_000.0
                )
            } else {
                format!("Downloading... {:.1} MB", downloaded as f64 / 1_000_000.0)
            };

            let _ = app.emit(
                "opencode-install-progress",
                InstallProgress {
                    stage: "downloading".to_string(),
                    progress,
                    bytes_downloaded: Some(downloaded),
                    total_bytes: total_size,
                    message,
                },
            );
        }

        drop(file);

        // Extract the archive
        let _ = app.emit(
            "opencode-install-progress",
            InstallProgress {
                stage: "extracting".to_string(),
                progress: 80,
                bytes_downloaded: None,
                total_bytes: None,
                message: "Extracting OpenCode...".to_string(),
            },
        );

        // Create a temp extraction directory
        let extract_dir = temp_dir.join("opencode_extract");
        if extract_dir.exists() {
            let _ = fs::remove_dir_all(&extract_dir);
        }
        fs::create_dir_all(&extract_dir)
            .map_err(|e| format!("Failed to create extract directory: {}", e))?;

        // Extract based on archive type
        if archive_name.ends_with(".tar.gz") {
            #[cfg(not(target_os = "windows"))]
            extract_tar_gz(&archive_path, &extract_dir)?;
            #[cfg(target_os = "windows")]
            return Err("tar.gz extraction not supported on Windows".to_string());
        } else if archive_name.ends_with(".zip") {
            extract_zip(&archive_path, &extract_dir)?;
        } else {
            return Err("Unknown archive format".to_string());
        }

        // Find the opencode binary in the extracted files
        let _ = app.emit(
            "opencode-install-progress",
            InstallProgress {
                stage: "configuring".to_string(),
                progress: 90,
                bytes_downloaded: None,
                total_bytes: None,
                message: "Installing OpenCode...".to_string(),
            },
        );

        // Look for the opencode binary
        #[cfg(target_os = "windows")]
        let binary_name = "opencode.exe";
        #[cfg(not(target_os = "windows"))]
        let binary_name = "opencode";

        let mut found_binary: Option<PathBuf> = None;
        for entry in WalkDir::new(&extract_dir).max_depth(3) {
            if let Ok(entry) = entry {
                if entry.file_name().to_string_lossy() == binary_name {
                    found_binary = Some(entry.path().to_path_buf());
                    break;
                }
            }
        }

        let source_binary = found_binary.ok_or("OpenCode binary not found in archive")?;

        // Copy to install location
        fs::copy(&source_binary, &binary_path)
            .map_err(|e| format!("Failed to install binary: {}", e))?;

        // Make executable on Unix
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&binary_path, fs::Permissions::from_mode(0o755))
                .map_err(|e| format!("Failed to set permissions: {}", e))?;
        }

        // Clean up temp files
        let _ = fs::remove_file(&archive_path);
        let _ = fs::remove_dir_all(&extract_dir);

        // Emit completion
        let _ = app.emit(
            "opencode-install-progress",
            InstallProgress {
                stage: "complete".to_string(),
                progress: 100,
                bytes_downloaded: None,
                total_bytes: None,
                message: "OpenCode installed successfully!".to_string(),
            },
        );

        Ok(binary_path.to_string_lossy().to_string())
    }

    /// Get the currently installed OpenCode version
    #[tauri::command]
    pub fn get_opencode_version() -> Result<String, String> {
        let binary_path = if let Some(path) = check_opencode_installed() {
            path
        } else {
            return Err("OpenCode not installed".to_string());
        };

        let output = Command::new(&binary_path)
            .arg("--version")
            .output()
            .map_err(|e| format!("Failed to get version: {}", e))?;

        if output.status.success() {
            let version = String::from_utf8_lossy(&output.stdout).trim().to_string();
            Ok(version)
        } else {
            Err("Failed to get version".to_string())
        }
    }
}

// PTY Session management (desktop only)
#[cfg(not(target_os = "android"))]
mod pty {
    use super::*;
    use std::io::Write;
    use std::time::{Instant, Duration};

    // Maximum PTY session lifetime: 4 hours
    const PTY_SESSION_TIMEOUT: Duration = Duration::from_secs(4 * 60 * 60);
    // Maximum number of concurrent PTY sessions
    const MAX_PTY_SESSIONS: usize = 10;

    pub struct PtySession {
        pub writer: Box<dyn Write + Send>,
        pub _child: Box<dyn portable_pty::Child + Send + Sync>,
        pub master: Box<dyn portable_pty::MasterPty + Send>,
        pub created_at: Instant,
    }

    pub struct PtyState {
        pub sessions: std::collections::HashMap<String, PtySession>,
        pub counter: u32,
    }

    impl Default for PtyState {
        fn default() -> Self {
            Self {
                sessions: std::collections::HashMap::new(),
                counter: 0,
            }
        }
    }
    
    impl PtyState {
        /// Remove sessions that have exceeded their timeout
        pub fn cleanup_expired_sessions(&mut self) {
            let now = Instant::now();
            self.sessions.retain(|_id, session| {
                now.duration_since(session.created_at) < PTY_SESSION_TIMEOUT
            });
        }
        
        /// Check if we can create a new session (respects max limit)
        pub fn can_create_session(&self) -> bool {
            self.sessions.len() < MAX_PTY_SESSIONS
        }
    }

    pub type SharedPtyState = Arc<Mutex<PtyState>>;

    #[tauri::command]
    pub fn spawn_pty(
        app: AppHandle,
        state: tauri::State<'_, SharedPtyState>,
        command: String,
        cwd: Option<String>,
        cols: u16,
        rows: u16,
    ) -> Result<String, String> {
        // Security: Clean up expired sessions and check limits
        {
            let mut state_guard = state.lock();
            state_guard.cleanup_expired_sessions();
            if !state_guard.can_create_session() {
                return Err("Maximum number of terminal sessions reached. Please close some terminals first.".to_string());
            }
        }
        
        let pty_system = native_pty_system();

        let pair = pty_system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|e| e.to_string())?;

        let mut cmd = CommandBuilder::new(&command);

        if let Some(dir) = cwd {
            cmd.cwd(dir);
        }

        // Set TERM environment variable for proper terminal emulation
        cmd.env("TERM", "xterm-256color");

        // Enhance PATH with common user binary locations
        // This helps find binaries when running as a system-installed app
        if let Ok(home) = std::env::var("HOME") {
            let current_path = std::env::var("PATH").unwrap_or_default();
            let user_paths = [
                format!("{}/.local/bin", home),
                format!("{}/bin", home),
                format!("{}/.cargo/bin", home),
                format!("{}/.opencode/bin", home),
                format!("{}/.nvm/versions/node/*/bin", home), // Common node location
            ];
            let enhanced_path = format!("{}:{}:/usr/local/bin", user_paths.join(":"), current_path);
            cmd.env("PATH", enhanced_path);
        }

        let child = pair.slave.spawn_command(cmd).map_err(|e| e.to_string())?;

        let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
        let writer = pair.master.take_writer().map_err(|e| e.to_string())?;

        // Generate session ID
        let session_id = {
            let mut state = state.lock();
            state.counter += 1;
            format!("pty_{}", state.counter)
        };

        let session_id_clone = session_id.clone();
        let app_clone = app.clone();

        // Spawn reader thread to emit output events
        thread::spawn(move || {
            let mut buf = [0u8; 4096];
            loop {
                match reader.read(&mut buf) {
                    Ok(0) => {
                        // EOF - process ended
                        let _ = app_clone.emit(&format!("pty-exit-{}", session_id_clone), ());
                        break;
                    }
                    Ok(n) => {
                        let data = String::from_utf8_lossy(&buf[..n]).to_string();
                        let _ = app_clone.emit(&format!("pty-output-{}", session_id_clone), data);
                    }
                    Err(_) => {
                        let _ = app_clone.emit(&format!("pty-exit-{}", session_id_clone), ());
                        break;
                    }
                }
            }
        });

        // Store session with creation timestamp
        {
            let mut state = state.lock();
            state.sessions.insert(
                session_id.clone(),
                PtySession {
                    writer,
                    _child: child,
                    master: pair.master,
                    created_at: Instant::now(),
                },
            );
        }

        Ok(session_id)
    }

    #[tauri::command]
    pub fn write_pty(
        state: tauri::State<'_, SharedPtyState>,
        session_id: String,
        data: String,
    ) -> Result<(), String> {
        let mut state = state.lock();
        if let Some(session) = state.sessions.get_mut(&session_id) {
            session
                .writer
                .write_all(data.as_bytes())
                .map_err(|e| e.to_string())?;
            session.writer.flush().map_err(|e| e.to_string())?;
            Ok(())
        } else {
            Err("Session not found".to_string())
        }
    }

    #[tauri::command]
    pub fn resize_pty(
        state: tauri::State<'_, SharedPtyState>,
        session_id: String,
        cols: u16,
        rows: u16,
    ) -> Result<(), String> {
        let state = state.lock();
        if let Some(session) = state.sessions.get(&session_id) {
            session
                .master
                .resize(PtySize {
                    rows,
                    cols,
                    pixel_width: 0,
                    pixel_height: 0,
                })
                .map_err(|e| e.to_string())?;
            Ok(())
        } else {
            Err("Session not found".to_string())
        }
    }

    #[tauri::command]
    pub fn kill_pty(
        state: tauri::State<'_, SharedPtyState>,
        session_id: String,
    ) -> Result<(), String> {
        let mut state = state.lock();
        if state.sessions.remove(&session_id).is_some() {
            Ok(())
        } else {
            Err("Session not found".to_string())
        }
    }
}

#[cfg(not(target_os = "android"))]
use pty::{PtyState, SharedPtyState};

// Stub PTY functions for Android
#[cfg(target_os = "android")]
mod pty {
    use super::*;

    pub struct PtyState;
    impl Default for PtyState {
        fn default() -> Self {
            Self
        }
    }
    pub type SharedPtyState = Arc<Mutex<PtyState>>;

    #[tauri::command]
    pub fn spawn_pty(
        _app: AppHandle,
        _state: tauri::State<'_, SharedPtyState>,
        _command: String,
        _cwd: Option<String>,
        _cols: u16,
        _rows: u16,
    ) -> Result<String, String> {
        Err("PTY not supported on Android".to_string())
    }

    #[tauri::command]
    pub fn write_pty(
        _state: tauri::State<'_, SharedPtyState>,
        _session_id: String,
        _data: String,
    ) -> Result<(), String> {
        Err("PTY not supported on Android".to_string())
    }

    #[tauri::command]
    pub fn resize_pty(
        _state: tauri::State<'_, SharedPtyState>,
        _session_id: String,
        _cols: u16,
        _rows: u16,
    ) -> Result<(), String> {
        Err("PTY not supported on Android".to_string())
    }

    #[tauri::command]
    pub fn kill_pty(
        _state: tauri::State<'_, SharedPtyState>,
        _session_id: String,
    ) -> Result<(), String> {
        Err("PTY not supported on Android".to_string())
    }
}

#[cfg(target_os = "android")]
use pty::{PtyState, SharedPtyState};

// File watcher for detecting changes
struct WatcherState {
    watcher: Option<RecommendedWatcher>,
}

impl Default for WatcherState {
    fn default() -> Self {
        Self { watcher: None }
    }
}

type SharedWatcherState = Arc<Mutex<WatcherState>>;

#[tauri::command]
fn start_watching(
    app: AppHandle,
    state: tauri::State<'_, SharedWatcherState>,
    path: String,
) -> Result<(), String> {
    let mut watcher_state = state.lock();

    // Stop existing watcher if any
    watcher_state.watcher = None;

    let app_clone = app.clone();
    let watcher = RecommendedWatcher::new(
        move |res: Result<notify::Event, notify::Error>| {
            if let Ok(event) = res {
                // Only emit for create, modify, remove events on .md files
                let dominated_by_md = event
                    .paths
                    .iter()
                    .any(|p| p.extension().map(|e| e == "md").unwrap_or(false));

                let dominated_by_dir = event.paths.iter().any(|p| p.is_dir());

                if dominated_by_md || dominated_by_dir {
                    match event.kind {
                        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) => {
                            let _ = app_clone.emit("files-changed", ());
                            // Also emit specific file paths for open tab reload
                            let paths: Vec<String> = event
                                .paths
                                .iter()
                                .filter(|p| p.extension().map(|e| e == "md").unwrap_or(false))
                                .filter_map(|p| p.to_str().map(|s| s.to_string()))
                                .collect();
                            if !paths.is_empty() {
                                let _ = app_clone.emit("file-modified", paths);
                            }
                        }
                        _ => {}
                    }
                }
            }
        },
        Config::default().with_poll_interval(Duration::from_secs(1)),
    )
    .map_err(|e| e.to_string())?;

    watcher_state.watcher = Some(watcher);

    // Start watching the path
    if let Some(ref mut w) = watcher_state.watcher {
        w.watch(Path::new(&path), RecursiveMode::Recursive)
            .map_err(|e| e.to_string())?;
    }

    Ok(())
}

#[tauri::command]
fn stop_watching(state: tauri::State<'_, SharedWatcherState>) -> Result<(), String> {
    let mut watcher_state = state.lock();
    watcher_state.watcher = None;
    Ok(())
}

// Skills directory management
fn get_skills_dir() -> PathBuf {
    // All platforms: ~/.config/opencode/skills
    // On Windows this resolves to C:\Users\<user>\.config\opencode\skills
    if let Some(home) = dirs::home_dir() {
        home.join(".config").join("opencode").join("skills")
    } else {
        PathBuf::from(".").join(".config").join("opencode").join("skills")
    }
}

#[tauri::command]
fn skill_is_installed(skill_id: String) -> bool {
    let skill_dir = get_skills_dir().join(&skill_id);
    skill_dir.exists() && skill_dir.join("SKILL.md").exists()
}

#[tauri::command]
fn skill_save_file(skill_id: String, file_name: String, content: String) -> Result<(), String> {
    let skills_dir = get_skills_dir();
    let skill_dir = skills_dir.join(&skill_id);
    
    // Create the skills directory first if it doesn't exist
    fs::create_dir_all(&skill_dir).map_err(|e| {
        format!(
            "Failed to create skill directory '{}': {}",
            skill_dir.display(),
            e
        )
    })?;

    let file_path = skill_dir.join(&file_name);
    fs::write(&file_path, &content).map_err(|e| {
        format!(
            "Failed to write file '{}': {}",
            file_path.display(),
            e
        )
    })
}

#[tauri::command]
fn skill_delete(skill_id: String) -> Result<(), String> {
    let skill_dir = get_skills_dir().join(&skill_id);
    if skill_dir.exists() {
        fs::remove_dir_all(&skill_dir).map_err(|e| e.to_string())
    } else {
        Ok(())
    }
}

#[tauri::command]
fn skill_list_installed() -> Result<Vec<String>, String> {
    let skills_dir = get_skills_dir();
    if !skills_dir.exists() {
        return Ok(Vec::new());
    }

    let mut installed = Vec::new();
    if let Ok(entries) = fs::read_dir(&skills_dir) {
        for entry in entries.filter_map(|e| e.ok()) {
            if entry.path().is_dir() {
                if entry.path().join("SKILL.md").exists() {
                    if let Some(name) = entry.file_name().to_str() {
                        installed.push(name.to_string());
                    }
                }
            }
        }
    }
    Ok(installed)
}

#[tauri::command]
fn skill_read_file(skill_id: String, file_name: String) -> Result<String, String> {
    let file_path = get_skills_dir().join(&skill_id).join(&file_name);
    fs::read_to_string(&file_path).map_err(|e| e.to_string())
}

/// Import a skill from a ZIP file
/// Returns the skill ID (folder name) extracted from the ZIP
#[tauri::command]
fn skill_import_zip(zip_path: String) -> Result<String, String> {
    use std::io::Read;
    use zip::ZipArchive;

    let file = fs::File::open(&zip_path).map_err(|e| format!("Failed to open ZIP: {}", e))?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| format!("Failed to read ZIP archive: {}", e))?;

    // Find SKILL.md to determine the skill structure
    // ZIP could be structured as:
    // 1. skill-name/SKILL.md (with folder)
    // 2. SKILL.md (flat, at root)
    let mut skill_id: Option<String> = None;
    let mut has_root_skill_md = false;

    for i in 0..archive.len() {
        let file = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read ZIP entry: {}", e))?;
        let name = file.name();

        if name == "SKILL.md" {
            has_root_skill_md = true;
        } else if name.ends_with("/SKILL.md") {
            // Extract folder name (first component)
            if let Some(folder) = name.split('/').next() {
                skill_id = Some(folder.to_string());
            }
        }
    }

    // Determine skill ID
    let skill_id = if let Some(id) = skill_id {
        id
    } else if has_root_skill_md {
        // Use ZIP filename as skill ID
        let zip_name = std::path::Path::new(&zip_path)
            .file_stem()
            .and_then(|s| s.to_str())
            .unwrap_or("imported-skill");
        zip_name
            .to_lowercase()
            .replace(|c: char| !c.is_alphanumeric() && c != '-', "-")
    } else {
        return Err("ZIP does not contain a SKILL.md file".to_string());
    };

    let skill_dir = get_skills_dir().join(&skill_id);
    fs::create_dir_all(&skill_dir).map_err(|e| format!("Failed to create skill directory: {}", e))?;

    // Re-open archive for extraction
    let file = fs::File::open(&zip_path).map_err(|e| format!("Failed to open ZIP: {}", e))?;
    let mut archive =
        ZipArchive::new(file).map_err(|e| format!("Failed to read ZIP archive: {}", e))?;

    // Extract files
    for i in 0..archive.len() {
        let mut file = archive
            .by_index(i)
            .map_err(|e| format!("Failed to read ZIP entry: {}", e))?;
        let name = file.name().to_string();

        // Skip directories
        if name.ends_with('/') {
            continue;
        }

        // Determine output path
        let output_name = if has_root_skill_md && !name.contains('/') {
            // Flat structure - file is at root
            name.clone()
        } else if let Some(rest) = name.strip_prefix(&format!("{}/", skill_id)) {
            // Nested structure - strip the folder prefix
            rest.to_string()
        } else if name.contains('/') {
            // Some other nested structure - use path after first /
            name.split('/').skip(1).collect::<Vec<_>>().join("/")
        } else {
            name.clone()
        };

        if output_name.is_empty() {
            continue;
        }

        let output_path = skill_dir.join(&output_name);

        // Create parent directories if needed
        if let Some(parent) = output_path.parent() {
            fs::create_dir_all(parent)
                .map_err(|e| format!("Failed to create directory: {}", e))?;
        }

        // Read and write file
        let mut contents = Vec::new();
        file.read_to_end(&mut contents)
            .map_err(|e| format!("Failed to read ZIP entry: {}", e))?;
        fs::write(&output_path, &contents)
            .map_err(|e| format!("Failed to write file: {}", e))?;
    }

    // Verify SKILL.md exists
    if !skill_dir.join("SKILL.md").exists() {
        // Clean up
        let _ = fs::remove_dir_all(&skill_dir);
        return Err("Extracted files do not contain SKILL.md".to_string());
    }

    Ok(skill_id)
}

#[tauri::command]
async fn fetch_skills_sh(limit: Option<u32>) -> Result<String, String> {
    let limit = limit.unwrap_or(500); // Fetch up to 500 skills by default
    let url = format!("https://skills.sh/api/skills?limit={}", limit);
    
    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch skills.sh: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("skills.sh returned status: {}", response.status()));
    }

    response
        .text()
        .await
        .map_err(|e| format!("Failed to read response: {}", e))
}

#[tauri::command]
async fn fetch_skill_file(url: String) -> Result<String, String> {
    let client = reqwest::Client::new();
    let response = client
        .get(&url)
        .timeout(Duration::from_secs(30))
        .send()
        .await
        .map_err(|e| format!("Failed to fetch skill file: {}", e))?;

    if !response.status().is_success() {
        return Err(format!("Failed to fetch skill file: status {}", response.status()));
    }

    response
        .text()
        .await
        .map_err(|e| format!("Failed to read skill file: {}", e))
}

// Keyring commands for secure credential storage (desktop only)
#[cfg(not(target_os = "android"))]
mod keyring_commands {
    use super::*;

    const KEYRING_SERVICE: &str = "com.onyx.app";

    #[tauri::command]
    pub fn keyring_set(key: String, value: String) -> Result<(), String> {
        let entry = Entry::new(KEYRING_SERVICE, &key).map_err(|e| e.to_string())?;
        entry.set_password(&value).map_err(|e| e.to_string())
    }

    #[tauri::command]
    pub fn keyring_get(key: String) -> Result<Option<String>, String> {
        let entry = Entry::new(KEYRING_SERVICE, &key).map_err(|e| e.to_string())?;
        match entry.get_password() {
            Ok(password) => Ok(Some(password)),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    #[tauri::command]
    pub fn keyring_delete(key: String) -> Result<(), String> {
        let entry = Entry::new(KEYRING_SERVICE, &key).map_err(|e| e.to_string())?;
        match entry.delete_credential() {
            Ok(()) => Ok(()),
            Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }
}

// Android keyring commands using app-private file storage
// Data is stored in the app's private directory which requires root access to read
// Combined with biometric authentication in the UI layer for additional security
#[cfg(target_os = "android")]
mod keyring_commands {
    use sha2::{Sha256, Digest};
    use std::fs;
    use std::path::PathBuf;
    use tauri::Manager;

    fn get_secure_storage_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|e| format!("Failed to get app data dir: {}", e))?;
        
        let secure_dir = data_dir.join(".secure");
        if !secure_dir.exists() {
            fs::create_dir_all(&secure_dir)
                .map_err(|e| format!("Failed to create secure dir: {}", e))?;
        }
        Ok(secure_dir)
    }

    fn get_key_path(app: &tauri::AppHandle, key: &str) -> Result<PathBuf, String> {
        let secure_dir = get_secure_storage_path(app)?;
        // Hash the key name using SHA-256 to avoid filesystem issues with special characters
        let mut hasher = Sha256::new();
        hasher.update(key.as_bytes());
        let hash = format!("{:x}", hasher.finalize());
        Ok(secure_dir.join(hash))
    }

    #[tauri::command]
    pub fn keyring_set(app: tauri::AppHandle, key: String, value: String) -> Result<(), String> {
        let path = get_key_path(&app, &key)?;
        fs::write(&path, value.as_bytes())
            .map_err(|e| format!("Failed to write secure data: {}", e))
    }

    #[tauri::command]
    pub fn keyring_get(app: tauri::AppHandle, key: String) -> Result<Option<String>, String> {
        let path = get_key_path(&app, &key)?;
        if !path.exists() {
            return Ok(None);
        }
        let data = fs::read_to_string(&path)
            .map_err(|e| format!("Failed to read secure data: {}", e))?;
        Ok(Some(data))
    }

    #[tauri::command]
    pub fn keyring_delete(app: tauri::AppHandle, key: String) -> Result<(), String> {
        let path = get_key_path(&app, &key)?;
        if path.exists() {
            fs::remove_file(&path)
                .map_err(|e| format!("Failed to delete secure data: {}", e))?;
        }
        Ok(())
    }
}

/// Get any deep link URLs passed as command line arguments
/// On Linux, when the app is launched via xdg-open, the URL is passed as an argument
#[tauri::command]
fn get_deep_link_args() -> Vec<String> {
    let args: Vec<String> = std::env::args().collect();
    let mut deep_links = Vec::new();
    
    // Skip the first arg (program name), check for URLs starting with onyx://
    for arg in args.iter().skip(1) {
        if arg.starts_with("onyx://") {
            deep_links.push(arg.clone());
        }
    }
    
    deep_links
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Create shared state for OpenCode server
    let opencode_server_state: SharedOpenCodeServerState =
        Arc::new(Mutex::new(OpenCodeServerState::default()));
    let opencode_server_state_clone = opencode_server_state.clone();

    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_store::Builder::new().build())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        // Single instance plugin - ensures only one instance runs
        // When a second instance is launched, it passes args to the first instance
        .plugin(tauri_plugin_single_instance::init(|app, args, _cwd| {
            // Focus the main window
            if let Some(window) = app.get_webview_window("main") {
                let _ = window.set_focus();
            }
            
            // Check for deep link URLs in args and emit them to the frontend
            for arg in args.iter().skip(1) {
                if arg.starts_with("onyx://") {
                    let _ = app.emit("deep-link-received", arg.clone());
                }
            }
        }));

    // Mobile-only plugins
    #[cfg(mobile)]
    {
        builder = builder
            .plugin(tauri_plugin_haptics::init())
            .plugin(tauri_plugin_biometric::init());
    }

    builder
        .manage(Arc::new(Mutex::new(PtyState::default())) as SharedPtyState)
        .manage(Arc::new(Mutex::new(WatcherState::default())) as SharedWatcherState)
        .manage(opencode_server_state)
        // Clean up OpenCode server on app exit
        .on_window_event(move |_window, event| {
            if let tauri::WindowEvent::Destroyed = event {
                let mut server_state = opencode_server_state_clone.lock();
                if let Some(ref mut child) = server_state.process {
                    let _ = child.kill();
                    let _ = child.wait();
                }
                server_state.process = None;
                server_state.port = None;
            }
        })
        // Register asset protocol to serve local files
        .register_uri_scheme_protocol("asset", |_app, request| {
            let path = request.uri().path();
            // URL decode the path
            let decoded_path = percent_decode_str(path).decode_utf8_lossy().to_string();
            // On Windows, path might start with / before drive letter, remove it
            #[cfg(target_os = "windows")]
            let decoded_path = if decoded_path.starts_with('/')
                && decoded_path.len() > 2
                && decoded_path.chars().nth(2) == Some(':')
            {
                decoded_path[1..].to_string()
            } else {
                decoded_path
            };
            
            // Security: Reject paths with traversal sequences
            if decoded_path.contains("..") {
                return tauri::http::Response::builder()
                    .status(403)
                    .header("Content-Type", "text/plain")
                    .body("Access denied: path traversal detected".as_bytes().to_vec())
                    .unwrap();
            }
            
            // Security: Canonicalize path and verify it doesn't escape expected directories
            let path_obj = Path::new(&decoded_path);
            let canonical = match path_obj.canonicalize() {
                Ok(p) => p,
                Err(_) => {
                    return tauri::http::Response::builder()
                        .status(404)
                        .body(Vec::new())
                        .unwrap();
                }
            };
            
            // Only allow access to files (not directories) and common media/document types
            if !canonical.is_file() {
                return tauri::http::Response::builder()
                    .status(403)
                    .header("Content-Type", "text/plain")
                    .body("Access denied: not a file".as_bytes().to_vec())
                    .unwrap();
            }

            match fs::read(&canonical) {
                Ok(data) => {
                    // Determine MIME type based on extension
                    let mime = match Path::new(&decoded_path)
                        .extension()
                        .and_then(|e| e.to_str())
                    {
                        Some("png") => "image/png",
                        Some("jpg") | Some("jpeg") => "image/jpeg",
                        Some("gif") => "image/gif",
                        Some("webp") => "image/webp",
                        Some("svg") => "image/svg+xml",
                        Some("bmp") => "image/bmp",
                        Some("avif") => "image/avif",
                        Some("mp3") => "audio/mpeg",
                        Some("wav") => "audio/wav",
                        Some("ogg") => "audio/ogg",
                        Some("flac") => "audio/flac",
                        Some("m4a") => "audio/mp4",
                        Some("webm") => "video/webm",
                        Some("mp4") => "video/mp4",
                        Some("mkv") => "video/x-matroska",
                        Some("mov") => "video/quicktime",
                        Some("ogv") => "video/ogg",
                        Some("pdf") => "application/pdf",
                        _ => "application/octet-stream",
                    };
                    tauri::http::Response::builder()
                        .status(200)
                        .header("Content-Type", mime)
                        .header("Access-Control-Allow-Origin", "tauri://localhost")
                        .body(data)
                        .unwrap()
                }
                Err(_) => tauri::http::Response::builder()
                    .status(404)
                    .body(Vec::new())
                    .unwrap(),
            }
        })
        .setup(|app| {
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_files,
            list_assets,
            read_file,
            write_file,
            write_binary_file,
            read_binary_file,
            create_file,
            create_folder,
            get_file_modified_time,
            file_exists,
            delete_file,
            rename_file,
            copy_file,
            open_in_default_app,
            show_in_folder,
            search_files,
            get_file_stats,
            run_terminal_command,
            start_opencode_server,
            stop_opencode_server,
            is_opencode_server_managed,
            pty::spawn_pty,
            pty::write_pty,
            pty::resize_pty,
            pty::kill_pty,
            load_settings,
            save_settings,
            keyring_commands::keyring_set,
            keyring_commands::keyring_get,
            keyring_commands::keyring_delete,
            start_watching,
            stop_watching,
            skill_is_installed,
            skill_save_file,
            skill_delete,
            skill_list_installed,
            skill_read_file,
            skill_import_zip,
            fetch_skills_sh,
            fetch_skill_file,
            get_platform_info,
            opencode_installer::check_opencode_installed,
            opencode_installer::get_opencode_install_path,
            opencode_installer::install_opencode,
            opencode_installer::get_opencode_version,
            get_deep_link_args,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
