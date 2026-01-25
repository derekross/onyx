/**
 * Onboarding - Welcome wizard for new users
 * 
 * Guides users through setting up their Onyx workspace including:
 * - Vault creation/selection
 * - Nostr identity setup
 * - Cloud sync configuration
 * - OpenCode AI assistant (desktop only)
 * - Productivity skills (desktop only)
 */

import { Component, createSignal, createEffect, Show, For, onMount } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { generateNewLogin, importNsecLogin, saveLogin } from '../lib/nostr/login';
import type { NostrIdentity } from '../lib/nostr/types';
import '../styles/onboarding.css';

// Import SVG illustrations
import WelcomeSvg from '../assets/onboarding/welcome.svg';
import VaultSvg from '../assets/onboarding/vault.svg';
import FeaturesSvg from '../assets/onboarding/features.svg';
import NostrSvg from '../assets/onboarding/nostr.svg';
import SyncSvg from '../assets/onboarding/sync.svg';
import AiSvg from '../assets/onboarding/ai.svg';
import SkillsSvg from '../assets/onboarding/skills.svg';
import CompleteSvg from '../assets/onboarding/complete.svg';

// Types
export interface OnboardingResult {
  vaultPath: string;
  nostrSetup: 'created' | 'imported' | 'skipped';
  nostrNpub?: string;
  syncEnabled: boolean;
  openCodeInstalled: boolean;
  installedSkills: string[];
  createFirstNote: boolean;
}

interface OnboardingProps {
  isMobile: boolean;
  onComplete: (result: OnboardingResult) => void;
}

type OnboardingStep = 'welcome' | 'vault' | 'features' | 'nostr' | 'sync' | 'opencode' | 'skills' | 'complete';

// Skills manifest URL
const SKILLS_MANIFEST_URL = 'https://raw.githubusercontent.com/derekross/onyx-skills/main/manifest.json';
const SKILLS_BASE_URL = 'https://raw.githubusercontent.com/derekross/onyx-skills/main';

interface SkillInfo {
  id: string;
  name: string;
  description: string;
  files: string[];
}

// Install progress from Rust backend
interface InstallProgress {
  stage: 'checking' | 'downloading' | 'extracting' | 'configuring' | 'complete' | 'error';
  progress: number;
  message: string;
}

