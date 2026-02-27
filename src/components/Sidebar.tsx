import { Component, createSignal, createEffect, For, Show, onMount, onCleanup } from 'solid-js';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { isMobile } from '../lib/platform';

/**
 * Get the parent directory of a path, handling both / and \ separators (Windows compatibility).
 */
function getParentPath(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const lastSlash = normalized.lastIndexOf('/');
  if (lastSlash <= 0) return normalized.substring(0, lastSlash + 1) || '/';
  // Return using original characters up to the last separator position
  return filePath.substring(0, lastSlash);
}

/**
 * Get the file/folder name from a path, handling both / and \ separators.
 */
function getFileName(filePath: string): string {
  return filePath.replace(/\\/g, '/').split('/').pop() || '';
}

interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileEntry[];
}

type SidebarView = 'files' | 'search' | 'bookmarks';

interface SidebarProps {
  onFileSelect: (path: string, line?: number) => void;
  currentFile: string | null;
  vaultPath: string | null;
  onVaultOpen: (path: string) => void;
  onFileCreated: (path: string) => void;
  onFileDeleted: (path: string) => void;
  onFileMoved?: (oldPath: string, newPath: string) => void;
  view: SidebarView;
  bookmarks: string[];
  onToggleBookmark: (path: string) => void;
  savedSearches: string[];
  onToggleSavedSearch: (query: string) => void;
  exposeCreateNote?: (fn: () => void) => void;
  exposeRefresh?: (fn: () => void) => void;
  exposeSearchQuery?: (fn: (query: string) => void) => void;
  onShareFile?: (path: string, content: string) => void;
  onFileInfo?: (path: string) => void;
  onPostToNostr?: (path: string, content: string, title: string) => void;
  // External expanded folders state (for session persistence)
  expandedFolders?: Set<string>;
  onExpandedFoldersChange?: (folders: Set<string>) => void;
}

interface SearchResult {
  path: string;
  name: string;
  matches: { line: number; content: string }[];
}

interface FileTypeInfo {
  icon: string;
  badge: string | null;
  displayName: string;
}

const IMAGE_EXTENSIONS = new Set(['avif', 'bmp', 'gif', 'jpeg', 'jpg', 'png', 'svg', 'webp']);
const DOCUMENT_EXTENSIONS: Record<string, string> = {
  pdf: 'PDF',
  docx: 'DOCX',
  xlsx: 'XLSX',
  pptx: 'PPTX',
};

function getFileTypeInfo(name: string, isDirectory: boolean): FileTypeInfo {
  if (isDirectory) {
    return { icon: '', badge: null, displayName: name };
  }

  const dotIndex = name.lastIndexOf('.');
  if (dotIndex === -1) {
    return { icon: '', badge: null, displayName: name };
  }

  const ext = name.substring(dotIndex + 1).toLowerCase();
  const baseName = name.substring(0, dotIndex);

  if (ext === 'md') {
    return { icon: '', badge: null, displayName: baseName };
  }

  if (IMAGE_EXTENSIONS.has(ext)) {
    return { icon: '', badge: ext.toUpperCase(), displayName: baseName };
  }

  if (ext in DOCUMENT_EXTENSIONS) {
    return { icon: '', badge: DOCUMENT_EXTENSIONS[ext], displayName: baseName };
  }

  return { icon: '', badge: ext.toUpperCase(), displayName: baseName };
}

