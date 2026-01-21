import { Component, createSignal, createEffect, For, Show, onMount, onCleanup } from 'solid-js';
import Sidebar from './components/Sidebar';
import Editor from './components/Editor';
import QuickSwitcher from './components/QuickSwitcher';
import CommandPalette from './components/CommandPalette';
import SearchPanel from './components/SearchPanel';
import OpenCodePanel from './components/OpenCodePanel';
import Settings from './components/Settings';
import GraphView from './components/GraphView';
import OutlinePanel from './components/OutlinePanel';
import BacklinksPanel from './components/BacklinksPanel';
import ShareDialog from './components/ShareDialog';
import NotificationsPanel from './components/NotificationsPanel';
import SharedDocPreview from './components/SharedDocPreview';
import SentSharesPanel from './components/SentSharesPanel';
import FileInfoDialog from './components/FileInfoDialog';
import PostToNostrDialog from './components/PostToNostrDialog';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { writeTextFile, mkdir, exists } from '@tauri-apps/plugin-fs';
import { getSyncEngine, getCurrentLogin } from './lib/nostr';
import { getSignerFromStoredLogin } from './lib/nostr/signer';
import { buildNoteIndex, resolveWikilink, NoteIndex, FileEntry, NoteGraph, buildNoteGraph } from './lib/editor/note-index';
import { HeadingInfo } from './lib/editor/heading-plugin';
import { AssetIndex, AssetEntry, buildAssetIndex } from './lib/editor/asset-index';
import type { SharedDocument, SentShare, Vault } from './lib/nostr/types';

interface Tab {
  path: string;
  name: string;
  content: string;
  isDirty: boolean;
}

interface AppSettings {
  vault_path: string | null;
  show_terminal: boolean;
}

type SidebarView = 'files' | 'search' | 'bookmarks';

