import { Component, createSignal, For, Show } from 'solid-js';

type SettingsSection = 'general' | 'editor' | 'files' | 'appearance' | 'hotkeys' | 'sync' | 'nostr' | 'about';

interface SettingsProps {
  onClose: () => void;
}

interface SettingsSectionItem {
  id: SettingsSection;
  label: string;
  icon: string;
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
                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Enable sync</div>
                    <div class="setting-description">Sync this vault using Nostr relays</div>
                  </div>
                  <label class="setting-toggle">
                    <input type="checkbox" />
                    <span class="toggle-slider"></span>
                  </label>
                </div>

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
                    <input type="checkbox" checked disabled />
                    <span class="toggle-slider"></span>
                  </label>
                </div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Sync frequency</div>
                    <div class="setting-description">How often to sync changes</div>
                  </div>
                  <select class="setting-select" disabled>
                    <option value="realtime">Real-time</option>
                    <option value="5min">Every 5 minutes</option>
                    <option value="manual">Manual only</option>
                  </select>
                </div>
              </div>
            </Show>

            {/* Nostr Settings */}
            <Show when={activeSection() === 'nostr'}>
              <div class="settings-section">
                <div class="settings-section-title">Identity</div>
                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Public key (npub)</div>
                    <div class="setting-description">Your Nostr public identity</div>
                  </div>
                  <div class="setting-readonly">Not configured</div>
                </div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Private key</div>
                    <div class="setting-description">Your secret key (never shared)</div>
                  </div>
                  <button class="setting-button">Generate New Key</button>
                </div>

                <div class="settings-notice warning">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                    <line x1="12" y1="9" x2="12" y2="13"></line>
                    <line x1="12" y1="17" x2="12.01" y2="17"></line>
                  </svg>
                  <p>Your private key gives full access to your Nostr identity. Keep it safe and never share it with anyone.</p>
                </div>

                <div class="settings-section-title">Relays</div>
                <div class="setting-item column">
                  <div class="setting-info">
                    <div class="setting-name">Connected relays</div>
                    <div class="setting-description">Nostr relays used for syncing</div>
                  </div>
                  <div class="relay-list">
                    <div class="relay-item">
                      <span class="relay-status connected"></span>
                      <span class="relay-url">wss://relay.damus.io</span>
                      <button class="relay-remove">×</button>
                    </div>
                    <div class="relay-item">
                      <span class="relay-status connected"></span>
                      <span class="relay-url">wss://nos.lol</span>
                      <button class="relay-remove">×</button>
                    </div>
                  </div>
                  <div class="relay-add">
                    <input type="text" placeholder="wss://relay.example.com" class="setting-input" />
                    <button class="setting-button">Add</button>
                  </div>
                </div>

                <div class="settings-section-title">Blossom Servers</div>
                <div class="setting-item column">
                  <div class="setting-info">
                    <div class="setting-name">Attachment servers</div>
                    <div class="setting-description">Blossom servers for file storage</div>
                  </div>
                  <div class="relay-list">
                    <div class="relay-item">
                      <span class="relay-status"></span>
                      <span class="relay-url">https://blossom.oxtr.dev</span>
                      <button class="relay-remove">×</button>
                    </div>
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
