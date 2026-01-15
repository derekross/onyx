import { Component, createSignal, createEffect, For, Show, onMount } from 'solid-js';
import Sidebar from './components/Sidebar';
import Editor from './components/Editor';
import QuickSwitcher from './components/QuickSwitcher';
import CommandPalette from './components/CommandPalette';
import SearchPanel from './components/SearchPanel';
import OpenCodeTerminal from './components/OpenCodeTerminal';
import Settings from './components/Settings';
import { invoke } from '@tauri-apps/api/core';

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
  const [terminalWidth, setTerminalWidth] = createSignal(500);
  const [sidebarWidth, setSidebarWidth] = createSignal(260);
  const [isResizing, setIsResizing] = createSignal<'sidebar' | 'terminal' | null>(null);
  const [resizeStartX, setResizeStartX] = createSignal(0);
  const [resizeStartWidth, setResizeStartWidth] = createSignal(0);
  const [sidebarCollapsed, setSidebarCollapsed] = createSignal(false);
  const [sidebarView, setSidebarView] = createSignal<SidebarView>('files');
  const [bookmarks, setBookmarks] = createSignal<string[]>([]);

  // Auto-save timer
  let autoSaveTimeout: number | null = null;

  // Load settings on startup
  onMount(async () => {
    try {
      const settings = await invoke<AppSettings>('load_settings');
      if (settings.vault_path) {
        setVaultPath(settings.vault_path);
      }
      if (settings.show_terminal) {
        setShowTerminal(true);
      }
    } catch (err) {
      console.error('Failed to load settings:', err);
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

  const currentTab = () => {
    const idx = activeTabIndex();
    return idx >= 0 ? tabs()[idx] : null;
  };

  const openFile = async (path: string) => {
    // Check if already open
    const existingIndex = tabs().findIndex(t => t.path === path);
    if (existingIndex >= 0) {
      setActiveTabIndex(existingIndex);
      return;
    }

    // Load file content
    try {
      const content = await invoke<string>('read_file', { path });
      const name = path.split('/').pop() || 'Untitled';

      setTabs([...tabs(), { path, name, content, isDirty: false }]);
      setActiveTabIndex(tabs().length); // Will be the new last index after state updates
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
      if (!confirm(`Save changes to ${tab.name}?`)) {
        // Don't save, just close
      } else {
        saveTab(index);
      }
    }

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

  const handleFileDeleted = (path: string) => {
    const idx = tabs().findIndex(t => t.path === path);
    if (idx >= 0) {
      closeTab(idx);
    }
  };

  const toggleBookmark = (path: string) => {
    const current = bookmarks();
    if (current.includes(path)) {
      setBookmarks(current.filter(p => p !== path));
    } else {
      setBookmarks([...current, path]);
    }
  };

  const switchSidebarView = (view: SidebarView) => {
    if (sidebarCollapsed()) {
      setSidebarCollapsed(false);
    }
    setSidebarView(view);
  };

  const commands = [
    { id: 'new-file', name: 'New File', action: () => console.log('New file - use sidebar') },
    { id: 'save', name: 'Save', shortcut: 'Ctrl+S', action: saveCurrentTab },
    { id: 'quick-switcher', name: 'Quick Switcher', shortcut: 'Ctrl+O', action: () => setShowQuickSwitcher(true) },
    { id: 'search', name: 'Search in Files', shortcut: 'Ctrl+Shift+F', action: () => setShowSearch(true) },
    { id: 'toggle-terminal', name: 'Toggle Terminal', shortcut: 'Ctrl+`', action: () => setShowTerminal(!showTerminal()) },
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
        <div class="icon-bar-spacer"></div>
        <button
          class={`icon-btn opencode-icon ${showTerminal() ? 'active' : ''}`}
          onClick={() => setShowTerminal(!showTerminal())}
          title="Toggle OpenCode (Ctrl+`)"
        >
          <svg width="20" height="20" viewBox="0 0 512 512" fill="currentColor">
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
            <Show when={tabs().length > 0}>
              <div class="tab-bar">
                <For each={tabs()}>
                  {(tab, index) => (
                    <div
                      class={`tab ${index() === activeTabIndex() ? 'active' : ''}`}
                      onClick={() => setActiveTabIndex(index())}
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
              </div>
            </Show>
          </div>
          <div class="toolbar-right">
            {/* Reserved for future toolbar actions */}
          </div>
        </div>

        {/* Editor + Terminal horizontal layout */}
        <div class="content-area">
          {/* Editor */}
          <div class="editor-area">
            <Editor
              content={currentTab()?.content || ''}
              onContentChange={updateTabContent}
              filePath={currentTab()?.path || null}
            />
          </div>

          {/* OpenCode Terminal Panel - Right Side */}
          <Show when={showTerminal()}>
            <div
              class="resize-handle"
              onMouseDown={handleTerminalResizeStart}
            />
            <div style={{ width: `${terminalWidth()}px` }}>
              <OpenCodeTerminal vaultPath={vaultPath()} onClose={() => setShowTerminal(false)} />
            </div>
          </Show>
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
        <Settings onClose={() => setShowSettings(false)} />
      </Show>
    </div>
  );
};

export default App;
