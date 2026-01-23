import { Component, createSignal, For, Show, onMount, onCleanup, createEffect } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { open } from '@tauri-apps/plugin-shell';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import {
  getSyncEngine,
  setOnSaveSyncCallback,
  type NostrIdentity,
  DEFAULT_SYNC_CONFIG,
  // Login functions
  generateNewLogin,
  importNsecLogin,
  fetchUserRelays,
  fetchUserBlossomServers,
  fetchUserProfile,
  saveLogin,
  getCurrentLogin,
  removeLogin,
  clearLogins,
  getIdentityFromLogin,
  saveUserProfile,
  getSavedProfile,
  type StoredLogin,
  type UserProfile,
} from '../lib/nostr';
import { createSignerFromLogin, type NostrSigner } from '../lib/nostr/signer';
import {
  initClient,
  isServerRunning,
  getProviders,
  getCurrentModel,
  setCurrentModel,
  type ProviderInfo,
} from '../lib/opencode/client';
import {
  fetchSkillsShLeaderboard,
  searchSkillsSh,
  sortSkillsSh,
  formatInstallCount,
  getSkillGitHubUrl,
  installSkillFromSkillsSh,
  isSkillInstalled,
  type SkillsShSkill,
  type SkillsSortOption,
} from '../lib/skills';
import { usePlatformInfo, isMobile } from '../lib/platform';
import { authenticateWithBiometric } from '../lib/biometric';

type SettingsSection = 'general' | 'editor' | 'files' | 'appearance' | 'hotkeys' | 'opencode' | 'productivity' | 'sync' | 'nostr' | 'about';
type LoginTab = 'generate' | 'import';

interface SettingsProps {
  onClose: () => void;
  vaultPath: string | null;
  onSyncComplete?: () => void;
  onSyncEnabledChange?: (enabled: boolean) => void;
  initialSection?: SettingsSection;
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
  const [activeSection, setActiveSection] = createSignal<SettingsSection>(props.initialSection || 'general');

  // Platform detection for hiding OpenCode/Productivity on mobile
  const platformInfo = usePlatformInfo();
  const isMobileApp = () => {
    const info = platformInfo();
    return info?.platform === 'android' || info?.platform === 'ios';
  };

  // Filter sections based on platform - hide OpenCode, Productivity, and Hotkeys on mobile
  const filteredSections = () => {
    if (isMobileApp()) {
      return sections.filter(s => s.id !== 'opencode' && s.id !== 'productivity' && s.id !== 'hotkeys');
    }
    return sections;
  };

  // Login state
  const [currentLogin, setCurrentLogin] = createSignal<StoredLogin | null>(null);
  const [identity, setIdentity] = createSignal<NostrIdentity | null>(null);
  const [signer, setSigner] = createSignal<NostrSigner | null>(null);
  const [userProfile, setUserProfile] = createSignal<UserProfile | null>(null);
  const [loginTab, setLoginTab] = createSignal<LoginTab>('import');
  const [showPrivateKey, setShowPrivateKey] = createSignal(false);
  const [importKeyInput, setImportKeyInput] = createSignal('');
  const [keyError, setKeyError] = createSignal<string | null>(null);
  const [loginLoading, setLoginLoading] = createSignal(false);

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

  // Blocked users state
  const [blockedUsers, setBlockedUsers] = createSignal<Array<{ pubkey: string; name?: string; picture?: string }>>([]);
  const [loadingBlocked, setLoadingBlocked] = createSignal(false);
  const [unblockingUser, setUnblockingUser] = createSignal<string | null>(null);

  // Sync state
  const [syncEnabled, setSyncEnabled] = createSignal(false);
  const [syncOnStartup, setSyncOnStartup] = createSignal(true);
  const [syncFrequency, setSyncFrequency] = createSignal<'onsave' | '5min' | 'manual'>('manual');
  const [syncStatus, setSyncStatus] = createSignal<'idle' | 'syncing' | 'success' | 'error'>('idle');
  const [syncMessage, setSyncMessage] = createSignal<string | null>(null);
  let syncIntervalId: number | null = null;

  // File recovery state
  interface RecoverableFile {
    path: string;
    content: string;
    deletedAt: number;
    eventId: string;
  }
  const [recoverableFiles, setRecoverableFiles] = createSignal<RecoverableFile[]>([]);
  const [recoveryLoading, setRecoveryLoading] = createSignal(false);
  const [recoveryMessage, setRecoveryMessage] = createSignal<string | null>(null);
  const [recoveringFile, setRecoveringFile] = createSignal<string | null>(null);

  // Skills state
  const [availableSkills, setAvailableSkills] = createSignal<SkillInfo[]>([]);
  const [skillStates, setSkillStates] = createSignal<Record<string, SkillState>>({});
  const [skillsLoading, setSkillsLoading] = createSignal(true);
  const [skillsError, setSkillsError] = createSignal<string | null>(null);

