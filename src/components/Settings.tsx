import { Component, createSignal, createEffect, For, Show, onMount, onCleanup } from 'solid-js';
import { QRCodeSVG } from 'qrcode.react';
import {
  getSyncEngine,
  type NostrIdentity,
  type SyncConfig,
  DEFAULT_SYNC_CONFIG,
  // Login functions
  generateNewLogin,
  importNsecLogin,
  generateNostrConnectParams,
  buildNostrConnectUri,
  waitForNostrConnect,
  fetchUserRelays,
  fetchUserBlossomServers,
  fetchUserProfile,
  saveLogin,
  getLogins,
  getCurrentLogin,
  removeLogin,
  getIdentityFromLogin,
  saveUserProfile,
  getSavedProfile,
  type StoredLogin,
  type NostrConnectParams,
  type RelayEntry,
  type UserProfile,
} from '../lib/nostr';

type SettingsSection = 'general' | 'editor' | 'files' | 'appearance' | 'hotkeys' | 'sync' | 'nostr' | 'about';
type LoginTab = 'generate' | 'import' | 'connect';

interface SettingsProps {
  onClose: () => void;
}

interface SettingsSectionItem {
  id: SettingsSection;
  label: string;
  icon: string;
}

interface RelayInfo {
  url: string;
  read: boolean;
  write: boolean;
}