const Sidebar: Component<SidebarProps> = (props) => {
  const [files, setFiles] = createSignal<FileEntry[]>([]);
  // Use external expanded folders state if provided, otherwise use internal state
  const [internalExpandedFolders, setInternalExpandedFolders] = createSignal<Set<string>>(new Set());
  const expandedFolders = () => props.expandedFolders ?? internalExpandedFolders();
  const setExpandedFolders = (folders: Set<string>) => {
    if (props.onExpandedFoldersChange) {
      props.onExpandedFoldersChange(folders);
    } else {
      setInternalExpandedFolders(folders);
    }
  };
  const [contextMenu, setContextMenu] = createSignal<{ x: number; y: number; path: string; isDir: boolean; openUpward: boolean } | null>(null);
  const [isCreating, setIsCreating] = createSignal<{ parentPath: string; type: 'file' | 'folder' } | null>(null);
  const [newItemName, setNewItemName] = createSignal('');
  const [isRenaming, setIsRenaming] = createSignal<string | null>(null);
  const [renameValue, setRenameValue] = createSignal('');
  const [draggedItem, setDraggedItem] = createSignal<string | null>(null);
  const [dropTarget, setDropTarget] = createSignal<string | null>(null);
  const [searchQuery, setSearchQuery] = createSignal('');
  const [searchResults, setSearchResults] = createSignal<SearchResult[]>([]);
  const [isSearching, setIsSearching] = createSignal(false);
  const [sortOrder, setSortOrder] = createSignal<'name' | 'modified'>('name');
  const [, setAllCollapsed] = createSignal(false);
  const [showVaultMenu, setShowVaultMenu] = createSignal(false);
  const [deleteConfirm, setDeleteConfirm] = createSignal<{ path: string; name: string } | null>(null);
  const [moveConfirm, setMoveConfirm] = createSignal<{ sourcePath: string; destPath: string; name: string } | null>(null);

  const openVault = async () => {
    try {
      // Check platform first
      const platformInfo = await invoke<{ platform: string; default_vault_path: string | null }>('get_platform_info');

      if (platformInfo.platform === 'android' || platformInfo.platform === 'ios') {
        // On mobile, use default vault path (folder picker not supported)
        if (platformInfo.default_vault_path) {
          // Create the directory if it doesn't exist
          await invoke('create_folder', { path: platformInfo.default_vault_path, vaultPath: platformInfo.default_vault_path });
          props.onVaultOpen(platformInfo.default_vault_path);
          await loadFiles(platformInfo.default_vault_path);
        } else {
          console.error('Could not determine default vault path');
        }
      } else {
        // On desktop, use folder picker
        const selected = await open({
          directory: true,
          multiple: false,
          title: 'Select Vault Folder',
        });

        if (selected && typeof selected === 'string') {
          props.onVaultOpen(selected);
          await loadFiles(selected);
        }
      }
    } catch (err) {
      console.error('Failed to open vault:', err);
    }
  };

  const loadFiles = async (path: string) => {
    try {
      const entries = await invoke<FileEntry[]>('list_files', { path });
      setFiles(entries);
    } catch (err) {
      console.error('Failed to load files:', err);
    }
  };

  // Reload files when vault changes
  const refreshFiles = async () => {
    if (props.vaultPath) {
      await loadFiles(props.vaultPath);
    }
  };

  // Auto-load files when vault path changes (including on mount)
  createEffect(() => {
    if (props.vaultPath) {
      loadFiles(props.vaultPath);
    }
  });

  const toggleFolder = (path: string) => {
    const expanded = new Set(expandedFolders());
    if (expanded.has(path)) {
      expanded.delete(path);
    } else {
      expanded.add(path);
    }
    setExpandedFolders(expanded);
    setAllCollapsed(false);
  };

  const collapseAll = () => {
    setExpandedFolders(new Set());
    setAllCollapsed(true);
  };

  const toggleSortOrder = () => {
    setSortOrder(sortOrder() === 'name' ? 'modified' : 'name');
  };

  const handleContextMenu = (e: MouseEvent, path: string, isDir: boolean) => {
    e.preventDefault();
    const menuHeight = 400;
    const menuWidth = 200;
    const margin = 8;

    let x = e.clientX;
    let y = e.clientY;

    // On mobile, center the menu horizontally and position from the touch point
    if (isMobile()) {
      x = Math.max(margin, Math.min(x, window.innerWidth - menuWidth - margin));
      y = Math.max(margin, Math.min(y, window.innerHeight - margin));
    }

    // Check if menu would overflow bottom of screen
    const openUpward = y + menuHeight > window.innerHeight - margin;

    // Clamp horizontal position so menu doesn't go off-screen
    x = Math.max(margin, Math.min(x, window.innerWidth - menuWidth - margin));

    setContextMenu({ x, y, path, isDir, openUpward });
  };

  const closeContextMenu = () => {
    setContextMenu(null);
  };

  const handleCreateFile = async (parentPath: string) => {
    setIsCreating({ parentPath, type: 'file' });
    setNewItemName('');
    closeContextMenu();
  };

  const handleCreateFolder = async (parentPath: string) => {
    setIsCreating({ parentPath, type: 'folder' });
    setNewItemName('');
    closeContextMenu();
  };

  // Create note at vault root - exposed for external use
  const createNoteAtRoot = () => {
    if (props.vaultPath) {
      handleCreateFile(props.vaultPath);
    }
  };

  // Expose the create note function to parent
  if (props.exposeCreateNote) {
    props.exposeCreateNote(createNoteAtRoot);
  }

  // Expose the refresh function to parent
  if (props.exposeRefresh) {
    props.exposeRefresh(refreshFiles);
  }

  // Expose the search query function to parent (for hashtag clicks)
  const setSearchQueryAndSearch = (query: string) => {
    setSearchQuery(query);
    performSearch(query);
  };

  if (props.exposeSearchQuery) {
    props.exposeSearchQuery(setSearchQueryAndSearch);
  }

  const confirmCreate = async () => {
    const creating = isCreating();
    if (!creating || !newItemName()) return;

    const createSep = creating.parentPath.includes('\\') ? '\\' : '/';
    const fullPath = `${creating.parentPath}${createSep}${newItemName()}${creating.type === 'file' && !newItemName().endsWith('.md') ? '.md' : ''}`;

    try {
      if (creating.type === 'file') {
        await invoke('create_file', { path: fullPath, vaultPath: props.vaultPath });
        props.onFileCreated(fullPath);
      } else {
        await invoke('create_folder', { path: fullPath, vaultPath: props.vaultPath });
      }
      await refreshFiles();
    } catch (err) {
      console.error('Failed to create:', err);
    }

    setIsCreating(null);
    setNewItemName('');
  };

  const handleRename = (path: string, currentName: string) => {
    setIsRenaming(path);
    // Strip .md extension for display in rename input
    setRenameValue(currentName.replace(/\.md$/i, ''));
    closeContextMenu();
  };

  const confirmRename = async (oldPath: string) => {
    if (!renameValue()) return;

    const parentPath = getParentPath(oldPath);
    let newName = renameValue();

    // If original file was .md and user didn't include extension, add it back
    if (oldPath.endsWith('.md') && !newName.endsWith('.md')) {
      newName = `${newName}.md`;
    }

    // Use the same path separator as the original path for Windows compatibility
    const sep = oldPath.includes('\\') ? '\\' : '/';
    const newPath = `${parentPath}${sep}${newName}`;

    try {
      await invoke('rename_file', { oldPath, newPath, vaultPath: props.vaultPath });
      props.onFileMoved?.(oldPath, newPath);
      await refreshFiles();
      if (props.currentFile === oldPath) {
        props.onFileSelect(newPath);
      }
    } catch (err) {
      console.error('Failed to rename:', err);
    }

    setIsRenaming(null);
    setRenameValue('');
  };

  const handleDelete = (path: string) => {
    const name = path.replace(/\\/g, '/').split('/').pop() || 'this item';
    setDeleteConfirm({ path, name });
    closeContextMenu();
  };

  const confirmDelete = async () => {
    const item = deleteConfirm();
    if (!item) return;

    try {
      await invoke('delete_file', { path: item.path, vaultPath: props.vaultPath });
      props.onFileDeleted(item.path);
      await refreshFiles();
    } catch (err) {
      console.error('Failed to delete:', err);
    }
    setDeleteConfirm(null);
  };

  const handleMakeCopy = async (path: string) => {
    const fileName = path.replace(/\\/g, '/').split('/').pop() || '';
    const parentPath = getParentPath(path);
    const ext = fileName.includes('.') ? fileName.substring(fileName.lastIndexOf('.')) : '';
    const baseName = ext ? fileName.substring(0, fileName.lastIndexOf('.')) : fileName;
    const copyName = `${baseName} copy${ext}`;
    const copySep = path.includes('\\') ? '\\' : '/';
    const destPath = `${parentPath}${copySep}${copyName}`;

    try {
      await invoke('copy_file', { source: path, dest: destPath, vaultPath: props.vaultPath });
      await refreshFiles();
    } catch (err) {
      console.error('Failed to copy:', err);
    }
    closeContextMenu();
  };

  const handleCopyPath = async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
    } catch (err) {
      console.error('Failed to copy path:', err);
    }
    closeContextMenu();
  };

  const handleOpenInDefaultApp = async (path: string) => {
    try {
      await invoke('open_in_default_app', { path });
    } catch (err) {
      console.error('Failed to open in default app:', err);
    }
    closeContextMenu();
  };

  const handleShowInFolder = async (path: string) => {
    try {
      await invoke('show_in_folder', { path });
    } catch (err) {
      console.error('Failed to show in folder:', err);
    }
    closeContextMenu();
  };

  const handleMoveTo = async (sourcePath: string) => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
        title: 'Move to...',
      });

      if (selected && typeof selected === 'string') {
        const fileName = sourcePath.replace(/\\/g, '/').split('/').pop() || '';
        const destPath = `${selected}/${fileName}`;
        setMoveConfirm({ sourcePath, destPath, name: fileName });
      }
    } catch (err) {
      console.error('Failed to move:', err);
    }
    closeContextMenu();
  };

  const confirmMove = async () => {
    const move = moveConfirm();
    if (!move) return;

    try {
      await invoke('rename_file', { oldPath: move.sourcePath, newPath: move.destPath, vaultPath: props.vaultPath });
      props.onFileMoved?.(move.sourcePath, move.destPath);
      await refreshFiles();

      if (props.currentFile === move.sourcePath) {
        props.onFileSelect(move.destPath);
      }
    } catch (err) {
      console.error('Failed to move:', err);
    }
    setMoveConfirm(null);
  };

  // Drag and drop handlers
  const handleDragStart = (e: DragEvent, path: string) => {
    setDraggedItem(path);
    if (e.dataTransfer) {
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', path);
    }
  };

  const handleDragEnd = () => {
    setDraggedItem(null);
    setDropTarget(null);
  };

  const handleDragOver = (e: DragEvent, targetPath: string, isDir: boolean) => {
    // Must always preventDefault to avoid forbidden cursor on Windows WebView2
    e.preventDefault();
    const dragged = draggedItem();
    if (!dragged) return;

    // Can only drop on directories
    if (!isDir) {
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
      return;
    }

    // Can't drop on itself or its children
    const draggedNorm = dragged.replace(/\\/g, '/');
    const targetNorm = targetPath.replace(/\\/g, '/');
    if (targetNorm === draggedNorm || targetNorm.startsWith(draggedNorm + '/')) {
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
      return;
    }

    // Can't drop on its current parent
    const draggedParent = getParentPath(dragged);
    if (targetPath === draggedParent) {
      if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
      return;
    }

    if (e.dataTransfer) {
      e.dataTransfer.dropEffect = 'move';
    }
    setDropTarget(targetPath);
  };

  const handleDragLeave = (e: DragEvent) => {
    // Only clear if leaving the element entirely
    const relatedTarget = e.relatedTarget as HTMLElement;
    const current = e.currentTarget as HTMLElement | null;
    if (!relatedTarget || !current?.contains(relatedTarget)) {
      setDropTarget(null);
    }
  };

  const handleDrop = (e: DragEvent, targetPath: string) => {
    e.preventDefault();
    const sourcePath = draggedItem();
    if (!sourcePath) return;

    const fileName = getFileName(sourcePath);
    const dropSep = targetPath.includes('\\') ? '\\' : '/';
    const newPath = `${targetPath}${dropSep}${fileName}`;

    // Don't move to same location
    if (sourcePath === newPath) {
      setDraggedItem(null);
      setDropTarget(null);
      return;
    }

    // Show confirmation modal
    setMoveConfirm({ sourcePath, destPath: newPath, name: fileName });

    setDraggedItem(null);
    setDropTarget(null);
  };

  const handleDropOnRoot = (e: DragEvent) => {
    e.preventDefault();
    if (!props.vaultPath) return;

    const sourcePath = draggedItem();
    if (!sourcePath) return;

    const fileName = getFileName(sourcePath);
    const rootSep = props.vaultPath.includes('\\') ? '\\' : '/';
    const newPath = `${props.vaultPath}${rootSep}${fileName}`;

    // Don't move if already in root
    const sourceParent = getParentPath(sourcePath);
    if (sourceParent === props.vaultPath) {
      setDraggedItem(null);
      setDropTarget(null);
      return;
    }

    // Show confirmation modal
    setMoveConfirm({ sourcePath, destPath: newPath, name: fileName });

    setDraggedItem(null);
    setDropTarget(null);
  };

  // Search functionality
  const performSearch = async (query: string) => {
    if (!query.trim() || !props.vaultPath) {
      setSearchResults([]);
      return;
    }

    setIsSearching(true);
    try {
      const results = await invoke<SearchResult[]>('search_files', {
        path: props.vaultPath,
        query: query.trim(),
      });
      setSearchResults(results);
    } catch (err) {
      console.error('Search failed:', err);
      setSearchResults([]);
    } finally {
      setIsSearching(false);
    }
  };

  // Debounced search
  let searchTimeout: number | null = null;
  const handleSearchInput = (value: string) => {
    setSearchQuery(value);
    if (searchTimeout) clearTimeout(searchTimeout);
    searchTimeout = window.setTimeout(() => {
      performSearch(value);
    }, 300);
  };

  const FileTreeItem: Component<{ entry: FileEntry; depth: number }> = (itemProps) => {
    const isExpanded = () => expandedFolders().has(itemProps.entry.path);
    const isActive = () => props.currentFile === itemProps.entry.path;
    const isBeingRenamed = () => isRenaming() === itemProps.entry.path;
    const isDragging = () => draggedItem() === itemProps.entry.path;
    const isDropTarget = () => dropTarget() === itemProps.entry.path;
    const typeInfo = () => getFileTypeInfo(itemProps.entry.name, itemProps.entry.isDirectory);

    return (
      <>
        <div
          class={`file-tree-item ${itemProps.entry.isDirectory ? 'folder' : ''} ${isActive() ? 'active' : ''} ${isDragging() ? 'dragging' : ''} ${isDropTarget() ? 'drop-target' : ''}`}
          style={{ 'padding-left': `${16 + itemProps.depth * 16}px` }}
          draggable={!isBeingRenamed() && !isMobile()}
          onDragStart={(e) => { if (!isMobile()) handleDragStart(e, itemProps.entry.path); }}
          onDragEnd={() => { if (!isMobile()) handleDragEnd(); }}
          onDragOver={(e) => { if (!isMobile()) handleDragOver(e, itemProps.entry.path, itemProps.entry.isDirectory); }}
          onDragLeave={(e) => { if (!isMobile()) handleDragLeave(e); }}
          onDrop={(e) => { if (!isMobile()) handleDrop(e, itemProps.entry.path); }}
          onClick={() => {
            if (itemProps.entry.isDirectory) {
              toggleFolder(itemProps.entry.path);
            } else if (!isBeingRenamed()) {
              props.onFileSelect(itemProps.entry.path);
            }
          }}
          onContextMenu={(e) => handleContextMenu(e, itemProps.entry.path, itemProps.entry.isDirectory)}
        >
          <span>{itemProps.entry.isDirectory ? (isExpanded() ? '▼' : '▶') : '📄'}</span>
          <Show
            when={!isBeingRenamed()}
            fallback={
              <input
                type="text"
                class="rename-input"
                value={renameValue()}
                onInput={(e) => setRenameValue(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') confirmRename(itemProps.entry.path);
                  if (e.key === 'Escape') setIsRenaming(null);
                }}
                onBlur={() => confirmRename(itemProps.entry.path)}
                autofocus
                onClick={(e) => e.stopPropagation()}
              />
            }
          >
            <span class="file-name">{typeInfo().displayName}</span>
            <Show when={typeInfo().badge}>
              <span class="file-type-badge">{typeInfo().badge}</span>
            </Show>
          </Show>
        </div>
        <Show when={itemProps.entry.isDirectory && isExpanded()}>
          <Show when={isCreating()?.parentPath === itemProps.entry.path}>
            <div class="file-tree-item new-item" style={{ 'padding-left': `${16 + (itemProps.depth + 1) * 16}px` }}>
              <span>{isCreating()?.type === 'folder' ? '📁' : '📄'}</span>
              <input
                type="text"
                class="rename-input"
                placeholder={isCreating()?.type === 'folder' ? 'folder name' : 'filename'}
                value={newItemName()}
                onInput={(e) => setNewItemName(e.currentTarget.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') confirmCreate();
                  if (e.key === 'Escape') setIsCreating(null);
                }}
                onBlur={() => {
                  if (newItemName()) confirmCreate();
                  else setIsCreating(null);
                }}
                autofocus
              />
            </div>
          </Show>
          <For each={itemProps.entry.children}>
            {(child) => <FileTreeItem entry={child} depth={itemProps.depth + 1} />}
          </For>
        </Show>
      </>
    );
  };

  // Close menus when clicking elsewhere
  const handleGlobalClick = (e: MouseEvent) => {
    closeContextMenu();
    // Close vault menu if clicking outside of it
    const target = e.target as HTMLElement;
    if (!target.closest('.vault-name-btn') && !target.closest('.vault-menu')) {
      setShowVaultMenu(false);
    }
  };

  onMount(() => {
    document.addEventListener('click', handleGlobalClick);
  });

  onCleanup(() => {
    document.removeEventListener('click', handleGlobalClick);
    if (searchTimeout) clearTimeout(searchTimeout);
  });

  const viewTitle = () => {
    switch (props.view) {
      case 'files': return props.vaultPath ? props.vaultPath.replace(/\\/g, '/').split('/').pop() : 'No Vault Open';
      case 'search': return 'Search';
      case 'bookmarks': return 'Bookmarks';
    }
  };

  const handleSwitchVault = async () => {
    setShowVaultMenu(false);
    await openVault();
  };

  return (
    <aside class="sidebar">
      <div class="sidebar-header">
        <Show when={props.view === 'files' && props.vaultPath}>
          <button
            class="vault-name-btn"
            onClick={() => setShowVaultMenu(!showVaultMenu())}
            title="Vault options"
          >
            <span>{viewTitle()}</span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="6 9 12 15 18 9"></polyline>
            </svg>
          </button>
          {/* Vault Menu Dropdown */}
          <Show when={showVaultMenu()}>
            <div class="vault-menu">
              <div class="context-menu-item" onClick={handleSwitchVault}>
                Open another vault
              </div>
              <div class="context-menu-item" onClick={() => {
                handleShowInFolder(props.vaultPath!);
                setShowVaultMenu(false);
              }}>
                Open vault folder
              </div>
              <div class="context-menu-divider" />
              <div class="context-menu-item" onClick={() => {
                handleCopyPath(props.vaultPath!);
                setShowVaultMenu(false);
              }}>
                Copy vault path
              </div>
            </div>
          </Show>
        </Show>
        <Show when={props.view !== 'files' || !props.vaultPath}>
          <span>{viewTitle()}</span>
        </Show>
        {/* Files View Header Actions */}
        <Show when={props.vaultPath && props.view === 'files'}>
          <div class="sidebar-header-actions">
            <button
              class="header-btn"
              onClick={() => handleCreateFile(props.vaultPath!)}
              title="New Note"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
                <polyline points="14 2 14 8 20 8"/>
                <line x1="12" y1="18" x2="12" y2="12"/>
                <line x1="9" y1="15" x2="15" y2="15"/>
              </svg>
            </button>
            <button
              class="header-btn"
              onClick={() => handleCreateFolder(props.vaultPath!)}
              title="New Folder"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>
                <line x1="12" y1="11" x2="12" y2="17"/>
                <line x1="9" y1="14" x2="15" y2="14"/>
              </svg>
            </button>
            <button
              class="header-btn"
              onClick={toggleSortOrder}
              title={`Sort by ${sortOrder() === 'name' ? 'Modified' : 'Name'}`}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M3 6h18"/>
                <path d="M6 12h12"/>
                <path d="M9 18h6"/>
              </svg>
            </button>
            <button
              class="header-btn"
              onClick={collapseAll}
              title="Collapse All"
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="4 14 10 14 10 20"/>
                <polyline points="20 10 14 10 14 4"/>
                <line x1="14" y1="10" x2="21" y2="3"/>
                <line x1="3" y1="21" x2="10" y2="14"/>
              </svg>
            </button>
          </div>
        </Show>
        {/* Bookmarks View Header Actions */}
        <Show when={props.view === 'bookmarks'}>
          <div class="sidebar-header-actions">
            <button
              class="header-btn"
              onClick={() => {
                const currentFile = props.currentFile;
                if (currentFile) {
                  props.onToggleBookmark(currentFile);
                }
              }}
              title="Bookmark Active Tab"
              disabled={!props.currentFile}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>
                <line x1="12" y1="7" x2="12" y2="13"/>
                <line x1="9" y1="10" x2="15" y2="10"/>
              </svg>
            </button>
          </div>
        </Show>
      </div>

      {/* Files View */}
      <Show when={props.view === 'files'}>
        <div
          class={`sidebar-content ${dropTarget() === props.vaultPath ? 'drop-target' : ''}`}
          onDragOver={(e) => {
            if (isMobile()) return;
            e.preventDefault();
            const dragged = draggedItem();
            if (!dragged || !props.vaultPath) {
              if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
              return;
            }
            const draggedParent = getParentPath(dragged);
            if (draggedParent === props.vaultPath) {
              if (e.dataTransfer) e.dataTransfer.dropEffect = 'none';
              return;
            }
            if (e.dataTransfer) e.dataTransfer.dropEffect = 'move';
            setDropTarget(props.vaultPath);
          }}
          onDragLeave={(e) => {
            if (isMobile()) return;
            const relatedTarget = e.relatedTarget as HTMLElement;
    if (!relatedTarget || !(e.currentTarget as HTMLElement)?.contains(relatedTarget)) {
              if (dropTarget() === props.vaultPath) setDropTarget(null);
            }
          }}
          onDrop={(e) => { if (!isMobile()) handleDropOnRoot(e); }}
        >
          <Show
            when={props.vaultPath}
            fallback={
              <div style={{ padding: '16px', 'text-align': 'center' }}>
                <button class="open-vault-btn" onClick={openVault}>
                  Open Vault
                </button>
              </div>
            }
          >
            <Show when={isCreating()?.parentPath === props.vaultPath}>
              <div class="file-tree-item new-item" style={{ 'padding-left': '16px' }}>
                <span>{isCreating()?.type === 'folder' ? '📁' : '📄'}</span>
                <input
                  type="text"
                  class="rename-input"
                  placeholder={isCreating()?.type === 'folder' ? 'folder name' : 'filename'}
                  value={newItemName()}
                  onInput={(e) => setNewItemName(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') confirmCreate();
                    if (e.key === 'Escape') setIsCreating(null);
                  }}
                  onBlur={() => {
                    if (newItemName()) confirmCreate();
                    else setIsCreating(null);
                  }}
                  autofocus
                />
              </div>
            </Show>
            <For each={files()}>
              {(entry) => <FileTreeItem entry={entry} depth={0} />}
            </For>
          </Show>
        </div>
      </Show>

      {/* Search View */}
      <Show when={props.view === 'search'}>
        <div class="sidebar-content">
          <Show
            when={props.vaultPath}
            fallback={
              <div class="sidebar-empty-state">
                <p>Open a vault to search files</p>
                <button class="open-vault-btn" onClick={openVault}>
                  Open Vault
                </button>
              </div>
            }
          >
            <div class="sidebar-search">
              <input
                type="text"
                class="sidebar-search-input"
                placeholder="Search in files..."
                value={searchQuery()}
                onInput={(e) => handleSearchInput(e.currentTarget.value)}
              />
              <Show when={searchQuery().trim()}>
                <button
                  class={`search-save-btn ${props.savedSearches.includes(searchQuery().trim()) ? 'saved' : ''}`}
                  onClick={() => props.onToggleSavedSearch(searchQuery().trim())}
                  title={props.savedSearches.includes(searchQuery().trim()) ? 'Remove saved search' : 'Save this search'}
                >
                  <svg width="14" height="14" viewBox="0 0 24 24" fill={props.savedSearches.includes(searchQuery().trim()) ? 'currentColor' : 'none'} stroke="currentColor" stroke-width="2">
                    <path d="m19 21-7-4-7 4V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v16z"/>
                  </svg>
                </button>
              </Show>
            </div>
            <Show when={isSearching()}>
              <div class="sidebar-message">Searching...</div>
            </Show>
            <Show when={!isSearching() && searchQuery() && searchResults().length === 0}>
              <div class="sidebar-message">No results found</div>
            </Show>
            <Show when={!isSearching() && searchResults().length > 0}>
              <For each={searchResults()}>
                {(result) => (
                  <div class="search-result-item">
                    <div
                      class="search-result-file"
                      onClick={() => props.onFileSelect(result.path)}
                    >
                      📄 {result.name}
                    </div>
                    <For each={result.matches.slice(0, 3)}>
                      {(match) => (
                        <div
                          class="search-result-match"
                          onClick={() => props.onFileSelect(result.path, match.line)}
                        >
                          <span class="match-line">{match.line}</span>
                          <span class="match-content">{match.content}</span>
                        </div>
                      )}
                    </For>
                  </div>
                )}
              </For>
            </Show>
            <Show when={!searchQuery()}>
              <div class="sidebar-message">Type to search in all files</div>
            </Show>
          </Show>
        </div>
      </Show>

      {/* Bookmarks View */}
      <Show when={props.view === 'bookmarks'}>
        <div class="sidebar-content">
          <Show
            when={props.vaultPath}
            fallback={
              <div class="sidebar-empty-state">
                <p>Open a vault to use bookmarks</p>
                <button class="open-vault-btn" onClick={openVault}>
                  Open Vault
                </button>
              </div>
            }
          >
            <Show when={props.bookmarks.length === 0 && props.savedSearches.length === 0}>
              <div class="sidebar-message">No bookmarks yet. Right-click a file to bookmark it, or save a search.</div>
            </Show>

          {/* Saved Searches */}
          <Show when={props.savedSearches.length > 0}>
            <div class="bookmark-section">
              <div class="bookmark-section-title">Saved Searches</div>
              <For each={props.savedSearches}>
                {(query) => (
                  <div
                    class="file-tree-item saved-search"
                    onClick={() => {
                      setSearchQueryAndSearch(query);
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <circle cx="11" cy="11" r="8"></circle>
                      <path d="m21 21-4.35-4.35"></path>
                    </svg>
                    <span>{query}</span>
                    <button
                      class="bookmark-remove-btn"
                      onClick={(e) => {
                        e.stopPropagation();
                        props.onToggleSavedSearch(query);
                      }}
                      title="Remove saved search"
                    >
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                      </svg>
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>

            {/* File Bookmarks */}
            <Show when={props.bookmarks.length > 0}>
              <div class="bookmark-section">
                <Show when={props.savedSearches.length > 0}>
                  <div class="bookmark-section-title">Files</div>
                </Show>
                <For each={props.bookmarks}>
                  {(path) => (
                    <div
                      class={`file-tree-item ${props.currentFile === path ? 'active' : ''}`}
                      onClick={() => props.onFileSelect(path)}
                    >
                      <span>🔖</span>
                      <span>{path.replace(/\\/g, '/').split('/').pop()}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </Show>
        </div>
      </Show>

      {/* Context Menu */}
      <Show when={contextMenu()}>
        <div
          class={`context-menu ${contextMenu()!.openUpward ? 'open-upward' : ''}`}
          style={{ 
            left: `${contextMenu()!.x}px`, 
            ...(contextMenu()!.openUpward 
              ? { bottom: `${Math.max(8, window.innerHeight - contextMenu()!.y)}px`, 'max-height': `${contextMenu()!.y - 8}px` }
              : { top: `${contextMenu()!.y}px`, 'max-height': `${window.innerHeight - contextMenu()!.y - 8}px` })
          }}
        >
          {/* File-specific options */}
          <Show when={!contextMenu()!.isDir}>
            <div class="context-menu-item" onClick={() => {
              props.onFileSelect(contextMenu()!.path);
              closeContextMenu();
            }}>
              Open in new tab
            </div>
            <div class="context-menu-divider" />
          </Show>

          {/* Folder-specific options */}
          <Show when={contextMenu()!.isDir}>
            <div class="context-menu-item" onClick={() => handleCreateFile(contextMenu()!.path)}>
              New note
            </div>
            <div class="context-menu-item" onClick={() => handleCreateFolder(contextMenu()!.path)}>
              New folder
            </div>
            <div class="context-menu-divider" />
          </Show>

          {/* Common options */}
          <div class="context-menu-item" onClick={() => handleMakeCopy(contextMenu()!.path)}>
            Make a copy
          </div>
          <div class="context-menu-item" onClick={() => handleMoveTo(contextMenu()!.path)}>
            Move {contextMenu()!.isDir ? 'folder' : 'file'} to...
          </div>
          <div
            class="context-menu-item"
            onClick={() => {
              props.onToggleBookmark(contextMenu()!.path);
              closeContextMenu();
            }}
          >
            {props.bookmarks.includes(contextMenu()!.path) ? 'Remove bookmark' : 'Bookmark'}
          </div>

          {/* File info option for files only */}
          <Show when={!contextMenu()!.isDir && props.onFileInfo}>
            <div
              class="context-menu-item"
              onClick={() => {
                const path = contextMenu()!.path;
                closeContextMenu();
                props.onFileInfo?.(path);
              }}
            >
              File info...
            </div>
          </Show>

          {/* Nostr options - grouped together */}
          <Show when={!contextMenu()!.isDir && (props.onShareFile || (contextMenu()!.path.endsWith('.md') && props.onPostToNostr))}>
            <div class="context-menu-divider" />
            <div class="context-menu-label">Nostr</div>
            
            <Show when={props.onShareFile}>
              <div
                class="context-menu-item"
                onClick={async () => {
                  const path = contextMenu()!.path;
                  closeContextMenu();
                  try {
                    const content = await invoke<string>('read_file', { path, vaultPath: props.vaultPath });
                    props.onShareFile?.(path, content);
                  } catch (err) {
                    console.error('Failed to read file for sharing:', err);
                  }
                }}
              >
                Share with user...
              </div>
            </Show>

            <Show when={contextMenu()!.path.endsWith('.md') && props.onPostToNostr}>
              <div
                class="context-menu-item"
                onClick={async () => {
                  const path = contextMenu()!.path;
                  closeContextMenu();
                  try {
                    const content = await invoke<string>('read_file', { path, vaultPath: props.vaultPath });
                    const fileName = path.replace(/\\/g, '/').split('/').pop() || '';
                    const title = fileName.replace(/\.md$/, '');
                    props.onPostToNostr?.(path, content, title);
                  } catch (err) {
                    console.error('Failed to read file for posting:', err);
                  }
                }}
              >
                Publish as article...
              </div>
            </Show>
          </Show>

          <div class="context-menu-divider" />

          <div class="context-menu-item" onClick={() => handleCopyPath(contextMenu()!.path)}>
            Copy path
          </div>
          <Show when={!contextMenu()!.isDir}>
            <div class="context-menu-item" onClick={() => handleOpenInDefaultApp(contextMenu()!.path)}>
              Open in default app
            </div>
          </Show>
          <div class="context-menu-item" onClick={() => handleShowInFolder(contextMenu()!.path)}>
            Show in system explorer
          </div>

          <div class="context-menu-divider" />

          <div class="context-menu-item" onClick={() => handleRename(contextMenu()!.path, contextMenu()!.path.replace(/\\/g, '/').split('/').pop()!)}>
            Rename
          </div>
          <div class="context-menu-item danger" onClick={() => handleDelete(contextMenu()!.path)}>
            Delete
          </div>
        </div>
      </Show>

      {/* Delete Confirmation Modal */}
      <Show when={deleteConfirm()}>
        <div class="modal-overlay" onClick={() => setDeleteConfirm(null)}>
          <div class="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <h3>Delete "{deleteConfirm()!.name}"?</h3>
              <button class="modal-close" onClick={() => setDeleteConfirm(null)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>
            <div class="modal-body">
              <p>This will permanently delete this item. This action cannot be undone.</p>
            </div>
            <div class="modal-footer">
              <button class="setting-button secondary" onClick={() => setDeleteConfirm(null)}>Cancel</button>
              <button class="setting-button danger" onClick={confirmDelete}>Delete</button>
            </div>
          </div>
        </div>
      </Show>

      {/* Move Confirmation Modal */}
      <Show when={moveConfirm()}>
        <div class="modal-overlay" onClick={() => setMoveConfirm(null)}>
          <div class="modal-dialog" onClick={(e) => e.stopPropagation()}>
            <div class="modal-header">
              <h3>Move "{moveConfirm()!.name}"?</h3>
              <button class="modal-close" onClick={() => setMoveConfirm(null)}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="18" y1="6" x2="6" y2="18"></line>
                  <line x1="6" y1="6" x2="18" y2="18"></line>
                </svg>
              </button>
            </div>
            <div class="modal-body">
              <p>Move to: <code>{moveConfirm()!.destPath}</code></p>
            </div>
            <div class="modal-footer">
              <button class="setting-button secondary" onClick={() => setMoveConfirm(null)}>Cancel</button>
              <button class="setting-button" onClick={confirmMove}>Move</button>
            </div>
          </div>
        </div>
      </Show>
    </aside>
  );
};

export default Sidebar;
