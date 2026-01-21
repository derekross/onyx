import { Component, Show, createSignal, onMount, For } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';

interface LocalFileInfo {
  path: string;
  name: string;
  size: number;
  created: number;
  modified: number;
  extension: string;
}

interface RemoteFileInfo {
  eventId: string;
  d: string;
  checksum: string;
  version: number;
  modified: number;
  naddr: string;
  relays: string[];
}

interface FileInfoDialogProps {
  filePath: string;
  vaultPath: string;
  onClose: () => void;
  getRemoteInfo?: () => Promise<RemoteFileInfo | null>;
  onSyncFile?: () => Promise<RemoteFileInfo | null>;
  syncEnabled?: boolean;
}

const FileInfoDialog: Component<FileInfoDialogProps> = (props) => {
  const [localInfo, setLocalInfo] = createSignal<LocalFileInfo | null>(null);
  const [remoteInfo, setRemoteInfo] = createSignal<RemoteFileInfo | null>(null);
  const [isLoadingLocal, setIsLoadingLocal] = createSignal(true);
  const [isLoadingRemote, setIsLoadingRemote] = createSignal(true);
  const [isSyncing, setIsSyncing] = createSignal(false);
  const [syncError, setSyncError] = createSignal<string | null>(null);
  const [copiedField, setCopiedField] = createSignal<string | null>(null);

  onMount(async () => {
    // Fetch local file info
    try {
      const stats = await invoke<{
        size: number;
        created: number;
        modified: number;
      }>('get_file_stats', { path: props.filePath });
      
      const name = props.filePath.split('/').pop() || '';
      const extension = name.includes('.') ? name.split('.').pop() || '' : '';
      
      setLocalInfo({
        path: props.filePath,
        name,
        size: stats.size,
        created: stats.created,
        modified: stats.modified,
        extension,
      });
    } catch (err) {
      console.error('Failed to get local file info:', err);
    } finally {
      setIsLoadingLocal(false);
    }

    // Fetch remote sync info
    if (props.getRemoteInfo) {
      try {
        const info = await props.getRemoteInfo();
        setRemoteInfo(info);
      } catch (err) {
        console.error('Failed to get remote file info:', err);
      } finally {
        setIsLoadingRemote(false);
      }
    } else {
      setIsLoadingRemote(false);
    }
  });

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(2)} MB`;
  };

  const formatDate = (timestamp: number): string => {
    const date = new Date(timestamp * 1000);
    return date.toLocaleString(undefined, {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getRelativePath = (): string => {
    if (!props.vaultPath) return props.filePath;
    return props.filePath.replace(props.vaultPath + '/', '');
  };

  const copyToClipboard = async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  const getFileIcon = () => {
    const ext = localInfo()?.extension.toLowerCase();
    if (ext === 'md') return 'M12 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8';
    return 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6';
  };

  const handleSyncNow = async () => {
    if (!props.onSyncFile) return;
    
    setIsSyncing(true);
    setSyncError(null);
    
    try {
      const info = await props.onSyncFile();
      if (info) {
        setRemoteInfo(info);
      } else {
        setSyncError('Sync completed but no remote info returned');
      }
    } catch (err) {
      console.error('Failed to sync file:', err);
      setSyncError(err instanceof Error ? err.message : 'Sync failed');
    } finally {
      setIsSyncing(false);
    }
  };

  return (
    <div class="modal-overlay" onClick={props.onClose}>
      <div class="modal-dialog file-info-dialog" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h3>File Information</h3>
          <button class="modal-close" onClick={props.onClose}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <div class="modal-body file-info-content">
          {/* Local File Section */}
          <div class="file-info-section">
            <div class="file-info-section-header">
              <div class="file-info-section-icon local">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                  <line x1="3" y1="9" x2="21" y2="9"></line>
                  <line x1="9" y1="21" x2="9" y2="9"></line>
                </svg>
              </div>
              <div class="file-info-section-title">
                <span>Local File</span>
                <span class="file-info-section-subtitle">Stored on this device</span>
              </div>
            </div>

            <Show when={isLoadingLocal()}>
              <div class="file-info-loading">
                <div class="spinner small"></div>
                <span>Loading file info...</span>
              </div>
            </Show>

            <Show when={!isLoadingLocal() && localInfo()}>
              {/* File Preview Header */}
              <div class="file-info-preview">
                <div class="file-info-preview-icon">
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d={getFileIcon()}></path>
                  </svg>
                </div>
                <div class="file-info-preview-details">
                  <div class="file-info-filename">{localInfo()!.name.replace(/\.md$/i, '')}</div>
                  <div class="file-info-meta">
                    <span class="file-info-type">{localInfo()!.extension.toUpperCase()}</span>
                    <span class="file-info-size">{formatSize(localInfo()!.size)}</span>
                  </div>
                </div>
              </div>

              {/* File Details Grid */}
              <div class="file-info-grid">
                <div class="file-info-item">
                  <div class="file-info-item-label">Location</div>
                  <div class="file-info-item-value file-info-path">
                    <span title={props.filePath}>{getRelativePath()}</span>
                    <button 
                      class="file-info-copy-btn" 
                      onClick={() => copyToClipboard(props.filePath, 'path')}
                      title="Copy full path"
                    >
                      <Show when={copiedField() === 'path'} fallback={
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
                      }>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <polyline points="20 6 9 17 4 12"></polyline>
                        </svg>
                      </Show>
                    </button>
                  </div>
                </div>
                <div class="file-info-item">
                  <div class="file-info-item-label">Created</div>
                  <div class="file-info-item-value">{formatDate(localInfo()!.created)}</div>
                </div>
                <div class="file-info-item">
                  <div class="file-info-item-label">Modified</div>
                  <div class="file-info-item-value">{formatDate(localInfo()!.modified)}</div>
                </div>
              </div>
            </Show>
          </div>

          {/* Divider */}
          <div class="file-info-divider"></div>

          {/* Cloud Sync Section */}
          <div class="file-info-section">
            <div class="file-info-section-header">
              <div class={`file-info-section-icon cloud ${remoteInfo() ? 'synced' : 'not-synced'}`}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path>
                </svg>
              </div>
              <div class="file-info-section-title">
                <span>Nostr Sync</span>
                <span class="file-info-section-subtitle">
                  <Show when={isLoadingRemote()}>Checking sync status...</Show>
                  <Show when={!isLoadingRemote() && remoteInfo()}>Synced to relays</Show>
                  <Show when={!isLoadingRemote() && !remoteInfo()}>Not synced</Show>
                </span>
              </div>
              <Show when={!isLoadingRemote()}>
                <div class={`file-info-sync-badge ${remoteInfo() ? 'synced' : 'not-synced'}`}>
                  <Show when={remoteInfo()}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                      <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                    Synced
                  </Show>
                  <Show when={!remoteInfo()}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <circle cx="12" cy="12" r="10"></circle>
                      <line x1="15" y1="9" x2="9" y2="15"></line>
                      <line x1="9" y1="9" x2="15" y2="15"></line>
                    </svg>
                    Local Only
                  </Show>
                </div>
              </Show>
            </div>

            <Show when={isLoadingRemote()}>
              <div class="file-info-loading">
                <div class="spinner small"></div>
                <span>Checking sync status...</span>
              </div>
            </Show>

            <Show when={!isLoadingRemote() && !remoteInfo() && !isSyncing()}>
              <div class="file-info-empty-state">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path>
                  <line x1="12" y1="14" x2="12" y2="17"></line>
                  <line x1="12" y1="11" x2="12.01" y2="11"></line>
                </svg>
                <p>This file hasn't been synced to Nostr relays yet.</p>
                <Show when={props.syncEnabled && props.onSyncFile} fallback={
                  <span class="file-info-empty-hint">Enable sync in Settings to back up your notes.</span>
                }>
                  <button class="file-info-sync-btn" onClick={handleSyncNow}>
                    Sync Now
                  </button>
                </Show>
                <Show when={syncError()}>
                  <span class="file-info-sync-error">{syncError()}</span>
                </Show>
              </div>
            </Show>

            <Show when={isSyncing()}>
              <div class="file-info-loading">
                <div class="spinner small"></div>
                <span>Syncing to Nostr...</span>
              </div>
            </Show>

            <Show when={!isLoadingRemote() && remoteInfo()}>
              <div class="file-info-grid">
                <Show when={remoteInfo()!.naddr}>
                  <div class="file-info-item full-width">
                    <div class="file-info-item-label">Nostr Address (naddr)</div>
                    <div class="file-info-item-value file-info-mono">
                      <span>{remoteInfo()!.naddr.slice(0, 24)}...{remoteInfo()!.naddr.slice(-8)}</span>
                      <button 
                        class="file-info-copy-btn" 
                        onClick={() => copyToClipboard(remoteInfo()!.naddr, 'naddr')}
                        title="Copy naddr"
                      >
                        <Show when={copiedField() === 'naddr'} fallback={
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                            <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                          </svg>
                        }>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="20 6 9 17 4 12"></polyline>
                          </svg>
                        </Show>
                      </button>
                    </div>
                  </div>
                </Show>
                <div class="file-info-item">
                  <div class="file-info-item-label">Version</div>
                  <div class="file-info-item-value">
                    <span class="file-info-version-badge">v{remoteInfo()!.version}</span>
                  </div>
                </div>
                <div class="file-info-item">
                  <div class="file-info-item-label">Last Synced</div>
                  <div class="file-info-item-value">{formatDate(remoteInfo()!.modified)}</div>
                </div>
                <div class="file-info-item">
                  <div class="file-info-item-label">Checksum</div>
                  <div class="file-info-item-value file-info-mono">
                    <span>{remoteInfo()!.checksum.slice(0, 12)}...</span>
                    <button 
                      class="file-info-copy-btn" 
                      onClick={() => copyToClipboard(remoteInfo()!.checksum, 'checksum')}
                      title="Copy checksum"
                    >
                      <Show when={copiedField() === 'checksum'} fallback={
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
                      }>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <polyline points="20 6 9 17 4 12"></polyline>
                        </svg>
                      </Show>
                    </button>
                  </div>
                </div>
                <div class="file-info-item full-width">
                  <div class="file-info-item-label">Relays</div>
                  <div class="file-info-item-value file-info-relays">
                    <For each={remoteInfo()!.relays}>
                      {(relay) => (
                        <span class="file-info-relay-tag" title={relay}>
                          <svg width="10" height="10" viewBox="0 0 24 24" fill="currentColor">
                            <circle cx="12" cy="12" r="4"></circle>
                          </svg>
                          {relay.replace('wss://', '').replace(/\/$/, '')}
                        </span>
                      )}
                    </For>
                  </div>
                </div>
              </div>
            </Show>
          </div>
        </div>

        <div class="modal-footer">
          <button class="setting-button" onClick={props.onClose}>Done</button>
        </div>
      </div>
    </div>
  );
};

export default FileInfoDialog;