  // Skills.sh library state
  type SkillsTab = 'recommended' | 'browse' | 'installed';
  const [skillsTab, setSkillsTab] = createSignal<SkillsTab>('recommended');
  const [skillsShList, setSkillsShList] = createSignal<SkillsShSkill[]>([]);
  const [skillsShLoading, setSkillsShLoading] = createSignal(false);
  const [skillsShError, setSkillsShError] = createSignal<string | null>(null);
  const [skillsShSearch, setSkillsShSearch] = createSignal('');
  const [skillsShSort, setSkillsShSort] = createSignal<SkillsSortOption>('popular');
  const [skillsShInstalling, setSkillsShInstalling] = createSignal<string | null>(null);
  const [skillsShInstalled, setSkillsShInstalled] = createSignal<Set<string>>(new Set());

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
  const [openCodeDetectedPath, setOpenCodeDetectedPath] = createSignal<string | null>(null);
  const [openCodeProviders, setOpenCodeProviders] = createSignal<ProviderInfo[]>([]);
  const [openCodeModel, setOpenCodeModel] = createSignal<string | null>(null);
  const [openCodeLoading, setOpenCodeLoading] = createSignal(false);
  const [openCodeServerRunning, setOpenCodeServerRunning] = createSignal(false);
  const [openCodeError, setOpenCodeError] = createSignal<string | null>(null);
  const [modelSearch, setModelSearch] = createSignal('');
  const [modelDropdownOpen, setModelDropdownOpen] = createSignal(false);
  let modelSearchRef: HTMLInputElement | undefined;
  let modelDropdownRef: HTMLDivElement | undefined;

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

      // Load blocked users list (in background, don't block UI)
      loadBlockedUsers();
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

  // Load skills.sh library
  const loadSkillsShLibrary = async () => {
    setSkillsShLoading(true);
    setSkillsShError(null);

    try {
      const skills = await fetchSkillsShLeaderboard();
      setSkillsShList(skills);

      // Check which skills.sh skills are already installed
      const installed = new Set<string>();
      for (const skill of skills) {
        const isInstalled = await isSkillInstalled(skill.id);
        if (isInstalled) {
          installed.add(skill.id);
        }
      }
      setSkillsShInstalled(installed);
    } catch (err) {
      console.error('Failed to load skills.sh library:', err);
      setSkillsShError(err instanceof Error ? err.message : 'Failed to load skills library');
    } finally {
      setSkillsShLoading(false);
    }
  };

  // Install a skill from skills.sh
  const handleSkillsShInstall = async (skill: SkillsShSkill) => {
    setSkillsShInstalling(skill.id);

    try {
      await installSkillFromSkillsSh(skill);
      setSkillsShInstalled(prev => new Set([...prev, skill.id]));
      // Refresh the recommended skills list to show the newly installed skill
      await loadSkillsManifest();
    } catch (err) {
      console.error(`Failed to install skill ${skill.id}:`, err);
      setModalConfig({
        type: 'info',
        title: 'Installation Failed',
        message: `Failed to install "${skill.name}": ${err instanceof Error ? err.message : 'Unknown error'}`,
      });
    } finally {
      setSkillsShInstalling(null);
    }
  };

