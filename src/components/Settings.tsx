import { Component, createSignal, For, Show, onMount, onCleanup, createEffect } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { getVersion } from '@tauri-apps/api/app';
import { open } from '@tauri-apps/plugin-shell';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import {
  getSyncEngine,
  setOnSaveSyncCallback,
  calculateChecksum,
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
  getAllProvidersWithAuthStatus,
  setProviderApiKey,
  removeProviderAuth,
  startProviderOAuth,
  type ProviderInfo,
  type ProviderAuthInfo,
} from '../lib/opencode/client';
import {
  getSkillsStatus,
  updateSkill,
  installSkill,
  type SkillStatus,
} from '../lib/openclaw/gateway';
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
import {
  loadDailyNotesConfig,
  saveDailyNotesConfig,
  DEFAULT_DAILY_NOTES_CONFIG,
  type DailyNotesConfig,
} from '../lib/daily-notes';
import {
  loadTemplatesConfig,
  saveTemplatesConfig,
  DEFAULT_TEMPLATES_CONFIG,
  type TemplatesConfig,
} from '../lib/templates';

type SettingsSection = 'general' | 'editor' | 'files' | 'appearance' | 'hotkeys' | 'opencode' | 'openclaw' | 'customprovider' | 'productivity' | 'sync' | 'nostr' | 'about';
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
  { id: 'openclaw', label: 'OpenClaw', icon: 'm175.656 22.375-48.47 82.094c-23.017 4.384-43.547 11.782-60.124 22.374-24.436 15.613-40.572 37.414-45.5 67.875-4.79 29.62 1.568 68.087 24.125 116.093 93.162 22.88 184.08-10.908 257.25-18.813 37.138-4.012 71.196-.898 96.344 22.97 22.33 21.19 36.21 56.808 41.908 113.436 29.246-35.682 44.538-69.065 49.343-99.594 5.543-35.207-2.526-66.97-20.31-95.593-8.52-13.708-19.368-26.618-32-38.626l14.217-33-41.218 10.625c-8.637-6.278-17.765-12.217-27.314-17.782l-7.03-59.782-38.157 37.406a423.505 423.505 0 0 0-38.158-13.812l-8.375-71.28-57.625 56.5c-9.344-1.316-18.625-2.333-27.812-2.97l-31.094-78.125zM222 325.345c-39.146 7.525-82.183 14.312-127.156 11.686 47.403 113.454 207.056 224.082 260.125 87-101.18 33.84-95.303-49.595-132.97-98.686z' },
  { id: 'customprovider', label: 'Custom Provider', icon: 'M12 2L2 7l10 5 10-5-10-5z M2 17l10 5 10-5 M2 12l10 5 10-5' },
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
      return sections.filter(s => s.id !== 'opencode' && s.id !== 'openclaw' && s.id !== 'customprovider' && s.id !== 'productivity' && s.id !== 'hotkeys');
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

  // Skill edit modal state
  const [editingSkill, setEditingSkill] = createSignal<{
    skillId: string;
    skillName: string;
    content: string;
    originalContent: string;
    isCustom: boolean;
    saving: boolean;
    resetting: boolean;
  } | null>(null);
  const [skillModified, setSkillModified] = createSignal<Set<string>>(new Set(
    JSON.parse(localStorage.getItem('skill_modified_ids') || '[]')
  ));

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

  // API Keys settings
  const [apiKeyProviders, setApiKeyProviders] = createSignal<ProviderAuthInfo[]>([]);
  const [apiKeysLoading, setApiKeysLoading] = createSignal(false);
  const [apiKeyInputs, setApiKeyInputs] = createSignal<Record<string, string>>({});
  const [apiKeySaving, setApiKeySaving] = createSignal<string | null>(null);
  const [apiKeyError, setApiKeyError] = createSignal<string | null>(null);
  const [expandedProvider, setExpandedProvider] = createSignal<string | null>(null);
  
  // Provider picker modal
  const [providerPickerOpen, setProviderPickerOpen] = createSignal(false);
  const [providerSearch, setProviderSearch] = createSignal('');
  let providerSearchRef: HTMLInputElement | undefined;

  // OpenClaw settings
  const [openClawUrl, setOpenClawUrl] = createSignal<string>(
    localStorage.getItem('openclaw_url') || ''
  );
  const [openClawToken, setOpenClawToken] = createSignal<string>(
    localStorage.getItem('openclaw_token') || ''
  );
  const [openClawTokenVisible, setOpenClawTokenVisible] = createSignal(false);
  const [openClawTestStatus, setOpenClawTestStatus] = createSignal<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [openClawTestError, setOpenClawTestError] = createSignal<string | null>(null);

  // OpenClaw Skills state
  const [openClawSkillsTab, setOpenClawSkillsTab] = createSignal<'config' | 'skills'>('config');
  const [openClawSkills, setOpenClawSkills] = createSignal<SkillStatus[]>([]);
  const [openClawSkillsLoading, setOpenClawSkillsLoading] = createSignal(false);
  const [openClawSkillsError, setOpenClawSkillsError] = createSignal<string | null>(null);
  const [openClawSkillInstalling, setOpenClawSkillInstalling] = createSignal<string | null>(null);
  const [openClawSkillToggling, setOpenClawSkillToggling] = createSignal<string | null>(null);
  const [openClawSkillSearch, setOpenClawSkillSearch] = createSignal('');
  const [viewingOpenClawSkill, setViewingOpenClawSkill] = createSignal<SkillStatus | null>(null);

  const loadOpenClawSkills = async () => {
    setOpenClawSkillsLoading(true);
    setOpenClawSkillsError(null);
    try {
      const report = await getSkillsStatus();
      setOpenClawSkills(report.skills);
    } catch (err: any) {
      setOpenClawSkillsError(err.message || err || 'Failed to fetch skills');
    } finally {
      setOpenClawSkillsLoading(false);
    }
  };

  const handleOpenClawSkillToggle = async (skill: SkillStatus) => {
    setOpenClawSkillToggling(skill.skillKey);
    try {
      await updateSkill({ skillKey: skill.skillKey, enabled: skill.disabled });
      await loadOpenClawSkills(); // Refresh
    } catch (err: any) {
      setOpenClawSkillsError(err.message || 'Failed to update skill');
    } finally {
      setOpenClawSkillToggling(null);
    }
  };

  const handleOpenClawSkillInstall = async (skill: SkillStatus, installOptionId: string) => {
    setOpenClawSkillInstalling(skill.skillKey);
    try {
      const result = await installSkill(skill.name, installOptionId);
      if (!result.ok) {
        setOpenClawSkillsError(result.message || 'Install failed');
      }
      await loadOpenClawSkills(); // Refresh
    } catch (err: any) {
      setOpenClawSkillsError(err.message || 'Install failed');
    } finally {
      setOpenClawSkillInstalling(null);
    }
  };

  const filteredOpenClawSkills = () => {
    const query = openClawSkillSearch().toLowerCase();
    const skills = openClawSkills();
    if (!query) return skills;
    return skills.filter(s =>
      s.name.toLowerCase().includes(query) ||
      s.description.toLowerCase().includes(query) ||
      s.skillKey.toLowerCase().includes(query)
    );
  };

  const handleOpenClawUrlChange = (value: string) => {
    setOpenClawUrl(value);
    localStorage.setItem('openclaw_url', value);
    window.dispatchEvent(new CustomEvent('openclaw-settings-changed'));
  };

  const handleOpenClawTokenChange = (value: string) => {
    setOpenClawToken(value);
    localStorage.setItem('openclaw_token', value);
    window.dispatchEvent(new CustomEvent('openclaw-settings-changed'));
  };

  const handleTestOpenClawConnection = async () => {
    const url = openClawUrl();
    const token = openClawToken();
    if (!url || !token) return;

    setOpenClawTestStatus('testing');
    setOpenClawTestError(null);

    try {
      const baseUrl = url.replace(/\/+$/, '');
      await invoke('openclaw_request', {
        url: `${baseUrl}/v1/chat/completions`,
        token,
        body: JSON.stringify({
          model: 'openclaw:main',
          messages: [{ role: 'user', content: 'ping' }],
          stream: false,
        }),
      });
      setOpenClawTestStatus('success');
    } catch (err: any) {
      setOpenClawTestStatus('error');
      setOpenClawTestError(err.message || err || 'Connection failed');
    }
  };

  // Custom Provider state
  const [customProviderUrl, setCustomProviderUrl] = createSignal<string>(
    localStorage.getItem('custom_provider_url') || ''
  );
  const [customProviderApiKey, setCustomProviderApiKey] = createSignal<string>(
    localStorage.getItem('custom_provider_api_key') || ''
  );
  const [customProviderName, setCustomProviderName] = createSignal<string>(
    localStorage.getItem('custom_provider_name') || ''
  );
  const [customProviderApiKeyVisible, setCustomProviderApiKeyVisible] = createSignal(false);
  const [customProviderModels, setCustomProviderModels] = createSignal<string[]>(
    (() => {
      try {
        const stored = localStorage.getItem('custom_provider_models');
        return stored ? JSON.parse(stored) : [];
      } catch { return []; }
    })()
  );
  const [customProviderModel, setCustomProviderModel] = createSignal<string>(
    localStorage.getItem('custom_provider_model') || ''
  );
  const [customProviderTestStatus, setCustomProviderTestStatus] = createSignal<'idle' | 'testing' | 'success' | 'error'>('idle');
  const [customProviderTestError, setCustomProviderTestError] = createSignal<string | null>(null);
  const [customProviderModelsLoading, setCustomProviderModelsLoading] = createSignal(false);

  const handleCustomProviderUrlChange = (value: string) => {
    setCustomProviderUrl(value);
    localStorage.setItem('custom_provider_url', value);
    window.dispatchEvent(new CustomEvent('custom-provider-settings-changed'));
  };

  const handleCustomProviderApiKeyChange = (value: string) => {
    setCustomProviderApiKey(value);
    localStorage.setItem('custom_provider_api_key', value);
    window.dispatchEvent(new CustomEvent('custom-provider-settings-changed'));
  };

  const handleCustomProviderNameChange = (value: string) => {
    setCustomProviderName(value);
    localStorage.setItem('custom_provider_name', value);
    window.dispatchEvent(new CustomEvent('custom-provider-settings-changed'));
  };

  const handleCustomProviderModelChange = (value: string) => {
    setCustomProviderModel(value);
    localStorage.setItem('custom_provider_model', value);
    window.dispatchEvent(new CustomEvent('custom-provider-settings-changed'));
  };

  const handleFetchCustomProviderModels = async () => {
    const url = customProviderUrl();
    if (!url) return;

    setCustomProviderModelsLoading(true);
    try {
      const baseUrl = url.replace(/\/+$/, '');
      const apiKey = customProviderApiKey();
      const response = await invoke<string>('custom_provider_list_models', {
        url: `${baseUrl}/v1/models`,
        apiKey,
      });
      const data = JSON.parse(response);
      const models: string[] = (data.data || []).map((m: { id: string }) => m.id).sort();
      setCustomProviderModels(models);
      localStorage.setItem('custom_provider_models', JSON.stringify(models));
      // Auto-select first model if none selected
      if (!customProviderModel() && models.length > 0) {
        handleCustomProviderModelChange(models[0]);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setCustomProviderTestError(`Failed to fetch models: ${message}`);
      setCustomProviderTestStatus('error');
    } finally {
      setCustomProviderModelsLoading(false);
    }
  };

  const handleTestCustomProviderConnection = async () => {
    const url = customProviderUrl();
    if (!url) return;

    setCustomProviderTestStatus('testing');
    setCustomProviderTestError(null);

    try {
      const baseUrl = url.replace(/\/+$/, '');
      const apiKey = customProviderApiKey();
      const model = customProviderModel() || 'test';
      await invoke('custom_provider_request', {
        url: `${baseUrl}/v1/chat/completions`,
        apiKey,
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: 'ping' }],
          stream: false,
          max_tokens: 1,
        }),
      });
      setCustomProviderTestStatus('success');
    } catch (err: unknown) {
      setCustomProviderTestStatus('error');
      const message = err instanceof Error ? err.message : String(err);
      setCustomProviderTestError(message || 'Connection failed');
    }
  };

  // Files & Links settings
  const [useWikilinks, setUseWikilinks] = createSignal(
    localStorage.getItem('use_wikilinks') !== 'false' // Default to true
  );

  // Daily Notes settings
  const [dailyNotesConfig, setDailyNotesConfig] = createSignal<DailyNotesConfig>(loadDailyNotesConfig());

  // Templates settings
  const [templatesConfig, setTemplatesConfig] = createSignal<TemplatesConfig>(loadTemplatesConfig());

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
    // Calculate contrasting text color for accent backgrounds
    const contrastColor = getContrastColor(accent);
    root.style.setProperty('--accent-text', contrastColor);

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

  // Helper to calculate relative luminance and determine contrast color
  const getContrastColor = (hex: string): string => {
    const num = parseInt(hex.replace('#', ''), 16);
    const R = (num >> 16) & 0xFF;
    const G = (num >> 8) & 0xFF;
    const B = num & 0xFF;
    // Calculate relative luminance using sRGB formula
    const luminance = (0.299 * R + 0.587 * G + 0.114 * B) / 255;
    // Return black for light colors, white for dark colors
    return luminance > 0.5 ? '#000000' : '#ffffff';
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
      const isModified = skillModified().has(skillId);
      
      let message: string;
      if (isCustom) {
        message = 'This will delete the custom skill from your system. You will need to re-import it to use it again.';
      } else if (isModified) {
        message = 'You have customized this skill. Removing it will delete your changes. You can re-enable it later, but your customizations will be lost.';
      } else {
        message = 'This will delete the skill files from your system. You can re-enable it later to download again.';
      }
      
      setModalConfig({
        type: 'confirm',
        title: `Remove "${skill.name}" skill?`,
        message,
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
            // Remove from modified set
            if (isModified) {
              const modified = new Set(skillModified());
              modified.delete(skillId);
              setSkillModified(modified);
              localStorage.setItem('skill_modified_ids', JSON.stringify([...modified]));
            }
          } catch (err) {
            console.error(`Failed to remove skill ${skillId}:`, err);
          }
          setModalConfig(null);
        }
      });
    }
  };

  // Open skill editor modal
  const handleEditSkill = async (skill: SkillInfo) => {
    try {
      const content = await invoke<string>('skill_read_file', { skillId: skill.id, fileName: 'SKILL.md' });
      setEditingSkill({
        skillId: skill.id,
        skillName: skill.name,
        content,
        originalContent: content,
        isCustom: skill.isCustom || false,
        saving: false,
        resetting: false,
      });
    } catch (err) {
      console.error(`Failed to read skill ${skill.id}:`, err);
      setModalConfig({
        type: 'info',
        title: 'Error',
        message: `Failed to read skill file: ${err instanceof Error ? err.message : 'Unknown error'}`
      });
    }
  };

  // Save skill edits
  const handleSaveSkillEdit = async () => {
    const editing = editingSkill();
    if (!editing) return;

    setEditingSkill({ ...editing, saving: true });

    try {
      await invoke('skill_save_file', { skillId: editing.skillId, fileName: 'SKILL.md', content: editing.content });
      
      // Mark as modified if content changed from original (for non-custom skills)
      if (!editing.isCustom && editing.content !== editing.originalContent) {
        const modified = new Set(skillModified());
        modified.add(editing.skillId);
        setSkillModified(modified);
        localStorage.setItem('skill_modified_ids', JSON.stringify([...modified]));
      }
      
      // Update the skill name in the list if it changed
      const newName = parseSkillName(editing.content, editing.skillId);
      if (newName !== editing.skillName) {
        setAvailableSkills(prev => prev.map(s => 
          s.id === editing.skillId ? { ...s, name: newName } : s
        ));
      }

      setEditingSkill(null);
    } catch (err) {
      console.error(`Failed to save skill ${editing.skillId}:`, err);
      setEditingSkill({ ...editing, saving: false });
      setModalConfig({
        type: 'info',
        title: 'Error',
        message: `Failed to save skill: ${err instanceof Error ? err.message : 'Unknown error'}`
      });
    }
  };

  // Reset skill to original version (re-download from manifest)
  const handleResetSkill = async () => {
    const editing = editingSkill();
    if (!editing || editing.isCustom) return;

    setEditingSkill({ ...editing, resetting: true });

    try {
      // Find the skill in availableSkills to get the files list
      const skill = availableSkills().find(s => s.id === editing.skillId);
      if (!skill) throw new Error('Skill not found');

      // Re-download all skill files
      for (const file of skill.files) {
        const fileUrl = `${SKILLS_BASE_URL}/${editing.skillId}/${file}`;
        const response = await fetch(fileUrl);
        if (!response.ok) {
          throw new Error(`Failed to download ${file}`);
        }
        const content = await response.text();
        await invoke('skill_save_file', { skillId: editing.skillId, fileName: file, content });
      }

      // Remove from modified set
      const modified = new Set(skillModified());
      modified.delete(editing.skillId);
      setSkillModified(modified);
      localStorage.setItem('skill_modified_ids', JSON.stringify([...modified]));

      // Reload the skill content
      const newContent = await invoke<string>('skill_read_file', { skillId: editing.skillId, fileName: 'SKILL.md' });
      
      // Update the skill name in case it was changed
      const newName = parseSkillName(newContent, editing.skillId);
      setAvailableSkills(prev => prev.map(s => 
        s.id === editing.skillId ? { ...s, name: newName } : s
      ));

      setEditingSkill({
        ...editing,
        content: newContent,
        originalContent: newContent,
        resetting: false,
      });
    } catch (err) {
      console.error(`Failed to reset skill ${editing.skillId}:`, err);
      setEditingSkill({ ...editing, resetting: false });
      setModalConfig({
        type: 'info',
        title: 'Error',
        message: `Failed to reset skill: ${err instanceof Error ? err.message : 'Unknown error'}`
      });
    }
  };

  // Check if a skill has been modified
  const isSkillModifiedLocally = (skillId: string) => skillModified().has(skillId);

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

    // Save to localStorage (save full RelayInfo objects, consistent with handleAddRelay)
    localStorage.setItem('nostr_relays', JSON.stringify(updated));

    // Update sync engine config
    const engine = getSyncEngine();
    engine.setConfig({ relays: updated.filter(r => r.write).map(r => r.url) });
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
      let movedCount = 0;

      // Rate limit: delay between uploads to avoid spamming relays
      const UPLOAD_DELAY_MS = 500; // 500ms between uploads
      
      // Collect local-only files for move detection
      const localOnlyFiles: typeof localFiles = [];
      
      for (const localFile of localFiles) {
        const remoteFile = remoteFileMap.get(localFile.path);

        if (remoteFile) {
          // Check if file needs to be uploaded (content changed)
          if (remoteFile.data.content !== localFile.content) {
            setSyncMessage(`Uploading ${localFile.path}... (${uploadedCount + 1} files)`);
            const result = await engine.publishFile(vault, localFile.path, localFile.content, remoteFile);
            vault = result.vault;
            uploadedCount++;
            
            if (uploadedCount > 0) {
              await new Promise(resolve => setTimeout(resolve, UPLOAD_DELAY_MS));
            }
          }
          remoteFileMap.delete(localFile.path);
        } else {
          // Local-only file - collect for move detection
          localOnlyFiles.push(localFile);
        }
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

      // --- Move detection (3 layers) ---
      const dtagMap = JSON.parse(localStorage.getItem('file_dtag_map') || '{}') as Record<string, string>;
      const remoteByDtag = new Map(remoteFiles.map(f => [f.d, f]));

      // Layer 1: Explicitly tracked moves (from in-app rename/move operations)
      const movedPaths = JSON.parse(localStorage.getItem('moved_paths') || '[]') as Array<{ from: string; to: string }>;
      const movesToKeep: Array<{ from: string; to: string }> = [];
      
      for (const move of movedPaths) {
        const remoteFile = remoteFileMap.get(move.from);
        const localFile = localOnlyFiles.find(f => f.path === move.to);
        
        if (remoteFile && localFile) {
          setSyncMessage(`Processing move: ${move.from} -> ${move.to}`);
          try {
            const result = await engine.moveFile(vault, move.from, move.to, localFile.content);
            vault = result.vault;
            movedCount++;
            remoteFileMap.delete(move.from);
            const idx = localOnlyFiles.indexOf(localFile);
            if (idx >= 0) localOnlyFiles.splice(idx, 1);
          } catch (err) {
            console.error(`[Sync] Failed to process tracked move ${move.from} -> ${move.to}:`, err);
            movesToKeep.push(move);
          }
        } else if (remoteFile && !localFile) {
          movesToKeep.push(move);
        }
      }
      
      localStorage.setItem('moved_paths', JSON.stringify(movesToKeep));

      // Layer 2: d-tag map matching (handles move+edit)
      if (localOnlyFiles.length > 0) {
        const dtagMatchedIndices = new Set<number>();
        
        for (let i = 0; i < localOnlyFiles.length; i++) {
          const localFile = localOnlyFiles[i];
          const knownDtag = dtagMap[localFile.path];
          if (!knownDtag) continue;
          
          const remoteFile = remoteByDtag.get(knownDtag);
          if (!remoteFile) continue;
          if (remoteFile.data.path === localFile.path) continue;
          if (!remoteFileMap.has(remoteFile.data.path)) continue;
          
          setSyncMessage(`Processing move: ${remoteFile.data.path} -> ${localFile.path}`);
          try {
            const result = await engine.moveFile(vault, remoteFile.data.path, localFile.path, localFile.content);
            vault = result.vault;
            movedCount++;
            remoteFileMap.delete(remoteFile.data.path);
            dtagMatchedIndices.add(i);
          } catch (err) {
            console.error(`[Sync] Failed to process d-tag move ${remoteFile.data.path} -> ${localFile.path}:`, err);
          }
        }
        
        for (let i = localOnlyFiles.length - 1; i >= 0; i--) {
          if (dtagMatchedIndices.has(i)) {
            localOnlyFiles.splice(i, 1);
          }
        }
      }

      // Layer 3: SHA-256 content matching (fallback for system file manager moves)
      if (localOnlyFiles.length > 0 && remoteFileMap.size > 0) {
        const remoteByChecksum = new Map<string, Array<{ path: string; file: typeof remoteFiles[0] }>>();
        for (const [path, file] of remoteFileMap) {
          const cs = file.data.checksum;
          if (!remoteByChecksum.has(cs)) {
            remoteByChecksum.set(cs, []);
          }
          remoteByChecksum.get(cs)!.push({ path, file });
        }

        const matchedLocalIndices = new Set<number>();
        
        for (let i = 0; i < localOnlyFiles.length; i++) {
          const localFile = localOnlyFiles[i];
          const localChecksum = calculateChecksum(localFile.content);
          const candidates = remoteByChecksum.get(localChecksum);
          
          if (candidates && candidates.length > 0) {
            const match = candidates.shift()!;
            if (candidates.length === 0) {
              remoteByChecksum.delete(localChecksum);
            }
            
            setSyncMessage(`Processing move: ${match.path} -> ${localFile.path}`);
            try {
              const result = await engine.moveFile(vault, match.path, localFile.path, localFile.content);
              vault = result.vault;
              movedCount++;
              remoteFileMap.delete(match.path);
              matchedLocalIndices.add(i);
            } catch (err) {
              console.error(`[Sync] Failed to process checksum move ${match.path} -> ${localFile.path}:`, err);
            }
          }
        }
        
        for (let i = localOnlyFiles.length - 1; i >= 0; i--) {
          if (matchedLocalIndices.has(i)) {
            localOnlyFiles.splice(i, 1);
          }
        }
      }

      // Upload remaining local-only files (truly new files)
      for (const localFile of localOnlyFiles) {
        setSyncMessage(`Uploading ${localFile.path}... (${uploadedCount + 1} files)`);
        const result = await engine.publishFile(vault, localFile.path, localFile.content);
        vault = result.vault;
        uploadedCount++;
        
        if (uploadedCount > 0) {
          await new Promise(resolve => setTimeout(resolve, UPLOAD_DELAY_MS));
        }
      }

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

      // Persist the d-tag map from the final vault state
      const updatedDtagMap: Record<string, string> = {};
      for (const fileEntry of vault.data.files) {
        updatedDtagMap[fileEntry.path] = fileEntry.d;
      }
      localStorage.setItem('file_dtag_map', JSON.stringify(updatedDtagMap));

      setSyncStatus('success');
      const totalSynced = vault.data.files?.length || 0;
      const parts = [];
      if (uploadedCount > 0) parts.push(`${uploadedCount} uploaded`);
      if (downloadedCount > 0) parts.push(`${downloadedCount} downloaded`);
      if (deletedCount > 0) parts.push(`${deletedCount} deleted`);
      if (movedCount > 0) parts.push(`${movedCount} moved`);
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

  // Load API keys providers
  const loadApiKeyProviders = async () => {
    if (!openCodeServerRunning()) return;
    
    setApiKeysLoading(true);
    setApiKeyError(null);
    try {
      const providers = await getAllProvidersWithAuthStatus();
      setApiKeyProviders(providers);
    } catch (err) {
      console.error('Failed to load API key providers:', err);
      setApiKeyError(err instanceof Error ? err.message : 'Failed to load providers');
    } finally {
      setApiKeysLoading(false);
    }
  };

  // Handle saving an API key for a provider
  const handleSaveApiKey = async (providerId: string) => {
    const key = apiKeyInputs()[providerId];
    if (!key?.trim()) {
      setApiKeyError('Please enter an API key');
      return;
    }
    
    setApiKeySaving(providerId);
    setApiKeyError(null);
    try {
      await setProviderApiKey(providerId, key.trim());
      // Clear the input and refresh providers
      setApiKeyInputs(prev => ({ ...prev, [providerId]: '' }));
      setExpandedProvider(null);
      // Refresh both API key providers and model providers
      await Promise.all([
        loadApiKeyProviders(),
        loadOpenCodeConfig(),
      ]);
    } catch (err) {
      console.error('Failed to save API key:', err);
      setApiKeyError(err instanceof Error ? err.message : 'Failed to save API key');
    } finally {
      setApiKeySaving(null);
    }
  };

  // Handle removing a provider's API key
  const handleRemoveApiKey = async (providerId: string) => {
    setApiKeySaving(providerId);
    setApiKeyError(null);
    try {
      await removeProviderAuth(providerId);
      // Refresh both API key providers and model providers
      await Promise.all([
        loadApiKeyProviders(),
        loadOpenCodeConfig(),
      ]);
    } catch (err) {
      console.error('Failed to remove API key:', err);
      setApiKeyError(err instanceof Error ? err.message : 'Failed to remove API key');
    } finally {
      setApiKeySaving(null);
    }
  };

  // Handle starting OAuth flow
  const handleStartOAuth = async (providerId: string, methodIndex: number = 0) => {
    setApiKeySaving(providerId);
    setApiKeyError(null);
    try {
      const result = await startProviderOAuth(providerId, methodIndex);
      if (result?.url) {
        // Open the OAuth URL in the browser
        await open(result.url);
        
        // Show instructions if available
        if (result.instructions) {
          setApiKeyError(result.instructions);
        }
        
        // If method is 'auto', the callback should happen automatically
        // If method is 'code', user needs to paste the code
        if (result.method === 'auto') {
          // Start polling or wait for callback
          // For now, we'll just refresh after a delay
          setTimeout(async () => {
            await Promise.all([
              loadApiKeyProviders(),
              loadOpenCodeConfig(),
            ]);
            setApiKeySaving(null);
          }, 5000);
        }
      }
    } catch (err) {
      console.error('Failed to start OAuth flow:', err);
      setApiKeyError(err instanceof Error ? err.message : 'Failed to start OAuth');
      setApiKeySaving(null);
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

  // Get configured providers (connected ones)
  const configuredProviders = () => apiKeyProviders().filter(p => p.isConnected);
  
  // Get unconfigured providers for the picker
  const unconfiguredProviders = () => apiKeyProviders().filter(p => !p.isConnected);
  
  // Filter unconfigured providers based on search
  const filteredPickerProviders = () => {
    const search = providerSearch().toLowerCase().trim();
    const providers = unconfiguredProviders();
    if (!search) return providers;
    
    return providers.filter(provider =>
      provider.name.toLowerCase().includes(search) ||
      provider.id.toLowerCase().includes(search)
    );
  };
  
  // Handle opening provider picker
  const handleOpenProviderPicker = () => {
    setProviderPickerOpen(true);
    setProviderSearch('');
    // Focus search input after render
    setTimeout(() => providerSearchRef?.focus(), 50);
  };
  
  // Handle selecting a provider from picker
  const handleSelectProvider = (providerId: string) => {
    setProviderPickerOpen(false);
    setExpandedProvider(providerId);
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

  // Load API key providers when server is running and we're on opencode section
  createEffect(() => {
    if (activeSection() === 'opencode' && openCodeServerRunning() && !openCodeLoading()) {
      loadApiKeyProviders();
    }
  });

  // Auto-load OpenClaw skills when switching to skills tab
  createEffect(() => {
    if (openClawSkillsTab() === 'skills' && openClawUrl() && openClawToken() && openClawSkills().length === 0 && !openClawSkillsLoading()) {
      loadOpenClawSkills();
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
        const fileName = selected.replace(/\\/g, '/').split('/').pop() || 'skill';

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
                  {section.id === 'openclaw' ? (
                    <svg width="18" height="18" viewBox="0 0 512 512" fill="currentColor">
                      <path d={section.icon}></path>
                    </svg>
                  ) : (
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d={section.icon}></path>
                    </svg>
                  )}
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

                <div class="settings-divider" />

                <div class="settings-section-title">Daily Notes</div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Enable Daily Notes</div>
                    <div class="setting-description">Create a new note for each day</div>
                  </div>
                  <label class="setting-toggle">
                    <input 
                      type="checkbox" 
                      checked={dailyNotesConfig().enabled}
                      onChange={(e) => {
                        const newConfig = { ...dailyNotesConfig(), enabled: e.currentTarget.checked };
                        setDailyNotesConfig(newConfig);
                        saveDailyNotesConfig(newConfig);
                      }}
                    />
                    <span class="toggle-slider"></span>
                  </label>
                </div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Daily Notes folder</div>
                    <div class="setting-description">Folder where daily notes will be created</div>
                  </div>
                  <input
                    type="text"
                    class="setting-input wide"
                    value={dailyNotesConfig().folder}
                    onInput={(e) => {
                      const newConfig = { ...dailyNotesConfig(), folder: e.currentTarget.value };
                      setDailyNotesConfig(newConfig);
                      saveDailyNotesConfig(newConfig);
                    }}
                    placeholder="Daily Notes"
                  />
                </div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Date format</div>
                    <div class="setting-description">Format for daily note filenames (e.g., YYYY-MM-DD)</div>
                  </div>
                  <input
                    type="text"
                    class="setting-input"
                    value={dailyNotesConfig().dateFormat}
                    onInput={(e) => {
                      const newConfig = { ...dailyNotesConfig(), dateFormat: e.currentTarget.value };
                      setDailyNotesConfig(newConfig);
                      saveDailyNotesConfig(newConfig);
                    }}
                    placeholder="YYYY-MM-DD"
                  />
                </div>

                <div class="setting-item full-width">
                  <div class="setting-info">
                    <div class="setting-name">Daily note template</div>
                    <div class="setting-description">
                      Content template for new daily notes. Use {'{{date}}'}, {'{{date:FORMAT}}'}, {'{{time}}'}, {'{{title}}'} for variables.
                    </div>
                  </div>
                  <textarea
                    class="setting-textarea"
                    rows={8}
                    value={dailyNotesConfig().template}
                    onInput={(e) => {
                      const newConfig = { ...dailyNotesConfig(), template: e.currentTarget.value };
                      setDailyNotesConfig(newConfig);
                      saveDailyNotesConfig(newConfig);
                    }}
                    placeholder="# {{date:MMMM D, YYYY}}&#10;&#10;## Tasks&#10;- [ ] &#10;&#10;## Notes&#10;"
                  />
                </div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Reset to defaults</div>
                    <div class="setting-description">Reset daily notes settings to default values</div>
                  </div>
                  <button
                    class="setting-button secondary"
                    onClick={() => {
                      setDailyNotesConfig(DEFAULT_DAILY_NOTES_CONFIG);
                      saveDailyNotesConfig(DEFAULT_DAILY_NOTES_CONFIG);
                    }}
                  >
                    Reset
                  </button>
                </div>

                <div class="settings-divider" />

                <div class="settings-section-title">Templates</div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Templates folder</div>
                    <div class="setting-description">Folder containing your note templates</div>
                  </div>
                  <input
                    type="text"
                    class="setting-input wide"
                    value={templatesConfig().folder}
                    onInput={(e) => {
                      const newConfig = { ...templatesConfig(), folder: e.currentTarget.value };
                      setTemplatesConfig(newConfig);
                      saveTemplatesConfig(newConfig);
                    }}
                    placeholder="Templates"
                  />
                </div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Reset to defaults</div>
                    <div class="setting-description">Reset templates settings to default values</div>
                  </div>
                  <button
                    class="setting-button secondary"
                    onClick={() => {
                      setTemplatesConfig(DEFAULT_TEMPLATES_CONFIG);
                      saveTemplatesConfig(DEFAULT_TEMPLATES_CONFIG);
                    }}
                  >
                    Reset
                  </button>
                </div>

                <div class="settings-divider" />

                <div class="settings-section-title">AI Providers</div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">OpenCode</div>
                    <div class="setting-description">Show OpenCode AI assistant in the sidebar</div>
                  </div>
                  <label class="setting-toggle">
                    <input
                      type="checkbox"
                      checked={localStorage.getItem('opencode_enabled') !== 'false'}
                      onChange={(e) => {
                        localStorage.setItem('opencode_enabled', e.currentTarget.checked ? 'true' : 'false');
                        window.dispatchEvent(new CustomEvent('ai-provider-toggle'));
                      }}
                    />
                    <span class="toggle-slider"></span>
                  </label>
                </div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">OpenClaw</div>
                    <div class="setting-description">Show OpenClaw AI assistant in the sidebar</div>
                  </div>
                  <label class="setting-toggle">
                    <input
                      type="checkbox"
                      checked={localStorage.getItem('openclaw_enabled') !== 'false'}
                      onChange={(e) => {
                        localStorage.setItem('openclaw_enabled', e.currentTarget.checked ? 'true' : 'false');
                        window.dispatchEvent(new CustomEvent('ai-provider-toggle'));
                      }}
                    />
                    <span class="toggle-slider"></span>
                  </label>
                </div>

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Custom Provider</div>
                    <div class="setting-description">Show Custom AI provider in the sidebar</div>
                  </div>
                  <label class="setting-toggle">
                    <input
                      type="checkbox"
                      checked={localStorage.getItem('custom_provider_enabled') !== 'false'}
                      onChange={(e) => {
                        localStorage.setItem('custom_provider_enabled', e.currentTarget.checked ? 'true' : 'false');
                        window.dispatchEvent(new CustomEvent('ai-provider-toggle'));
                      }}
                    />
                    <span class="toggle-slider"></span>
                  </label>
                </div>

                <div class="settings-divider" />

                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Welcome Tour</div>
                    <div class="setting-description">Show the welcome tour again to learn about Onyx features</div>
                  </div>
                  <button 
                    class="setting-button secondary"
                    onClick={() => {
                      localStorage.removeItem('onboarding_completed');
                      props.onClose();
                      // Trigger onboarding show via custom event
                      window.dispatchEvent(new CustomEvent('show-onboarding'));
                    }}
                  >
                    Show Welcome Tour
                  </button>
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

                {/* API Keys Section */}
                <Show when={openCodeServerRunning()}>
                  <div class="settings-section-title">API Keys</div>
                  
                  <Show when={apiKeysLoading()}>
                    <div class="setting-item">
                      <div class="opencode-loading">
                        <div class="spinner"></div>
                        <span>Loading providers...</span>
                      </div>
                    </div>
                  </Show>

                  <Show when={apiKeyError()}>
                    <div class="settings-notice warning">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"></circle>
                        <line x1="12" y1="8" x2="12" y2="12"></line>
                        <line x1="12" y1="16" x2="12.01" y2="16"></line>
                      </svg>
                      <p>{apiKeyError()}</p>
                    </div>
                  </Show>

                  <Show when={!apiKeysLoading() && apiKeyProviders().length > 0}>
                    {/* Configured providers */}
                    <Show when={configuredProviders().length > 0}>
                      <div class="api-keys-list">
                        <For each={configuredProviders()}>
                          {(provider) => (
                            <div class={`api-key-provider connected ${expandedProvider() === provider.id ? 'expanded' : ''}`}>
                              <div 
                                class="api-key-provider-header"
                                onClick={() => setExpandedProvider(expandedProvider() === provider.id ? null : provider.id)}
                              >
                                <div class="api-key-provider-info">
                                  <span class="api-key-provider-name">{provider.name}</span>
                                  <span class="api-key-status connected">
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                      <polyline points="20 6 9 17 4 12"></polyline>
                                    </svg>
                                    Connected
                                  </span>
                                </div>
                                <svg 
                                  width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                                  class="api-key-chevron"
                                >
                                  <polyline points="6 9 12 15 18 9"></polyline>
                                </svg>
                              </div>
                              
                              <Show when={expandedProvider() === provider.id}>
                                <div class="api-key-provider-content">
                                  <div class="api-key-actions">
                                    <button
                                      class="setting-button secondary danger"
                                      onClick={() => handleRemoveApiKey(provider.id)}
                                      disabled={apiKeySaving() === provider.id}
                                    >
                                      {apiKeySaving() === provider.id ? (
                                        <div class="spinner small"></div>
                                      ) : (
                                        'Remove'
                                      )}
                                    </button>
                                  </div>
                                </div>
                              </Show>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                    
                    {/* Provider being configured (expanded unconfigured provider) */}
                    <For each={unconfiguredProviders()}>
                      {(provider) => (
                        <Show when={expandedProvider() === provider.id}>
                          <div class="api-keys-list" style="margin-top: 8px;">
                            <div class={`api-key-provider expanded`}>
                              <div 
                                class="api-key-provider-header"
                                onClick={() => setExpandedProvider(null)}
                              >
                                <div class="api-key-provider-info">
                                  <span class="api-key-provider-name">{provider.name}</span>
                                  <span class="api-key-status not-configured">Configuring...</span>
                                </div>
                                <svg 
                                  width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
                                  class="api-key-chevron"
                                >
                                  <polyline points="6 9 12 15 18 9"></polyline>
                                </svg>
                              </div>
                              
                              <div class="api-key-provider-content">
                                {/* Show available auth methods */}
                                <For each={provider.authMethods}>
                                  {(method, methodIndex) => (
                                    <div class="api-key-method">
                                      <Show when={method.type === 'api'}>
                                        <div class="api-key-input-group">
                                          <input
                                            type="password"
                                            class="setting-input wide"
                                            placeholder={`Enter ${provider.name} API key`}
                                            value={apiKeyInputs()[provider.id] || ''}
                                            onInput={(e) => setApiKeyInputs(prev => ({ ...prev, [provider.id]: e.currentTarget.value }))}
                                            onKeyDown={(e) => {
                                              if (e.key === 'Enter') {
                                                handleSaveApiKey(provider.id);
                                              }
                                            }}
                                          />
                                          <button
                                            class="setting-button"
                                            onClick={() => handleSaveApiKey(provider.id)}
                                            disabled={apiKeySaving() === provider.id || !apiKeyInputs()[provider.id]?.trim()}
                                          >
                                            {apiKeySaving() === provider.id ? (
                                              <div class="spinner small"></div>
                                            ) : (
                                              'Save'
                                            )}
                                          </button>
                                        </div>
                                        <Show when={provider.env.length > 0}>
                                          <p class="setting-hint">
                                            Environment variable: <code>{provider.env[0]}</code>
                                          </p>
                                        </Show>
                                      </Show>
                                      
                                      <Show when={method.type === 'oauth'}>
                                        <button
                                          class="setting-button oauth-button"
                                          onClick={() => handleStartOAuth(provider.id, methodIndex())}
                                          disabled={apiKeySaving() === provider.id}
                                        >
                                          {apiKeySaving() === provider.id ? (
                                            <div class="spinner small"></div>
                                          ) : (
                                            <>
                                              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path>
                                                <polyline points="15 3 21 3 21 9"></polyline>
                                                <line x1="10" y1="14" x2="21" y2="3"></line>
                                              </svg>
                                              {method.label}
                                            </>
                                          )}
                                        </button>
                                      </Show>
                                    </div>
                                  )}
                                </For>
                              </div>
                            </div>
                          </div>
                        </Show>
                      )}
                    </For>
                    
                    {/* Add Provider button */}
                    <Show when={unconfiguredProviders().length > 0}>
                      <button 
                        class="setting-button add-provider-button"
                        onClick={handleOpenProviderPicker}
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <line x1="12" y1="5" x2="12" y2="19"></line>
                          <line x1="5" y1="12" x2="19" y2="12"></line>
                        </svg>
                        Add Provider
                      </button>
                    </Show>
                    
                    {/* Provider Picker Modal */}
                    <Show when={providerPickerOpen()}>
                      <div class="provider-picker-overlay" onClick={() => setProviderPickerOpen(false)}>
                        <div class="provider-picker-modal" onClick={(e) => e.stopPropagation()}>
                          <div class="provider-picker-header">
                            <h3>Add Provider</h3>
                            <button class="provider-picker-close" onClick={() => setProviderPickerOpen(false)}>
                              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <line x1="18" y1="6" x2="6" y2="18"></line>
                                <line x1="6" y1="6" x2="18" y2="18"></line>
                              </svg>
                            </button>
                          </div>
                          <div class="provider-picker-search">
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                              <circle cx="11" cy="11" r="8"></circle>
                              <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                            </svg>
                            <input
                              ref={providerSearchRef}
                              type="text"
                              placeholder="Search providers..."
                              value={providerSearch()}
                              onInput={(e) => setProviderSearch(e.currentTarget.value)}
                              onKeyDown={(e) => {
                                if (e.key === 'Escape') {
                                  setProviderPickerOpen(false);
                                }
                              }}
                            />
                          </div>
                          <div class="provider-picker-list">
                            <Show when={filteredPickerProviders().length > 0} fallback={
                              <div class="provider-picker-empty">
                                No providers found
                              </div>
                            }>
                              <For each={filteredPickerProviders()}>
                                {(provider) => (
                                  <button
                                    class="provider-picker-item"
                                    onClick={() => handleSelectProvider(provider.id)}
                                  >
                                    <span class="provider-picker-item-name">{provider.name}</span>
                                    <span class="provider-picker-item-id">{provider.id}</span>
                                  </button>
                                )}
                              </For>
                            </Show>
                          </div>
                        </div>
                      </div>
                    </Show>
                  </Show>

                  <Show when={!apiKeysLoading() && apiKeyProviders().length === 0}>
                    <div class="settings-notice">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"></circle>
                        <line x1="12" y1="8" x2="12" y2="12"></line>
                        <line x1="12" y1="16" x2="12.01" y2="16"></line>
                      </svg>
                      <p>No providers available. Make sure OpenCode is properly configured.</p>
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

            {/* OpenClaw Settings */}
            <Show when={activeSection() === 'openclaw'}>
              <div class="settings-section">
                {/* Tab bar */}
                <div class="openclaw-tabs">
                  <button
                    class={`openclaw-tab ${openClawSkillsTab() === 'config' ? 'active' : ''}`}
                    onClick={() => setOpenClawSkillsTab('config')}
                  >
                    Configuration
                  </button>
                  <button
                    class={`openclaw-tab ${openClawSkillsTab() === 'skills' ? 'active' : ''}`}
                    onClick={() => setOpenClawSkillsTab('skills')}
                  >
                    Skills
                  </button>
                </div>

                <div style={{ display: openClawSkillsTab() === 'config' ? 'block' : 'none' }}>
                <div class="settings-section-title">OpenClaw Configuration</div>

                <div class="settings-notice">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="16" x2="12" y2="12"></line>
                    <line x1="12" y1="8" x2="12.01" y2="8"></line>
                  </svg>
                  <p>OpenClaw is an AI assistant server. Configure your server URL and gateway token to connect.</p>
                </div>

                <div class="settings-section-title">Server URL</div>
                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">OpenClaw Server URL</div>
                    <div class="setting-description">The URL of your OpenClaw server (e.g., http://localhost:18789)</div>
                  </div>
                </div>
                <div class="setting-item column">
                  <input
                    type="text"
                    class="setting-input wide"
                    placeholder="http://localhost:18789"
                    value={openClawUrl()}
                    onInput={(e) => handleOpenClawUrlChange(e.currentTarget.value)}
                  />
                </div>

                <div class="settings-section-title">Gateway Token</div>
                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Authorization Token</div>
                    <div class="setting-description">Your OpenClaw gateway token for authentication</div>
                  </div>
                </div>
                <div class="setting-item column">
                  <div class="openclaw-token-input">
                    <input
                      type={openClawTokenVisible() ? 'text' : 'password'}
                      class="setting-input wide"
                      placeholder="Enter your gateway token"
                      value={openClawToken()}
                      onInput={(e) => handleOpenClawTokenChange(e.currentTarget.value)}
                    />
                    <button
                      class="setting-button secondary"
                      onClick={() => setOpenClawTokenVisible(!openClawTokenVisible())}
                      title={openClawTokenVisible() ? 'Hide token' : 'Show token'}
                    >
                      <Show when={openClawTokenVisible()} fallback={
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                          <circle cx="12" cy="12" r="3"></circle>
                        </svg>
                      }>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
                          <line x1="1" y1="1" x2="23" y2="23"></line>
                        </svg>
                      </Show>
                    </button>
                  </div>
                </div>

                <div class="settings-section-title">Connection Test</div>
                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Test Connection</div>
                    <div class="setting-description">Verify that your OpenClaw server is reachable and the token is valid</div>
                  </div>
                  <button
                    class="setting-button"
                    onClick={handleTestOpenClawConnection}
                    disabled={!openClawUrl() || !openClawToken() || openClawTestStatus() === 'testing'}
                  >
                    <Show when={openClawTestStatus() === 'testing'} fallback={
                      <>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <polyline points="20 6 9 17 4 12"></polyline>
                        </svg>
                        Test
                      </>
                    }>
                      <div class="spinner small"></div>
                      Testing...
                    </Show>
                  </button>
                </div>

                <Show when={openClawTestStatus() === 'success'}>
                  <div class="settings-notice success">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                      <polyline points="22 4 12 14.01 9 11.01"></polyline>
                    </svg>
                    <p>Connection successful! OpenClaw server is reachable.</p>
                  </div>
                </Show>

                <Show when={openClawTestStatus() === 'error'}>
                  <div class="settings-notice warning">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <circle cx="12" cy="12" r="10"></circle>
                      <line x1="12" y1="8" x2="12" y2="12"></line>
                      <line x1="12" y1="16" x2="12.01" y2="16"></line>
                    </svg>
                    <p>Connection failed: {openClawTestError()}</p>
                  </div>
                </Show>
                </div>

                {/* Skills Tab */}
                <div style={{ display: openClawSkillsTab() === 'skills' ? 'block' : 'none' }}>
                  <Show when={!openClawUrl() || !openClawToken()}>
                    <div class="settings-notice warning">
                      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="10"></circle>
                        <line x1="12" y1="8" x2="12" y2="12"></line>
                        <line x1="12" y1="16" x2="12.01" y2="16"></line>
                      </svg>
                      <p>Configure your OpenClaw server URL and token first.</p>
                    </div>
                  </Show>

                  <Show when={openClawUrl() && openClawToken()}>
                    <Show when={openClawSkillsLoading()}>
                      <div class="skills-loading">
                        <div class="spinner"></div>
                        <span>Loading skills...</span>
                      </div>
                    </Show>

                    <Show when={openClawSkillsError()}>
                      <div class="settings-notice warning">
                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                          <line x1="12" y1="9" x2="12" y2="13"></line>
                          <line x1="12" y1="17" x2="12.01" y2="17"></line>
                        </svg>
                        <p>{openClawSkillsError()}</p>
                      </div>
                      <button class="setting-button" onClick={loadOpenClawSkills}>Retry</button>
                    </Show>

                    <Show when={!openClawSkillsLoading() && !openClawSkillsError() && openClawSkills().length > 0}>
                      {/* Search */}
                      <div class="skills-search-bar">
                        <div class="skills-search-input">
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="11" cy="11" r="8"></circle>
                            <line x1="21" y1="21" x2="16.65" y2="16.65"></line>
                          </svg>
                          <input
                            type="text"
                            placeholder="Search skills..."
                            value={openClawSkillSearch()}
                            onInput={(e) => setOpenClawSkillSearch(e.currentTarget.value)}
                          />
                        </div>
                      </div>

                      {/* Skills list */}
                      <div class="skills-list">
                        <For each={filteredOpenClawSkills()}>
                          {(skill) => (
                            <div class={`skill-item ${!skill.disabled && skill.eligible ? 'enabled' : ''}`}>
                              <div class="skill-icon">
                                <Show when={skill.emoji} fallback={
                                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z"></path>
                                  </svg>
                                }>
                                  <span style={{ "font-size": "20px" }}>{skill.emoji}</span>
                                </Show>
                              </div>
                              <div class="skill-info">
                                <div class="skill-header">
                                  <span class="skill-name">{skill.name}</span>
                                  <Show when={!skill.eligible}>
                                    <span class="skill-badge deps">Ineligible</span>
                                  </Show>
                                  <Show when={skill.missing.bins.length > 0}>
                                    <button
                                      class="skill-badge deps clickable"
                                      onClick={() => setModalConfig({
                                        type: 'info',
                                        title: `${skill.name} - Missing Dependencies`,
                                        message: `Missing binaries: ${skill.missing.bins.join(', ')}${skill.missing.env.length > 0 ? `\n\nMissing env vars: ${skill.missing.env.join(', ')}` : ''}${skill.install.length > 0 ? `\n\nInstall options:\n${skill.install.map(o => `  ${o.label} (${o.kind})`).join('\n')}` : ''}`
                                      })}
                                      title="Click to see missing dependencies"
                                    >
                                      Missing deps
                                    </button>
                                  </Show>
                                  <Show when={skill.always}>
                                    <span class="skill-badge installed">Always on</span>
                                  </Show>
                                </div>
                                <p class="skill-description">{skill.description}</p>
                                <span class="skill-category">{skill.source.replace('openclaw-', '')}</span>
                                <Show when={skill.homepage}>
                                  {' '}
                                  <a class="openclaw-skill-link" href={skill.homepage!} target="_blank" rel="noopener noreferrer">docs</a>
                                </Show>
                              </div>
                              <div class="skill-actions">
                                <Show when={skill.missing.bins.length > 0 && skill.install.length > 0}>
                                  <For each={skill.install}>
                                    {(opt) => (
                                      <button
                                        class="setting-button small"
                                        onClick={() => handleOpenClawSkillInstall(skill, opt.id)}
                                        disabled={openClawSkillInstalling() === skill.skillKey}
                                        title={`Install via ${opt.kind}: ${opt.label}`}
                                      >
                                        <Show when={openClawSkillInstalling() === skill.skillKey} fallback={
                                          <>{opt.label}</>
                                        }>
                                          <div class="spinner small"></div>
                                        </Show>
                                      </button>
                                    )}
                                  </For>
                                </Show>
                                <button
                                  class="skill-edit-btn"
                                  onClick={() => setViewingOpenClawSkill(skill)}
                                  title="View skill details"
                                >
                                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <circle cx="12" cy="12" r="10"></circle>
                                    <line x1="12" y1="16" x2="12" y2="12"></line>
                                    <line x1="12" y1="8" x2="12.01" y2="8"></line>
                                  </svg>
                                </button>
                                <label class="setting-toggle"
                                  onClick={(e) => {
                                    e.preventDefault();
                                    if (openClawSkillToggling() !== skill.skillKey) {
                                      handleOpenClawSkillToggle(skill);
                                    }
                                  }}
                                >
                                  <input
                                    type="checkbox"
                                    checked={!skill.disabled && skill.eligible}
                                    readOnly
                                    disabled={openClawSkillToggling() === skill.skillKey}
                                  />
                                  <span class="toggle-slider"></span>
                                </label>
                              </div>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </Show>
                </div>
              </div>
            </Show>

            {/* Custom Provider */}
            <Show when={activeSection() === 'customprovider'}>
              <div class="settings-section">
                <div class="settings-section-title">Custom Provider Configuration</div>

                <div class="settings-notice">
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="12" y1="16" x2="12" y2="12"></line>
                    <line x1="12" y1="8" x2="12.01" y2="8"></line>
                  </svg>
                  <p>Connect to any OpenAI-compatible API provider. Works with MapleAI Proxy, Ollama, LM Studio, vLLM, and more.</p>
                </div>

                <div class="settings-section-title">Display Name</div>
                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Provider Name</div>
                    <div class="setting-description">Name shown in the chat panel header</div>
                  </div>
                </div>
                <div class="setting-item column">
                  <input
                    type="text"
                    class="setting-input wide"
                    placeholder="MapleAI"
                    value={customProviderName()}
                    onInput={(e) => handleCustomProviderNameChange(e.currentTarget.value)}
                  />
                </div>

                <div class="settings-section-title">Server URL</div>
                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Base URL</div>
                    <div class="setting-description">The base URL of your OpenAI-compatible API server</div>
                  </div>
                </div>
                <div class="setting-item column">
                  <input
                    type="text"
                    class="setting-input wide"
                    placeholder="http://localhost:8080"
                    value={customProviderUrl()}
                    onInput={(e) => handleCustomProviderUrlChange(e.currentTarget.value)}
                  />
                </div>

                <div class="settings-section-title">API Key</div>
                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">API Key</div>
                    <div class="setting-description">Optional. Required by some providers (MapleAI, OpenRouter). Not needed for local servers like Ollama.</div>
                  </div>
                </div>
                <div class="setting-item column">
                  <div class="openclaw-token-input">
                    <input
                      type={customProviderApiKeyVisible() ? 'text' : 'password'}
                      class="setting-input wide"
                      placeholder="sk-..."
                      value={customProviderApiKey()}
                      onInput={(e) => handleCustomProviderApiKeyChange(e.currentTarget.value)}
                    />
                    <button
                      class="token-toggle-btn"
                      onClick={() => setCustomProviderApiKeyVisible(!customProviderApiKeyVisible())}
                      title={customProviderApiKeyVisible() ? 'Hide' : 'Show'}
                    >
                      <Show when={customProviderApiKeyVisible()} fallback={
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
                          <circle cx="12" cy="12" r="3"></circle>
                        </svg>
                      }>
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"></path>
                          <line x1="1" y1="1" x2="23" y2="23"></line>
                        </svg>
                      </Show>
                    </button>
                  </div>
                </div>

                <div class="settings-section-title">Model</div>
                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Fetch Available Models</div>
                    <div class="setting-description">Query the provider's /v1/models endpoint</div>
                  </div>
                  <button
                    class="setting-button"
                    onClick={handleFetchCustomProviderModels}
                    disabled={!customProviderUrl() || customProviderModelsLoading()}
                  >
                    {customProviderModelsLoading() ? 'Fetching...' : 'Fetch Models'}
                  </button>
                </div>
                <Show when={customProviderModels().length > 0}>
                  <div class="setting-item">
                    <div class="setting-info">
                      <div class="setting-name">Select Model</div>
                      <div class="setting-description">Choose which model to use for chat completions</div>
                    </div>
                    <select
                      class="setting-select"
                      value={customProviderModel()}
                      onChange={(e) => handleCustomProviderModelChange(e.currentTarget.value)}
                    >
                      <option value="">Select a model...</option>
                      <For each={customProviderModels()}>
                        {(model) => <option value={model}>{model}</option>}
                      </For>
                    </select>
                  </div>
                </Show>
                <Show when={customProviderModels().length === 0 && !customProviderModelsLoading()}>
                  <div class="setting-item">
                    <div class="setting-info">
                      <div class="setting-description">No models loaded yet. Enter a URL and click "Fetch Models".</div>
                    </div>
                  </div>
                </Show>

                <div class="settings-section-title">Connection Test</div>
                <div class="setting-item">
                  <div class="setting-info">
                    <div class="setting-name">Test Connection</div>
                    <div class="setting-description">Verify connectivity to your provider</div>
                  </div>
                  <button
                    class="setting-button"
                    onClick={handleTestCustomProviderConnection}
                    disabled={!customProviderUrl() || customProviderTestStatus() === 'testing'}
                  >
                    {customProviderTestStatus() === 'testing' ? 'Testing...' : 'Test Connection'}
                  </button>
                </div>

                <Show when={customProviderTestStatus() === 'success'}>
                  <div class="settings-notice success">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                    <p>Connection successful!</p>
                  </div>
                </Show>

                <Show when={customProviderTestStatus() === 'error'}>
                  <div class="settings-notice warning">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <circle cx="12" cy="12" r="10"></circle>
                      <line x1="15" y1="9" x2="9" y2="15"></line>
                      <line x1="9" y1="9" x2="15" y2="15"></line>
                    </svg>
                    <p>{customProviderTestError() || 'Connection failed'}</p>
                  </div>
                </Show>

                <div class="settings-section-title">Quick Setup Guides</div>
                <div class="custom-provider-guides">
                    <div class="custom-provider-guide">
                      <strong>MapleAI Proxy</strong>
                      <p>URL: <code>http://localhost:8080</code></p>
                      <p>API Key: Your Maple API key</p>
                      <p>Models fetched dynamically from proxy</p>
                    </div>
                    <div class="custom-provider-guide">
                      <strong>Ollama</strong>
                      <p>URL: <code>http://localhost:11434</code></p>
                      <p>API Key: Not required</p>
                      <p>Models: Your locally pulled models</p>
                    </div>
                    <div class="custom-provider-guide">
                      <strong>LM Studio</strong>
                      <p>URL: <code>http://localhost:1234</code></p>
                      <p>API Key: Not required</p>
                      <p>Models: Your loaded models</p>
                    </div>
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
                          const isModified = () => isSkillModifiedLocally(skill.id);
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
                                  <Show when={!skill.isCustom && isModified()}>
                                    <span class="skill-badge modified">Modified</span>
                                  </Show>
                                </div>
                                <p class="skill-description">{skill.description}</p>
                                <span class="skill-category">{skill.category}</span>
                              </div>
                              <div class="skill-actions">
                                <button
                                  class="skill-edit-btn"
                                  onClick={() => handleEditSkill(skill)}
                                  title="Edit skill"
                                >
                                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                    <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"></path>
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

        {/* Skill Edit Modal */}
        <Show when={editingSkill()}>
          <div class="modal-overlay" onClick={() => setEditingSkill(null)}>
            <div class="modal-dialog skill-edit-modal" onClick={(e) => e.stopPropagation()}>
              <div class="modal-header">
                <h3>Edit "{editingSkill()!.skillName}"</h3>
                <button class="modal-close" onClick={() => setEditingSkill(null)}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </svg>
                </button>
              </div>
              <div class="modal-body skill-edit-body">
                <textarea
                  class="skill-edit-textarea"
                  value={editingSkill()!.content}
                  onInput={(e) => setEditingSkill({
                    ...editingSkill()!,
                    content: e.currentTarget.value
                  })}
                  placeholder="Enter skill content in Markdown format..."
                  disabled={editingSkill()!.saving || editingSkill()!.resetting}
                />
              </div>
              <div class="modal-footer skill-edit-footer">
                <Show when={!editingSkill()!.isCustom}>
                  <button
                    class="setting-button secondary"
                    onClick={handleResetSkill}
                    disabled={editingSkill()!.saving || editingSkill()!.resetting}
                    title="Reset to original version from the repository"
                  >
                    {editingSkill()!.resetting ? (
                      <>
                        <div class="spinner small"></div>
                        Resetting...
                      </>
                    ) : 'Reset to Default'}
                  </button>
                </Show>
                <div class="skill-edit-footer-right">
                  <button
                    class="setting-button secondary"
                    onClick={() => setEditingSkill(null)}
                    disabled={editingSkill()!.saving || editingSkill()!.resetting}
                  >
                    Cancel
                  </button>
                  <button
                    class="setting-button primary"
                    onClick={handleSaveSkillEdit}
                    disabled={editingSkill()!.saving || editingSkill()!.resetting}
                  >
                    {editingSkill()!.saving ? (
                      <>
                        <div class="spinner small"></div>
                        Saving...
                      </>
                    ) : 'Save'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </Show>

        {/* OpenClaw Skill Detail Modal */}
        <Show when={viewingOpenClawSkill()}>
          <div class="modal-overlay" onClick={() => setViewingOpenClawSkill(null)}>
            <div class="modal-dialog skill-edit-modal" onClick={(e) => e.stopPropagation()}>
              <div class="modal-header">
                <h3>{viewingOpenClawSkill()!.emoji ? `${viewingOpenClawSkill()!.emoji} ` : ''}{viewingOpenClawSkill()!.name}</h3>
                <button class="modal-close" onClick={() => setViewingOpenClawSkill(null)}>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <line x1="18" y1="6" x2="6" y2="18"></line>
                    <line x1="6" y1="6" x2="18" y2="18"></line>
                  </svg>
                </button>
              </div>
              <div class="modal-body" style={{ "max-height": "60vh", "overflow-y": "auto" }}>
                <p style={{ "margin-bottom": "16px" }}>{viewingOpenClawSkill()!.description}</p>

                <div class="openclaw-detail-section">
                  <div class="openclaw-detail-label">Status</div>
                  <div class="openclaw-detail-value">
                    <span class={`skill-badge ${viewingOpenClawSkill()!.disabled ? '' : 'installed'}`}>
                      {viewingOpenClawSkill()!.disabled ? 'Disabled' : 'Enabled'}
                    </span>
                    {' '}
                    <span class={`skill-badge ${viewingOpenClawSkill()!.eligible ? 'installed' : 'deps'}`}>
                      {viewingOpenClawSkill()!.eligible ? 'Eligible' : 'Ineligible'}
                    </span>
                    <Show when={viewingOpenClawSkill()!.always}>
                      {' '}<span class="skill-badge installed">Always on</span>
                    </Show>
                  </div>
                </div>

                <div class="openclaw-detail-section">
                  <div class="openclaw-detail-label">Source</div>
                  <div class="openclaw-detail-value">{viewingOpenClawSkill()!.source}</div>
                </div>

                <div class="openclaw-detail-section">
                  <div class="openclaw-detail-label">Path</div>
                  <div class="openclaw-detail-value" style={{ "font-family": "monospace", "font-size": "12px", "word-break": "break-all" }}>{viewingOpenClawSkill()!.filePath}</div>
                </div>

                <Show when={viewingOpenClawSkill()!.primaryEnv}>
                  <div class="openclaw-detail-section">
                    <div class="openclaw-detail-label">Primary Env</div>
                    <div class="openclaw-detail-value"><code>{viewingOpenClawSkill()!.primaryEnv}</code></div>
                  </div>
                </Show>

                <Show when={viewingOpenClawSkill()!.requirements.bins.length > 0}>
                  <div class="openclaw-detail-section">
                    <div class="openclaw-detail-label">Required Binaries</div>
                    <div class="openclaw-detail-value">{viewingOpenClawSkill()!.requirements.bins.join(', ')}</div>
                  </div>
                </Show>

                <Show when={viewingOpenClawSkill()!.missing.bins.length > 0}>
                  <div class="openclaw-detail-section">
                    <div class="openclaw-detail-label">Missing Binaries</div>
                    <div class="openclaw-detail-value" style={{ color: '#e67e22' }}>{viewingOpenClawSkill()!.missing.bins.join(', ')}</div>
                  </div>
                </Show>

                <Show when={viewingOpenClawSkill()!.requirements.env.length > 0}>
                  <div class="openclaw-detail-section">
                    <div class="openclaw-detail-label">Required Env Vars</div>
                    <div class="openclaw-detail-value">{viewingOpenClawSkill()!.requirements.env.join(', ')}</div>
                  </div>
                </Show>

                <Show when={viewingOpenClawSkill()!.missing.env.length > 0}>
                  <div class="openclaw-detail-section">
                    <div class="openclaw-detail-label">Missing Env Vars</div>
                    <div class="openclaw-detail-value" style={{ color: '#e67e22' }}>{viewingOpenClawSkill()!.missing.env.join(', ')}</div>
                  </div>
                </Show>

                <Show when={viewingOpenClawSkill()!.configChecks.length > 0}>
                  <div class="openclaw-detail-section">
                    <div class="openclaw-detail-label">Config Checks</div>
                    <div class="openclaw-detail-value">
                      <For each={viewingOpenClawSkill()!.configChecks}>
                        {(check) => (
                          <div style={{ "font-size": "12px", "margin-bottom": "4px" }}>
                            <code>{check.path}</code>: {check.satisfied ? 'OK' : 'Not satisfied'}
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>

                <Show when={viewingOpenClawSkill()!.install.length > 0}>
                  <div class="openclaw-detail-section">
                    <div class="openclaw-detail-label">Install Options</div>
                    <div class="openclaw-detail-value">
                      <For each={viewingOpenClawSkill()!.install}>
                        {(opt) => (
                          <div style={{ "display": "flex", "align-items": "center", "gap": "8px", "margin-bottom": "4px" }}>
                            <span style={{ "font-size": "12px" }}>{opt.label} ({opt.kind})</span>
                            <button
                              class="setting-button small"
                              onClick={() => {
                                const skill = viewingOpenClawSkill()!;
                                setViewingOpenClawSkill(null);
                                handleOpenClawSkillInstall(skill, opt.id);
                              }}
                              disabled={openClawSkillInstalling() === viewingOpenClawSkill()!.skillKey}
                            >
                              Install
                            </button>
                          </div>
                        )}
                      </For>
                    </div>
                  </div>
                </Show>

                <Show when={viewingOpenClawSkill()!.homepage}>
                  <div class="openclaw-detail-section">
                    <div class="openclaw-detail-label">Homepage</div>
                    <div class="openclaw-detail-value">
                      <a href={viewingOpenClawSkill()!.homepage!} target="_blank" rel="noopener noreferrer" style={{ color: 'var(--accent)' }}>
                        {viewingOpenClawSkill()!.homepage}
                      </a>
                    </div>
                  </div>
                </Show>
              </div>
              <div class="modal-footer">
                <button class="setting-button" onClick={() => setViewingOpenClawSkill(null)}>Close</button>
              </div>
            </div>
          </div>
        </Show>
      </div>
    </div>
  );
};

export default Settings;
