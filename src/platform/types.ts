// Platform adapter — type definitions
//
// This module is the single source of truth for the boundary between the
// SolidJS UI and platform-specific code (Tauri commands today, browser APIs
// on web). Implementations live in src/platform/{tauri,web}/. Vite resolves
// the `@platform` alias to one of those at build time based on BUILD_TARGET.

export type PlatformName = 'web' | 'android' | 'ios' | 'macos' | 'windows' | 'linux';

export interface PlatformCapabilities {
  filesystemWatch: boolean;
  nativeDialog: boolean;
  systemKeyring: boolean;
  openCodeLocal: boolean;
  openCodeRemote: boolean;
  ptyLocal: boolean;
  ptyRemote: boolean;
  shellOpen: boolean;
  haptics: boolean;
  biometric: boolean;
  notifications: boolean;
  deepLinkScheme: boolean;
  pushNotifications: boolean;
}

export interface PlatformInfo {
  platform: PlatformName;
  default_vault_path: string | null;
  is_web: boolean;
  capabilities: PlatformCapabilities;
}

// ---------- Vault filesystem ----------

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileEntry[];
}

export interface AssetEntry {
  name: string;
  path: string;
  extension: string;
  relative_path: string;
}

export interface FileStats {
  size: number;
  created: number;
  modified: number;
}

export interface VaultFS {
  list(vaultPath: string): Promise<FileEntry[]>;
  listAssets(vaultPath: string): Promise<AssetEntry[]>;
  read(path: string, vaultPath: string): Promise<string>;
  readBinary(path: string, vaultPath: string): Promise<Uint8Array>;
  write(path: string, content: string, vaultPath: string): Promise<void>;
  writeBinary(path: string, data: Uint8Array, vaultPath: string): Promise<void>;
  createFile(path: string, vaultPath: string): Promise<void>;
  createFolder(path: string, vaultPath: string): Promise<void>;
  rename(oldPath: string, newPath: string, vaultPath: string): Promise<void>;
  remove(path: string, vaultPath: string): Promise<void>;
  copy(source: string, dest: string, vaultPath: string): Promise<void>;
  exists(path: string): Promise<boolean>;
  modifiedTime(path: string): Promise<number>;
  stats(path: string): Promise<FileStats>;
  setVaultScope(vaultPath: string): Promise<void>;
  startWatching(vaultPath: string): Promise<void>;
  stopWatching(): Promise<void>;
  onFilesChanged(cb: () => void): Promise<() => void>;
  onFileModified(cb: (paths: string[]) => void): Promise<() => void>;
}

// ---------- Assets ----------

export interface Assets {
  resolveAssetUrl(absolutePath: string): string | Promise<string>;
  revokeAssetUrl?(url: string): void;
}

// ---------- Secret store ----------

export interface SecretStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
  unlock?(passphrase: string): Promise<void>;
  isLocked?(): boolean;
}

// ---------- Settings ----------

export interface AppSettings {
  vault_path?: string | null;
  show_terminal?: boolean;
}

export interface Settings {
  load(): Promise<AppSettings>;
  save(settings: AppSettings): Promise<void>;
}

// ---------- Search ----------

export interface SearchMatch {
  line: number;
  content: string;
}

export interface SearchResult {
  path: string;
  name: string;
  matches: SearchMatch[];
}

export interface Search {
  searchVault(vaultPath: string, query: string): Promise<SearchResult[]>;
}

// ---------- Dialog ----------

export interface DialogOpenOptions {
  multiple?: boolean;
  directory?: boolean;
  filters?: Array<{ name: string; extensions: string[] }>;
  defaultPath?: string;
  title?: string;
}

export interface Dialog {
  open(options?: DialogOpenOptions): Promise<string | string[] | null>;
  // Reads the text contents of a user-picked file from outside the vault.
  // On web, this is implemented via a File object captured during pick.
  readTextFile(path: string): Promise<string>;
  // Writes a text file to an absolute path outside the vault scope
  // (e.g. shared-documents directory). On web this is a no-op or uses
  // the File System Access API where available.
  writeTextFile(path: string, content: string): Promise<void>;
  // Recursive mkdir for paths outside the vault.
  mkdir(path: string, recursive?: boolean): Promise<void>;
  // Existence check for paths outside the vault.
  pathExists(path: string): Promise<boolean>;
}

// ---------- Clipboard ----------

export interface ClipboardImage {
  rgba: Uint8Array;
  width: number;
  height: number;
}

export interface Clipboard {
  readText(): Promise<string>;
  writeText(text: string): Promise<void>;
  readImage(): Promise<ClipboardImage | null>;
}

// ---------- Deep link ----------

export interface DeepLink {
  onOpenUrl(cb: (urls: string[]) => void): Promise<() => void>;
  getCurrent(): Promise<string[] | null>;
  getLaunchArgs(): Promise<string[]>;
  onReceived(cb: (url: string) => void): Promise<() => void>;
}