  // Filtered and sorted skills.sh list
  const filteredSkillsShList = () => {
    let skills = skillsShList();
    if (skillsShSearch()) {
      skills = searchSkillsSh(skills, skillsShSearch());
    }
    return sortSkillsSh(skills, skillsShSort());
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

  // Logout
  const handleLogout = async () => {
    // Close signer connections
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
    setBlockedUsers([]);
    
    // Reset to import tab
    setLoginTab('import');
  };

  // Load blocked users list
  const loadBlockedUsers = async () => {
    if (!currentLogin()) return;
    
    setLoadingBlocked(true);
    try {
      const engine = getSyncEngine();
      const { pubkeys } = await engine.fetchMuteList();
      
      // Fetch profiles for each blocked user
      const usersWithProfiles = await Promise.all(
        pubkeys.map(async (pubkey) => {
          try {
            const profile = await fetchUserProfile(pubkey, relays().map(r => r.url));
            return {
              pubkey,
              name: profile?.displayName || profile?.name,
              picture: profile?.picture,
            };
          } catch {
            return { pubkey };
          }
        })
      );
      
      setBlockedUsers(usersWithProfiles);
    } catch (err) {
      console.error('Failed to load blocked users:', err);
    } finally {
      setLoadingBlocked(false);
    }
  };

  // Unblock a user
  const handleUnblockUser = async (pubkey: string) => {
    setUnblockingUser(pubkey);
    try {
      const engine = getSyncEngine();
      await engine.removeFromMuteList(pubkey);
      engine.invalidateMuteCache();
      
      // Remove from local state
      setBlockedUsers(prev => prev.filter(u => u.pubkey !== pubkey));
    } catch (err) {
      console.error('Failed to unblock user:', err);
    } finally {
      setUnblockingUser(null);
    }
  };

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

    // Security: Only allow secure WebSocket connections (wss://)
    // ws:// is unencrypted and vulnerable to MITM attacks
    if (!url.startsWith('wss://')) {
      setNewRelayUrl('');
      return;
    }

    // Check for duplicates
    if (relays().some(r => r.url === url)) {
      return;
    }

    const updated = [...relays(), { url, read: true, write: true }];
    setRelays(updated);
    setNewRelayUrl('');

    // Save to localStorage
    localStorage.setItem('nostr_relays', JSON.stringify(updated));

    // Update sync engine config (write relays only)
    const engine = getSyncEngine();
    engine.setConfig({ relays: updated.filter(r => r.write).map(r => r.url) });
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

    // Notify parent of sync status change
    props.onSyncEnabledChange?.(enabled);

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

      // Get locally deleted files that need to be synced
      const locallyDeletedPaths = JSON.parse(localStorage.getItem('deleted_paths') || '[]') as string[];
      const localFilePathSet = new Set(localFiles.map(f => f.path));

      // Push local files that are new or changed
      let uploadedCount = 0;
      let downloadedCount = 0;
      let deletedCount = 0;

      // Rate limit: delay between uploads to avoid spamming relays
      const UPLOAD_DELAY_MS = 500; // 500ms between uploads
      
      for (const localFile of localFiles) {
        const remoteFile = remoteFileMap.get(localFile.path);

        // Check if file needs to be uploaded (new or content changed)
        if (!remoteFile || remoteFile.data.content !== localFile.content) {
          setSyncMessage(`Uploading ${localFile.path}... (${uploadedCount + 1} files)`);
          const result = await engine.publishFile(vault, localFile.path, localFile.content, remoteFile);
          vault = result.vault; // Update vault with new file index
          uploadedCount++;
          
          // Add delay between uploads to avoid rate limiting
          if (uploadedCount > 0) {
            await new Promise(resolve => setTimeout(resolve, UPLOAD_DELAY_MS));
          }
        }

        // Remove from map so we know what's left (remote-only files)
        remoteFileMap.delete(localFile.path);
      }

      // Process local deletions - sync them to the vault
      const pathsToKeepTracking: string[] = [];
      
      for (const deletedPath of locallyDeletedPaths) {
        const inRemoteMap = remoteFileMap.has(deletedPath);
        const inLocalFiles = localFilePathSet.has(deletedPath);
        
        // Only process if the file exists on remote and not locally
        if (inRemoteMap && !inLocalFiles) {
          setSyncMessage(`Syncing deletion: ${deletedPath}`);
          try {
            vault = await engine.deleteFile(vault, deletedPath);
            deletedCount++;
          } catch {
            // Keep tracking this path since deletion failed
            pathsToKeepTracking.push(deletedPath);
          }
        } else if (inLocalFiles) {
          // File still exists locally (was recreated?), keep tracking
          pathsToKeepTracking.push(deletedPath);
        }
        // Remove from remoteFileMap so we don't re-download it
        remoteFileMap.delete(deletedPath);
      }
      
      // Update the locally deleted paths - only keep those that need continued tracking
      localStorage.setItem('deleted_paths', JSON.stringify(pathsToKeepTracking));


      // Download remote-only files (files on Nostr but not locally)
      for (const [path, remoteFile] of remoteFileMap) {
        // Skip if in vault's deleted list
        if (vault.data.deleted?.some(d => d.path === path)) {
          continue;
        }
        
        // Skip if locally deleted (but not yet synced)
        // Also check for folder deletions - if any deleted path is a prefix of this file path
        const isLocallyDeleted = locallyDeletedPaths.some(deletedPath => 
          path === deletedPath || path.startsWith(deletedPath + '/')
        );
        if (isLocallyDeleted) {
          continue;
        }

        setSyncMessage(`Downloading ${path}...`);
        const fullPath: string = `${props.vaultPath}/${path}`;

        // Ensure parent directory exists
        const parentDir: string = fullPath.substring(0, fullPath.lastIndexOf('/'));
        if (parentDir !== props.vaultPath) {
          await invoke('create_folder', { path: parentDir }).catch(() => {});
        }

        await invoke('write_file', { path: fullPath, content: remoteFile.data.content });
        downloadedCount++;
      }

      setSyncStatus('success');
      const totalSynced = vault.data.files?.length || 0;
      const parts = [];
      if (uploadedCount > 0) parts.push(`${uploadedCount} uploaded`);
      if (downloadedCount > 0) parts.push(`${downloadedCount} downloaded`);
      if (deletedCount > 0) parts.push(`${deletedCount} deleted`);
      if (parts.length === 0) {
        setSyncMessage(`Sync complete: all ${totalSynced} files up to date`);
      } else {
        setSyncMessage(`Sync complete: ${parts.join(', ')} (${totalSynced} total)`);
      }

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

  // File recovery handlers
  const handleScanForRecoverableFiles = async () => {
    if (!signer() || !props.vaultPath) return;

    setRecoveryLoading(true);
    setRecoveryMessage('Scanning Nostr for deleted files...');
    setRecoverableFiles([]);

    try {
      const engine = getSyncEngine();
      
      // Fetch all vaults
      const vaults = await engine.fetchVaults();
      if (vaults.length === 0) {
        setRecoveryMessage('No vault found on Nostr.');
        setRecoveryLoading(false);
        return;
      }

      const vault = vaults[0];
      
      // Get deleted files from vault index
      const deletedFiles = vault.data.deleted || [];
      
      if (deletedFiles.length === 0) {
        setRecoveryMessage('No deleted files found.');
        setRecoveryLoading(false);
        return;
      }

      // Fetch the actual file content for each deleted file
      const recoverable: RecoverableFile[] = [];
      
      for (const deleted of deletedFiles) {
        // Check if we can recover from the lastEventId
        if (deleted.lastEventId) {
          // The file content might still be available on relays
          // For now, we'll show what's in the deleted list
          recoverable.push({
            path: deleted.path,
            content: '', // We'll fetch content when recovering
            deletedAt: deleted.deletedAt,
            eventId: deleted.lastEventId,
          });
        }
      }

      setRecoverableFiles(recoverable);
      setRecoveryMessage(recoverable.length > 0 
        ? `Found ${recoverable.length} recoverable file(s).`
        : 'No recoverable files found.');
    } catch (err) {
      console.error('Recovery scan failed:', err);
      setRecoveryMessage(err instanceof Error ? err.message : 'Scan failed');
    } finally {
      setRecoveryLoading(false);
    }
  };

  const handleRecoverFile = async (file: RecoverableFile) => {
    if (!props.vaultPath) return;

    setRecoveringFile(file.path);
    
    try {
      const engine = getSyncEngine();
      
      // Fetch the file content from Nostr using the event ID
      const events = await engine['pool'].querySync(
        engine.getConfig().relays,
        { ids: [file.eventId] }
      );
      
      if (events.length === 0) {
        throw new Error('File content not found on relays');
      }
      
      const event = events[0];
      
      // Decrypt the content
      const decrypted = await engine['decryptContent'](event.content);
      const data = JSON.parse(decrypted);
      
      // Write the file locally
      const fullPath = `${props.vaultPath}/${file.path}`;
      const parentDir = fullPath.substring(0, fullPath.lastIndexOf('/'));
      
      if (parentDir !== props.vaultPath) {
        await invoke('create_folder', { path: parentDir }).catch(() => {});
      }
      
      await invoke('write_file', { path: fullPath, content: data.content });
      
      // Remove from recoverable list
      setRecoverableFiles(prev => prev.filter(f => f.path !== file.path));
      
      // Remove from local deleted_paths if present
      const deletedPaths = JSON.parse(localStorage.getItem('deleted_paths') || '[]') as string[];
      const updatedDeleted = deletedPaths.filter(p => p !== file.path);
      localStorage.setItem('deleted_paths', JSON.stringify(updatedDeleted));
      
      setRecoveryMessage(`Recovered: ${file.path}`);
      
      // Refresh file explorer
      props.onSyncComplete?.();
      
      // Clear message after 3 seconds
      setTimeout(() => {
        setRecoveryMessage(prev => prev === `Recovered: ${file.path}` ? null : prev);
      }, 3000);
    } catch (err) {
      console.error('Recovery failed:', err);
      setRecoveryMessage(`Failed to recover ${file.path}: ${err instanceof Error ? err.message : 'Unknown error'}`);
    } finally {
      setRecoveringFile(null);
    }
  };

  const handleClearDeletedHistory = async () => {
    // Clear local deleted paths tracking
    localStorage.setItem('deleted_paths', '[]');
    setRecoverableFiles([]);
    setRecoveryMessage('Deleted files history cleared.');
    
    setTimeout(() => {
      setRecoveryMessage(null);
    }, 3000);
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

  // Load OpenCode providers and current model
  const loadOpenCodeConfig = async () => {
    setOpenCodeLoading(true);
    setOpenCodeError(null);
    try {
      // Try to auto-detect OpenCode installation
      try {
        const detectedPath = await invoke<string | null>('check_opencode_installed');
        setOpenCodeDetectedPath(detectedPath);
        
        // If we detected a path and user hasn't set a custom one, use the detected path
        const savedPath = localStorage.getItem('opencode_path');
        if (detectedPath && !savedPath) {
          setOpenCodePath(detectedPath);
          localStorage.setItem('opencode_path', detectedPath);
        }
      } catch (err) {
        console.log('Could not auto-detect OpenCode:', err);
        setOpenCodeDetectedPath(null);
      }
      
      initClient();
      const running = await isServerRunning();
      setOpenCodeServerRunning(running);
      
      if (running) {
        const [providers, currentModel] = await Promise.all([
          getProviders(),
          getCurrentModel(),
        ]);
        setOpenCodeProviders(providers);
        setOpenCodeModel(currentModel);
      }
    } catch (err) {
      console.error('Failed to load OpenCode config:', err);
      setOpenCodeError(err instanceof Error ? err.message : 'Failed to load configuration');
    } finally {
      setOpenCodeLoading(false);
    }
  };

  // Handle model change
  const handleModelChange = async (model: string) => {
    try {
      await setCurrentModel(model);
      setOpenCodeModel(model);
      setModelDropdownOpen(false);
      setModelSearch('');
    } catch (err) {
      console.error('Failed to set model:', err);
    }
  };

  // Filter models based on search
  const filteredProviders = () => {
    const search = modelSearch().toLowerCase().trim();
    if (!search) return openCodeProviders();
    
    return openCodeProviders()
      .map(provider => ({
        ...provider,
        models: provider.models.filter(model => 
          model.name.toLowerCase().includes(search) ||
          model.id.toLowerCase().includes(search) ||
          provider.name.toLowerCase().includes(search)
        )
      }))
      .filter(provider => provider.models.length > 0);
  };

  // Get display name for current model
  const currentModelDisplayName = () => {
    const model = openCodeModel();
    if (!model) return null;
    
    for (const provider of openCodeProviders()) {
      for (const m of provider.models) {
        if (`${provider.id}/${m.id}` === model) {
          return `${provider.name} / ${m.name}`;
        }
      }
    }
    return model; // Fallback to raw model string
  };

  // Handle click outside to close dropdown
  const handleClickOutside = (e: MouseEvent) => {
    if (modelDropdownRef && !modelDropdownRef.contains(e.target as Node)) {
      setModelDropdownOpen(false);
    }
  };

  // Load OpenCode config when switching to opencode section
  createEffect(() => {
    if (activeSection() === 'opencode') {
      loadOpenCodeConfig();
    }
  });

  // Add/remove click outside listener
  createEffect(() => {
    if (modelDropdownOpen()) {
      document.addEventListener('mousedown', handleClickOutside);
      // Focus the search input when dropdown opens
      setTimeout(() => modelSearchRef?.focus(), 0);
    } else {
      document.removeEventListener('mousedown', handleClickOutside);
    }
  });

  // Cleanup listener on unmount
  onCleanup(() => {
    document.removeEventListener('mousedown', handleClickOutside);
  });

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
        } else if (selected.endsWith('.zip')) {
          // Import ZIP archive
          const skillId = await invoke<string>('skill_import_zip', { zipPath: selected });
          
          // Read the SKILL.md to get the skill name
          const content = await invoke<string>('skill_read_file', { skillId, fileName: 'SKILL.md' });
          const skillName = parseSkillName(content, skillId);
          
          setModalConfig({
            type: 'info',
            title: 'Skill imported',
            message: `Successfully imported skill "${skillName}" from ZIP archive.`
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
            <For each={filteredSections()}>
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
            <h2>{filteredSections().find(s => s.id === activeSection())?.label}</h2>
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
                  <p>OpenCode is an AI coding assistant. Configure your preferred AI provider and model below.</p>
                </div>

                {/* Model Selection */}
                <div class="settings-section-title">AI Model</div>
                
                <Show when={openCodeLoading()}>
                  <div class="setting-item">
                    <div class="opencode-loading">
                      <div class="spinner"></div>
                      <span>Loading providers...</span>
                    </div>
                  </div>
                </Show>

                <Show when={!openCodeLoading() && openCodeError()}>
                  <div class="settings-notice warning">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <circle cx="12" cy="12" r="10"></circle>
                      <line x1="12" y1="8" x2="12" y2="12"></line>
                      <line x1="12" y1="16" x2="12.01" y2="16"></line>
                    </svg>
                    <p>Error loading configuration: {openCodeError()}</p>
                  </div>
                </Show>

                <Show when={!openCodeLoading() && !openCodeError() && !openCodeServerRunning()}>
                  <div class="settings-notice warning">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <circle cx="12" cy="12" r="10"></circle>
                      <line x1="12" y1="8" x2="12" y2="12"></line>
                      <line x1="12" y1="16" x2="12.01" y2="16"></line>
                    </svg>
                    <p>OpenCode server is not running. Open the OpenCode panel to start it, then return here to configure the model.</p>
                  </div>
                </Show>

                <Show when={!openCodeLoading() && openCodeServerRunning()}>
                  <div class="setting-item">
                    <div class="setting-info">
                      <div class="setting-name">Provider / Model</div>
                      <div class="setting-description">Select the AI provider and model to use for chat</div>
                    </div>
                  </div>

                  <div class="setting-item column">
                    <Show when={openCodeProviders().length > 0} fallback={
                      <div class="settings-notice">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <circle cx="12" cy="12" r="10"></circle>
                          <line x1="12" y1="8" x2="12" y2="12"></line>
                          <line x1="12" y1="16" x2="12.01" y2="16"></line>
                        </svg>
                        <p>No providers configured. Set up API keys for providers like Anthropic, OpenAI, or OpenRouter in your OpenCode config file.</p>
                      </div>
                    }>
                      <div class="model-selector" ref={modelDropdownRef}>
                        <button 
                          class="model-selector-trigger"
                          onClick={() => setModelDropdownOpen(!modelDropdownOpen())}
                        >
                          <span class="model-selector-value">
                            {currentModelDisplayName() || 'Select a model...'}
                          </span>
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="6 9 12 15 18 9"></polyline>
                          </svg>
                        </button>
                        
                        <Show when={modelDropdownOpen()}>
                          <div class="model-selector-dropdown">
                            <div class="model-selector-search">
                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="11" cy="11" r="8"></circle>
                                <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                              </svg>
                              <input
                                ref={modelSearchRef}
                                type="text"
                                placeholder="Search models..."
                                value={modelSearch()}
                                onInput={(e) => setModelSearch(e.currentTarget.value)}
                                onKeyDown={(e) => {
                                  if (e.key === 'Escape') {
                                    setModelDropdownOpen(false);
                                    setModelSearch('');
                                  }
                                }}
                              />
                              <Show when={modelSearch()}>
                                <button 
                                  class="model-search-clear"
                                  onClick={() => setModelSearch('')}
                                >
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <line x1="18" y1="6" x2="6" y2="18"></line>
                                    <line x1="6" y1="6" x2="18" y2="18"></line>
                                  </svg>
                                </button>
                              </Show>
                            </div>
                            
                            <div class="model-selector-options">
                              <Show when={filteredProviders().length > 0} fallback={
                                <div class="model-selector-empty">No models match "{modelSearch()}"</div>
                              }>
                                <For each={filteredProviders()}>
                                  {(provider) => (
                                    <div class="model-selector-group">
                                      <div class="model-selector-group-label">{provider.name}</div>
                                      <For each={provider.models}>
                                        {(model) => (
                                          <button
                                            class={`model-selector-option ${openCodeModel() === `${provider.id}/${model.id}` ? 'selected' : ''}`}
                                            onClick={() => handleModelChange(`${provider.id}/${model.id}`)}
                                          >
                                            <span class="model-name">{model.name}</span>
                                            <Show when={openCodeModel() === `${provider.id}/${model.id}`}>
                                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                                <polyline points="20 6 9 17 4 12"></polyline>
                                              </svg>
                                            </Show>
                                          </button>
                                        )}
                                      </For>
                                    </div>
                                  )}
                                </For>
                              </Show>
                            </div>
                          </div>
                        </Show>
                      </div>
                    </Show>
                  </div>

                  <Show when={openCodeModel()}>
                    <div class="setting-item">
                      <div class="setting-info">
                        <div class="setting-name">Current model</div>
                        <div class="setting-description opencode-current-model">{openCodeModel()}</div>
                      </div>
                    </div>
                  </Show>
                </Show>

                <div class="settings-section-title">Binary Path</div>
                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">OpenCode binary path</div>
                    <div class="setting-description">Leave empty to use system PATH, or specify the full path to the OpenCode executable</div>
                  </div>
                </div>

                {/* Show auto-detected path info */}
                <Show when={openCodeDetectedPath()}>
                  <div class="settings-notice success">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                      <polyline points="22 4 12 14.01 9 11.01"></polyline>
                    </svg>
                    <div>
                      <p><strong>OpenCode detected</strong></p>
                      <p class="detected-path">{openCodeDetectedPath()}</p>
                    </div>
                  </div>
                </Show>

                <Show when={!openCodeDetectedPath() && !openCodePath()}>
                  <div class="settings-notice warning">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <circle cx="12" cy="12" r="10"></circle>
                      <line x1="12" y1="8" x2="12" y2="12"></line>
                      <line x1="12" y1="16" x2="12.01" y2="16"></line>
                    </svg>
                    <p>OpenCode not found. Use the OpenCode panel to install it automatically, or specify the path below.</p>
                  </div>
                </Show>

                <div class="setting-item column">
                  <div class="opencode-path-input">
                    <input
                      type="text"
                      class="setting-input wide"
                      placeholder={openCodeDetectedPath() || "e.g., /usr/local/bin/opencode"}
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
                      <button class="setting-button secondary" onClick={handleClearOpenCodePath} title="Clear path and use auto-detected">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <line x1="18" y1="6" x2="6" y2="18"></line>
                          <line x1="6" y1="6" x2="18" y2="18"></line>
                        </svg>
                      </button>
                    </Show>
                  </div>
                  <Show when={openCodePath() && openCodePath() !== openCodeDetectedPath()}>
                    <p class="setting-hint">Custom path overrides auto-detected location</p>
                  </Show>
                </div>

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
                  <p>AI skills enhance OpenCode with specialized capabilities. Skills are stored in <code>~/.config/opencode/skills/</code></p>
                </div>

                {/* Skills tabs */}
                <div class="skills-tabs">
                  <button
                    class={`skills-tab ${skillsTab() === 'recommended' ? 'active' : ''}`}
                    onClick={() => setSkillsTab('recommended')}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"></polygon>
                    </svg>
                    Recommended
                  </button>
                  <button
                    class={`skills-tab ${skillsTab() === 'browse' ? 'active' : ''}`}
                    onClick={() => {
                      setSkillsTab('browse');
                      if (skillsShList().length === 0 && !skillsShLoading()) {
                        loadSkillsShLibrary();
                      }
                    }}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <circle cx="11" cy="11" r="8"></circle>
                      <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                    </svg>
                    Browse Library
                  </button>
                  <button
                    class={`skills-tab ${skillsTab() === 'installed' ? 'active' : ''}`}
                    onClick={() => setSkillsTab('installed')}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                      <polyline points="22 4 12 14.01 9 11.01"></polyline>
                    </svg>
                    Installed
                  </button>
                </div>

                {/* Recommended Skills Tab */}
                <Show when={skillsTab() === 'recommended'}>
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
                      <For each={availableSkills().filter(s => !s.isCustom)}>
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
                                  <Show when={state().installed}>
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
                </Show>

                {/* Browse Library Tab (skills.sh) */}
                <Show when={skillsTab() === 'browse'}>
                  {/* Search and filter bar */}
                  <div class="skills-search-bar">
                    <div class="skills-search-input">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="11" cy="11" r="8"></circle>
                        <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                      </svg>
                      <input
                        type="text"
                        placeholder="Search skills..."
                        value={skillsShSearch()}
                        onInput={(e) => setSkillsShSearch(e.currentTarget.value)}
                      />
                    </div>
                    <select
                      class="skills-sort-select"
                      value={skillsShSort()}
                      onChange={(e) => setSkillsShSort(e.currentTarget.value as SkillsSortOption)}
                    >
                      <option value="popular">Most Popular</option>
                      <option value="name">Name A-Z</option>
                      <option value="source">By Source</option>
                    </select>
                  </div>

                  <Show when={skillsShLoading()}>
                    <div class="skills-loading">
                      <div class="spinner"></div>
                      <span>Loading skills library...</span>
                    </div>
                  </Show>

                  <Show when={skillsShError()}>
                    <div class="settings-notice warning">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                        <line x1="12" y1="9" x2="12" y2="13"></line>
                        <line x1="12" y1="17" x2="12.01" y2="17"></line>
                      </svg>
                      <p>{skillsShError()}</p>
                    </div>
                    <button class="setting-button" onClick={loadSkillsShLibrary}>Retry</button>
                  </Show>

                  <Show when={!skillsShLoading() && !skillsShError()}>
                    <div class="skills-sh-info">
                      <span>Powered by <a href="https://skills.sh" target="_blank" rel="noopener noreferrer">skills.sh</a></span>
                      <span class="skills-count">{filteredSkillsShList().length} skills</span>
                    </div>
                    <div class="skills-list skills-sh-list">
                      <For each={filteredSkillsShList()}>
                        {(skill) => {
                          const isInstalled = () => skillsShInstalled().has(skill.id);
                          const isInstalling = () => skillsShInstalling() === skill.id;
                          return (
                            <div class={`skill-item ${isInstalled() ? 'enabled' : ''} ${isInstalling() ? 'downloading' : ''}`}>
                              <div class="skill-icon">
                                <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                  <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"></path>
                                </svg>
                              </div>
                              <div class="skill-info">
                                <div class="skill-header">
                                  <span class="skill-name">{skill.name}</span>
                                  <span class="skill-badge installs" title={`${skill.installs.toLocaleString()} installs`}>
                                    {formatInstallCount(skill.installs)}
                                  </span>
                                  <Show when={isInstalled()}>
                                    <span class="skill-badge installed">Installed</span>
                                  </Show>
                                </div>
                                <span class="skill-source">{skill.topSource}</span>
                              </div>
                              <div class="skill-actions">
                                <Show when={isInstalling()}>
                                  <div class="spinner small"></div>
                                </Show>
                                <Show when={!isInstalling()}>
                                  <button
                                    class="skill-source-btn"
                                    onClick={() => open(getSkillGitHubUrl(skill.topSource, skill.id))}
                                    title="View on GitHub"
                                  >
                                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                      <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                                      <polyline points="15 3 21 3 21 9"></polyline>
                                      <line x1="10" y1="14" x2="21" y2="3"></line>
                                    </svg>
                                  </button>
                                  <Show when={!isInstalled()}>
                                    <button
                                      class="setting-button small"
                                      onClick={() => handleSkillsShInstall(skill)}
                                      title="Install skill"
                                    >
                                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                                        <polyline points="7 10 12 15 17 10"></polyline>
                                        <line x1="12" y1="15" x2="12" y2="3"></line>
                                      </svg>
                                      Add
                                    </button>
                                  </Show>
                                  <Show when={isInstalled()}>
                                    <span class="skill-installed-check">
                                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                        <polyline points="20 6 9 17 4 12"></polyline>
                                      </svg>
                                    </span>
                                  </Show>
                                </Show>
                              </div>
                            </div>
                          );
                        }}
                      </For>
                    </div>
                  </Show>
                </Show>

                {/* Installed Skills Tab */}
                <Show when={skillsTab() === 'installed'}>
                  <Show when={skillsLoading()}>
                    <div class="skills-loading">
                      <div class="spinner"></div>
                      <span>Loading installed skills...</span>
                    </div>
                  </Show>

                  <Show when={!skillsLoading()}>
                    <div class="skills-list">
                      <For each={availableSkills().filter(s => {
                        const state = skillStates()[s.id];
                        return state?.installed || state?.enabled;
                      })}>
                        {(skill) => {
                          const state = () => skillStates()[skill.id] || { installed: false, enabled: false, downloading: false };
                          return (
                            <div class={`skill-item enabled`}>
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
                                </div>
                                <p class="skill-description">{skill.description}</p>
                                <span class="skill-category">{skill.category}</span>
                              </div>
                              <div class="skill-actions">
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
                              </div>
                            </div>
                          );
                        }}
                      </For>

                      <Show when={availableSkills().filter(s => {
                        const state = skillStates()[s.id];
                        return state?.installed || state?.enabled;
                      }).length === 0}>
                        <div class="skills-empty">
                          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                            <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"></path>
                          </svg>
                          <p>No skills installed yet</p>
                          <span>Browse the library or check out recommended skills to get started.</span>
                        </div>
                      </Show>
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
                </Show>
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

                  {/* File Recovery Section */}
                  <div class="settings-section-title">File Recovery</div>
                  <div class="settings-notice">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M3 6h18"></path>
                      <path d="M19 6v14c0 1-1 2-2 2H7c-1 0-2-1-2-2V6"></path>
                      <path d="M8 6V4c0-1 1-2 2-2h4c1 0 2 1 2 2v2"></path>
                      <line x1="10" y1="11" x2="10" y2="17"></line>
                      <line x1="14" y1="11" x2="14" y2="17"></line>
                    </svg>
                    <p>Recover files that were deleted locally but may still exist on Nostr relays. This is a failsafe for accidental deletions.</p>
                  </div>

                  <div class="setting-item">
                    <div class="setting-info">
                      <div class="setting-name">Scan for recoverable files</div>
                      <div class="setting-description">Search Nostr for deleted files that can be restored</div>
                    </div>
                    <button
                      class="setting-button"
                      onClick={handleScanForRecoverableFiles}
                      disabled={recoveryLoading()}
                    >
                      {recoveryLoading() ? 'Scanning...' : 'Scan'}
                    </button>
                  </div>

                  <Show when={recoveryMessage()}>
                    <div class="sync-feedback idle">
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"></circle>
                        <line x1="12" y1="16" x2="12" y2="12"></line>
                        <line x1="12" y1="8" x2="12.01" y2="8"></line>
                      </svg>
                      <span>{recoveryMessage()}</span>
                    </div>
                  </Show>

                  <Show when={recoverableFiles().length > 0}>
                    <div class="recoverable-files-list">
                      <For each={recoverableFiles()}>
                        {(file) => (
                          <div class="recoverable-file-item">
                            <div class="recoverable-file-info">
                              <div class="recoverable-file-path">{file.path}</div>
                              <div class="recoverable-file-date">
                                Deleted: {new Date(file.deletedAt * 1000).toLocaleString()}
                              </div>
                            </div>
                            <button
                              class="setting-button small"
                              onClick={() => handleRecoverFile(file)}
                              disabled={recoveringFile() === file.path}
                            >
                              {recoveringFile() === file.path ? 'Recovering...' : 'Recover'}
                            </button>
                          </div>
                        )}
                      </For>
                    </div>
                  </Show>

                  <div class="setting-item">
                    <div class="setting-info">
                      <div class="setting-name">Clear deletion history</div>
                      <div class="setting-description">Remove local tracking of deleted files (prevents re-download on next sync)</div>
                    </div>
                    <button
                      class="setting-button secondary"
                      onClick={handleClearDeletedHistory}
                    >
                      Clear History
                    </button>
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
                          <span class="login-type-badge">Local Key</span>
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
                            <button class="key-action-btn" onClick={async () => {
                              if (!showPrivateKey() && isMobile()) {
                                // Require biometric to show nsec on mobile
                                const authenticated = await authenticateWithBiometric('View your private key');
                                if (!authenticated) return;
                              }
                              setShowPrivateKey(!showPrivateKey());
                            }} title={showPrivateKey() ? "Hide" : "Show"}>
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
                            <button class="key-action-btn" onClick={async () => {
                              if (isMobile()) {
                                // Require biometric to copy nsec on mobile
                                const authenticated = await authenticateWithBiometric('Copy your private key');
                                if (!authenticated) return;
                              }
                              copyToClipboard(identity()!.nsec);
                            }} title="Copy">
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
                      title="Only secure WebSocket connections (wss://) are allowed"
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

                <Show when={currentLogin()}>
                  <div class="settings-section-title">Blocked Users</div>
                  <div class="setting-item column">
                    <div class="setting-info">
                      <div class="setting-name">Muted accounts</div>
                      <div class="setting-description">Users you've blocked won't be able to share documents with you (NIP-51 mute list)</div>
                    </div>
                    
                    <Show when={loadingBlocked()}>
                      <div class="blocked-users-loading">
                        <div class="spinner small"></div>
                        <span>Loading blocked users...</span>
                      </div>
                    </Show>

                    <Show when={!loadingBlocked()}>
                      <div class="blocked-users-list">
                        <For each={blockedUsers()}>
                          {(user) => (
                            <div class="blocked-user-item">
                              <div class="blocked-user-avatar">
                                <Show when={user.picture} fallback={
                                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                                    <circle cx="12" cy="7" r="4"></circle>
                                  </svg>
                                }>
                                  <img src={user.picture} alt="" />
                                </Show>
                              </div>
                              <div class="blocked-user-info">
                                <Show when={user.name} fallback={
                                  <span class="blocked-user-pubkey">{user.pubkey.slice(0, 12)}...{user.pubkey.slice(-6)}</span>
                                }>
                                  <span class="blocked-user-name">{user.name}</span>
                                </Show>
                              </div>
                              <button 
                                class="setting-button secondary small"
                                onClick={() => handleUnblockUser(user.pubkey)}
                                disabled={unblockingUser() === user.pubkey}
                              >
                                <Show when={unblockingUser() === user.pubkey}>
                                  <div class="spinner small"></div>
                                </Show>
                                <Show when={unblockingUser() !== user.pubkey}>
                                  Unblock
                                </Show>
                              </button>
                            </div>
                          )}
                        </For>
                        <Show when={blockedUsers().length === 0}>
                          <div class="blocked-users-empty">
                            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                              <circle cx="12" cy="12" r="10"></circle>
                              <line x1="4.93" y1="4.93" x2="19.07" y2="19.07"></line>
                            </svg>
                            <span>No blocked users</span>
                          </div>
                        </Show>
                      </div>
                    </Show>
                  </div>
                </Show>
              </div>
            </Show>

            {/* About */}
            <Show when={activeSection() === 'about'}>
              <div class="settings-section about">
                <div class="about-header">
                  <div class="about-logo">
                    <svg width="64" height="64" viewBox="0 0 512 512">
                      <defs>
                        <linearGradient id="aboutRockShine" x1="0%" y1="0%" x2="100%" y2="100%">
                          <stop offset="0%" style="stop-color:#3a3a3a"/>
                          <stop offset="30%" style="stop-color:#1a1a1a"/>
                          <stop offset="70%" style="stop-color:#0a0a0a"/>
                          <stop offset="100%" style="stop-color:#000000"/>
                        </linearGradient>
                        <linearGradient id="aboutHighlight" x1="0%" y1="0%" x2="100%" y2="100%">
                          <stop offset="0%" style="stop-color:#4a4a4a"/>
                          <stop offset="100%" style="stop-color:#2a2a2a"/>
                        </linearGradient>
                      </defs>
                      <g>
                        <polygon points="256,48 380,140 420,280 350,420 162,420 92,280 132,140" fill="#0a0a0a"/>
                        <polygon points="132,140 92,280 162,420 200,320 180,200" fill="#151515"/>
                        <polygon points="380,140 420,280 350,420 312,320 332,200" fill="#101010"/>
                        <polygon points="162,420 350,420 312,320 256,360 200,320" fill="#080808"/>
                        <polygon points="256,48 132,140 180,200 256,160" fill="url(#aboutHighlight)"/>
                        <polygon points="256,48 380,140 332,200 256,160" fill="#2a2a2a"/>
                        <polygon points="180,200 332,200 312,320 256,360 200,320" fill="url(#aboutRockShine)"/>
                        <polygon points="200,210 280,210 260,260 210,250" fill="#4a4a4a" opacity="0.3"/>
                        <polygon points="210,220 250,220 240,245 215,240" fill="#5a5a5a" opacity="0.2"/>
                      </g>
                      <polygon points="256,48 380,140 420,280 350,420 162,420 92,280 132,140" fill="none" stroke="#2a2a2a" stroke-width="2"/>
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