const Onboarding: Component<OnboardingProps> = (props) => {
  // Steps based on platform
  const getSteps = (): OnboardingStep[] => {
    if (props.isMobile) {
      return ['welcome', 'vault', 'features', 'nostr', 'sync', 'complete'];
    }
    return ['welcome', 'vault', 'features', 'nostr', 'sync', 'opencode', 'skills', 'complete'];
  };

  const steps = getSteps();
  const [currentStepIndex, setCurrentStepIndex] = createSignal(0);
  const currentStep = () => steps[currentStepIndex()];

  // Collected data
  const [vaultPath, setVaultPath] = createSignal<string | null>(null);
  const [nostrSetup, setNostrSetup] = createSignal<'created' | 'imported' | 'skipped' | null>(null);
  const [nostrIdentity, setNostrIdentity] = createSignal<NostrIdentity | null>(null);
  const [syncEnabled, setSyncEnabled] = createSignal(false);
  const [openCodeInstalled, setOpenCodeInstalled] = createSignal(false);
  const [installedSkills, setInstalledSkills] = createSignal<string[]>([]);

  // Step-specific state
  // Vault
  const [vaultError, setVaultError] = createSignal<string | null>(null);
  const [vaultLoading, setVaultLoading] = createSignal(false);
  const [defaultVaultPath, setDefaultVaultPath] = createSignal<string | null>(null);

  // Nostr
  const [nostrMode, setNostrMode] = createSignal<'choose' | 'create' | 'import'>('choose');
  const [nostrLoading, setNostrLoading] = createSignal(false);
  const [nostrError, setNostrError] = createSignal<string | null>(null);
  const [importKey, setImportKey] = createSignal('');
  const [showNsec, setShowNsec] = createSignal(false);
  const [copiedKey, setCopiedKey] = createSignal<'npub' | 'nsec' | null>(null);

  // OpenCode
  const [openCodeStatus, setOpenCodeStatus] = createSignal<'checking' | 'not-installed' | 'installing' | 'installed' | 'error'>('checking');
  const [openCodeError, setOpenCodeError] = createSignal<string | null>(null);
  const [installProgress, setInstallProgress] = createSignal<InstallProgress | null>(null);

  // Skills
  const [availableSkills, setAvailableSkills] = createSignal<SkillInfo[]>([]);
  const [selectedSkills, setSelectedSkills] = createSignal<Set<string>>(new Set());
  const [skillsLoading, setSkillsLoading] = createSignal(false);
  const [skillsInstalling, setSkillsInstalling] = createSignal(false);
  const [skillsError, setSkillsError] = createSignal<string | null>(null);

  // Navigation
  const goNext = () => {
    if (currentStepIndex() < steps.length - 1) {
      setCurrentStepIndex(currentStepIndex() + 1);
    }
  };

  const goBack = () => {
    if (currentStepIndex() > 0) {
      setCurrentStepIndex(currentStepIndex() - 1);
    }
  };

  const completeOnboarding = (createNote: boolean) => {
    props.onComplete({
      vaultPath: vaultPath()!,
      nostrSetup: nostrSetup() || 'skipped',
      nostrNpub: nostrIdentity()?.npub,
      syncEnabled: syncEnabled(),
      openCodeInstalled: openCodeInstalled(),
      installedSkills: installedSkills(),
      createFirstNote: createNote,
    });
  };

  // Load default vault path on mount
  onMount(async () => {
    try {
      const info = await invoke<{ default_vault_path: string | null }>('get_platform_info');
      if (info.default_vault_path) {
        setDefaultVaultPath(info.default_vault_path);
      }
    } catch (err) {
      console.error('Failed to get platform info:', err);
    }
  });

  // Check OpenCode status when reaching that step
  createEffect(() => {
    if (currentStep() === 'opencode' && openCodeStatus() === 'checking') {
      checkOpenCodeInstalled();
    }
  });

  // Load skills when reaching that step
  createEffect(() => {
    if (currentStep() === 'skills' && availableSkills().length === 0) {
      loadSkills();
    }
  });

  // === Vault Functions ===
  const createNewVault = async () => {
    setVaultLoading(true);
    setVaultError(null);
    try {
      const path = defaultVaultPath() || (props.isMobile ? null : `${await getHomeDir()}/Documents/Onyx Notes`);
      if (!path) throw new Error('Could not determine vault path');
      
      // Create the folder
      await invoke('create_folder', { path });
      setVaultPath(path);
      
      // Save to settings
      await invoke('save_settings', { settings: { vault_path: path } });
      localStorage.setItem('vault_path', path);
      
      goNext();
    } catch (err) {
      console.error('Failed to create vault:', err);
      setVaultError(err instanceof Error ? err.message : 'Failed to create vault');
    } finally {
      setVaultLoading(false);
    }
  };

  const chooseExistingVault = async () => {
    setVaultLoading(true);
    setVaultError(null);
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Choose your notes folder',
      });
      
      if (selected && typeof selected === 'string') {
        setVaultPath(selected);
        await invoke('save_settings', { settings: { vault_path: selected } });
        localStorage.setItem('vault_path', selected);
        goNext();
      }
    } catch (err) {
      console.error('Failed to select vault:', err);
      setVaultError(err instanceof Error ? err.message : 'Failed to select folder');
    } finally {
      setVaultLoading(false);
    }
  };

  const getHomeDir = async (): Promise<string> => {
    try {
      const info = await invoke<{ home_dir: string }>('get_platform_info');
      return info.home_dir || '';
    } catch {
      return '';
    }
  };

  // === Nostr Functions ===
  const createNostrIdentity = async () => {
    setNostrLoading(true);
    setNostrError(null);
    try {
      const { identity, login } = generateNewLogin();
      
      await saveLogin(login);
      setNostrIdentity(identity);
      setNostrSetup('created');
      setNostrMode('create');
    } catch (err) {
      console.error('Failed to generate Nostr identity:', err);
      setNostrError(err instanceof Error ? err.message : 'Failed to generate identity');
    } finally {
      setNostrLoading(false);
    }
  };

  const importNostrIdentity = async () => {
    const key = importKey().trim();
    if (!key) {
      setNostrError('Please enter your private key');
      return;
    }

    setNostrLoading(true);
    setNostrError(null);
    try {
      const { identity, login } = importNsecLogin(key);
      
      await saveLogin(login);
      setNostrIdentity(identity);
      setNostrSetup('imported');
    } catch (err) {
      console.error('Failed to import Nostr identity:', err);
      setNostrError(err instanceof Error ? err.message : 'Failed to import identity');
    } finally {
      setNostrLoading(false);
    }
  };

  const skipNostr = () => {
    setNostrSetup('skipped');
    goNext();
  };

  const copyToClipboard = async (text: string, type: 'npub' | 'nsec') => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedKey(type);
      setTimeout(() => setCopiedKey(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  // === Sync Functions ===
  const enableSync = () => {
    setSyncEnabled(true);
    localStorage.setItem('sync_enabled', 'true');
    goNext();
  };

  const skipSync = () => {
    setSyncEnabled(false);
    goNext();
  };

  // === OpenCode Functions ===
  const checkOpenCodeInstalled = async () => {
    setOpenCodeStatus('checking');
    try {
      const path = await invoke<string | null>('check_opencode_installed');
      if (path) {
        setOpenCodeInstalled(true);
        setOpenCodeStatus('installed');
      } else {
        setOpenCodeStatus('not-installed');
      }
    } catch (err) {
      console.error('Failed to check OpenCode:', err);
      setOpenCodeStatus('not-installed');
    }
  };

  const installOpenCode = async () => {
    setOpenCodeStatus('installing');
    setOpenCodeError(null);
    setInstallProgress({ stage: 'checking', progress: 0, message: 'Preparing installation...' });

    // Listen for install progress events
    const unlisten = await listen<InstallProgress>('opencode-install-progress', (event) => {
      setInstallProgress(event.payload);
      if (event.payload.stage === 'complete') {
        setOpenCodeInstalled(true);
        setOpenCodeStatus('installed');
      } else if (event.payload.stage === 'error') {
        setOpenCodeError(event.payload.message);
        setOpenCodeStatus('error');
      }
    });

    try {
      await invoke('install_opencode');
    } catch (err) {
      console.error('Failed to install OpenCode:', err);
      setOpenCodeError(err instanceof Error ? err.message : 'Installation failed');
      setOpenCodeStatus('error');
    } finally {
      unlisten();
    }
  };

  const skipOpenCode = () => {
    setOpenCodeInstalled(false);
    goNext();
  };

  // === Skills Functions ===
  const loadSkills = async () => {
    setSkillsLoading(true);
    setSkillsError(null);
    try {
      const response = await fetch(SKILLS_MANIFEST_URL);
      if (!response.ok) throw new Error('Failed to fetch skills');
      
      const manifest = await response.json();
      const skills: SkillInfo[] = manifest.skills || [];
      setAvailableSkills(skills);
      
      // Pre-select all skills by default
      const allIds = new Set(skills.map(s => s.id));
      setSelectedSkills(allIds);
    } catch (err) {
      console.error('Failed to load skills:', err);
      setSkillsError(err instanceof Error ? err.message : 'Failed to load skills');
    } finally {
      setSkillsLoading(false);
    }
  };

  const toggleSkill = (skillId: string) => {
    setSelectedSkills(prev => {
      const next = new Set(prev);
      if (next.has(skillId)) {
        next.delete(skillId);
      } else {
        next.add(skillId);
      }
      return next;
    });
  };

  const installSelectedSkills = async () => {
    const toInstall = Array.from(selectedSkills());
    if (toInstall.length === 0) {
      goNext();
      return;
    }

    setSkillsInstalling(true);
    setSkillsError(null);
    const installed: string[] = [];

    try {
      for (const skillId of toInstall) {
        const skill = availableSkills().find(s => s.id === skillId);
        if (!skill) continue;

        try {
          // Download all skill files
          for (const file of skill.files) {
            const fileUrl = `${SKILLS_BASE_URL}/${skillId}/${file}`;
            const response = await fetch(fileUrl);
            if (!response.ok) throw new Error(`Failed to download ${file}`);
            const content = await response.text();
            await invoke('skill_save_file', { skillId, fileName: file, content });
          }
          installed.push(skillId);
        } catch (err) {
          console.error(`Failed to install skill ${skillId}:`, err);
        }
      }

      setInstalledSkills(installed);
      goNext();
    } catch (err) {
      console.error('Failed to install skills:', err);
      setSkillsError(err instanceof Error ? err.message : 'Failed to install skills');
    } finally {
      setSkillsInstalling(false);
    }
  };

  const skipSkills = () => {
    setInstalledSkills([]);
    goNext();
  };

  // === Render Steps ===
  const renderWelcome = () => (
    <>
      <div class="onboarding-illustration">
        <img src={WelcomeSvg} alt="Welcome to Onyx" />
      </div>
      <h1 class="onboarding-headline">Welcome to Onyx</h1>
      <p class="onboarding-subhead">Your AI-powered workspace for focused work and clear thinking.</p>
      
      <div class="onboarding-benefits">
        <div class="onboarding-benefit-item">
          <span class="onboarding-benefit-icon">🚀</span>
          <span class="onboarding-benefit-text">Capture ideas, organize projects, and get more done</span>
        </div>
        <div class="onboarding-benefit-item">
          <span class="onboarding-benefit-icon">🤖</span>
          <span class="onboarding-benefit-text">AI assistant helps you write, research, and brainstorm</span>
        </div>
        <div class="onboarding-benefit-item">
          <span class="onboarding-benefit-icon">🔒</span>
          <span class="onboarding-benefit-text">Your work stays private — you own your data, always</span>
        </div>
      </div>

      <div class="onboarding-actions">
        <button class="onboarding-button primary" onClick={goNext}>
          Get Started
        </button>
      </div>
    </>
  );

  const renderVault = () => (
    <>
      <div class="onboarding-illustration">
        <img src={VaultSvg} alt="Choose your vault" />
      </div>
      <h1 class="onboarding-headline">Choose your vault</h1>
      <p class="onboarding-subhead">
        A vault is simply a folder where your notes live. They're regular files you can access anytime, anywhere.
      </p>

      <Show when={vaultError()}>
        <div class="onboarding-error">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <p>{vaultError()}</p>
        </div>
      </Show>

      <Show when={props.isMobile} fallback={
        <div class="onboarding-vault-options">
          <div class="onboarding-vault-option" onClick={createNewVault}>
            <div class="onboarding-vault-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 5v14M5 12h14"/>
              </svg>
            </div>
            <div class="onboarding-vault-info">
              <div class="onboarding-vault-title">Create a new vault</div>
              <div class="onboarding-vault-desc">We'll create a folder called "Onyx Notes"</div>
            </div>
          </div>
          <div class="onboarding-vault-option" onClick={chooseExistingVault}>
            <div class="onboarding-vault-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
              </svg>
            </div>
            <div class="onboarding-vault-info">
              <div class="onboarding-vault-title">Choose existing folder</div>
              <div class="onboarding-vault-desc">Use a folder you already have</div>
            </div>
          </div>
        </div>
      }>
        {/* Mobile - simpler flow */}
        <div class="onboarding-actions">
          <button 
            class="onboarding-button primary" 
            onClick={createNewVault}
            disabled={vaultLoading()}
          >
            {vaultLoading() ? 'Creating...' : 'Create My Vault'}
          </button>
        </div>
      </Show>
    </>
  );

  const renderFeatures = () => (
    <>
      <div class="onboarding-illustration">
        <img src={FeaturesSvg} alt="Your productivity workspace" />
      </div>
      <h1 class="onboarding-headline">Built for focused work</h1>
      <p class="onboarding-subhead">Everything you need to think clearly and work efficiently</p>

      <div class="onboarding-feature-cards">
        <div class="onboarding-feature-card">
          <span class="onboarding-feature-icon">🤖</span>
          <div class="onboarding-feature-title">AI Executive Assistant</div>
          <div class="onboarding-feature-desc">Stay organized, manage tasks, and get more done with AI that works for you</div>
        </div>
        <div class="onboarding-feature-card">
          <span class="onboarding-feature-icon">🔗</span>
          <div class="onboarding-feature-title">Connected Ideas</div>
          <div class="onboarding-feature-desc">Link notes together to build your knowledge base</div>
        </div>
        <div class="onboarding-feature-card">
          <span class="onboarding-feature-icon">⚡</span>
          <div class="onboarding-feature-title">Lightning Fast</div>
          <div class="onboarding-feature-desc">Search and navigate instantly across all your work</div>
        </div>
        <div class="onboarding-feature-card">
          <span class="onboarding-feature-icon">🔒</span>
          <div class="onboarding-feature-title">Your Data</div>
          <div class="onboarding-feature-desc">Files stored locally — no vendor lock-in, ever</div>
        </div>
      </div>

      <div class="onboarding-actions">
        <button class="onboarding-button primary" onClick={goNext}>
          Continue
        </button>
      </div>
    </>
  );

  const renderNostr = () => (
    <>
      <div class="onboarding-illustration">
        <img src={NostrSvg} alt="Own your identity" />
      </div>
      <h1 class="onboarding-headline">Own your identity</h1>
      <p class="onboarding-subhead">Connect with Nostr to unlock powerful features</p>

      <Show when={nostrSetup() === null || nostrMode() === 'choose'}>
        <div class="onboarding-benefits">
          <div class="onboarding-benefit-item">
            <span class="onboarding-benefit-icon">🌐</span>
            <span class="onboarding-benefit-text">Publish your writing to the world</span>
          </div>
          <div class="onboarding-benefit-item">
            <span class="onboarding-benefit-icon">💾</span>
            <span class="onboarding-benefit-text">Back up your notes securely</span>
          </div>
          <div class="onboarding-benefit-item">
            <span class="onboarding-benefit-icon">🤝</span>
            <span class="onboarding-benefit-text">Share notes with friends and collaborators</span>
          </div>
          <div class="onboarding-benefit-item">
            <span class="onboarding-benefit-icon">🔑</span>
            <span class="onboarding-benefit-text">One identity across many apps — no passwords needed</span>
          </div>
        </div>

        <p class="onboarding-explanation">
          Nostr is a new way to own your online identity. Unlike social media accounts, no company controls it — you do.
        </p>

        <Show when={nostrError()}>
          <div class="onboarding-error">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <p>{nostrError()}</p>
          </div>
        </Show>

        <div class="onboarding-nostr-options">
          <button 
            class="onboarding-button primary" 
            onClick={createNostrIdentity}
            disabled={nostrLoading()}
          >
            {nostrLoading() ? 'Creating...' : 'Create New Identity'}
          </button>
          <button 
            class="onboarding-button secondary" 
            onClick={() => setNostrMode('import')}
            disabled={nostrLoading()}
          >
            I Already Have One
          </button>
        </div>

        <button class="onboarding-skip" onClick={skipNostr}>
          Set up later in Settings
        </button>
      </Show>

      {/* Import mode */}
      <Show when={nostrMode() === 'import' && nostrSetup() === null}>
        <div class="onboarding-nostr-form">
          <input
            type="password"
            class="onboarding-input"
            placeholder="nsec1... or hex private key"
            value={importKey()}
            onInput={(e) => setImportKey(e.currentTarget.value)}
            onKeyPress={(e) => e.key === 'Enter' && importNostrIdentity()}
          />
          
          <Show when={nostrError()}>
            <div class="onboarding-error">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"/>
                <line x1="12" y1="8" x2="12" y2="12"/>
                <line x1="12" y1="16" x2="12.01" y2="16"/>
              </svg>
              <p>{nostrError()}</p>
            </div>
          </Show>

          <div class="onboarding-button-row">
            <button class="onboarding-button secondary" onClick={() => setNostrMode('choose')}>
              Back
            </button>
            <button 
              class="onboarding-button primary" 
              onClick={importNostrIdentity}
              disabled={nostrLoading()}
            >
              {nostrLoading() ? 'Importing...' : 'Import'}
            </button>
          </div>
        </div>
      </Show>

      {/* Success - show keys */}
      <Show when={nostrIdentity() && (nostrSetup() === 'created' || nostrSetup() === 'imported')}>
        <div class="onboarding-key-display">
          <div class="onboarding-key-item">
            <div class="onboarding-key-label">Your Public Key (npub)</div>
            <div class="onboarding-key-value">
              <code>{nostrIdentity()!.npub}</code>
              <button 
                class="onboarding-key-copy" 
                onClick={() => copyToClipboard(nostrIdentity()!.npub, 'npub')}
                title="Copy"
              >
                <Show when={copiedKey() === 'npub'} fallback={
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                  </svg>
                }>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                </Show>
              </button>
            </div>
          </div>

          <div class="onboarding-key-item">
            <div class="onboarding-key-label">Your Private Key (nsec) — Keep this secret!</div>
            <div class="onboarding-key-value">
              <Show when={showNsec()} fallback={<code>••••••••••••••••••••••••••••••••</code>}>
                <code>{nostrIdentity()!.nsec}</code>
              </Show>
              <button 
                class="onboarding-key-copy" 
                onClick={() => setShowNsec(!showNsec())}
                title={showNsec() ? 'Hide' : 'Show'}
              >
                <Show when={showNsec()} fallback={
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                    <circle cx="12" cy="12" r="3"/>
                  </svg>
                }>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/>
                    <line x1="1" y1="1" x2="23" y2="23"/>
                  </svg>
                </Show>
              </button>
              <button 
                class="onboarding-key-copy" 
                onClick={() => copyToClipboard(nostrIdentity()!.nsec, 'nsec')}
                title="Copy"
              >
                <Show when={copiedKey() === 'nsec'} fallback={
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <rect x="9" y="9" width="13" height="13" rx="2" ry="2"/>
                    <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>
                  </svg>
                }>
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                </Show>
              </button>
            </div>
          </div>
        </div>

        <div class="onboarding-key-warning">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
            <line x1="12" y1="9" x2="12" y2="13"/>
            <line x1="12" y1="17" x2="12.01" y2="17"/>
          </svg>
          <p>
            <strong>Save your private key now!</strong> It's the only way to recover your identity. 
            Store it somewhere safe — we can't recover it for you.
          </p>
        </div>

        <div class="onboarding-actions">
          <button class="onboarding-button primary" onClick={goNext}>
            I've Saved My Key — Continue
          </button>
        </div>
      </Show>
    </>
  );

  const renderSync = () => (
    <>
      <div class="onboarding-illustration">
        <img src={SyncSvg} alt="Access your notes everywhere" />
      </div>
      <h1 class="onboarding-headline">Access your notes everywhere</h1>
      <p class="onboarding-subhead">Sync keeps your notes safe and available on all your devices</p>

      <Show when={nostrSetup() !== 'skipped'} fallback={
        <div class="onboarding-sync-disabled">
          <p>Sync requires a Nostr identity to work securely. You can set this up anytime in Settings.</p>
          <button class="onboarding-button secondary" onClick={goBack}>
            Go Back to Set Up Identity
          </button>
        </div>
      }>
        <div class="onboarding-benefits">
          <div class="onboarding-benefit-item">
            <span class="onboarding-benefit-icon">📱</span>
            <span class="onboarding-benefit-text">Read and edit from your phone, tablet, or any computer</span>
          </div>
          <div class="onboarding-benefit-item">
            <span class="onboarding-benefit-icon">☁️</span>
            <span class="onboarding-benefit-text">Automatic backups — never lose a note again</span>
          </div>
          <div class="onboarding-benefit-item">
            <span class="onboarding-benefit-icon">🔐</span>
            <span class="onboarding-benefit-text">End-to-end encrypted — only you can read your notes</span>
          </div>
        </div>

        <div class="onboarding-sync-toggle">
          <div class="onboarding-sync-info">
            <div class="onboarding-sync-label">Enable cloud sync</div>
            <div class="onboarding-sync-desc">Sync your notes across devices</div>
          </div>
          <label class="onboarding-toggle">
            <input 
              type="checkbox" 
              checked={syncEnabled()} 
              onChange={(e) => setSyncEnabled(e.currentTarget.checked)}
            />
            <span class="onboarding-toggle-slider"></span>
          </label>
        </div>
      </Show>

      <div class="onboarding-actions">
        <button class="onboarding-button primary" onClick={syncEnabled() ? enableSync : goNext}>
          {syncEnabled() ? 'Enable Sync & Continue' : 'Continue'}
        </button>
      </div>

      <Show when={nostrSetup() !== 'skipped'}>
        <button class="onboarding-skip" onClick={skipSync}>
          Set up later in Settings
        </button>
      </Show>
    </>
  );

  const renderOpenCode = () => (
    <>
      <div class="onboarding-illustration">
        <img src={AiSvg} alt="Meet your AI writing partner" />
      </div>
      <h1 class="onboarding-headline">Meet your AI writing partner</h1>
      <p class="onboarding-subhead">Get help with research, writing, and editing — right inside your notes</p>

      <div class="onboarding-benefits">
        <div class="onboarding-benefit-item">
          <span class="onboarding-benefit-icon">💡</span>
          <span class="onboarding-benefit-text">Ask questions and get instant answers</span>
        </div>
        <div class="onboarding-benefit-item">
          <span class="onboarding-benefit-icon">✍️</span>
          <span class="onboarding-benefit-text">Help with writing, editing, and summarizing</span>
        </div>
        <div class="onboarding-benefit-item">
          <span class="onboarding-benefit-icon">🔍</span>
          <span class="onboarding-benefit-text">Research topics without leaving your notes</span>
        </div>
        <div class="onboarding-benefit-item">
          <span class="onboarding-benefit-icon">📝</span>
          <span class="onboarding-benefit-text">Generate outlines, drafts, and ideas</span>
        </div>
      </div>

      <div class="onboarding-opencode-status">
        <Show when={openCodeStatus() === 'checking'}>
          <div class="onboarding-status-icon checking">
            <div class="onboarding-spinner"></div>
          </div>
          <span class="onboarding-status-text">Checking for AI assistant...</span>
        </Show>

        <Show when={openCodeStatus() === 'installed'}>
          <div class="onboarding-status-icon success">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>
          <span class="onboarding-status-text">AI Assistant is ready!</span>
        </Show>

        <Show when={openCodeStatus() === 'not-installed'}>
          <button 
            class="onboarding-button primary" 
            onClick={installOpenCode}
          >
            Install AI Assistant
          </button>
        </Show>

        <Show when={openCodeStatus() === 'installing'}>
          <div class="onboarding-install-progress">
            <div class="onboarding-progress-bar">
              <div 
                class="onboarding-progress-fill" 
                style={{ width: `${installProgress()?.progress || 0}%` }}
              ></div>
            </div>
            <p class="onboarding-progress-text">{installProgress()?.message || 'Installing...'}</p>
          </div>
        </Show>

        <Show when={openCodeStatus() === 'error'}>
          <div class="onboarding-error">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="10"/>
              <line x1="12" y1="8" x2="12" y2="12"/>
              <line x1="12" y1="16" x2="12.01" y2="16"/>
            </svg>
            <p>{openCodeError() || 'Installation failed'}</p>
          </div>
          <button class="onboarding-button primary" onClick={installOpenCode}>
            Retry Installation
          </button>
        </Show>
      </div>

      <Show when={openCodeStatus() === 'installed'}>
        <div class="onboarding-actions">
          <button class="onboarding-button primary" onClick={goNext}>
            Continue
          </button>
        </div>
      </Show>

      <Show when={openCodeStatus() !== 'checking' && openCodeStatus() !== 'installing' && openCodeStatus() !== 'installed'}>
        <button class="onboarding-skip" onClick={skipOpenCode}>
          Set up later in Settings
        </button>
      </Show>
    </>
  );

  const renderSkills = () => (
    <>
      <div class="onboarding-illustration">
        <img src={SkillsSvg} alt="Supercharge your workflow" />
      </div>
      <h1 class="onboarding-headline">Supercharge your workflow</h1>
      <p class="onboarding-subhead">Skills teach your AI assistant new tricks</p>

      <p class="onboarding-explanation">
        Skills are like apps for your AI — install the ones that match how you work.
      </p>

      <Show when={skillsLoading()}>
        <div class="onboarding-opencode-status">
          <div class="onboarding-spinner"></div>
          <span class="onboarding-status-text">Loading skills...</span>
        </div>
      </Show>

      <Show when={skillsError()}>
        <div class="onboarding-error">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="10"/>
            <line x1="12" y1="8" x2="12" y2="12"/>
            <line x1="12" y1="16" x2="12.01" y2="16"/>
          </svg>
          <p>{skillsError()}</p>
        </div>
      </Show>

      <Show when={!skillsLoading() && !skillsInstalling() && availableSkills().length > 0}>
        <div class="onboarding-skills-list">
          <For each={availableSkills()}>
            {(skill) => (
              <div 
                class={`onboarding-skill-item ${selectedSkills().has(skill.id) ? 'selected' : ''}`}
                onClick={() => toggleSkill(skill.id)}
              >
                <div class="onboarding-skill-checkbox">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                    <polyline points="20 6 9 17 4 12"/>
                  </svg>
                </div>
                <div class="onboarding-skill-info">
                  <div class="onboarding-skill-name">{skill.name}</div>
                  <div class="onboarding-skill-desc">{skill.description}</div>
                </div>
              </div>
            )}
          </For>
        </div>

        <div class="onboarding-actions">
          <button 
            class="onboarding-button primary" 
            onClick={installSelectedSkills}
            disabled={skillsInstalling()}
          >
            {selectedSkills().size > 0 
              ? `Install ${selectedSkills().size} Skill${selectedSkills().size > 1 ? 's' : ''}`
              : 'Continue Without Skills'}
          </button>
        </div>
      </Show>

      <Show when={skillsInstalling()}>
        <div class="onboarding-skills-installing">
          <div class="onboarding-spinner"></div>
          <span class="onboarding-status-text">Installing skills...</span>
        </div>
      </Show>

      <Show when={!skillsLoading() && !skillsInstalling()}>
        <button class="onboarding-skip" onClick={skipSkills}>
          Browse skills later in Settings
        </button>
      </Show>
    </>
  );

  const renderComplete = () => (
    <>
      <div class="onboarding-illustration">
        <img src={CompleteSvg} alt="You're all set!" />
      </div>
      <h1 class="onboarding-headline">You're all set!</h1>
      <p class="onboarding-subhead">Your workspace is ready. Let's create something amazing.</p>

      <div class="onboarding-summary">
        <div class="onboarding-summary-item">
          <div class="onboarding-summary-icon completed">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          </div>
          <span class="onboarding-summary-text">Vault created</span>
        </div>

        <div class="onboarding-summary-item">
          <div class={`onboarding-summary-icon ${nostrSetup() !== 'skipped' ? 'completed' : 'skipped'}`}>
            <Show when={nostrSetup() !== 'skipped'} fallback={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M5 12h14"/>
                <path d="M12 5l7 7-7 7"/>
              </svg>
            }>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            </Show>
          </div>
          <span class={`onboarding-summary-text ${nostrSetup() === 'skipped' ? 'skipped' : ''}`}>
            {nostrSetup() !== 'skipped' ? 'Nostr identity connected' : 'Nostr identity — set up in Settings'}
          </span>
        </div>

        <div class="onboarding-summary-item">
          <div class={`onboarding-summary-icon ${syncEnabled() ? 'completed' : 'skipped'}`}>
            <Show when={syncEnabled()} fallback={
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M5 12h14"/>
                <path d="M12 5l7 7-7 7"/>
              </svg>
            }>
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                <polyline points="20 6 9 17 4 12"/>
              </svg>
            </Show>
          </div>
          <span class={`onboarding-summary-text ${!syncEnabled() ? 'skipped' : ''}`}>
            {syncEnabled() ? 'Cloud sync enabled' : 'Cloud sync — set up in Settings'}
          </span>
        </div>

        <Show when={!props.isMobile}>
          <div class="onboarding-summary-item">
            <div class={`onboarding-summary-icon ${openCodeInstalled() ? 'completed' : 'skipped'}`}>
              <Show when={openCodeInstalled()} fallback={
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M5 12h14"/>
                  <path d="M12 5l7 7-7 7"/>
                </svg>
              }>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              </Show>
            </div>
            <span class={`onboarding-summary-text ${!openCodeInstalled() ? 'skipped' : ''}`}>
              {openCodeInstalled() ? 'AI assistant installed' : 'AI assistant — set up in Settings'}
            </span>
          </div>

          <div class="onboarding-summary-item">
            <div class={`onboarding-summary-icon ${installedSkills().length > 0 ? 'completed' : 'skipped'}`}>
              <Show when={installedSkills().length > 0} fallback={
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M5 12h14"/>
                  <path d="M12 5l7 7-7 7"/>
                </svg>
              }>
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                  <polyline points="20 6 9 17 4 12"/>
                </svg>
              </Show>
            </div>
            <span class={`onboarding-summary-text ${installedSkills().length === 0 ? 'skipped' : ''}`}>
              {installedSkills().length > 0 
                ? `${installedSkills().length} skill${installedSkills().length > 1 ? 's' : ''} installed` 
                : 'Skills — browse in Settings'}
            </span>
          </div>
        </Show>
      </div>

      <div class="onboarding-actions">
        <button class="onboarding-button primary" onClick={() => completeOnboarding(true)}>
          Create Your First Note
        </button>
        <button class="onboarding-button secondary" onClick={() => completeOnboarding(false)}>
          Explore Onyx
        </button>
      </div>
    </>
  );

  return (
    <div class="onboarding-overlay">
      <div class="onboarding-modal">
        {/* Progress dots */}
        <div class="onboarding-progress">
          <For each={steps}>
            {(_step, index) => (
              <div 
                class={`onboarding-progress-dot ${
                  index() === currentStepIndex() ? 'active' : 
                  index() < currentStepIndex() ? 'completed' : ''
                }`}
              />
            )}
          </For>
        </div>

        {/* Step content */}
        <div class="onboarding-content">
          <Show when={currentStep() === 'welcome'}>{renderWelcome()}</Show>
          <Show when={currentStep() === 'vault'}>{renderVault()}</Show>
          <Show when={currentStep() === 'features'}>{renderFeatures()}</Show>
          <Show when={currentStep() === 'nostr'}>{renderNostr()}</Show>
          <Show when={currentStep() === 'sync'}>{renderSync()}</Show>
          <Show when={currentStep() === 'opencode'}>{renderOpenCode()}</Show>
          <Show when={currentStep() === 'skills'}>{renderSkills()}</Show>
          <Show when={currentStep() === 'complete'}>{renderComplete()}</Show>
        </div>
      </div>
    </div>
  );
};

export default Onboarding;
