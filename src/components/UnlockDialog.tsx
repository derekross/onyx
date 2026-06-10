// Master-passphrase prompt for the web build.
//
// Shown when the SecretStore reports isLocked() = true. The same passphrase
// both unlocks an existing nsec and sets the seal for a first-time install.

import { Component, createSignal, Show } from 'solid-js';
import { platform } from '@platform';

interface UnlockDialogProps {
  onUnlocked: () => void;
}

const UnlockDialog: Component<UnlockDialogProps> = (props) => {
  const [passphrase, setPassphrase] = createSignal('');
  const [confirmPass, setConfirmPass] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  const [busy, setBusy] = createSignal(false);
  const [mode, setMode] = createSignal<'unlock' | 'create'>('unlock');

  // First boot detection: if no secrets exist yet, switch to "create" mode that
  // confirms the passphrase. Otherwise the user is unlocking an existing seal.
  const handleSubmit = async (e: Event) => {
    e.preventDefault();
    setError(null);

    if (mode() === 'create' && passphrase() !== confirmPass()) {
      setError('Passphrases do not match.');
      return;
    }
    if (passphrase().length < 8) {
      setError('Use at least 8 characters.');
      return;
    }

    setBusy(true);
    try {
      if (platform.secrets.unlock) {
        await platform.secrets.unlock(passphrase());
      }
      props.onUnlocked();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div class="unlock-dialog-overlay">
      <form class="unlock-dialog" onSubmit={handleSubmit}>
        <h2>{mode() === 'create' ? 'Create master passphrase' : 'Unlock Onyx'}</h2>
        <p class="unlock-dialog-body">
          {mode() === 'create'
            ? 'Choose a passphrase. It encrypts your Nostr key in this browser. We cannot recover it for you.'
            : 'Enter your passphrase to decrypt your stored Nostr key.'}
        </p>

        <input
          type="password"
          class="unlock-input"
          placeholder="Passphrase"
          value={passphrase()}
          onInput={(e) => setPassphrase(e.currentTarget.value)}
          autofocus
          disabled={busy()}
        />

        <Show when={mode() === 'create'}>
          <input
            type="password"
            class="unlock-input"
            placeholder="Confirm passphrase"
            value={confirmPass()}
            onInput={(e) => setConfirmPass(e.currentTarget.value)}
            disabled={busy()}
          />
        </Show>

        <Show when={error()}>
          <div class="unlock-error">{error()}</div>
        </Show>

        <div class="unlock-actions">
          <button
            type="button"
            class="unlock-mode-toggle"
            onClick={() => setMode(mode() === 'create' ? 'unlock' : 'create')}
            disabled={busy()}
          >
            {mode() === 'create' ? 'I already have a passphrase' : 'First time here? Create one'}
          </button>
          <button type="submit" class="unlock-submit" disabled={busy() || !passphrase()}>
            {busy() ? 'Unlocking...' : 'Continue'}
          </button>
        </div>
      </form>
    </div>
  );
};

export default UnlockDialog;