const App: Component = () => {
  const [vaultPath, setVaultPath] = createSignal<string | null>(null);
  const [tabs, setTabs] = createSignal<Tab[]>([]);
  const [activeTabIndex, setActiveTabIndex] = createSignal<number>(-1);
  const [showQuickSwitcher, setShowQuickSwitcher] = createSignal(false);
  const [showCommandPalette, setShowCommandPalette] = createSignal(false);
  const [showSearch, setShowSearch] = createSignal(false);
  const [showTerminal, setShowTerminal] = createSignal(false);
  const [showSettings, setShowSettings] = createSignal(false);
  const [settingsSection, setSettingsSection] = createSignal<string | undefined>(undefined);
  const [showGraphView, setShowGraphView] = createSignal(false);
  const [terminalWidth, setTerminalWidth] = createSignal(500);
  const [sidebarWidth, setSidebarWidth] = createSignal(260);
  let createNoteFromSidebar: (() => void) | null = null;
  let refreshSidebar: (() => void) | null = null;
  let setSearchQuery: ((query: string) => void) | null = null;
  const [scrollToLine, setScrollToLine] = createSignal<number | null>(null);
  const [noteIndex, setNoteIndex] = createSignal<NoteIndex | null>(null);
  const [assetIndex, setAssetIndex] = createSignal<AssetIndex | null>(null);
  const [isResizing, setIsResizing] = createSignal<'sidebar' | 'terminal' | 'outline' | 'backlinks' | null>(null);

  // Backlinks panel state
  const [showBacklinks, setShowBacklinks] = createSignal(
    localStorage.getItem('show_backlinks') === 'true'
  );
  const [backlinksWidth, setBacklinksWidth] = createSignal(
    parseInt(localStorage.getItem('backlinks_width') || '250')
  );

  // Note graph and file contents for backlinks
  const [noteGraph, setNoteGraph] = createSignal<NoteGraph | null>(null);
  const [fileContents, setFileContents] = createSignal<Map<string, string>>(new Map());

  // Outline panel state
  const [showOutline, setShowOutline] = createSignal(
    localStorage.getItem('show_outline') === 'true'
  );
  const [outlineWidth, setOutlineWidth] = createSignal(
    parseInt(localStorage.getItem('outline_width') || '250')
  );

  // Heading state from editor plugin
  const [currentHeadings, setCurrentHeadings] = createSignal<HeadingInfo[]>([]);
  const [activeHeadingId, setActiveHeadingId] = createSignal<string | null>(null);
  const [scrollToHeadingId, setScrollToHeadingId] = createSignal<string | null>(null);

  // Anchor navigation state (for wikilink #heading and ^blockid references)
  const [scrollToHeadingText, setScrollToHeadingText] = createSignal<string | null>(null);
  const [scrollToBlockId, setScrollToBlockId] = createSignal<string | null>(null);

  const [resizeStartX, setResizeStartX] = createSignal(0);
  const [resizeStartWidth, setResizeStartWidth] = createSignal(0);
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);
  const [sidebarView, setSidebarView] = createSignal<SidebarView>('files');
  // TODO: Sync bookmarks and saved searches via Nostr (encrypted user preferences)
  const [bookmarks, setBookmarks] = createSignal<string[]>(
    JSON.parse(localStorage.getItem('bookmarks') || '[]')
  );
  const [savedSearches, setSavedSearches] = createSignal<string[]>(
    JSON.parse(localStorage.getItem('savedSearches') || '[]')
  );

  // Close tab confirmation modal
  const [closeTabConfirm, setCloseTabConfirm] = createSignal<{ index: number; name: string } | null>(null);

  // Document Sharing state
  const [showNotifications, setShowNotifications] = createSignal(false);
  const [showSentShares, setShowSentShares] = createSignal(false);
  const [showShareDialog, setShowShareDialog] = createSignal(false);
  const [shareTarget, setShareTarget] = createSignal<{ path: string; content: string; title: string } | null>(null);
  const [sharedWithMe, setSharedWithMe] = createSignal<SharedDocument[]>([]);
  const [sentShares, setSentShares] = createSignal<SentShare[]>([]);
  const [isLoadingShares, setIsLoadingShares] = createSignal(false);
  const [previewingDoc, setPreviewingDoc] = createSignal<SharedDocument | null>(null);
  const [isImporting, setIsImporting] = createSignal(false);
  const [currentVault, setCurrentVault] = createSignal<Vault | null>(null);

  // File Info and Post to Nostr dialogs
  const [showFileInfo, setShowFileInfo] = createSignal<string | null>(null);
  const [postToNostrTarget, setPostToNostrTarget] = createSignal<{ path: string; content: string; title: string } | null>(null);

  // Unread count for notifications badge
  const unreadShareCount = () => sharedWithMe().filter(d => !d.isRead).length;

  // Auto-save timer
  let autoSaveTimeout: number | null = null;

  // Share polling interval
  let sharePollingInterval: number | null = null;

  // Debounce timer for file watcher
  let fileChangeDebounce: number | null = null;

  // Apply appearance settings from localStorage
  const applyAppearanceSettings = () => {
    const root = document.documentElement;

    // Apply theme
    const theme = localStorage.getItem('theme') || 'dark';
    if (theme === 'system') {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      root.setAttribute('data-theme', prefersDark ? 'dark' : 'light');
    } else {
      root.setAttribute('data-theme', theme);
    }

    // Apply accent color
    const accent = localStorage.getItem('accent_color') || '#8b5cf6';
    root.style.setProperty('--accent', accent);
    // Calculate hover color (lighter version)
    const num = parseInt(accent.replace('#', ''), 16);
    const amt = Math.round(2.55 * 20);
    const R = Math.min(255, (num >> 16) + amt);
    const G = Math.min(255, ((num >> 8) & 0x00FF) + amt);
    const B = Math.min(255, (num & 0x0000FF) + amt);
    const hoverColor = `#${(0x1000000 + R * 0x10000 + G * 0x100 + B).toString(16).slice(1)}`;
    root.style.setProperty('--accent-hover', hoverColor);
    root.style.setProperty('--accent-muted', `${accent}26`);

    // Apply font size
    const fontSize = localStorage.getItem('interface_font_size') || 'medium';
    root.setAttribute('data-font-size', fontSize);

    // Apply translucent
    const translucent = localStorage.getItem('translucent_window') === 'true';
    root.setAttribute('data-translucent', translucent.toString());
  };

  // Load settings on startup
  onMount(() => {
    // Apply appearance settings immediately
    applyAppearanceSettings();

    // Listen for system theme changes
    const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
    mediaQuery.addEventListener('change', () => {
      if (localStorage.getItem('theme') === 'system') {
        applyAppearanceSettings();
      }
    });

    // Load settings asynchronously
    invoke<AppSettings>('load_settings').then(async (settings) => {
      if (settings.vault_path) {
        setVaultPath(settings.vault_path);
        // Build note index for wikilink resolution
        try {
          const files = await invoke<FileEntry[]>('list_files', { path: settings.vault_path });
          setNoteIndex(buildNoteIndex(files, settings.vault_path));
        } catch (err) {
          console.error('Failed to build initial note index:', err);
        }
        // Build asset index for embed resolution
        try {
          const assets = await invoke<AssetEntry[]>('list_assets', { path: settings.vault_path });
          setAssetIndex(buildAssetIndex(assets, settings.vault_path));
        } catch (err) {
          console.error('Failed to build initial asset index:', err);
        }
      }
      if (settings.show_terminal) {
        setShowTerminal(true);
      }
    }).catch(err => {
      console.error('Failed to load settings:', err);
    });

    // Initialize sync status from localStorage
    const syncEnabled = localStorage.getItem('sync_enabled') === 'true';
    setSyncStatus(syncEnabled ? 'idle' : 'off');

    // Set up file change listener
    let unlistenFn: (() => void) | null = null;
    let unlistenFileModified: (() => void) | null = null;

    listen('files-changed', () => {
      // Debounce refreshes to avoid too many updates
      if (fileChangeDebounce) {
        clearTimeout(fileChangeDebounce);
      }
      fileChangeDebounce = window.setTimeout(() => {
        refreshSidebar?.();
        rebuildNoteIndex();  // Rebuild index on file changes for wikilink resolution
        fileChangeDebounce = null;
      }, 500);
    }).then(unlisten => {
      unlistenFn = unlisten;
    });

    // Listen for specific file modifications to reload open tabs
    listen<string[]>('file-modified', async (event) => {
      const modifiedPaths = event.payload;
      const currentTabs = tabs();

      for (const modifiedPath of modifiedPaths) {
        const tabIndex = currentTabs.findIndex(tab => tab.path === modifiedPath);
        if (tabIndex !== -1) {
          const tab = currentTabs[tabIndex];
          // Only reload if the tab is not dirty (no unsaved changes)
          if (!tab.isDirty) {
            try {
              const newContent = await invoke<string>('read_file', { path: modifiedPath });
              // Update tab content
              setTabs(prevTabs => prevTabs.map((t, i) =>
                i === tabIndex ? { ...t, content: newContent } : t
              ));
            } catch (err) {
              console.error('Failed to reload file:', modifiedPath, err);
            }
          }
        }
      }
    }).then(unlisten => {
      unlistenFileModified = unlisten;
    });

    // Cleanup must be registered synchronously
    onCleanup(() => {
      unlistenFn?.();
      unlistenFileModified?.();
      invoke('stop_watching').catch(() => {});
      if (sharePollingInterval) {
        clearInterval(sharePollingInterval);
      }
    });

    // Fetch shared documents if logged in
    fetchSharedDocuments();

    // Set up polling for shared documents (every 5 minutes)
    sharePollingInterval = window.setInterval(() => {
      fetchSharedDocuments();
    }, 5 * 60 * 1000);
  });

  // Fetch shared documents from relays
  const fetchSharedDocuments = async () => {
    const login = getCurrentLogin();
    if (!login) return;

    setIsLoadingShares(true);
    try {
      const engine = getSyncEngine();
      
      // Only create signer if engine doesn't have one yet
      if (!engine.getSigner()) {
        const signer = await getSignerFromStoredLogin();
        if (signer) {
          await engine.setSigner(signer);
        }
      }
      
      if (engine.getSigner()) {
        // Fetch documents shared with me and documents I've shared
        const [receivedDocs, sentDocs] = await Promise.all([
          engine.fetchSharedWithMe(),
          engine.fetchSentShares(),
        ]);
        
        setSharedWithMe(receivedDocs);
        setSentShares(sentDocs);

        // Also fetch vault for import functionality
        const vaults = await engine.fetchVaults();
        if (vaults.length > 0) {
          setCurrentVault(vaults[0]);
        }
      }
    } catch (err) {
      console.error('Failed to fetch shared documents:', err);
    } finally {
      setIsLoadingShares(false);
    }
  };

  // Handle previewing a shared document
  const handlePreviewSharedDoc = (doc: SharedDocument) => {
    // Mark as read
    const engine = getSyncEngine();
    engine.markShareAsRead(doc.eventId);
    
    // Update local state
    setSharedWithMe(prev => prev.map(d => 
      d.eventId === doc.eventId ? { ...d, isRead: true } : d
    ));
    
    setPreviewingDoc(doc);
    setShowNotifications(false);
  };

  // Handle importing a shared document
  const handleImportSharedDoc = async (doc: SharedDocument) => {
    const vp = vaultPath();
    if (!vp) {
      console.error('No vault path available for import');
      return;
    }

    setIsImporting(true);
    try {
      // Extract safe filename from the document
      const rawFilename = doc.title || doc.data.path || 'Untitled';
      // Get just the filename part (handle Windows and Unix paths)
      let filename = rawFilename.split(/[/\\]/).pop() || 'Untitled';
      // Sanitize filename
      filename = filename
        .replace(/[<>:"|?*\x00-\x1f]/g, '_')  // Remove invalid chars
        .replace(/\.\./g, '_');  // Remove traversal attempts
      // Ensure .md extension
      if (!filename.toLowerCase().endsWith('.md')) {
        filename += '.md';
      }
      
      // Create Shared directory if it doesn't exist
      const sharedDir = `${vp}/Shared`;
      const dirExists = await exists(sharedDir);
      if (!dirExists) {
        await mkdir(sharedDir, { recursive: true });
      }
      
      // Write file to local filesystem
      const filePath = `${sharedDir}/${filename}`;
      await writeTextFile(filePath, doc.data.content);
      
      // Also sync to Nostr if sync is enabled
      const vault = currentVault();
      if (vault) {
        try {
          const engine = getSyncEngine();
          await engine.importSharedDocument(doc, vault);
        } catch (syncErr) {
          console.warn('Failed to sync imported document to Nostr:', syncErr);
          // Don't fail the import if sync fails - file is saved locally
        }
      }
      
      // Mark as read
      const engine = getSyncEngine();
      engine.markShareAsRead(doc.eventId);
      
      // Refresh sidebar to show new file
      refreshSidebar?.();
      
      // Open the imported file
      await openFile(filePath);
    } catch (err) {
      console.error('Failed to import shared document:', err);
    } finally {
      setIsImporting(false);
    }
  };

  // Handle dismissing a shared document (just mark as read)
  const handleDismissSharedDoc = (doc: SharedDocument) => {
    const engine = getSyncEngine();
    engine.markShareAsRead(doc.eventId);
    
    setSharedWithMe(prev => prev.map(d => 
      d.eventId === doc.eventId ? { ...d, isRead: true } : d
    ));
  };

  // Handle revoking a share
  const handleRevokeShare = async (share: SentShare) => {
    try {
      const engine = getSyncEngine();
      await engine.revokeShare(share.eventId);
      
      // Remove from local state
      setSentShares(prev => prev.filter(s => s.eventId !== share.eventId));
    } catch (err) {
      console.error('Failed to revoke share:', err);
    }
  };

  // Handle blocking a user (adds to NIP-51 mute list)
  const handleBlockUser = async (pubkey: string) => {
    try {
      const engine = getSyncEngine();
      await engine.addToMuteList(pubkey, true); // Private mute
      engine.invalidateMuteCache();
      
      // Remove all shares from this user from local state
      setSharedWithMe(prev => prev.filter(d => d.senderPubkey !== pubkey));
      
      // Close the preview
      setPreviewingDoc(null);
    } catch (err) {
      console.error('Failed to block user:', err);
      throw err; // Re-throw so the UI can show error state
    }
  };

  // Handle sharing a file
  const handleShareFile = (fullPath: string, content: string) => {
    // Extract title from path
    const parts = fullPath.split('/');
    const filename = parts[parts.length - 1] || 'Untitled';
    const title = filename.replace(/\.[^/.]+$/, '');
    
    // Use relative path for sharing (strip vault path)
    const relativePath = vaultPath() ? fullPath.replace(vaultPath()! + '/', '') : fullPath;
    
    setShareTarget({ path: relativePath, content, title });
    setShowShareDialog(true);
  };

  // Handle showing file info
  const handleFileInfo = (path: string) => {
    setShowFileInfo(path);
  };

  // Handle posting to Nostr
  const handlePostToNostr = (path: string, content: string, title: string) => {
    setPostToNostrTarget({ path, content, title });
  };

  // Start/stop file watcher when vault path changes
  createEffect(() => {
    const path = vaultPath();
    if (path) {
      invoke('start_watching', { path }).catch(console.error);
    } else {
      invoke('stop_watching').catch(() => {});
    }
  });

  // Save settings when vault path changes
  createEffect(() => {
    const path = vaultPath();
    const terminal = showTerminal();
    // Save settings (debounced by the effect system)
    invoke('save_settings', {
      settings: {
        vault_path: path,
        show_terminal: terminal,
      }
    }).catch(console.error);
  });

  // Persist outline panel state
  createEffect(() => {
    localStorage.setItem('show_outline', showOutline().toString());
  });
  createEffect(() => {
    localStorage.setItem('outline_width', outlineWidth().toString());
  });

  // Persist backlinks panel state
  createEffect(() => {
    localStorage.setItem('show_backlinks', showBacklinks().toString());
  });
  createEffect(() => {
    localStorage.setItem('backlinks_width', backlinksWidth().toString());
  });

  // Build note graph and cache file contents for backlinks
  createEffect(async () => {
    const index = noteIndex();
    const vault = vaultPath();
    if (!index || !vault) {
      setNoteGraph(null);
      setFileContents(new Map());
      return;
    }

    try {
      const contents = new Map<string, string>();

      // Read all files and cache contents
      const readFile = async (path: string) => {
        const content = await invoke<string>('read_file', { path });
        contents.set(path, content);
        return content;
      };

      const graph = await buildNoteGraph(vault, index, readFile);
      setNoteGraph(graph);
      setFileContents(contents);
    } catch (err) {
      console.error('Failed to build note graph:', err);
    }
  });

  // Clear headings when switching tabs
  createEffect(() => {
    activeTabIndex(); // Dependency
    setCurrentHeadings([]);
    setActiveHeadingId(null);
  });

  const currentTab = () => {
    const idx = activeTabIndex();
    return idx >= 0 ? tabs()[idx] : null;
  };

  // Word and character count for status bar
  const wordCount = () => {
    const content = currentTab()?.content || '';
    if (!content.trim()) return 0;
    return content.trim().split(/\s+/).length;
  };

  const charCount = () => {
    return (currentTab()?.content || '').length;
  };

  // Sync status for status bar
  const [syncStatus, setSyncStatus] = createSignal<'off' | 'idle' | 'syncing' | 'error'>('off');

  const openFile = async (path: string, line?: number) => {
    // Check if already open
    const existingIndex = tabs().findIndex(t => t.path === path);
    if (existingIndex >= 0) {
      setActiveTabIndex(existingIndex);
      // If line specified, scroll to it even if file is already open
      if (line) {
        setScrollToLine(line);
      }
      return;
    }

    // Load file content
    try {
      const content = await invoke<string>('read_file', { path });
      // Strip .md extension for display name
      // Handle both Unix (/) and Windows (\) path separators
      const parts = path.split(/[/\\]/);
      const name = (parts[parts.length - 1] || 'Untitled').replace(/\.md$/i, '');

      setTabs([...tabs(), { path, name, content, isDirty: false }]);
      setActiveTabIndex(tabs().length); // Will be the new last index after state updates

      // Set line to scroll to after editor loads
      if (line) {
        setScrollToLine(line);
      }
    } catch (err) {
      console.error('Failed to open file:', err);
    }
  };

  // Fix: Update activeTabIndex after tabs update
  createEffect(() => {
    const tabList = tabs();
    const idx = activeTabIndex();
    if (idx >= tabList.length && tabList.length > 0) {
      setActiveTabIndex(tabList.length - 1);
    }
  });

  const closeTab = (index: number) => {
    const tab = tabs()[index];
    if (tab.isDirty) {
      setCloseTabConfirm({ index, name: tab.name });
      return;
    }
    doCloseTab(index);
  };

  const doCloseTab = (index: number) => {
    const newTabs = tabs().filter((_, i) => i !== index);
    setTabs(newTabs);

    if (activeTabIndex() >= newTabs.length) {
      setActiveTabIndex(Math.max(0, newTabs.length - 1));
    } else if (activeTabIndex() > index) {
      setActiveTabIndex(activeTabIndex() - 1);
    }

    if (newTabs.length === 0) {
      setActiveTabIndex(-1);
    }
  };

  const handleCloseTabSave = async () => {
    const confirm = closeTabConfirm();
    if (!confirm) return;
    await saveTab(confirm.index);
    doCloseTab(confirm.index);
    setCloseTabConfirm(null);
  };

  const handleCloseTabDiscard = () => {
    const confirm = closeTabConfirm();
    if (!confirm) return;
    doCloseTab(confirm.index);
    setCloseTabConfirm(null);
  };

  const saveTab = async (index: number) => {
    const tab = tabs()[index];
    if (!tab) return;

    try {
      await invoke('write_file', { path: tab.path, content: tab.content });
      setTabs(tabs().map((t, i) => i === index ? { ...t, isDirty: false } : t));
    } catch (err) {
      console.error('Failed to save:', err);
    }
  };

  const updateTabContent = (content: string) => {
    const idx = activeTabIndex();
    if (idx < 0) return;

    setTabs(tabs().map((t, i) => i === idx ? { ...t, content, isDirty: true } : t));

    // Auto-save after 2 seconds of no typing
    if (autoSaveTimeout) clearTimeout(autoSaveTimeout);
    autoSaveTimeout = window.setTimeout(() => {
      saveTab(idx);
    }, 2000);
  };

  const saveCurrentTab = () => {
    const idx = activeTabIndex();
    if (idx >= 0) saveTab(idx);
  };

  // Global keyboard shortcuts
  onMount(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const isMod = e.ctrlKey || e.metaKey;

      if (isMod && e.key === 'o') {
        e.preventDefault();
        setShowQuickSwitcher(true);
      } else if (isMod && e.key === 'p') {
        e.preventDefault();
        setShowCommandPalette(true);
      } else if (isMod && e.shiftKey && e.key === 'F') {
        e.preventDefault();
        setShowSearch(true);
      } else if (isMod && e.key === 's') {
        e.preventDefault();
        saveCurrentTab();
      } else if (isMod && e.key === '`') {
        e.preventDefault();
        setShowTerminal(!showTerminal());
      } else if (isMod && e.shiftKey && e.key === 'O') {
        e.preventDefault();
        setShowOutline(!showOutline());
      } else if (isMod && e.shiftKey && e.key === 'B') {
        e.preventDefault();
        setShowBacklinks(!showBacklinks());
      } else if (e.key === 'Escape') {
        setShowQuickSwitcher(false);
        setShowCommandPalette(false);
        setShowSearch(false);
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  });

  const handleFileCreated = (path: string) => {
    openFile(path);
  };

  const createNewNote = () => {
    if (createNoteFromSidebar) {
      createNoteFromSidebar();
    }
  };

  const handleFileDeleted = (path: string) => {
    const idx = tabs().findIndex(t => t.path === path);
    if (idx >= 0) {
      closeTab(idx);
    }
  };

  const toggleBookmark = (path: string) => {
    const current = bookmarks();
    let updated: string[];
    if (current.includes(path)) {
      updated = current.filter(p => p !== path);
    } else {
      updated = [...current, path];
    }
    setBookmarks(updated);
    localStorage.setItem('bookmarks', JSON.stringify(updated));
  };

  const toggleSavedSearch = (query: string) => {
    const current = savedSearches();
    let updated: string[];
    if (current.includes(query)) {
      updated = current.filter(q => q !== query);
    } else {
      updated = [...current, query];
    }
    setSavedSearches(updated);
    localStorage.setItem('savedSearches', JSON.stringify(updated));
  };

  // Handle hashtag clicks from editor
  const handleHashtagClick = (tag: string) => {
    // Switch to search view
    switchSidebarView('search');
    // Set search query with tag: prefix
    if (setSearchQuery) {
      setSearchQuery(`#${tag}`);
    }
  };

  // Build/rebuild note index for wikilink resolution and asset index for embeds
  const rebuildNoteIndex = async () => {
    const path = vaultPath();
    if (!path) return;
    try {
      const files = await invoke<FileEntry[]>('list_files', { path });
      setNoteIndex(buildNoteIndex(files, path));
    } catch (err) {
      console.error('Failed to build note index:', err);
    }
    // Also rebuild asset index
    try {
      const assets = await invoke<AssetEntry[]>('list_assets', { path });
      setAssetIndex(buildAssetIndex(assets, path));
    } catch (err) {
      console.error('Failed to build asset index:', err);
    }
  };

  // Handle wikilink clicks from editor
  const handleWikilinkClick = async (
    target: string,
    heading?: string | null,
    blockId?: string | null
  ) => {
    const index = noteIndex();
    const vault = vaultPath();
    if (!vault) return;

    // Clear previous anchor state first (allows re-triggering same anchor)
    setScrollToHeadingText(null);
    setScrollToBlockId(null);

    // Same-note reference (empty target) - now handled directly in wikilink plugin
    // This branch is kept for any edge cases where same-note refs still come through
    if (!target) {
      // Small delay to ensure clear takes effect before setting new value
      setTimeout(() => {
        if (heading) {
          setScrollToHeadingText(heading);
        } else if (blockId) {
          setScrollToBlockId(blockId);
        }
      }, 10);
      return;
    }

    // Resolve the wikilink to a file path
    const resolved = resolveWikilink(
      target,
      currentTab()?.path || '',
      index,
      vault
    );

    if (resolved.exists && resolved.path) {
      // Open existing note
      await openFile(resolved.path);

      // After opening, navigate to anchor if specified
      // Use setTimeout to allow the editor to load the content first
      if (heading || blockId) {
        setTimeout(() => {
          if (heading) {
            setScrollToHeadingText(heading);
          } else if (blockId) {
            setScrollToBlockId(blockId);
          }
        }, 200);
      }
    } else if (resolved.path) {
      // Create new note (no anchor navigation for new notes)
      try {
        await invoke('create_file', { path: resolved.path });
        await openFile(resolved.path);
        refreshSidebar?.();
      } catch (err) {
        console.error('Failed to create note:', err);
      }
    }
  };

  const switchSidebarView = (view: SidebarView) => {
    if (sidebarCollapsed()) {
      setSidebarCollapsed(false);
    }
    setSidebarView(view);
  };

  // Handle sync from status bar
  const handleStatusBarSync = async () => {
    // Don't sync if already syncing or sync is disabled
    if (syncStatus() === 'syncing' || syncStatus() === 'off') {
      return;
    }

    // Check if we have a vault open
    if (!vaultPath()) {
      return;
    }

    setSyncStatus('syncing');

    try {
      const engine = getSyncEngine();

      // Only create signer if engine doesn't have one yet
      if (!engine.getSigner()) {
        const signer = await getSignerFromStoredLogin();
        if (!signer) {
          setSyncStatus('idle');
          return;
        }
        await engine.setSigner(signer);
      }

      // Fetch vaults
      const vaults = await engine.fetchVaults();
      let vault = vaults[0];

      if (!vault) {
        vault = await engine.createVault('My Notes', 'Default vault');
      }

      // Get local files
      const entries = await invoke<Array<{ name: string; path: string; isDirectory: boolean; children?: unknown[] }>>('list_files', { path: vaultPath() });

      const localFiles: { path: string; content: string }[] = [];
      const processEntries = async (entries: Array<{ name: string; path: string; isDirectory: boolean; children?: unknown[] }>) => {
        for (const entry of entries) {
          if (entry.isDirectory && entry.children) {
            await processEntries(entry.children as typeof entries);
          } else if (entry.name.endsWith('.md')) {
            const content = await invoke<string>('read_file', { path: entry.path });
            const relativePath = entry.path.replace(vaultPath()! + '/', '');
            localFiles.push({ path: relativePath, content });
          }
        }
      };
      await processEntries(entries);

      // Get remote files
      const remoteFiles = await engine.fetchVaultFiles(vault);
      const remoteFileMap = new Map(remoteFiles.map(f => [f.data.path, f]));

      // Sync files
      let downloadedCount = 0;

      for (const localFile of localFiles) {
        const remoteFile = remoteFileMap.get(localFile.path);
        if (!remoteFile || remoteFile.data.content !== localFile.content) {
          const result = await engine.publishFile(vault, localFile.path, localFile.content, remoteFile);
          vault = result.vault;
        }
        remoteFileMap.delete(localFile.path);
      }

      // Download remote-only files
      for (const [path, remoteFile] of remoteFileMap) {
        if (vault.data.deleted?.some(d => d.path === path)) continue;

        const fullPath = `${vaultPath()}/${path}`;
        const parentDir = fullPath.substring(0, fullPath.lastIndexOf('/'));
        if (parentDir !== vaultPath()) {
          await invoke('create_folder', { path: parentDir }).catch(() => {});
        }
        await invoke('write_file', { path: fullPath, content: remoteFile.data.content });
        downloadedCount++;
      }

      setSyncStatus('idle');

      // Refresh sidebar if files were downloaded
      if (downloadedCount > 0) {
        refreshSidebar?.();
      }
    } catch (err) {
      console.error('Sync failed:', err);
      setSyncStatus('error');
      // Reset to idle after 3 seconds
      setTimeout(() => {
        if (syncStatus() === 'error') {
          setSyncStatus('idle');
        }
      }, 3000);
    }
  };

  const commands = [
    { id: 'new-file', name: 'New File', action: () => console.log('New file - use sidebar') },
    { id: 'save', name: 'Save', shortcut: 'Ctrl+S', action: saveCurrentTab },
    { id: 'quick-switcher', name: 'Quick Switcher', shortcut: 'Ctrl+O', action: () => setShowQuickSwitcher(true) },
    { id: 'search', name: 'Search in Files', shortcut: 'Ctrl+Shift+F', action: () => setShowSearch(true) },
    { id: 'toggle-terminal', name: 'Toggle Terminal', shortcut: 'Ctrl+`', action: () => setShowTerminal(!showTerminal()) },
    { id: 'toggle-outline', name: 'Toggle Outline', shortcut: 'Ctrl+Shift+O', action: () => setShowOutline(!showOutline()) },
    { id: 'toggle-backlinks', name: 'Toggle Backlinks', shortcut: 'Ctrl+Shift+B', action: () => setShowBacklinks(!showBacklinks()) },
    { id: 'close-tab', name: 'Close Tab', action: () => activeTabIndex() >= 0 && closeTab(activeTabIndex()) },
  ];

  // Resize handlers for panels
  const handleSidebarResizeStart = (e: MouseEvent) => {
    e.preventDefault();
    setIsResizing('sidebar');
    setResizeStartX(e.clientX);
    setResizeStartWidth(sidebarWidth());
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const handleTerminalResizeStart = (e: MouseEvent) => {
    e.preventDefault();
    setIsResizing('terminal');
    setResizeStartX(e.clientX);
    setResizeStartWidth(terminalWidth());
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const handleOutlineResizeStart = (e: MouseEvent) => {
    e.preventDefault();
    setIsResizing('outline');
    setResizeStartX(e.clientX);
    setResizeStartWidth(outlineWidth());
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const handleBacklinksResizeStart = (e: MouseEvent) => {
    e.preventDefault();
    setIsResizing('backlinks');
    setResizeStartX(e.clientX);
    setResizeStartWidth(backlinksWidth());
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };

  const handleResizeMove = (e: MouseEvent) => {
    const target = isResizing();
    if (!target) return;

    if (target === 'sidebar') {
      // Sidebar: dragging right = wider sidebar
      const delta = e.clientX - resizeStartX();
      const newWidth = resizeStartWidth() + delta;
      setSidebarWidth(Math.max(200, Math.min(500, newWidth)));
    } else if (target === 'terminal') {
      // Terminal: dragging left = wider terminal
      const delta = resizeStartX() - e.clientX;
      const newWidth = resizeStartWidth() + delta;
      setTerminalWidth(Math.max(300, Math.min(800, newWidth)));
    } else if (target === 'outline') {
      // Outline: dragging left = wider panel (same as terminal)
      const delta = resizeStartX() - e.clientX;
      const newWidth = resizeStartWidth() + delta;
      setOutlineWidth(Math.max(180, Math.min(400, newWidth)));
    } else if (target === 'backlinks') {
      // Backlinks: dragging left = wider panel (same as terminal)
      const delta = resizeStartX() - e.clientX;
      const newWidth = resizeStartWidth() + delta;
      setBacklinksWidth(Math.max(180, Math.min(400, newWidth)));
    }
  };

  const handleResizeEnd = () => {
    if (isResizing()) {
      setIsResizing(null);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  };

  // Add global mouse listeners for resize
  onMount(() => {
    document.addEventListener('mousemove', handleResizeMove);
    document.addEventListener('mouseup', handleResizeEnd);
    return () => {
      document.removeEventListener('mousemove', handleResizeMove);
      document.removeEventListener('mouseup', handleResizeEnd);
    };
  });

  return (
    <div class="app">
      {/* Left Icon Bar */}
      <div class="icon-bar">
        <button
          class={`icon-btn ${!sidebarCollapsed() && sidebarView() === 'files' ? 'active' : ''}`}
          onClick={() => switchSidebarView('files')}
          title="Files"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"></path>
          </svg>
        </button>
        <button
          class={`icon-btn ${!sidebarCollapsed() && sidebarView() === 'search' ? 'active' : ''}`}
          onClick={() => switchSidebarView('search')}
          title="Search"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="11" cy="11" r="8"></circle>
            <path d="m21 21-4.35-4.35"></path>
          </svg>
        </button>
        <button
          class={`icon-btn ${!sidebarCollapsed() && sidebarView() === 'bookmarks' ? 'active' : ''}`}
          onClick={() => switchSidebarView('bookmarks')}
          title="Bookmarks"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"></path>
          </svg>
        </button>
        <button
          class={`icon-btn ${showGraphView() ? 'active' : ''}`}
          onClick={() => setShowGraphView(true)}
          title="Graph View"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="6" cy="6" r="3"></circle>
            <circle cx="18" cy="6" r="3"></circle>
            <circle cx="6" cy="18" r="3"></circle>
            <circle cx="18" cy="18" r="3"></circle>
            <line x1="8.5" y1="7.5" x2="15.5" y2="16.5"></line>
            <line x1="15.5" y1="7.5" x2="8.5" y2="16.5"></line>
          </svg>
        </button>
        <button
          class={`icon-btn ${showOutline() ? 'active' : ''}`}
          onClick={() => setShowOutline(!showOutline())}
          title="Outline (Ctrl+Shift+O)"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="8" y1="6" x2="21" y2="6"></line>
            <line x1="8" y1="12" x2="21" y2="12"></line>
            <line x1="8" y1="18" x2="21" y2="18"></line>
            <line x1="3" y1="6" x2="3.01" y2="6"></line>
            <line x1="3" y1="12" x2="3.01" y2="12"></line>
            <line x1="3" y1="18" x2="3.01" y2="18"></line>
          </svg>
        </button>
        <button
          class={`icon-btn ${showBacklinks() ? 'active' : ''}`}
          onClick={() => setShowBacklinks(!showBacklinks())}
          title="Backlinks (Ctrl+Shift+B)"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M9 17H7A5 5 0 0 1 7 7h2"></path>
            <path d="M15 7h2a5 5 0 1 1 0 10h-2"></path>
            <line x1="8" y1="12" x2="16" y2="12"></line>
          </svg>
        </button>
        <button
          class={`icon-btn ${showNotifications() ? 'active' : ''}`}
          onClick={() => setShowNotifications(!showNotifications())}
          title="Shared with me"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
            <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
          </svg>
          <Show when={unreadShareCount() > 0}>
            <span class="notification-badge">{unreadShareCount()}</span>
          </Show>
        </button>
        <div class="icon-bar-spacer"></div>
        <button
          class={`icon-btn opencode-icon ${showTerminal() ? 'active' : ''}`}
          onClick={() => setShowTerminal(!showTerminal())}
          title="Toggle OpenCode (Ctrl+`)"
        >
          <svg width="24" height="24" viewBox="0 0 512 512" fill="currentColor">
            <path fill-rule="evenodd" clip-rule="evenodd" d="M384 416H128V96H384V416ZM320 160H192V352H320V160Z"/>
          </svg>
        </button>
        <button
          class={`icon-btn ${showSettings() ? 'active' : ''}`}
          onClick={() => setShowSettings(true)}
          title="Settings"
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <circle cx="12" cy="12" r="3"></circle>
            <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
          </svg>
        </button>
        <button
          class="icon-btn"
          onClick={() => setSidebarCollapsed(!sidebarCollapsed())}
          title={sidebarCollapsed() ? 'Expand Sidebar' : 'Collapse Sidebar'}
        >
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2"></rect>
            <line x1="9" y1="3" x2="9" y2="21"></line>
          </svg>
        </button>
      </div>

      {/* Sidebar */}
      <Show when={!sidebarCollapsed()}>
        <div style={{ width: `${sidebarWidth()}px`, 'flex-shrink': 0 }}>
          <Sidebar
            onFileSelect={openFile}
            currentFile={currentTab()?.path || null}
            vaultPath={vaultPath()}
            onVaultOpen={setVaultPath}
            onFileCreated={handleFileCreated}
            onFileDeleted={handleFileDeleted}
            view={sidebarView()}
            bookmarks={bookmarks()}
            onToggleBookmark={toggleBookmark}
            savedSearches={savedSearches()}
            onToggleSavedSearch={toggleSavedSearch}
            exposeCreateNote={(fn) => { createNoteFromSidebar = fn; }}
            exposeRefresh={(fn) => { refreshSidebar = fn; }}
            exposeSearchQuery={(fn) => { setSearchQuery = fn; }}
            onShareFile={handleShareFile}
            onFileInfo={handleFileInfo}
            onPostToNostr={handlePostToNostr}
          />
        </div>
        <div
          class="resize-handle"
          onMouseDown={handleSidebarResizeStart}
        />
      </Show>
      <main class="main-content">
        {/* Toolbar */}
        <div class="toolbar">
          <div class="toolbar-left">
            {/* Tab Bar */}
            <Show when={tabs().length > 0 || showGraphView()}>
              <div class="tab-bar">
                <For each={tabs()}>
                  {(tab, index) => (
                    <div
                      class={`tab ${index() === activeTabIndex() && !showGraphView() ? 'active' : ''}`}
                      onClick={() => { setShowGraphView(false); setActiveTabIndex(index()); }}
                    >
                      <span class="tab-name">{tab.isDirty ? '● ' : ''}{tab.name}</span>
                      <button
                        class="tab-close"
                        onClick={(e) => {
                          e.stopPropagation();
                          closeTab(index());
                        }}
                      >
                        ×
                      </button>
                    </div>
                  )}
                </For>
                <Show when={showGraphView()}>
                  <div class={`tab graph-tab active`}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <circle cx="6" cy="6" r="3"></circle>
                      <circle cx="18" cy="6" r="3"></circle>
                      <circle cx="6" cy="18" r="3"></circle>
                      <circle cx="18" cy="18" r="3"></circle>
                      <line x1="8.5" y1="7.5" x2="15.5" y2="16.5"></line>
                      <line x1="15.5" y1="7.5" x2="8.5" y2="16.5"></line>
                    </svg>
                    <span class="tab-name">Graph</span>
                    <button
                      class="tab-close"
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowGraphView(false);
                      }}
                    >
                      ×
                    </button>
                  </div>
                </Show>
              </div>
            </Show>
          </div>
          <div class="toolbar-right">
            {/* Reserved for future toolbar actions */}
          </div>
        </div>

        {/* Editor + Terminal horizontal layout */}
        <div class="content-area">
          {/* Editor or Graph View */}
          <div class="editor-area">
            <Show when={showGraphView()} fallback={
              <Editor
                content={currentTab()?.content || ''}
                onContentChange={updateTabContent}
                filePath={currentTab()?.path || null}
                vaultPath={vaultPath()}
                onCreateFile={createNewNote}
                onHashtagClick={handleHashtagClick}
                scrollToLine={scrollToLine()}
                onScrollComplete={() => setScrollToLine(null)}
                onWikilinkClick={handleWikilinkClick}
                noteIndex={noteIndex()}
                assetIndex={assetIndex()}
                fileContents={fileContents()}
                onHeadingsChange={setCurrentHeadings}
                onActiveHeadingChange={setActiveHeadingId}
                scrollToHeadingId={scrollToHeadingId()}
                scrollToHeadingText={scrollToHeadingText()}
                scrollToBlockId={scrollToBlockId()}
                onFilesUploaded={async () => {
                  // Rebuild asset index after files are uploaded
                  if (vaultPath()) {
                    try {
                      const assets = await invoke<AssetEntry[]>('list_assets', { path: vaultPath() });
                      setAssetIndex(buildAssetIndex(assets, vaultPath()!));
                    } catch (err) {
                      console.error('Failed to rebuild asset index after upload:', err);
                    }
                  }
                }}
              />
            }>
              <GraphView
                vaultPath={vaultPath()}
                noteIndex={noteIndex()}
                currentFile={currentTab()?.path || null}
                onNodeClick={(path) => { setShowGraphView(false); openFile(path); }}
              />
            </Show>
          </div>

          {/* Outline Panel - Right Side */}
          <Show when={showOutline() && currentTab()}>
            <div
              class="resize-handle"
              onMouseDown={handleOutlineResizeStart}
            />
            <div class="outline-panel-container" style={{ width: `${outlineWidth()}px` }}>
              <OutlinePanel
                headings={currentHeadings()}
                activeHeadingId={activeHeadingId()}
                onHeadingClick={(id) => {
                  setScrollToHeadingId(id);
                  setTimeout(() => setScrollToHeadingId(null), 100);
                }}
                onClose={() => setShowOutline(false)}
              />
            </div>
          </Show>

          {/* Backlinks Panel - Right Side */}
          <Show when={showBacklinks() && currentTab()}>
            <div
              class="resize-handle"
              onMouseDown={handleBacklinksResizeStart}
            />
            <div class="backlinks-panel-container" style={{ width: `${backlinksWidth()}px` }}>
              <BacklinksPanel
                currentFilePath={currentTab()?.path || null}
                currentFileName={currentTab()?.name || null}
                graph={noteGraph()}
                fileContents={fileContents()}
                onBacklinkClick={(path, line) => openFile(path, line)}
                onClose={() => setShowBacklinks(false)}
              />
            </div>
          </Show>

          {/* OpenCode Panel - Right Side */}
          <Show when={showTerminal()}>
            <div
              class="resize-handle"
              onMouseDown={handleTerminalResizeStart}
            />
            <div style={{ width: `${terminalWidth()}px` }}>
              <OpenCodePanel
                vaultPath={vaultPath()}
                currentFile={currentTab() ? { path: currentTab()!.path, content: currentTab()!.content } : null}
                onClose={() => setShowTerminal(false)}
                onOpenSettings={() => {
                  setSettingsSection('opencode');
                  setShowSettings(true);
                }}
              />
            </div>
          </Show>
        </div>

        {/* Status Bar */}
        <div class="status-bar">
          <div class="status-bar-left">
            {/* Future: git branch, etc */}
          </div>
          <div class="status-bar-right">
            <Show when={currentTab()}>
              <span class="status-item">{wordCount()} words</span>
              <span class="status-item">{charCount()} characters</span>
            </Show>
            <span
              class={`status-item sync-status ${syncStatus()} ${syncStatus() !== 'off' && syncStatus() !== 'syncing' ? 'clickable' : ''}`}
              title={
                syncStatus() === 'off' ? 'Sync disabled' :
                syncStatus() === 'idle' ? 'Click to sync' :
                syncStatus() === 'syncing' ? 'Syncing...' :
                'Sync error - Click to retry'
              }
              onClick={handleStatusBarSync}
            >
              <Show when={syncStatus() === 'off'}>
                {/* Cloud with slash - sync disabled */}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path>
                  <line x1="4" y1="4" x2="20" y2="20"></line>
                </svg>
              </Show>
              <Show when={syncStatus() === 'idle' || syncStatus() === 'syncing'}>
                {/* Cloud with sync arrows */}
                <svg class={syncStatus() === 'syncing' ? 'cloud-syncing' : ''} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M18 10h-1.26A8 8 0 1 0 9 20h9a5 5 0 0 0 0-10z"></path>
                  <Show when={syncStatus() === 'syncing'}>
                    <g class="sync-arrows">
                      <path d="M12 14v3m0 0l-1.5-1.5M12 17l1.5-1.5" stroke-width="1.5"></path>
                      <path d="M12 12V9m0 0l1.5 1.5M12 9l-1.5 1.5" stroke-width="1.5"></path>
                    </g>
                  </Show>
                </svg>
              </Show>
              <Show when={syncStatus() === 'error'}>
                {/* Warning triangle - error */}
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
                  <line x1="12" y1="9" x2="12" y2="13"></line>
                  <line x1="12" y1="17" x2="12.01" y2="17"></line>
                </svg>
              </Show>
            </span>
          </div>
        </div>
      </main>

      {/* Modals */}
      <Show when={showQuickSwitcher()}>
        <QuickSwitcher
          vaultPath={vaultPath()}
          onSelect={(path) => {
            openFile(path);
            setShowQuickSwitcher(false);
          }}
          onClose={() => setShowQuickSwitcher(false)}
        />
      </Show>

      <Show when={showCommandPalette()}>
        <CommandPalette
          commands={commands}
          onClose={() => setShowCommandPalette(false)}
        />
      </Show>

      <Show when={showSearch()}>
        <SearchPanel
          vaultPath={vaultPath()}
          onSelect={(path) => {
            openFile(path);
            setShowSearch(false);
          }}
          onClose={() => setShowSearch(false)}
        />
      </Show>

      <Show when={showSettings()}>
        <Settings
          onClose={() => {
            setShowSettings(false);
            setSettingsSection(undefined);
          }}
          vaultPath={vaultPath()}
          onSyncComplete={() => refreshSidebar?.()}
          onSyncEnabledChange={(enabled) => setSyncStatus(enabled ? 'idle' : 'off')}
          initialSection={settingsSection() as 'general' | 'editor' | 'files' | 'appearance' | 'hotkeys' | 'opencode' | 'productivity' | 'sync' | 'nostr' | 'about' | undefined}
        />
      </Show>

      {/* Close Tab Confirmation Modal */}
      <Show when={closeTabConfirm()}>
        <div class="modal-overlay" onClick={() => setCloseTabConfirm(null)}>
          <div class="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <h3>Unsaved Changes</h3>
              <button class="modal-close" onClick={() => setCloseTabConfirm(null)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>
            <div class="modal-body">
              <p>Do you want to save changes to "{closeTabConfirm()!.name}" before closing?</p>
            </div>
            <div class="modal-footer">
              <button class="setting-button secondary" onClick={() => setCloseTabConfirm(null)}>Cancel</button>
              <button class="setting-button secondary" onClick={handleCloseTabDiscard}>Don't Save</button>
              <button class="setting-button" onClick={handleCloseTabSave}>Save</button>
            </div>
          </div>
        </div>
      </Show>

      {/* Share Dialog */}
      <Show when={showShareDialog() && shareTarget()}>
        <ShareDialog
          filePath={shareTarget()!.path}
          content={shareTarget()!.content}
          title={shareTarget()!.title}
          onClose={() => {
            setShowShareDialog(false);
            setShareTarget(null);
          }}
          onSuccess={() => {
            fetchSharedDocuments();
          }}
        />
      </Show>

      {/* Notifications Panel (Shared with me) */}
      <Show when={showNotifications()}>
        <NotificationsPanel
          sharedDocuments={sharedWithMe()}
          isLoading={isLoadingShares()}
          onPreview={handlePreviewSharedDoc}
          onRefresh={fetchSharedDocuments}
          onClose={() => setShowNotifications(false)}
        />
      </Show>

      {/* Shared Document Preview */}
      <Show when={previewingDoc()}>
        <SharedDocPreview
          document={previewingDoc()!}
          onImport={handleImportSharedDoc}
          onDismiss={handleDismissSharedDoc}
          onBlockUser={handleBlockUser}
          onClose={() => setPreviewingDoc(null)}
          isImporting={isImporting()}
        />
      </Show>

      {/* Sent Shares Panel */}
      <Show when={showSentShares()}>
        <SentSharesPanel
          sentShares={sentShares()}
          isLoading={isLoadingShares()}
          onRevoke={handleRevokeShare}
          onRefresh={fetchSharedDocuments}
          onClose={() => setShowSentShares(false)}
        />
      </Show>

      {/* File Info Dialog */}
      <Show when={showFileInfo()}>
        <FileInfoDialog
          filePath={showFileInfo()!}
          vaultPath={vaultPath() || ''}
          onClose={() => setShowFileInfo(null)}
          syncEnabled={syncStatus() !== 'off'}
          getRemoteInfo={async () => {
            const engine = getSyncEngine();
            if (!vaultPath()) return null;
            
            try {
              // Ensure signer is set
              let signer = engine.getSigner();
              if (!signer) {
                const storedSigner = await getSignerFromStoredLogin();
                if (storedSigner) {
                  await engine.setSigner(storedSigner);
                  signer = storedSigner;
                } else {
                  return null;
                }
              }
              
              // Get the relative path
              const filePath = showFileInfo()!;
              const relativePath = filePath.replace(vaultPath()! + '/', '');
              
              // Always fetch fresh vault data to ensure accuracy
              const vaults = await engine.fetchVaults();
              const vault = vaults[0];
              if (vault) {
                setCurrentVault(vault);
              }
              
              if (!vault) return null;
              
              // Look for the file in the vault's file index
              const fileEntry = vault.data.files?.find(f => f.path === relativePath);
              if (!fileEntry) return null;
              
              // We have the file entry in the index, use that info
              // Generate naddr from the d-tag
              const naddr = engine.getFileNaddr(fileEntry.d) || '';
              
              return {
                eventId: fileEntry.eventId,
                d: fileEntry.d,
                checksum: fileEntry.checksum,
                version: fileEntry.version,
                modified: fileEntry.modified,
                naddr,
                relays: engine.getConfig().relays,
              };
            } catch (err) {
              console.error('Failed to get remote file info:', err);
              return null;
            }
          }}
          onSyncFile={async () => {
            const engine = getSyncEngine();
            let signer = engine.getSigner();
            if (!signer) {
              // Try to get signer from storage
              signer = await getSignerFromStoredLogin();
              if (signer) {
                await engine.setSigner(signer);
              } else {
                throw new Error('Not logged in. Please log in to sync files.');
              }
            }
            if (!vaultPath()) {
              throw new Error('No vault selected.');
            }
            
            // Get or create vault, use cached if available
            let vault = currentVault();
            if (!vault) {
              const vaults = await engine.fetchVaults();
              vault = vaults[0];
              if (!vault) {
                vault = await engine.createVault('My Notes', 'Default vault');
              }
            }
            
            // Read the file content
            const filePath = showFileInfo()!;
            const content = await invoke<string>('read_file', { path: filePath });
            const relativePath = filePath.replace(vaultPath()! + '/', '');
            
            // Publish the file
            const result = await engine.publishFile(vault, relativePath, content);
            
            // Update cached vault with the new file
            setCurrentVault(result.vault);
            
            // Generate naddr for the synced file
            const naddr = engine.getFileNaddr(result.file.d) || '';
            
            // Return remote info
            return {
              eventId: result.file.eventId,
              d: result.file.d,
              checksum: result.file.data.checksum,
              version: result.file.data.version,
              modified: result.file.data.modified,
              naddr,
              relays: engine.getConfig().relays,
            };
          }}
          getShareInfo={async () => {
            const filePath = showFileInfo()!;
            const relativePath = filePath.replace(vaultPath()! + '/', '');
            
            // Filter sent shares for this file
            const fileShares = sentShares().filter(s => s.path === relativePath);
            if (fileShares.length === 0) return { shares: [] };
            
            // Fetch profiles for recipients
            const engine = getSyncEngine();
            const relays = engine.getConfig().relays;
            const { fetchUserProfile } = await import('./lib/nostr/login');
            
            const recipientProfiles = new Map<string, { name?: string; picture?: string }>();
            for (const share of fileShares) {
              try {
                const profile = await fetchUserProfile(share.recipientPubkey, relays);
                if (profile) {
                  recipientProfiles.set(share.recipientPubkey, {
                    name: profile.displayName || profile.name,
                    picture: profile.picture,
                  });
                }
              } catch (err) {
                console.error('Failed to fetch profile:', err);
              }
            }
            
            return { shares: fileShares, recipientProfiles };
          }}
          onRevokeShare={async (share) => {
            await handleRevokeShare(share);
          }}
        />
      </Show>

      {/* Post to Nostr Dialog */}
      <Show when={postToNostrTarget()}>
        <PostToNostrDialog
          filePath={postToNostrTarget()!.path}
          content={postToNostrTarget()!.content}
          title={postToNostrTarget()!.title}
          onClose={() => setPostToNostrTarget(null)}
          onPublish={async (options) => {
            // TODO: Implement NIP-23 article publishing
            const engine = getSyncEngine();
            const signer = engine.getSigner();
            if (!signer) {
              throw new Error('Not logged in');
            }
            
            // Publish as NIP-23 long-form article
            const result = await engine.publishArticle(
              postToNostrTarget()!.content,
              options.title,
              options.summary,
              options.image,
              options.tags,
              options.isDraft
            );
            
            return result;
          }}
        />
      </Show>
    </div>
  );
};

export default App;