// ---------- Shell ----------

export interface Shell {
  openInDefaultApp(path: string): Promise<void>;
  showInFolder(path: string): Promise<void>;
  openExternal(url: string): Promise<void>;
}

// ---------- Notifications / haptics / biometric ----------

export interface Notifications {
  isPermissionGranted(): Promise<boolean>;
  requestPermission(): Promise<boolean>;
  send(title: string, body?: string): Promise<void>;
}

export type HapticImpactStyle = 'light' | 'medium' | 'heavy';
export type HapticNotificationStyle = 'success' | 'warning' | 'error';

export interface Haptics {
  impact(style: HapticImpactStyle): Promise<void>;
  notification(style: HapticNotificationStyle): Promise<void>;
  selection(): Promise<void>;
  vibrate(durationMs: number): Promise<void>;
}

export interface BiometricStatus {
  isAvailable: boolean;
  biometryType?: string;
  error?: string;
}

export interface Biometric {
  checkStatus(): Promise<BiometricStatus>;
  authenticate(reason: string): Promise<boolean>;
}

// ---------- OpenCode / PTY ----------

export interface StartOpenCodeOptions {
  command: string;
  cwd?: string;
  port: number;
}

export interface OpenCodeInstallProgress {
  stage: string;
  progress: number;
  bytes_downloaded?: number;
  total_bytes?: number;
  message: string;
}

export interface PtySpawnOptions {
  command: string;
  cwd?: string;
  cols: number;
  rows: number;
}

export interface OpenCode {
  isInstalled(): Promise<string | null>;
  getInstallPath(): Promise<string>;
  install(onProgress?: (p: OpenCodeInstallProgress) => void): Promise<string>;
  getVersion(): Promise<string>;

  registerPath(path: string): Promise<string>;
  getRegisteredPath(): Promise<string | null>;

  startServer(opts: StartOpenCodeOptions): Promise<void>;
  stopServer(): Promise<void>;
  isServerManaged(): Promise<boolean>;

  spawnPty(opts: PtySpawnOptions): Promise<string>;
  writePty(sessionId: string, data: string): Promise<void>;
  resizePty(sessionId: string, cols: number, rows: number): Promise<void>;
  killPty(sessionId: string): Promise<void>;
  onPtyOutput(sessionId: string, cb: (chunk: string) => void): Promise<() => void>;
  onPtyExit(sessionId: string, cb: () => void): Promise<() => void>;
}

// ---------- AI provider proxy (CORS bypass on Tauri, direct/CORS-worker on web) ----------

export interface AIProviderProxy {
  customProviderRequest(url: string, apiKey: string, body: string): Promise<string>;
  customProviderStream(
    requestId: string,
    url: string,
    apiKey: string,
    body: string,
  ): Promise<void>;
  customProviderListModels(url: string, apiKey: string): Promise<string>;
  onCustomProviderChunk(
    requestId: string,
    cb: (chunk: string) => void,
  ): Promise<() => void>;

  openClawRequest(url: string, token: string, body: string): Promise<string>;
  openClawStream(
    requestId: string,
    url: string,
    token: string,
    body: string,
  ): Promise<void>;
  onOpenClawChunk(
    requestId: string,
    cb: (chunk: string) => void,
  ): Promise<() => void>;

  openClawGatewayRequest(
    wsUrl: string,
    token: string,
    method: string,
    params: string,
  ): Promise<string>;
}

// ---------- Skills ----------

export interface Skills {
  isInstalled(skillId: string): Promise<boolean>;
  listInstalled(): Promise<string[]>;
  saveFile(skillId: string, fileName: string, content: string): Promise<void>;
  readFile(skillId: string, fileName: string): Promise<string>;
  remove(skillId: string): Promise<void>;
  importZip(zipPath: string): Promise<string>;
  fetchSkillsSh(pages?: number): Promise<string>;
  fetchSkillFile(url: string): Promise<string>;
}

// ---------- Misc app surfaces ----------

export interface BackButtonEvent {
  canGoBack: boolean;
}

export interface AppLifecycle {
  getVersion(): Promise<string>;
  onBackButton(
    cb: (event: BackButtonEvent) => Promise<boolean | void> | boolean | void,
  ): Promise<() => void>;
}

// ---------- Composed adapter ----------

export interface PlatformAdapter {
  info: PlatformInfo;
  refreshInfo(): Promise<PlatformInfo>;
  vault: VaultFS;
  assets: Assets;
  secrets: SecretStore;
  settings: Settings;
  search: Search;
  dialog: Dialog;
  clipboard: Clipboard;
  deepLink: DeepLink;
  shell: Shell;
  notifications: Notifications;
  haptics: Haptics;
  biometric: Biometric;
  opencode: OpenCode;
  ai: AIProviderProxy;
  skills: Skills;
  app: AppLifecycle;
}
