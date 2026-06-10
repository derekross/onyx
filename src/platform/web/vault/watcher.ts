// Minimal watcher abstraction.
//
// In-process change events are emitted directly by vault writes via
// notifyChange(). FileSystemObserver-based external watching is not yet
// implemented — Chromium-only and not required for Phase 2.

type ChangeListener = () => void;
type ModifyListener = (paths: string[]) => void;

const changeListeners = new Set<ChangeListener>();
const modifyListeners = new Set<ModifyListener>();

let watchedVault: string | null = null;

export async function startWatcher(vault: string): Promise<void> {
  watchedVault = vault;
}

export async function stopWatcher(): Promise<void> {
  watchedVault = null;
}

export function notifyChange(paths: string[]): void {
  if (!watchedVault) return;
  for (const cb of changeListeners) {
    try {
      cb();
    } catch (err) {
      console.error('[watcher] onFilesChanged listener threw:', err);
    }
  }
  for (const cb of modifyListeners) {
    try {
      cb(paths);
    } catch (err) {
      console.error('[watcher] onFileModified listener threw:', err);
    }
  }
}

export async function onFilesChanged(cb: ChangeListener): Promise<() => void> {
  changeListeners.add(cb);
  return () => {
    changeListeners.delete(cb);
  };
}

export async function onFileModified(cb: ModifyListener): Promise<() => void> {
  modifyListeners.add(cb);
  return () => {
    modifyListeners.delete(cb);
  };
}
