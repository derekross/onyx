import { Component, createSignal, createEffect, For, Show, onMount, onCleanup } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { open } from '@tauri-apps/plugin-shell';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import QRCode from 'qrcode';
import {
  getSyncEngine,
  setOnSaveSyncCallback,
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
  getCurrentLoginMeta,
  removeLogin,
  clearLogins,
  getIdentityFromLogin,
  saveUserProfile,
  getSavedProfile,
  type StoredLogin,
  type StoredLoginMeta,
  type NostrConnectParams,
  type RelayEntry,
  type UserProfile,
} from '../lib/nostr';
import { createSignerFromLogin, type NostrSigner } from '../lib/nostr/signer';

type SettingsSection = 'general' | 'editor' | 'files' | 'appearance' | 'hotkeys' | 'opencode' | 'productivity' | 'sync' | 'nostr' | 'about';
type LoginTab = 'generate' | 'import' | 'connect';

interface SettingsProps {
  onClose: () => void;
  vaultPath: string | null;
  onSyncComplete?: () => void;
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

interface SkillInfo {
  id: string;
  name: string;
  description: string;
  icon: string;
  category: string;
  dependencies?: string[];
  files: string[];
  isCustom?: boolean;
}

interface SkillState {
  enabled: boolean;
  installed: boolean;
  downloading: boolean;
}

// Skills manifest URL
const SKILLS_MANIFEST_URL = 'https://raw.githubusercontent.com/derekross/onyx-skills/main/manifest.json';
const SKILLS_BASE_URL = 'https://raw.githubusercontent.com/derekross/onyx-skills/main';

const sections: SettingsSectionItem[] = [
  { id: 'general', label: 'General', icon: 'M12 2L2 7l10 5 10-5-10-5zM2 17l10 5 10-5M2 12l10 5 10-5' },
  { id: 'editor', label: 'Editor', icon: 'M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z' },
  { id: 'files', label: 'Files & Links', icon: 'M14.5 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7.5L14.5 2z M14 2v6h6 M10 12l2 2 4-4' },
  { id: 'appearance', label: 'Appearance', icon: 'M12 2v4 M12 18v4 M4.93 4.93l2.83 2.83 M16.24 16.24l2.83 2.83 M2 12h4 M18 12h4 M4.93 19.07l2.83-2.83 M16.24 7.76l2.83-2.83' },
  { id: 'hotkeys', label: 'Hotkeys', icon: 'M18 3a3 3 0 0 0-3 3v12a3 3 0 0 0 3 3 3 3 0 0 0 3-3 3 3 0 0 0-3-3H6a3 3 0 0 0-3 3 3 3 0 0 0 3 3 3 3 0 0 0 3-3V6a3 3 0 0 0-3-3 3 3 0 0 0-3 3 3 3 0 0 0 3 3h12a3 3 0 0 0 3-3 3 3 0 0 0-3-3z' },
  { id: 'opencode', label: 'OpenCode', icon: 'M8 9l3 3-3 3 M13 15h3 M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z' },
  { id: 'productivity', label: 'Productivity', icon: 'M13 2L3 14h9l-1 8 10-12h-9l1-8z' },
  { id: 'sync', label: 'Sync', icon: 'M21 12a9 9 0 1 1-9-9c2.52 0 4.93 1 6.74 2.74L21 8 M21 3v5h-5' },
  { id: 'nostr', label: 'Nostr', icon: 'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z' },
  { id: 'about', label: 'About', icon: 'M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z M12 16v-4 M12 8h.01' },
];

const Settings: Component<SettingsProps> = (props) => {
  const [activeSection, setActiveSection] = createSignal<SettingsSection>('general');

  // Login state
  const [currentLogin, setCurrentLogin] = createSignal<StoredLogin | null>(null);
  const [identity, setIdentity] = createSignal<NostrIdentity | null>(null);
  const [signer, setSigner] = createSignal<NostrSigner | null>(null);
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
  const [qrCodeSvg, setQrCodeSvg] = createSignal<string>('');

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
  const [syncOnStartup, setSyncOnStartup] = createSignal(true);
  const [syncFrequency, setSyncFrequency] = createSignal<'onsave' | '5min' | 'manual'>('manual');
  const [syncStatus, setSyncStatus] = createSignal<'idle' | 'syncing' | 'success' | 'error'>('idle');
  const [syncMessage, setSyncMessage] = createSignal<string | null>(null);
  let syncIntervalId: number | null = null;

  // Skills state
  const [availableSkills, setAvailableSkills] = createSignal<SkillInfo[]>([]);
  const [skillStates, setSkillStates] = createSignal<Record<string, SkillState>>({});
  const [skillsLoading, setSkillsLoading] = createSignal(true);
  const [skillsError, setSkillsError] = createSignal<string | null>(null);

  // Modal dialog state
  const [modalConfig, setModalConfig] = createSignal<{
    type: 'confirm' | 'info';
    title: string;
    message: string;
    onConfirm?: () => void;
  } | null>(null);

  // App version
  const [appVersion, setAppVersion] = createSignal('...');

  // OpenCode settings
  const [openCodePath, setOpenCodePath] = createSignal<string>('');

  // Files & Links settings
  const [useWikilinks, setUseWikilinks] = createSignal(
    localStorage.getItem('use_wikilinks') !== 'false' // Default to true
  );

  // Editor settings
  const [editorFontFamily, setEditorFontFamily] = createSignal(
    localStorage.getItem('editor_font_family') || 'system-ui, sans-serif'
  );
  const [editorFontSize, setEditorFontSize] = createSignal(
    parseInt(localStorage.getItem('editor_font_size') || '16')
  );
  const [editorLineHeight, setEditorLineHeight] = createSignal(
    parseFloat(localStorage.getItem('editor_line_height') || '1.6')
  );
  const [showLineNumbers, setShowLineNumbers] = createSignal(
    localStorage.getItem('show_line_numbers') === 'true'
  );
  const [vimMode, setVimMode] = createSignal(
    localStorage.getItem('vim_mode') === 'true'
  );
  const [spellCheck, setSpellCheck] = createSignal(
    localStorage.getItem('spell_check') !== 'false' // Default to true
  );

  // Appearance settings
  const [theme, setTheme] = createSignal<'dark' | 'light' | 'system'>(
    (localStorage.getItem('theme') as 'dark' | 'light' | 'system') || 'dark'
  );
  const [accentColor, setAccentColor] = createSignal(
    localStorage.getItem('accent_color') || '#8b5cf6'
  );
  const [interfaceFontSize, setInterfaceFontSize] = createSignal<'small' | 'medium' | 'large'>(
    (localStorage.getItem('interface_font_size') as 'small' | 'medium' | 'large') || 'medium'
  );
  const [translucentWindow, setTranslucentWindow] = createSignal(
    localStorage.getItem('translucent_window') === 'true'
  );

  // Apply appearance settings to document
  const applyAppearanceSettings = () => {
    const root = document.documentElement;

    // Apply theme
    const currentTheme = theme();
    if (currentTheme === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
    } else {
      root.setAttribute('data-theme', currentTheme);
    }

    // Apply accent color
    const accent = accentColor();
    root.style.setProperty('--accent', accent);
    // Calculate hover color (lighter version)
    const hoverColor = lightenColor(accent, 20);
    root.style.setProperty('--accent-hover', hoverColor);
    // Calculate muted color (with alpha)
    root.style.setProperty('--accent-muted', `${accent}26`); // 15% opacity

    // Apply font size
    root.setAttribute('data-font-size', interfaceFontSize());

    // Apply translucent
    root.setAttribute('data-translucent', translucentWindow().toString());
  };

  // Helper to lighten a hex color
  const lightenColor = (hex: string, percent: number): string => {
    const num = parseInt(hex.replace('#', ''), 16);
    const amt = Math.round(2.55 * percent);
    const R = Math.min(255, (num >> 16) + amt);
    const G = Math.min(255, ((num >> 8) & 0x00FF) + amt);
    const B = Math.min(255, (num & 0x0000FF) + amt);
    return `#${(0x1000000 + R * 0x10000 + G * 0x100 + B).toString(16).slice(1)}`;
  };

  // Load saved login on mount
  onMount(async () => {
    // Get app version
    getVersion().then(setAppVersion).catch(() => setAppVersion('unknown'));

    // Apply saved appearance settings on mount
    applyAppearanceSettings();

    // Listen for system theme changes
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    const handleThemeChange = () => {
      if (theme() === 'system') {
        applyAppearanceSettings();
      }
    };
    mediaQuery.addEventListener('change', handleThemeChange);

    // Load OpenCode path setting
    const savedOpenCodePath = localStorage.getItem('opencode_path');
    if (savedOpenCodePath) {
      setOpenCodePath(savedOpenCodePath);
    }

    // Load login from secure storage
    const login = await getCurrentLogin();

    if (login) {
      setCurrentLogin(login);

      // Get identity if it's an nsec login (for displaying keys)
      const ident = getIdentityFromLogin(login);
      if (ident) {
        setIdentity(ident);
      }

      // Create signer for both nsec and bunker logins
      const loginSigner = createSignerFromLogin(login);
      if (loginSigner) {
        setSigner(loginSigner);
        // Set signer on sync engine
        const engine = getSyncEngine();
        await engine.setSigner(loginSigner);
      } else if (login.type === 'nsec') {
        // Login data is corrupted, clear it
        await removeLogin(login.id);
        setCurrentLogin(null);
      }

      // Load saved profile
      const savedProfile = await getSavedProfile();
      if (savedProfile) {
        setUserProfile(savedProfile);
      }
    }

    const savedRelays = localStorage.getItem('nostr_relays');
    if (savedRelays) {
      try {
        const parsed = JSON.parse(savedRelays);
        // Handle both old format (string[]) and new format (RelayInfo[])
        let relayInfos: RelayInfo[];
        if (typeof parsed[0] === 'string') {
          relayInfos = parsed.map((url: string) => ({ url, read: true, write: true }));
        } else {
          relayInfos = parsed;
        }
        setRelays(relayInfos);

        // Apply saved relays to sync engine (write relays only)
        const engine = getSyncEngine();
        engine.setConfig({ relays: relayInfos.filter(r => r.write).map(r => r.url) });
      } catch (e) {
        console.error('Failed to load saved relays:', e);
      }
    }

    const savedBlossom = localStorage.getItem('blossom_servers');
    if (savedBlossom) {
      try {
        const servers = JSON.parse(savedBlossom);
        setBlossomServers(servers);

        // Apply saved blossom servers to sync engine
        const engine = getSyncEngine();
        engine.setConfig({ blossomServers: servers });
      } catch (e) {
        console.error('Failed to load saved blossom servers:', e);
      }
    }

    const savedSyncEnabled = localStorage.getItem('sync_enabled');
    if (savedSyncEnabled) {
      setSyncEnabled(savedSyncEnabled === 'true');
    }

    const savedSyncOnStartup = localStorage.getItem('sync_on_startup');
    if (savedSyncOnStartup) {
      setSyncOnStartup(savedSyncOnStartup === 'true');
    }

    const savedSyncFrequency = localStorage.getItem('sync_frequency');
    if (savedSyncFrequency) {
      setSyncFrequency(savedSyncFrequency as 'onsave' | '5min' | 'manual');
    }

    // Trigger sync on startup if enabled
    if (savedSyncEnabled === 'true' && savedSyncOnStartup !== 'false') {
      // Delay slightly to let signer initialize
      setTimeout(() => {
        if (signer()) {
          handleSyncNow();
        }
      }, 500);
    }

    // Set up periodic sync if enabled
    if (savedSyncEnabled === 'true' && savedSyncFrequency === '5min') {
      startPeriodicSync();
    }

    // Register the on-save sync callback
    setOnSaveSyncCallback(async () => {
      if (signer() && syncStatus() !== 'syncing') {
        await handleSyncNow();
      }
    });

    // Load skills manifest and check installed skills
    loadSkillsManifest();
  });

  // Cleanup interval on unmount
  onCleanup(() => {
    if (syncIntervalId) {
      clearInterval(syncIntervalId);
    }
  });

  // Parse skill name from SKILL.md content (looks for name: field or first # heading)
  const parseSkillName = (content: string, fallbackId: string): string => {
    // First try to find a name: field
    const nameMatch = content.match(/^name:\s*(.+)$/m);
    if (nameMatch) {
      return nameMatch[1].trim();
    }
    // Fall back to first # heading
    const headingMatch = content.match(/^#\s+(.+)$/m);
    return headingMatch ? headingMatch[1].trim() : fallbackId;
  };

  // Parse skill description from SKILL.md (first paragraph after title)
  const parseSkillDescription = (content: string): string => {
    const lines = content.split('\n');
    let foundTitle = false;
    for (const line of lines) {
      if (line.startsWith('# ')) {
        foundTitle = true;
        continue;
      }
      if (foundTitle && line.trim() && !line.startsWith('#')) {
        return line.trim().slice(0, 100) + (line.length > 100 ? '...' : '');
      }
    }
    return 'Custom skill';
  };

  // Load skills manifest from GitHub
  const loadSkillsManifest = async () => {
    setSkillsLoading(true);
    setSkillsError(null);

    try {
      // Fetch manifest from GitHub
      const response = await fetch(SKILLS_MANIFEST_URL);
      if (!response.ok) {
        throw new Error('Failed to fetch skills manifest');
      }
      const manifest = await response.json();
      const manifestSkills: SkillInfo[] = manifest.skills || [];
      const manifestSkillIds = new Set(manifestSkills.map((s: SkillInfo) => s.id));

      // Check which skills are installed (installed = enabled)
      const states: Record<string, SkillState> = {};
      for (const skill of manifestSkills) {
        const installed = await invoke<boolean>('skill_is_installed', { skillId: skill.id });
        states[skill.id] = { installed, enabled: installed, downloading: false };
      }

      // Get all locally installed skills
      const installedSkillIds = await invoke<string[]>('skill_list_installed');

      // Find custom skills (installed but not in manifest)
      const customSkills: SkillInfo[] = [];
      for (const skillId of installedSkillIds) {
        if (!manifestSkillIds.has(skillId)) {
          try {
            // Read SKILL.md to get name and description
            const content = await invoke<string>('skill_read_file', { skillId, fileName: 'SKILL.md' });
            const name = parseSkillName(content, skillId);
            const description = parseSkillDescription(content);

            customSkills.push({
              id: skillId,
              name,
              description,
              icon: 'file-text',
              category: 'Custom',
              files: ['SKILL.md'],
              isCustom: true,
            });
            states[skillId] = { installed: true, enabled: true, downloading: false };
          } catch (err) {
            console.error(`Failed to read custom skill ${skillId}:`, err);
          }
        }
      }

      // Combine manifest skills with custom skills
      setAvailableSkills([...manifestSkills, ...customSkills]);
      setSkillStates(states);
    } catch (err) {
      console.error('Failed to load skills:', err);
      setSkillsError(err instanceof Error ? err.message : 'Failed to load skills');
    } finally {
      setSkillsLoading(false);
    }
  };

  // Toggle skill enabled/disabled (installs or removes the skill)
  const handleSkillToggle = async (skillId: string, enabled: boolean) => {
    const skill = availableSkills().find(s => s.id === skillId);
    if (!skill) return;

    const currentState = skillStates()[skillId] || { installed: false, enabled: false, downloading: false };

    if (enabled) {
      // Download and install the skill
      setSkillStates(prev => ({
        ...prev,
        [skillId]: { ...currentState, downloading: true }
      }));

      try {
        // Download all skill files
        for (const file of skill.files) {
          const fileUrl = `${SKILLS_BASE_URL}/${skillId}/${file}`;
          const response = await fetch(fileUrl);
          if (!response.ok) {
            throw new Error(`Failed to download ${file}`);
          }
          const content = await response.text();
          await invoke('skill_save_file', { skillId, fileName: file, content });
        }

        setSkillStates(prev => ({
          ...prev,
          [skillId]: { installed: true, enabled: true, downloading: false }
        }));
      } catch (err) {
        console.error(`Failed to download skill ${skillId}:`, err);
        setSkillStates(prev => ({
          ...prev,
          [skillId]: { ...currentState, downloading: false }
        }));
      }
    } else {
      // Disable = remove the skill (with confirmation)
      const isCustom = skill.isCustom;
      setModalConfig({
        type: 'confirm',
        title: `Remove "${skill.name}" skill?`,
        message: isCustom
          ? 'This will delete the custom skill from your system. You will need to re-import it to use it again.'
          : 'This will delete the skill files from your system. You can re-enable it later to download again.',
        onConfirm: async () => {
          try {
            await invoke('skill_delete', { skillId });
            setSkillStates(prev => ({
              ...prev,
              [skillId]: { installed: false, enabled: false, downloading: false }
            }));
            // Remove custom skills from the list entirely
            if (isCustom) {
              setAvailableSkills(prev => prev.filter(s => s.id !== skillId));
            }
          } catch (err) {
            console.error(`Failed to remove skill ${skillId}:`, err);
          }
          setModalConfig(null);
        }
      });
    }
  };

  // Get icon for skill category
  const getSkillIcon = (icon: string) => {
    const icons: Record<string, string> = {
      'pencil': 'M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z',
      'file-text': 'M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8',
      'briefcase': 'M20 7H4a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2z M16 21V5a2 2 0 0 0-2-2h-4a2 2 0 0 0-2 2v16',
      'zap': 'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
      'clipboard-list': 'M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2 M9 5a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2 M9 5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2 M12 12h4 M12 16h4 M8 12h.01 M8 16h.01',
      'presentation': 'M2 3h20 M10 12h4 M10 16h4 M4 3v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V3 M12 16v5 M8 21h8',
      'target': 'M22 12h-4 M6 12H2 M12 6V2 M12 22v-4 M12 12m-10 0a10 10 0 1 0 20 0 10 10 0 1 0-20 0 M12 12m-6 0a6 6 0 1 0 12 0 6 6 0 1 0-12 0 M12 12m-2 0a2 2 0 1 0 4 0 2 2 0 1 0-4 0',
      'table': 'M9 3H5a2 2 0 0 0-2 2v4m6-6h10a2 2 0 0 1 2 2v4M9 3v18m0 0h10a2 2 0 0 0 2-2V9M9 21H5a2 2 0 0 1-2-2V9m0 0h18',
    };
    return icons[icon] || icons['file-text'];
  };

  // Fetch user profile, relays and blossom servers after login
  const fetchUserData = async (pubkey: string) => {
    const relayUrls = relays().map(r => r.url);

    try {
      // Fetch user profile (kind 0)
      const profile = await fetchUserProfile(pubkey, relayUrls);
      if (profile) {
        setUserProfile(profile);
        await saveUserProfile(profile);
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
  const handleLoginSuccess = async (login: StoredLogin, ident: NostrIdentity | null) => {
    setCurrentLogin(login);
    if (ident) {
      setIdentity(ident);
    }

    // Create signer for both nsec and bunker logins
    const loginSigner = createSignerFromLogin(login);
    if (loginSigner) {
      setSigner(loginSigner);
      const engine = getSyncEngine();
      await engine.setSigner(loginSigner);
    }

    await saveLogin(login);
    setKeyError(null);
    setLoginLoading(false);

    // Fetch user's relay list and blossom servers
    fetchUserData(login.pubkey);
  };

  // Generate new keypair
  const handleGenerateKey = async () => {
    setLoginLoading(true);
    setKeyError(null);

    try {
      const { identity: newIdentity, login } = generateNewLogin();
      await handleLoginSuccess(login, newIdentity);
    } catch (e) {
      setKeyError('Failed to generate key');
      setLoginLoading(false);
    }
  };

  // Import existing key (nsec)
  const handleImportKey = async () => {
    const key = importKeyInput().trim();
    if (!key) {
      setKeyError('Please enter a key');
      return;
    }

    setLoginLoading(true);
    setKeyError(null);

    try {
      const { identity: imported, login } = importNsecLogin(key);
      await handleLoginSuccess(login, imported);
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
      await handleLoginSuccess(login, null);
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
  const handleLogout = async () => {
    // Close signer connections if NIP-46
    const currentSigner = signer();
    if (currentSigner?.close) {
      currentSigner.close();
    }

    // Clear all login data from secure storage
    await clearLogins();

    // Reset sync engine
    const engine = getSyncEngine();
    await engine.setSigner(null);

    // Reset all local state
    setCurrentLogin(null);
    setIdentity(null);
    setSigner(null);
    setUserProfile(null);
    setConnectParams(null);
    setConnectUri('');
    setConnectStatus('idle');
  };

  // Initialize connect params and start listening when switching to connect tab
  createEffect(() => {
    if (loginTab() === 'connect' && !connectParams()) {
      initNostrConnect();
      // Automatically start waiting for connection
      setTimeout(() => startNostrConnect(), 100);
    }
  });

  // Generate QR code SVG when URI changes
  createEffect(() => {
    const uri = connectUri();
    if (uri) {
      QRCode.toString(uri, {
        type: 'svg',
        margin: 1,
        color: { dark: '#000000', light: '#ffffff' }
      }).then(svg => {
        setQrCodeSvg(svg);
      }).catch(err => {
        console.error('Failed to generate QR code:', err);
      });
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

  // Start periodic sync (every 5 minutes)
  const startPeriodicSync = () => {
    if (syncIntervalId) {
      clearInterval(syncIntervalId);
    }
    // 5 minutes = 300000ms
    syncIntervalId = window.setInterval(() => {
      if (signer() && syncEnabled() && syncStatus() !== 'syncing') {
        handleSyncNow();
      }
    }, 300000);
  };

  // Stop periodic sync
  const stopPeriodicSync = () => {
    if (syncIntervalId) {
      clearInterval(syncIntervalId);
      syncIntervalId = null;
    }
  };

  // Toggle sync enabled
  const handleSyncToggle = (enabled: boolean) => {
    setSyncEnabled(enabled);
    localStorage.setItem('sync_enabled', enabled.toString());

    const engine = getSyncEngine();
    engine.setConfig({ enabled });

    // Manage periodic sync based on enabled state
    if (enabled && syncFrequency() === '5min') {
      startPeriodicSync();
    } else {
      stopPeriodicSync();
    }
  };

  // Toggle sync on startup
  const handleSyncOnStartupToggle = (enabled: boolean) => {
    setSyncOnStartup(enabled);
    localStorage.setItem('sync_on_startup', enabled.toString());
  };

  // Change sync frequency
  const handleSyncFrequencyChange = (frequency: 'onsave' | '5min' | 'manual') => {
    setSyncFrequency(frequency);
    localStorage.setItem('sync_frequency', frequency);

    // Manage periodic sync based on frequency
    if (syncEnabled() && frequency === '5min') {
      startPeriodicSync();
    } else {
      stopPeriodicSync();
    }
  };

  // Get all local markdown files recursively
  const getLocalFiles = async (basePath: string): Promise<{ path: string; content: string }[]> => {
    const files: { path: string; content: string }[] = [];

    const entries = await invoke<Array<{ name: string; path: string; isDirectory: boolean; children?: unknown[] }>>('list_files', { path: basePath });

    const processEntries = async (entries: Array<{ name: string; path: string; isDirectory: boolean; children?: unknown[] }>) => {
      for (const entry of entries) {
        if (entry.isDirectory && entry.children) {
          await processEntries(entry.children as typeof entries);
        } else if (entry.name.endsWith('.md')) {
          const content = await invoke<string>('read_file', { path: entry.path });
          // Get relative path from vault
          const relativePath = entry.path.replace(basePath + '/', '');
          files.push({ path: relativePath, content });
        }
      }
    };

    await processEntries(entries);
    return files;
  };

  // Manual sync
  const handleSyncNow = async () => {
    if (!signer()) {
      setSyncStatus('error');
      setSyncMessage('No identity found. Please log in first.');
      return;
    }

    if (!props.vaultPath) {
      setSyncStatus('error');
      setSyncMessage('No vault folder open. Open a folder first.');
      return;
    }

    setSyncStatus('syncing');
    setSyncMessage('Connecting to relays...');

    try {
      const engine = getSyncEngine();

      setSyncMessage('Fetching vaults...');
      const vaults = await engine.fetchVaults();

      let vault = vaults[0];
      if (!vault) {
        setSyncMessage('No vaults found. Creating default vault...');
        vault = await engine.createVault('My Notes', 'Default vault');
      }

      // Get local files
      setSyncMessage('Reading local files...');
      const localFiles = await getLocalFiles(props.vaultPath);

      // Get remote files
      setSyncMessage('Fetching remote files...');
      const remoteFiles = await engine.fetchVaultFiles(vault);

      // Create a map of remote files by path
      const remoteFileMap = new Map(remoteFiles.map(f => [f.data.path, f]));

      // Push local files that are new or changed
      let uploadedCount = 0;
      let downloadedCount = 0;

      for (const localFile of localFiles) {
        const remoteFile = remoteFileMap.get(localFile.path);

        // Check if file needs to be uploaded (new or content changed)
        if (!remoteFile || remoteFile.data.content !== localFile.content) {
          setSyncMessage(`Uploading ${localFile.path}...`);
          const result = await engine.publishFile(vault, localFile.path, localFile.content, remoteFile);
          vault = result.vault; // Update vault with new file index
          uploadedCount++;
        }

        // Remove from map so we know what's left (remote-only files)
        remoteFileMap.delete(localFile.path);
      }

      // Download remote-only files (files on Nostr but not locally)
      for (const [path, remoteFile] of remoteFileMap) {
        // Skip deleted files
        if (vault.data.deleted?.some(d => d.path === path)) {
          continue;
        }

        setSyncMessage(`Downloading ${path}...`);
        const fullPath = `${props.vaultPath}/${path}`;

        // Ensure parent directory exists
        const parentDir = fullPath.substring(0, fullPath.lastIndexOf('/'));
        if (parentDir !== props.vaultPath) {
          await invoke('create_folder', { path: parentDir }).catch(() => {});
        }

        await invoke('write_file', { path: fullPath, content: remoteFile.data.content });
        downloadedCount++;
      }

      setSyncStatus('success');
      const parts = [];
      if (uploadedCount > 0) parts.push(`uploaded ${uploadedCount}`);
      if (downloadedCount > 0) parts.push(`downloaded ${downloadedCount}`);
      if (parts.length === 0) parts.push('everything up to date');
      setSyncMessage(`Sync complete: ${parts.join(', ')}`);

      // Refresh file explorer if files were downloaded
      if (downloadedCount > 0) {
        props.onSyncComplete?.();
      }

      // Clear success message after 3 seconds
      setTimeout(() => {
        if (syncStatus() === 'success') {
          setSyncStatus('idle');
          setSyncMessage(null);
        }
      }, 3000);
    } catch (err) {
      console.error('Sync failed:', err);
      setSyncStatus('error');
      setSyncMessage(err instanceof Error ? err.message : 'Sync failed');
    }
  };

  const handleOverlayClick = (e: MouseEvent) => {
    if (e.target === e.currentTarget) {
      props.onClose();
    }
  };

  // OpenCode path handlers
  const handleBrowseOpenCode = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        title: 'Select OpenCode executable',
      });

      if (selected && typeof selected === 'string') {
        setOpenCodePath(selected);
        localStorage.setItem('opencode_path', selected);
      }
    } catch (err) {
      console.error('Failed to open file dialog:', err);
    }
  };

  const handleOpenCodePathChange = (path: string) => {
    setOpenCodePath(path);
    if (path.trim()) {
      localStorage.setItem('opencode_path', path);
    } else {
      localStorage.removeItem('opencode_path');
    }
  };

  const handleClearOpenCodePath = () => {
    setOpenCodePath('');
    localStorage.removeItem('opencode_path');
  };

  // Wikilinks toggle handler
  const handleWikilinksToggle = (enabled: boolean) => {
    setUseWikilinks(enabled);
    localStorage.setItem('use_wikilinks', String(enabled));
  };

  // Import custom skill handler
  const handleImportSkill = async () => {
    try {
      const selected = await openDialog({
        multiple: false,
        title: 'Select skill file',
        filters: [{
          name: 'Skill files',
          extensions: ['md', 'zip']
        }]
      });

      if (selected && typeof selected === 'string') {
        // Read the file and import it
        const fileName = selected.split('/').pop() || selected.split('\\').pop() || 'skill';

        if (selected.endsWith('.md')) {
          // Import single SKILL.md file
          const content = await invoke<string>('read_file', { path: selected });
          const skillId = fileName.replace('.md', '').toLowerCase().replace(/[^a-z0-9-]/g, '-');
          const skillName = parseSkillName(content, skillId);
          await invoke('skill_save_file', { skillId, fileName: 'SKILL.md', content });

          setModalConfig({
            type: 'info',
            title: 'Skill imported',
            message: `Successfully imported skill "${skillName}".`
          });
        } else {
          // TODO: Handle zip import
          setModalConfig({
            type: 'info',
            title: 'Not implemented',
            message: 'ZIP import is not yet implemented. Please import a SKILL.md file directly.'
          });
        }

        // Refresh skills list
        loadSkillsManifest();
      }
    } catch (err) {
      console.error('Failed to import skill:', err);
      setModalConfig({
        type: 'info',
        title: 'Import failed',
        message: `Failed to import skill: ${err instanceof Error ? err.message : 'Unknown error'}`
      });
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
                  <input
                    type="text"
                    class="setting-input wide"
                    value={editorFontFamily()}
                    onInput={(e) => {
                      const value = e.currentTarget.value;
                      setEditorFontFamily(value);
                      localStorage.setItem('editor_font_family', value);
                    }}
                  />
                </div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Font size</div>
                    <div class="setting-description">Base font size in pixels</div>
                  </div>
                  <input
                    type="number"
                    class="setting-input"
                    value={editorFontSize()}
                    min="10"
                    max="32"
                    onInput={(e) => {
                      const value = parseInt(e.currentTarget.value) || 16;
                      setEditorFontSize(value);
                      localStorage.setItem('editor_font_size', value.toString());
                    }}
                  />
                </div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Line height</div>
                    <div class="setting-description">Line height multiplier</div>
                  </div>
                  <input
                    type="number"
                    class="setting-input"
                    value={editorLineHeight()}
                    min="1"
                    max="3"
                    step="0.1"
                    onInput={(e) => {
                      const value = parseFloat(e.currentTarget.value) || 1.6;
                      setEditorLineHeight(value);
                      localStorage.setItem('editor_line_height', value.toString());
                    }}
                  />
                </div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Show line numbers</div>
                    <div class="setting-description">Display line numbers in the editor</div>
                  </div>
                  <label class="setting-toggle">
                    <input
                      type="checkbox"
                      checked={showLineNumbers()}
                      onChange={(e) => {
                        const value = e.currentTarget.checked;
                        setShowLineNumbers(value);
                        localStorage.setItem('show_line_numbers', value.toString());
                      }}
                    />
                    <span class="toggle-slider"></span>
                  </label>
                </div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Vim mode</div>
                    <div class="setting-description">Enable Vim keybindings in the editor</div>
                  </div>
                  <label class="setting-toggle">
                    <input
                      type="checkbox"
                      checked={vimMode()}
                      onChange={(e) => {
                        const value = e.currentTarget.checked;
                        setVimMode(value);
                        localStorage.setItem('vim_mode', value.toString());
                      }}
                    />
                    <span class="toggle-slider"></span>
                  </label>
                </div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Spell check</div>
                    <div class="setting-description">Enable spell checking</div>
                  </div>
                  <label class="setting-toggle">
                    <input
                      type="checkbox"
                      checked={spellCheck()}
                      onChange={(e) => {
                        const value = e.currentTarget.checked;
                        setSpellCheck(value);
                        localStorage.setItem('spell_check', value.toString());
                      }}
                    />
                    <span class="toggle-slider"></span>
                  </label>
                </div>

                <p class="setting-note">Note: Editor changes take effect when you reload the app or open a new file.</p>
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
                    <input
                      type="checkbox"
                      checked={useWikilinks()}
                      onChange={(e) => handleWikilinksToggle(e.target.checked)}
                    />
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
                  <select
                    class="setting-select"
                    value={theme()}
                    onChange={(e) => {
                      const value = e.currentTarget.value as 'dark' | 'light' | 'system';
                      setTheme(value);
                      localStorage.setItem('theme', value);
                      // Auto-apply purple accent for Nostr Purple theme
                      if (value === 'dark') {
                        const purple = '#8b5cf6';
                        setAccentColor(purple);
                        localStorage.setItem('accent_color', purple);
                      }
                      applyAppearanceSettings();
                    }}
                  >
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
                  <input
                    type="color"
                    class="setting-color"
                    value={accentColor()}
                    onInput={(e) => {
                      const value = e.currentTarget.value;
                      setAccentColor(value);
                      localStorage.setItem('accent_color', value);
                      applyAppearanceSettings();
                    }}
                  />
                </div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Interface font size</div>
                    <div class="setting-description">Font size for UI elements</div>
                  </div>
                  <select
                    class="setting-select"
                    value={interfaceFontSize()}
                    onChange={(e) => {
                      const value = e.currentTarget.value as 'small' | 'medium' | 'large';
                      setInterfaceFontSize(value);
                      localStorage.setItem('interface_font_size', value);
                      applyAppearanceSettings();
                    }}
                  >
                    <option value="small">Small</option>
                    <option value="medium">Medium</option>
                    <option value="large">Large</option>
                  </select>
                </div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Translucent window</div>
                    <div class="setting-description">Enable window translucency effects</div>
                  </div>
                  <label class="setting-toggle">
                    <input
                      type="checkbox"
                      checked={translucentWindow()}
                      onChange={(e) => {
                        const value = e.currentTarget.checked;
                        setTranslucentWindow(value);
                        localStorage.setItem('translucent_window', value.toString());
                        applyAppearanceSettings();
                      }}
                    />
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

            {/* OpenCode Settings */}
            <Show when={activeSection() === 'opencode'}>
              <div class="settings-section">
                <div class="settings-section-title">OpenCode Configuration</div>

                <div class="settings-notice">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="16" x2="12" y2="12"></line>
                    <line x1="12" y1="8" x2="12.01" y2="8"></line>
                  </svg>
                  <p>OpenCode is an AI coding assistant. If it's not in your system PATH, you can specify its location here.</p>
                </div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">OpenCode binary path</div>
                    <div class="setting-description">Leave empty to use system PATH, or specify the full path to the OpenCode executable</div>
                  </div>
                </div>

                <div class="setting-item column">
                  <div class="opencode-path-input">
                    <input
                      type="text"
                      class="setting-input wide"
                      placeholder="e.g., C:\Program Files\OpenCode\opencode.exe or /usr/local/bin/opencode"
                      value={openCodePath()}
                      onInput={(e) => handleOpenCodePathChange(e.currentTarget.value)}
                    />
                    <button class="setting-button" onClick={handleBrowseOpenCode}>
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
                      </svg>
                      Browse
                    </button>
                    <Show when={openCodePath()}>
                      <button class="setting-button secondary" onClick={handleClearOpenCodePath} title="Clear path">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <line x1="18" y1="6" x2="6" y2="18"></line>
                          <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                      </button>
                    </Show>
                  </div>
                </div>

                <Show when={openCodePath()}>
                  <div class="setting-item">
                    <div class="setting-info">
                      <div class="setting-name">Current path</div>
                      <div class="setting-description opencode-current-path">{openCodePath()}</div>
                    </div>
                  </div>
                </Show>

                <div class="settings-section-title">Installation</div>
                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Download OpenCode</div>
                    <div class="setting-description">Get the latest version of OpenCode</div>
                  </div>
                  <button class="setting-button" onClick={() => open('https://opencode.ai/download')}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                      <polyline points="7 10 12 15 17 10"></polyline>
                      <line x1="12" y1="15" x2="12" y2="3"></line>
                    </svg>
                    Download
                  </button>
                </div>
              </div>
            </Show>

            {/* Productivity Skills */}
            <Show when={activeSection() === 'productivity'}>
              <div class="settings-section">
                <div class="settings-section-title">AI Skills</div>

                <div class="settings-notice">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="16" x2="12" y2="12"></line>
                    <line x1="12" y1="8" x2="12.01" y2="8"></line>
                  </svg>
                  <p>AI skills enhance OpenCode with specialized capabilities. Enable skills to download them to your system. Skills are stored in <code>~/.config/opencode/skills/</code></p>
                </div>

                <Show when={skillsLoading()}>
                  <div class="skills-loading">
                    <div class="spinner"></div>
                    <span>Loading skills...</span>
                  </div>
                </Show>

                <Show when={skillsError()}>
                  <div class="settings-notice warning">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                      <line x1="12" y1="9" x2="12" y2="13"></line>
                      <line x1="12" y1="17" x2="12.01" y2="17"></line>
                    </svg>
                    <p>{skillsError()}</p>
                  </div>
                  <button class="setting-button" onClick={loadSkillsManifest}>Retry</button>
                </Show>

                <Show when={!skillsLoading() && !skillsError()}>
                  <div class="skills-list">
                    <For each={availableSkills()}>
                      {(skill) => {
                        const state = () => skillStates()[skill.id] || { installed: false, enabled: false, downloading: false };
                        return (
                          <div class={`skill-item ${state().enabled ? 'enabled' : ''} ${state().downloading ? 'downloading' : ''}`}>
                            <div class="skill-icon">
                              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d={getSkillIcon(skill.icon)}></path>
                              </svg>
                            </div>
                            <div class="skill-info">
                              <div class="skill-header">
                                <span class="skill-name">{skill.name}</span>
                                <Show when={skill.isCustom}>
                                  <span class="skill-badge custom">Custom</span>
                                </Show>
                                <Show when={state().installed && !skill.isCustom}>
                                  <span class="skill-badge installed">Installed</span>
                                </Show>
                                <Show when={skill.dependencies && skill.dependencies.length > 0}>
                                  <button
                                    class="skill-badge deps clickable"
                                    onClick={() => setModalConfig({
                                      type: 'info',
                                      title: `${skill.name} Dependencies`,
                                      message: `This skill requires the following Python packages:\n\n${skill.dependencies?.map(d => `• ${d}`).join('\n')}\n\nInstall with:\npip install ${skill.dependencies?.join(' ')}`
                                    })}
                                    title="Click to see dependencies"
                                  >
                                    Has deps
                                  </button>
                                </Show>
                              </div>
                              <p class="skill-description">{skill.description}</p>
                              <span class="skill-category">{skill.category}</span>
                            </div>
                            <div class="skill-actions">
                              <Show when={state().downloading}>
                                <div class="spinner small"></div>
                              </Show>
                              <Show when={!state().downloading}>
                                <button
                                  class="skill-source-btn"
                                  onClick={() => open(`${SKILLS_BASE_URL}/${skill.id}/SKILL.md`)}
                                  title="View source on GitHub"
                                >
                                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                                    <polyline points="15 3 21 3 21 9"></polyline>
                                    <line x1="10" y1="14" x2="21" y2="3"></line>
                                  </svg>
                                </button>
                                <label class="setting-toggle">
                                  <input
                                    type="checkbox"
                                    checked={state().enabled}
                                    onChange={(e) => handleSkillToggle(skill.id, e.currentTarget.checked)}
                                  />
                                  <span class="toggle-slider"></span>
                                </label>
                              </Show>
                            </div>
                          </div>
                        );
                      }}
                    </For>
                  </div>
                </Show>

                <div class="settings-section-title" style="margin-top: 24px;">Custom Skills</div>
                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Import skill</div>
                    <div class="setting-description">Upload a SKILL.md file or .zip archive</div>
                  </div>
                  <button class="setting-button secondary" onClick={handleImportSkill}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                      <polyline points="17 8 12 3 7 8"></polyline>
                      <line x1="12" y1="3" x2="12" y2="15"></line>
                    </svg>
                    Upload
                  </button>
                </div>
              </div>
            </Show>

            {/* Sync Settings */}
            <Show when={activeSection() === 'sync'}>
              <div class="settings-section">
                <div class="settings-section-title">Sync Status</div>

                <Show when={!signer()}>
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
                      disabled={!signer()}
                      onChange={(e) => handleSyncToggle(e.currentTarget.checked)}
                    />
                    <span class="toggle-slider"></span>
                  </label>
                </div>

                <Show when={syncEnabled() && signer()}>
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

                <Show when={syncEnabled()}>
                  <div class="settings-section-title">Sync Options</div>
                  <div class="setting-item">
                    <div class="setting-info">
                      <div class="setting-name">Sync on startup</div>
                      <div class="setting-description">Automatically sync when opening the app</div>
                    </div>
                    <label class="setting-toggle">
                      <input
                        type="checkbox"
                        checked={syncOnStartup()}
                        onChange={(e) => handleSyncOnStartupToggle(e.currentTarget.checked)}
                      />
                      <span class="toggle-slider"></span>
                    </label>
                  </div>

                  <div class="setting-item">
                    <div class="setting-info">
                      <div class="setting-name">Sync frequency</div>
                      <div class="setting-description">How often to sync changes automatically</div>
                    </div>
                    <select
                      class="setting-select"
                      value={syncFrequency()}
                      onChange={(e) => handleSyncFrequencyChange(e.currentTarget.value as 'onsave' | '5min' | 'manual')}
                    >
                      <option value="onsave">On file save</option>
                      <option value="5min">Every 5 minutes</option>
                      <option value="manual">Manual only</option>
                    </select>
                  </div>

                  <div class="settings-section-title">Actions</div>
                  <div class="setting-item">
                    <div class="setting-info">
                      <div class="setting-name">Manual sync</div>
                      <div class="setting-description">Sync all files now</div>
                    </div>
                    <button
                      class="setting-button"
                      onClick={handleSyncNow}
                      disabled={syncStatus() === 'syncing'}
                    >
                      {syncStatus() === 'syncing' ? 'Syncing...' : 'Sync Now'}
                    </button>
                  </div>

                  <Show when={syncMessage()}>
                    <div class={`sync-feedback ${syncStatus()}`}>
                      <Show when={syncStatus() === 'syncing'}>
                        <div class="spinner small"></div>
                      </Show>
                      <Show when={syncStatus() === 'success'}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <polyline points="20 6 9 17 4 12"></polyline>
                        </svg>
                      </Show>
                      <Show when={syncStatus() === 'error'}>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <circle cx="12" cy="12" r="10"></circle>
                          <line x1="15" y1="9" x2="9" y2="15"></line>
                          <line x1="9" y1="9" x2="15" y2="15"></line>
                        </svg>
                      </Show>
                      <span>{syncMessage()}</span>
                    </div>
                  </Show>
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
                          Scan this QR code with a Nostr signer app like <strong>Amber</strong> or <strong>Primal</strong> to login securely without exposing your private key.
                        </p>

                        <Show when={connectUri()}>
                          <div class="qr-container">
                            <Show when={connectStatus() !== 'success'}>
                              <div class="qr-code" style="width: 200px; height: 200px;" innerHTML={qrCodeSvg()} />
                              <Show when={connectStatus() === 'waiting'}>
                                <p class="connect-hint" style="margin-top: 12px; color: var(--text-secondary);">Scan with your signer app</p>
                              </Show>
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
                  <p class="about-version">Version {appVersion()}</p>
                </div>

                <div class="about-section">
                  <h3>About</h3>
                  <p>Onyx is an open-source note-taking app built with privacy and decentralization in mind. Your notes are stored locally as plain markdown files, with optional encrypted sync via Nostr.</p>
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
                    <a href="https://github.com/derekross/onyx" target="_blank" class="about-link">GitHub Repository</a>
                    <a href="https://github.com/derekross/onyx-skills" target="_blank" class="about-link">AI Skills Repository</a>
                    <a href="https://github.com/derekross/onyx/issues" target="_blank" class="about-link">Report an Issue</a>
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

        {/* Custom Modal Dialog */}
        <Show when={modalConfig()}>
          <div class="modal-overlay" onClick={() => setModalConfig(null)}>
            <div class="modal-dialog" onClick={(e) => e.stopPropagation()}>
              <div class="modal-header">
                <h3>{modalConfig()!.title}</h3>
                <button class="modal-close" onClick={() => setModalConfig(null)}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </svg>
                </button>
              </div>
              <div class="modal-body">
                <p>{modalConfig()!.message}</p>
              </div>
              <div class="modal-footer">
                <Show when={modalConfig()!.type === 'confirm'}>
                  <button class="setting-button secondary" onClick={() => setModalConfig(null)}>Cancel</button>
                  <button class="setting-button danger" onClick={modalConfig()!.onConfirm}>Remove</button>
                </Show>
                <Show when={modalConfig()!.type === 'info'}>
                  <button class="setting-button" onClick={() => setModalConfig(null)}>OK</button>
                </Show>
              </div>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
};

export default Settings;