const sections: SettingsSectionItem[] = [
  { id: 'general', label: 'General', icon: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5' },
  { id: 'editor', label: 'Editor', icon: 'M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z' },
  { id: 'files', label: 'Files & Links', icon: 'M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z M14 2v6h6 M10 12l2 2 4-4' },
  { id: 'appearance', label: 'Appearance', icon: 'M12 2v4 M12 18v4 M4.93 4.93l2.83 2.83 M16.24 16.24l2.83 2.83 M2 12h4 M18 12h4 M4.93 19.07l2.83-2.83 M16.24 7.76l2.83-2.83' },
  { id: 'hotkeys', label: 'Hotkeys', icon: 'M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z' },
  { id: 'sync', label: 'Sync', icon: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8 M21 3v5h-5' },
  { id: 'nostr', label: 'Nostr', icon: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' },
  { id: 'about', label: 'About', icon: 'M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z M12 16v-4 M12 8h.01' },
];

const Settings: Component<SettingsProps> = (props) => {
  const [activeSection, setActiveSection] = createSignal<SettingsSection>('general');

  // Login state
  const [currentLogin, setCurrentLogin] = createSignal<StoredLogin | null>(null);
  const [identity, setIdentity] = createSignal<NostrIdentity | null>(null);
  const [userProfile, setUserProfile] = createSignal<UserProfile | null>(null);
  const [loginTab, setLoginTab] = createSignal<LoginTab>('connect');
  const [showPrivateKey, setShowPrivateKey] = createSignal(false);
  const [importKeyInput, setImportKeyInput] = createSignal('');
  const [keyError, setKeyError] = createSignal<string | null>(null);
  const [loginLoading, setLoginLoading] = createSignal(false);

  // Nostr Connect state
  const [connectParams, setConnectParams] = createSignal<NostrConnectParams | null>(null);
  const [connectUri, setConnectUri] = createSignal<string>('');
  const [connectStatus, setConnectStatus] = createSignal<'idle' | 'waiting' | 'success' | 'error'>('idle');
  const [connectError, setConnectError] = createSignal<string | null>(null);

  // Relay state (now with read/write permissions)
  const [relays, setRelays] = createSignal<RelayInfo[]>(
    DEFAULT_SYNC_CONFIG.relays.map(url => ({ url, read: true, write: true }))
  );
  const [newRelayUrl, setNewRelayUrl] = createSignal('');

  // Blossom state
  const [blossomServers, setBlossomServers] = createSignal<string[]>(
    DEFAULT_SYNC_CONFIG.blossomServers
  );
  const [newBlossomUrl, setNewBlossomUrl] = createSignal('');

  // Sync state
  const [syncEnabled, setSyncEnabled] = createSignal(false);

  // Load saved login on mount
  onMount(() => {
    const login = getCurrentLogin();
    if (login) {
      setCurrentLogin(login);

      // Get identity if it's an nsec login
      const ident = getIdentityFromLogin(login);
      if (ident) {
        setIdentity(ident);
        // Set identity on sync engine
        const engine = getSyncEngine();
        engine.setIdentity(ident);
      }

      // Load saved profile
      const savedProfile = getSavedProfile();
      if (savedProfile) {
        setUserProfile(savedProfile);
      }
    }

    const savedRelays = localStorage.getItem('nostr_relays');
    if (savedRelays) {
      try {
        const parsed = JSON.parse(savedRelays);
        // Handle both old format (string[]) and new format (RelayInfo[])
        if (typeof parsed[0] === 'string') {
          setRelays(parsed.map((url: string) => ({ url, read: true, write: true })));
        } else {
          setRelays(parsed);
        }
      } catch (e) {
        console.error('Failed to load saved relays:', e);
      }
    }

    const savedBlossom = localStorage.getItem('blossom_servers');
    if (savedBlossom) {
      try {
        setBlossomServers(JSON.parse(savedBlossom));
      } catch (e) {
        console.error('Failed to load saved blossom servers:', e);
      }
    }

    const savedSyncEnabled = localStorage.getItem('sync_enabled');
    if (savedSyncEnabled) {
      setSyncEnabled(savedSyncEnabled === 'true');
    }
  });

  // Fetch user profile, relays and blossom servers after login
  const fetchUserData = async (pubkey: string) => {
    const relayUrls = relays().map(r => r.url);

    try {
      // Fetch user profile (kind 0)
      const profile = await fetchUserProfile(pubkey, relayUrls);
      if (profile) {
        setUserProfile(profile);
        saveUserProfile(profile);
      }

      // Fetch NIP-65 relay list
      const userRelays = await fetchUserRelays(pubkey, relayUrls);
      if (userRelays.length > 0) {
        setRelays(userRelays);
        localStorage.setItem('nostr_relays', JSON.stringify(userRelays));

        // Update sync engine config
        const engine = getSyncEngine();
        engine.setConfig({ relays: userRelays.filter(r => r.write).map(r => r.url) });
      }

      // Fetch blossom servers
      const userBlossom = await fetchUserBlossomServers(pubkey, relayUrls);
      if (userBlossom.length > 0) {
        setBlossomServers(userBlossom);
        localStorage.setItem('blossom_servers', JSON.stringify(userBlossom));

        // Update sync engine config
        const engine = getSyncEngine();
        engine.setConfig({ blossomServers: userBlossom });
      }
    } catch (e) {
      console.error('Failed to fetch user data:', e);
    }
  };

  // Handle successful login
  const handleLoginSuccess = (login: StoredLogin, ident: NostrIdentity | null) => {
    setCurrentLogin(login);
    if (ident) {
      setIdentity(ident);
      const engine = getSyncEngine();
      engine.setIdentity(ident);
    }
    saveLogin(login);
    setKeyError(null);
    setLoginLoading(false);

    // Fetch user's relay list and blossom servers
    fetchUserData(login.pubkey);
  };

  // Generate new keypair
  const handleGenerateKey = () => {
    setLoginLoading(true);
    setKeyError(null);

    try {
      const { identity: newIdentity, login } = generateNewLogin();
      handleLoginSuccess(login, newIdentity);
    } catch (e) {
      setKeyError('Failed to generate key');
      setLoginLoading(false);
    }
  };

  // Import existing key (nsec)
  const handleImportKey = () => {
    const key = importKeyInput().trim();
    if (!key) {
      setKeyError('Please enter a key');
      return;
    }

    setLoginLoading(true);
    setKeyError(null);

    try {
      const { identity: imported, login } = importNsecLogin(key);
      handleLoginSuccess(login, imported);
      setImportKeyInput('');
    } catch (e) {
      setKeyError('Invalid key format. Please enter a valid nsec or hex private key.');
      setLoginLoading(false);
    }
  };

  // Initialize Nostr Connect
  const initNostrConnect = () => {
    const relayUrls = relays().map(r => r.url);
    const params = generateNostrConnectParams(relayUrls);
    const uri = buildNostrConnectUri(params, 'Onyx');

    setConnectParams(params);
    setConnectUri(uri);
    setConnectStatus('idle');
    setConnectError(null);
  };

  // Start waiting for Nostr Connect
  const startNostrConnect = async () => {
    const params = connectParams();
    if (!params) {
      initNostrConnect();
      return;
    }

    setConnectStatus('waiting');
    setConnectError(null);

    try {
      const login = await waitForNostrConnect(params, 120000);
      setConnectStatus('success');
      handleLoginSuccess(login, null);
    } catch (e) {
      setConnectStatus('error');
      setConnectError(e instanceof Error ? e.message : 'Connection failed');
    }
  };

  // Retry Nostr Connect with new parameters
  const retryNostrConnect = () => {
    initNostrConnect();
    setConnectStatus('idle');
  };

  // Logout
  const handleLogout = () => {
    const login = currentLogin();
    if (login) {
      removeLogin(login.id);
    }
    setCurrentLogin(null);
    setIdentity(null);
    setUserProfile(null);
    setConnectParams(null);
    setConnectUri('');
    setConnectStatus('idle');
    // Clear profile from storage
    localStorage.removeItem('onyx:profile');
  };

  // Initialize connect params when switching to connect tab
  createEffect(() => {
    if (loginTab() === 'connect' && !connectParams()) {
      initNostrConnect();
    }
  });

  // Copy to clipboard
  const copyToClipboard = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text);
    } catch (e) {
      console.error('Failed to copy:', e);
    }
  };

  // Add relay
  const handleAddRelay = () => {
    const url = newRelayUrl().trim();
    if (!url) return;

    // Basic validation
    if (!url.startsWith('wss://') && !url.startsWith('ws://')) {
      return;
    }

    // Check for duplicates
    if (relays().some(r => r.url === url)) {
      return;
    }

    const updated = [...relays(), { url, connected: false }];
    setRelays(updated);
    setNewRelayUrl('');

    // Save to localStorage
    localStorage.setItem('nostr_relays', JSON.stringify(updated.map(r => r.url)));

    // Update sync engine config
    const engine = getSyncEngine();
    engine.setConfig({ relays: updated.map(r => r.url) });
  };

  // Remove relay
  const handleRemoveRelay = (url: string) => {
    const updated = relays().filter(r => r.url !== url);
    setRelays(updated);

    // Save to localStorage
    localStorage.setItem('nostr_relays', JSON.stringify(updated.map(r => r.url)));

    // Update sync engine config
    const engine = getSyncEngine();
    engine.setConfig({ relays: updated.map(r => r.url) });
  };

  // Add blossom server
  const handleAddBlossom = () => {
    const url = newBlossomUrl().trim();
    if (!url) return;

    // Basic validation
    if (!url.startsWith('https://') && !url.startsWith('http://')) {
      return;
    }

    // Check for duplicates
    if (blossomServers().includes(url)) {
      return;
    }

    const updated = [...blossomServers(), url];
    setBlossomServers(updated);
    setNewBlossomUrl('');

    // Save to localStorage
    localStorage.setItem('blossom_servers', JSON.stringify(updated));

    // Update sync engine config
    const engine = getSyncEngine();
    engine.setConfig({ blossomServers: updated });
  };

  // Remove blossom server
  const handleRemoveBlossom = (url: string) => {
    const updated = blossomServers().filter(u => u !== url);
    setBlossomServers(updated);

    // Save to localStorage
    localStorage.setItem('blossom_servers', JSON.stringify(updated));

    // Update sync engine config
    const engine = getSyncEngine();
    engine.setConfig({ blossomServers: updated });
  };

  // Toggle sync enabled
  const handleSyncToggle = (enabled: boolean) => {
    setSyncEnabled(enabled);
    localStorage.setItem('sync_enabled', enabled.toString());

    const engine = getSyncEngine();
    engine.setConfig({ enabled });
  };

  const handleOverlayClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget) {
      props.onClose();
    }
  };

  return (
    <div class="settings-overlay" onClick={handleOverlayClick}>
      <div class="settings-modal">
        {/* Settings Sidebar */}
        <div class="settings-sidebar">
          <div class="settings-sidebar-header">Settings</div>
          <div class="settings-nav">
            <For each={sections}>
              {(section) => (
                <button
                  class={`settings-nav-item ${activeSection() === section.id ? 'active' : ''}`}
                  onClick={() => setActiveSection(section.id)}
                >
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d={section.icon}></path>
                  </svg>
                  <span>{section.label}</span>
                </button>
              )}
            </For>
          </div>
        </div>

        {/* Settings Content */}
        <div class="settings-content">
          <div class="settings-content-header">
            <h2>{sections.find(s => s.id === activeSection())?.label}</h2>
            <button class="settings-close" onClick={props.onClose}>
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <line x1="18" y1="6" x2="6" y2="18"></line>
                <line x1="6" y1="6" x2="18" y2="18"></line>
              </svg>
            </button>
          </div>

          <div class="settings-content-body">
            {/* General Settings */}
            <Show when={activeSection() === 'general'}>
              <div class="settings-section">
                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Language</div>
                    <div class="setting-description">Select the display language for the interface</div>
                  </div>
                  <select class="setting-select">
                    <option value="en">English</option>
                  </select>
                </div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Auto-save</div>
                    <div class="setting-description">Automatically save files after changes</div>
                  </div>
                  <label class="setting-toggle">
                    <input type="checkbox" checked />
                    <span class="toggle-slider"></span>
                  </label>
                </div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Auto-save delay</div>
                    <div class="setting-description">Time in seconds before auto-saving</div>
                  </div>
                  <input type="number" class="setting-input" value="2" min="1" max="60" />
                </div>
              </div>
            </Show>

            {/* Editor Settings */}
            <Show when={activeSection() === 'editor'}>
              <div class="settings-section">
                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Font family</div>
                    <div class="setting-description">Font used in the editor</div>
                  </div>
                  <input type="text" class="setting-input wide" value="system-ui, sans-serif" />
                </div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Font size</div>
                    <div class="setting-description">Base font size in pixels</div>
                  </div>
                  <input type="number" class="setting-input" value="16" min="10" max="32" />
                </div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Line height</div>
                    <div class="setting-description">Line height multiplier</div>
                  </div>
                  <input type="number" class="setting-input" value="1.6" min="1" max="3" step="0.1" />
                </div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Show line numbers</div>
                    <div class="setting-description">Display line numbers in the editor</div>
                  </div>
                  <label class="setting-toggle">
                    <input type="checkbox" />
                    <span class="toggle-slider"></span>
                  </label>
                </div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Vim mode</div>
                    <div class="setting-description">Enable Vim keybindings in the editor</div>
                  </div>
                  <label class="setting-toggle">
                    <input type="checkbox" />
                    <span class="toggle-slider"></span>
                  </label>
                </div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Spell check</div>
                    <div class="setting-description">Enable spell checking</div>
                  </div>
                  <label class="setting-toggle">
                    <input type="checkbox" checked />
                    <span class="toggle-slider"></span>
                  </label>
                </div>
              </div>
            </Show>

            {/* Files & Links Settings */}
            <Show when={activeSection() === 'files'}>
              <div class="settings-section">
                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Default location for new notes</div>
                    <div class="setting-description">Where new notes are created</div>
                  </div>
                  <select class="setting-select">
                    <option value="root">Vault root</option>
                    <option value="current">Current folder</option>
                  </select>
                </div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">New link format</div>
                    <div class="setting-description">Format for created links</div>
                  </div>
                  <select class="setting-select">
                    <option value="shortest">Shortest path</option>
                    <option value="relative">Relative path</option>
                    <option value="absolute">Absolute path</option>
                  </select>
                </div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Use [[Wikilinks]]</div>
                    <div class="setting-description">Use wikilink syntax instead of markdown links</div>
                  </div>
                  <label class="setting-toggle">
                    <input type="checkbox" checked />
                    <span class="toggle-slider"></span>
                  </label>
                </div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Automatically update internal links</div>
                    <div class="setting-description">Update links when files are renamed or moved</div>
                  </div>
                  <label class="setting-toggle">
                    <input type="checkbox" checked />
                    <span class="toggle-slider"></span>
                  </label>
                </div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Attachment folder path</div>
                    <div class="setting-description">Where attachments are stored</div>
                  </div>
                  <input type="text" class="setting-input wide" value="attachments" />
                </div>
              </div>
            </Show>

            {/* Appearance Settings */}
            <Show when={activeSection() === 'appearance'}>
              <div class="settings-section">
                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Theme</div>
                    <div class="setting-description">Color theme for the application</div>
                  </div>
                  <select class="setting-select">
                    <option value="dark">Dark (Nostr Purple)</option>
                    <option value="light">Light</option>
                    <option value="system">System</option>
                  </select>
                </div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Accent color</div>
                    <div class="setting-description">Primary accent color</div>
                  </div>
                  <input type="color" class="setting-color" value="#8b5cf6" />
                </div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Interface font size</div>
                    <div class="setting-description">Font size for UI elements</div>
                  </div>
                  <select class="setting-select">
                    <option value="small">Small</option>
                    <option value="medium" selected>Medium</option>
                    <option value="large">Large</option>
                  </select>
                </div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Translucent window</div>
                    <div class="setting-description">Enable window translucency effects</div>
                  </div>
                  <label class="setting-toggle">
                    <input type="checkbox" />
                    <span class="toggle-slider"></span>
                  </label>
                </div>
              </div>
            </Show>

            {/* Hotkeys Settings */}
            <Show when={activeSection() === 'hotkeys'}>
              <div class="settings-section">
                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Quick switcher</div>
                    <div class="setting-description">Open file quick switcher</div>
                  </div>
                  <div class="hotkey-display">Ctrl + O</div>
                </div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Command palette</div>
                    <div class="setting-description">Open command palette</div>
                  </div>
                  <div class="hotkey-display">Ctrl + P</div>
                </div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Search in files</div>
                    <div class="setting-description">Search across all files</div>
                  </div>
                  <div class="hotkey-display">Ctrl + Shift + F</div>
                </div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Save file</div>
                    <div class="setting-description">Save current file</div>
                  </div>
                  <div class="hotkey-display">Ctrl + S</div>
                </div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Toggle terminal</div>
                    <div class="setting-description">Show/hide OpenCode terminal</div>
                  </div>
                  <div class="hotkey-display">Ctrl + `</div>
                </div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Close</div>
                    <div class="setting-description">Close modals and panels</div>
                  </div>
                  <div class="hotkey-display">Escape</div>
                </div>
              </div>
            </Show>

            {/* Sync Settings */}
            <Show when={activeSection() === 'sync'}>
              <div class="settings-section">
                <div class="settings-section-title">Sync Status</div>

                <Show when={!identity()}>
                  <div class="settings-notice warning">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                      <line x1="12" y1="9" x2="12" y2="13"></line>
                      <line x1="12" y1="17" x2="12.01" y2="17"></line>
                    </svg>
                    <p>You need to configure a Nostr identity before enabling sync. Go to the <button class="link-button" onClick={() => setActiveSection('nostr')}>Nostr settings</button> to generate or import keys.</p>
                  </div>
                </Show>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Enable sync</div>
                    <div class="setting-description">Sync this vault using Nostr relays</div>
                  </div>
                  <label class="setting-toggle">
                    <input
                      type="checkbox"
                      checked={syncEnabled()}
                      disabled={!identity()}
                      onChange={(e) => handleSyncToggle(e.currentTarget.checked)}
                    />
                    <span class="toggle-slider"></span>
                  </label>
                </div>

                <Show when={syncEnabled() && identity()}>
                  <div class="sync-status-display">
                    <div class="sync-status-indicator idle">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polyline points="20 6 9 17 4 12"></polyline>
                      </svg>
                      <span>Ready to sync</span>
                    </div>
                  </div>
                </Show>

                <div class="settings-notice">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="16" x2="12" y2="12"></line>
                    <line x1="12" y1="8" x2="12.01" y2="8"></line>
                  </svg>
                  <p>Sync is optional and disabled by default. Your notes are stored locally and can be synced using any method you prefer (Git, Dropbox, etc). Enable Nostr sync for encrypted, decentralized sync across devices.</p>
                </div>

                <div class="settings-section-title">Sync Options</div>
                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Sync on startup</div>
                    <div class="setting-description">Automatically sync when opening the vault</div>
                  </div>
                  <label class="setting-toggle">
                    <input type="checkbox" checked disabled={!syncEnabled()} />
                    <span class="toggle-slider"></span>
                  </label>
                </div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Sync frequency</div>
                    <div class="setting-description">How often to sync changes</div>
                  </div>
                  <select class="setting-select" disabled={!syncEnabled()}>
                    <option value="realtime">Real-time</option>
                    <option value="5min">Every 5 minutes</option>
                    <option value="manual">Manual only</option>
                  </select>
                </div>

                <Show when={syncEnabled()}>
                  <div class="settings-section-title">Actions</div>
                  <div class="setting-item">
                    <div class="setting-info">
                      <div class="setting-name">Manual sync</div>
                      <div class="setting-description">Sync all files now</div>
                    </div>
                    <button class="setting-button">Sync Now</button>
                  </div>
                </Show>
              </div>
            </Show>

            {/* Nostr Settings */}
            <Show when={activeSection() === 'nostr'}>
              <div class="settings-section">
                <div class="settings-section-title">Identity</div>

                {/* Logged in state */}
                <Show when={currentLogin()}>
                  <div class="login-info-card">
                    <div class="login-info-header">
                      <div class="login-avatar">
                        <Show when={userProfile()?.picture} fallback={
                          <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                            <circle cx="12" cy="7" r="4"></circle>
                          </svg>
                        }>
                          <img src={userProfile()!.picture} alt="Profile" class="login-avatar-img" />
                        </Show>
                      </div>
                      <div class="login-info-details">
                        <Show when={userProfile()?.displayName || userProfile()?.name} fallback={
                          <div class="login-name">Anonymous</div>
                        }>
                          <div class="login-name">{userProfile()?.displayName || userProfile()?.name}</div>
                        </Show>
                        <div class="login-meta">
                          <span class="login-type-badge">{currentLogin()!.type === 'bunker' ? 'Nostr Connect' : 'Local Key'}</span>
                          <Show when={userProfile()?.nip05}>
                            <span class="login-nip05">{userProfile()!.nip05}</span>
                          </Show>
                        </div>
                        <div class="login-pubkey">{currentLogin()!.pubkey.slice(0, 12)}...{currentLogin()!.pubkey.slice(-6)}</div>
                      </div>
                      <button class="setting-button secondary logout-btn" onClick={handleLogout}>Logout</button>
                    </div>

                    {/* Show key details for nsec logins */}
                    <Show when={identity()}>
                      <div class="login-key-details">
                        <div class="setting-item">
                          <div class="setting-info">
                            <div class="setting-name">Public key (npub)</div>
                          </div>
                          <div class="setting-key-display">
                            <code class="key-value">{identity()!.npub}</code>
                            <button class="key-action-btn" onClick={() => copyToClipboard(identity()!.npub)} title="Copy">
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                              </svg>
                            </button>
                          </div>
                        </div>
                        <div class="setting-item">
                          <div class="setting-info">
                            <div class="setting-name">Private key (nsec)</div>
                          </div>
                          <div class="setting-key-display">
                            <Show when={showPrivateKey()} fallback={<code class="key-value">••••••••••••••••••••••</code>}>
                              <code class="key-value">{identity()!.nsec}</code>
                            </Show>
                            <button class="key-action-btn" onClick={() => setShowPrivateKey(!showPrivateKey())} title={showPrivateKey() ? "Hide" : "Show"}>
                              <Show when={showPrivateKey()} fallback={
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                  <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                                  <circle cx="12" cy="12" r="3"></circle>
                                </svg>
                              }>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                  <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"></path>
                                  <line x1="1" y1="1" x2="23" y2="23"></line>
                                </svg>
                              </Show>
                            </button>
                            <button class="key-action-btn" onClick={() => copyToClipboard(identity()!.nsec)} title="Copy">
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                              </svg>
                            </button>
                          </div>
                        </div>
                      </div>
                    </Show>
                  </div>

                  <div class="settings-notice warning">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                      <line x1="12" y1="9" x2="12" y2="13"></line>
                      <line x1="12" y1="17" x2="12.01" y2="17"></line>
                    </svg>
                    <p>Your private key gives full access to your Nostr identity. Keep it safe and never share it with anyone!</p>
                  </div>
                </Show>

                {/* Not logged in - show login options */}
                <Show when={!currentLogin()}>
                  <div class="login-tabs">
                    <button class={`login-tab ${loginTab() === 'connect' ? 'active' : ''}`} onClick={() => setLoginTab('connect')}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
                        <line x1="3" y1="9" x2="21" y2="9"></line>
                        <line x1="9" y1="21" x2="9" y2="9"></line>
                      </svg>
                      Nostr Connect
                    </button>
                    <button class={`login-tab ${loginTab() === 'import' ? 'active' : ''}`} onClick={() => setLoginTab('import')}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                        <polyline points="7 10 12 15 17 10"></polyline>
                        <line x1="12" y1="15" x2="12" y2="3"></line>
                      </svg>
                      Import Key
                    </button>
                    <button class={`login-tab ${loginTab() === 'generate' ? 'active' : ''}`} onClick={() => setLoginTab('generate')}>
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="3"></circle>
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                      </svg>
                      Generate
                    </button>
                  </div>

                  <div class="login-tab-content">
                    {/* Nostr Connect Tab */}
                    <Show when={loginTab() === 'connect'}>
                      <div class="connect-content">
                        <p class="connect-description">
                          Scan this QR code with a Nostr signer app like <strong>Amber</strong>, <strong>Nostrudel</strong>, or <strong>nsec.app</strong> to login securely without exposing your private key.
                        </p>

                        <Show when={connectUri()}>
                          <div class="qr-container">
                            <Show when={connectStatus() === 'idle' || connectStatus() === 'error'}>
                              <QRCodeSVG
                                value={connectUri()}
                                size={200}
                                level="M"
                                includeMargin={false}
                                bgColor="transparent"
                                fgColor="#e0e0e0"
                              />
                            </Show>
                            <Show when={connectStatus() === 'waiting'}>
                              <div class="connect-waiting">
                                <div class="spinner"></div>
                                <p>Waiting for connection...</p>
                                <p class="connect-hint">Scan the QR code with your signer app</p>
                              </div>
                            </Show>
                            <Show when={connectStatus() === 'success'}>
                              <div class="connect-success">
                                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                  <polyline points="20 6 9 17 4 12"></polyline>
                                </svg>
                                <p>Connected!</p>
                              </div>
                            </Show>
                          </div>
                        </Show>

                        <Show when={connectError()}>
                          <div class="setting-error">{connectError()}</div>
                        </Show>

                        <div class="connect-actions">
                          <Show when={connectStatus() === 'idle'}>
                            <button class="setting-button" onClick={startNostrConnect}>Start Connection</button>
                          </Show>
                          <Show when={connectStatus() === 'waiting'}>
                            <button class="setting-button secondary" onClick={() => setConnectStatus('idle')}>Cancel</button>
                          </Show>
                          <Show when={connectStatus() === 'error'}>
                            <button class="setting-button" onClick={retryNostrConnect}>Try Again</button>
                          </Show>
                        </div>

                        <div class="connect-uri-section">
                          <p class="connect-uri-label">Or copy the connection URI:</p>
                          <div class="connect-uri-display">
                            <code class="connect-uri-value">{connectUri().slice(0, 50)}...</code>
                            <button class="key-action-btn" onClick={() => copyToClipboard(connectUri())} title="Copy URI">
                              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                              </svg>
                            </button>
                          </div>
                        </div>
                      </div>
                    </Show>

                    {/* Import Key Tab */}
                    <Show when={loginTab() === 'import'}>
                      <div class="import-content">
                        <p class="import-description">
                          Enter your Nostr private key (nsec or hex format) to login. Your key will be stored securely on this device.
                        </p>
                        <div class="import-key-form">
                          <input
                            type="password"
                            class="setting-input wide"
                            placeholder="nsec1... or hex private key"
                            value={importKeyInput()}
                            onInput={(e) => setImportKeyInput(e.currentTarget.value)}
                            onKeyPress={(e) => e.key === 'Enter' && handleImportKey()}
                            disabled={loginLoading()}
                          />
                          <button class="setting-button" onClick={handleImportKey} disabled={loginLoading()}>
                            {loginLoading() ? 'Importing...' : 'Import'}
                          </button>
                        </div>
                        <Show when={keyError()}>
                          <div class="setting-error">{keyError()}</div>
                        </Show>
                        <div class="settings-notice warning">
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                            <line x1="12" y1="9" x2="12" y2="13"></line>
                            <line x1="12" y1="17" x2="12.01" y2="17"></line>
                          </svg>
                          <p>Never share your private key with anyone. It provides full control over your Nostr identity.</p>
                        </div>
                      </div>
                    </Show>

                    {/* Generate Key Tab */}
                    <Show when={loginTab() === 'generate'}>
                      <div class="generate-content">
                        <p class="generate-description">
                          Generate a new Nostr keypair. Make sure to back up your private key securely - if you lose it, you lose access to your identity.
                        </p>
                        <button class="setting-button generate-btn" onClick={handleGenerateKey} disabled={loginLoading()}>
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"></path>
                          </svg>
                          {loginLoading() ? 'Generating...' : 'Generate New Keypair'}
                        </button>
                        <Show when={keyError()}>
                          <div class="setting-error">{keyError()}</div>
                        </Show>
                        <div class="settings-notice">
                          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="10"></circle>
                            <line x1="12" y1="16" x2="12" y2="12"></line>
                            <line x1="12" y1="8" x2="12.01" y2="8"></line>
                          </svg>
                          <p>After generating, you'll be able to copy and save your keys. Store them somewhere safe!</p>
                        </div>
                      </div>
                    </Show>
                  </div>
                </Show>

                <div class="settings-section-title">Relays</div>
                <div class="setting-item column">
                  <div class="setting-info">
                    <div class="setting-name">Your relays</div>
                    <div class="setting-description">Nostr relays for syncing (from your NIP-65 list)</div>
                  </div>
                  <div class="relay-list">
                    <For each={relays()}>
                      {(relay) => (
                        <div class="relay-item">
                          <span class="relay-status"></span>
                          <span class="relay-url">{relay.url}</span>
                          <span class="relay-permissions">
                            {relay.read && relay.write ? 'R/W' : relay.read ? 'R' : 'W'}
                          </span>
                          <button class="relay-remove" onClick={() => handleRemoveRelay(relay.url)}>×</button>
                        </div>
                      )}
                    </For>
                    <Show when={relays().length === 0}>
                      <div class="relay-empty">No relays configured</div>
                    </Show>
                  </div>
                  <div class="relay-add">
                    <input
                      type="text"
                      placeholder="wss://relay.example.com"
                      class="setting-input"
                      value={newRelayUrl()}
                      onInput={(e) => setNewRelayUrl(e.currentTarget.value)}
                      onKeyPress={(e) => e.key === 'Enter' && handleAddRelay()}
                    />
                    <button class="setting-button" onClick={handleAddRelay}>Add</button>
                  </div>
                </div>

                <div class="settings-section-title">Blossom Servers</div>
                <div class="setting-item column">
                  <div class="setting-info">
                    <div class="setting-name">Media servers</div>
                    <div class="setting-description">Blossom servers for encrypted attachments</div>
                  </div>
                  <div class="relay-list">
                    <For each={blossomServers()}>
                      {(server) => (
                        <div class="relay-item">
                          <span class="relay-status"></span>
                          <span class="relay-url">{server}</span>
                          <button class="relay-remove" onClick={() => handleRemoveBlossom(server)}>×</button>
                        </div>
                      )}
                    </For>
                    <Show when={blossomServers().length === 0}>
                      <div class="relay-empty">No servers configured</div>
                    </Show>
                  </div>
                  <div class="relay-add">
                    <input
                      type="text"
                      placeholder="https://blossom.example.com"
                      class="setting-input"
                      value={newBlossomUrl()}
                      onInput={(e) => setNewBlossomUrl(e.currentTarget.value)}
                      onKeyPress={(e) => e.key === 'Enter' && handleAddBlossom()}
                    />
                    <button class="setting-button" onClick={handleAddBlossom}>Add</button>
                  </div>
                </div>
              </div>
            </Show>

            {/* About */}
            <Show when={activeSection() === 'about'}>
              <div class="settings-section about">
                <div class="about-header">
                  <div class="about-logo">
                    <svg width="64" height="64" viewBox="0 0 512 512" fill="currentColor">
                      <path fill-rule="evenodd" clip-rule="evenodd" d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z"/>
                    </svg>
                  </div>
                  <h1>Onyx</h1>
                  <p class="about-tagline">A local-first, Nostr-native note-taking app</p>
                  <p class="about-version">Version 0.1.0</p>
                </div>

                <div class="about-section">
                  <h3>About</h3>
                  <p>Onyx is an open-source alternative to Obsidian, built with privacy and decentralization in mind. Your notes are stored locally as plain markdown files, with optional encrypted sync via Nostr.</p>
                </div>

                <div class="about-section">
                  <h3>Technology</h3>
                  <div class="about-tech">
                    <span class="tech-badge">Tauri 2.0</span>
                    <span class="tech-badge">SolidJS</span>
                    <span class="tech-badge">Rust</span>
                    <span class="tech-badge">Milkdown</span>
                    <span class="tech-badge">Nostr</span>
                  </div>
                </div>

                <div class="about-section">
                  <h3>Links</h3>
                  <div class="about-links">
                    <a href="#" class="about-link">GitHub Repository</a>
                    <a href="#" class="about-link">Documentation</a>
                    <a href="#" class="about-link">Report an Issue</a>
                  </div>
                </div>

                <div class="about-section">
                  <h3>License</h3>
                  <p>MIT License - Free and open source</p>
                </div>
              </div>
            </Show>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Settings;
