use serde::{Deserialize, Serialize};
use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::Arc;
use std::thread;
use std::time::Duration;
use walkdir::WalkDir;
use parking_lot::Mutex;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::{AppHandle, Emitter};
use keyring::Entry;
use notify::{Config, RecommendedWatcher, RecursiveMode, Watcher, EventKind};

#[derive(Debug, Serialize, Deserialize, Clone, Default)]
pub struct AppSettings {
    #[serde(default)]
    pub vault_path: Option<String>,
    #[serde(default)]
    pub show_terminal: bool,
}

fn get_config_dir() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| ".".to_string());
    PathBuf::from(home).join(".config").join("onyx")
}

fn get_settings_path() -> PathBuf {
    get_config_dir().join("settings.json")
}

#[tauri::command]
fn load_settings() -> Result<AppSettings, String> {
    let path = get_settings_path();
    if !path.exists() {
        return Ok(AppSettings::default());
    }
    let content = fs::read_to_string(&path).map_err(|e| e.to_string())?;
    serde_json::from_str(&content).map_err(|e| e.to_string())
}

#[tauri::command]
fn save_settings(settings: AppSettings) -> Result<(), String> {
    let config_dir = get_config_dir();
    fs::create_dir_all(&config_dir).map_err(|e| e.to_string())?;

    let path = get_settings_path();
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
fn read_file(path: String) -> Result<String, String> {
    fs::read_to_string(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_file(path: String, content: String) -> Result<(), String> {
    fs::write(&path, content).map_err(|e| e.to_string())
}

#[tauri::command]
fn create_file(path: String) -> Result<(), String> {
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
fn create_folder(path: String) -> Result<(), String> {
    fs::create_dir_all(&path).map_err(|e| e.to_string())
}

#[tauri::command]
fn delete_file(path: String) -> Result<(), String> {
    let path = Path::new(&path);
    if path.is_dir() {
        fs::remove_dir_all(path).map_err(|e| e.to_string())
    } else {
        fs::remove_file(path).map_err(|e| e.to_string())
    }
}

#[tauri::command]
fn rename_file(old_path: String, new_path: String) -> Result<(), String> {
    fs::rename(&old_path, &new_path).map_err(|e| e.to_string())
}

#[tauri::command]
fn copy_file(source: String, dest: String) -> Result<(), String> {
    let source_path = Path::new(&source);
    let dest_path = Path::new(&dest);

    if source_path.is_dir() {
        // Copy directory recursively
        copy_dir_recursive(source_path, dest_path).map_err(|e| e.to_string())
    } else {
        fs::copy(&source, &dest).map(|_| ()).map_err(|e| e.to_string())
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

#[tauri::command]
fn search_files(path: String, query: String) -> Result<Vec<SearchResult>, String> {
    let mut results: Vec<SearchResult> = Vec::new();
    let query_lower = query.to_lowercase();

    for entry in WalkDir::new(&path)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| {
            e.path().is_file()
                && e.path()
                    .extension()
                    .map(|ext| ext == "md")
                    .unwrap_or(false)
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

// PTY Session management
struct PtySession {
    writer: Box<dyn Write + Send>,
    _child: Box<dyn portable_pty::Child + Send + Sync>,
    master: Box<dyn portable_pty::MasterPty + Send>,
}

struct PtyState {
    sessions: std::collections::HashMap<String, PtySession>,
    counter: u32,
}

impl Default for PtyState {
    fn default() -> Self {
        Self {
            sessions: std::collections::HashMap::new(),
            counter: 0,
        }
    }
}

type SharedPtyState = Arc<Mutex<PtyState>>;

#[tauri::command]
fn spawn_pty(
    app: AppHandle,
    state: tauri::State<'_, SharedPtyState>,
    command: String,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
) -> Result<String, String> {
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
        let enhanced_path = format!(
            "{}:{}:/usr/local/bin",
            user_paths.join(":"),
            current_path
        );
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

    // Store session
    {
        let mut state = state.lock();
        state.sessions.insert(
            session_id.clone(),
            PtySession {
                writer,
                _child: child,
                master: pair.master,
            },
        );
    }

    Ok(session_id)
}

#[tauri::command]
fn write_pty(
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
fn resize_pty(
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
fn kill_pty(state: tauri::State<'_, SharedPtyState>, session_id: String) -> Result<(), String> {
    let mut state = state.lock();
    if state.sessions.remove(&session_id).is_some() {
        Ok(())
    } else {
        Err("Session not found".to_string())
    }
}

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
                let dominated_by_md = event.paths.iter().any(|p| {
                    p.extension().map(|e| e == "md").unwrap_or(false)
                });

                let dominated_by_dir = event.paths.iter().any(|p| p.is_dir());

                if dominated_by_md || dominated_by_dir {
                    match event.kind {
                        EventKind::Create(_) | EventKind::Modify(_) | EventKind::Remove(_) => {
                            let _ = app_clone.emit("files-changed", ());
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

// Keyring commands for secure credential storage
const KEYRING_SERVICE: &str = "com.onyx.app";

#[tauri::command]
fn keyring_set(key: String, value: String) -> Result<(), String> {
    let entry = Entry::new(KEYRING_SERVICE, &key).map_err(|e| e.to_string())?;
    entry.set_password(&value).map_err(|e| e.to_string())
}

#[tauri::command]
fn keyring_get(key: String) -> Result<Option<String>, String> {
    let entry = Entry::new(KEYRING_SERVICE, &key).map_err(|e| e.to_string())?;
    match entry.get_password() {
        Ok(password) => Ok(Some(password)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
fn keyring_delete(key: String) -> Result<(), String> {
    let entry = Entry::new(KEYRING_SERVICE, &key).map_err(|e| e.to_string())?;
    match entry.delete_credential() {
        Ok(()) => Ok(()),
        Err(keyring::Error::NoEntry) => Ok(()),
        Err(e) => Err(e.to_string()),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_fs::init())
        .manage(Arc::new(Mutex::new(PtyState::default())) as SharedPtyState)
        .manage(Arc::new(Mutex::new(WatcherState::default())) as SharedWatcherState)
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
            read_file,
            write_file,
            create_file,
            create_folder,
            delete_file,
            rename_file,
            copy_file,
            open_in_default_app,
            show_in_folder,
            search_files,
            run_terminal_command,
            spawn_pty,
            write_pty,
            resize_pty,
            kill_pty,
            load_settings,
            save_settings,
            keyring_set,
            keyring_get,
            keyring_delete,
            start_watching,
            stop_watching,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
