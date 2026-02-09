/**
 * ShareDialog Component
 * 
 * Dialog for sharing a document with another Nostr user.
 * Supports npub, hex pubkey, and NIP-05 identifier input.
 */

import { Component, createSignal, createEffect, Show, onCleanup } from 'solid-js';
import { parseRecipientInput, formatPubkey } from '../lib/nostr/nip05';
import { getSyncEngine } from '../lib/nostr/sync';
import { fetchUserProfile } from '../lib/nostr/login';
import type { NostrProfile } from '../lib/nostr/types';

interface ShareDialogProps {
  /** File path being shared */
  filePath: string;
  /** File content */
  content: string;
  /** Document title (filename without extension) */
  title: string;
  /** Callback when dialog is closed */
  onClose: () => void;
  /** Callback when share is successful */
  onSuccess?: (eventId: string) => void;
}

const ShareDialog: Component<ShareDialogProps> = (props) => {
  const [recipientInput, setRecipientInput] = createSignal('');
  const [recipientPubkey, setRecipientPubkey] = createSignal<string | null>(null);
  const [recipientProfile, setRecipientProfile] = createSignal<NostrProfile | null>(null);
  const [isValidating, setIsValidating] = createSignal(false);
  const [validationError, setValidationError] = createSignal<string | null>(null);
  const [isSharing, setIsSharing] = createSignal(false);
  const [shareError, setShareError] = createSignal<string | null>(null);
  const [shareSuccess, setShareSuccess] = createSignal(false);

  // Debounce timer for input validation
  let validationTimeout: number | null = null;

  onCleanup(() => {
    if (validationTimeout) clearTimeout(validationTimeout);
  });

  // Validate recipient input with debounce
  createEffect(() => {
    const input = recipientInput();
    
    // Clear previous state
    setRecipientPubkey(null);
    setRecipientProfile(null);
    setValidationError(null);

    if (!input.trim()) {
      return;
    }

    // Debounce validation
    if (validationTimeout) {
      clearTimeout(validationTimeout);
    }

    validationTimeout = window.setTimeout(async () => {
      setIsValidating(true);
      
      try {
        const result = await parseRecipientInput(input);
        
        if (result.pubkey) {
          setRecipientPubkey(result.pubkey);
          
          // Set initial profile with pubkey
          setRecipientProfile({
            pubkey: result.pubkey,
            name: result.type === 'nip05' ? input : undefined,
          });
          
          // Fetch full profile from relays
          const engine = getSyncEngine();
          const relays = engine.getConfig().relays;
          const profile = await fetchUserProfile(result.pubkey, relays);
          
          if (profile) {
            setRecipientProfile({
              pubkey: result.pubkey,
              name: profile.displayName || profile.name,
              picture: profile.picture,
              nip05: profile.nip05,
            });
          }
        } else {
          setValidationError(result.error || 'Invalid recipient');
        }
      } catch (err) {
        setValidationError('Failed to validate recipient');
      } finally {
        setIsValidating(false);
      }
    }, 500);
  });

  const handleShare = async () => {
    const pubkey = recipientPubkey();
    if (!pubkey) return;

    setIsSharing(true);
    setShareError(null);

    try {
      const engine = getSyncEngine();
      
      const result = await engine.shareDocument(
        pubkey,
        props.title,
        props.content,
        props.filePath
      );

      setShareSuccess(true);
      props.onSuccess?.(result.eventId);

      // Close dialog after short delay
      setTimeout(() => {
        props.onClose();
      }, 1500);
    } catch (err) {
      console.error('Failed to share document:', err);
      setShareError(err instanceof Error ? err.message : 'Failed to share document');
    } finally {
      setIsSharing(false);
    }
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Escape') {
      props.onClose();
    } else if (e.key === 'Enter' && recipientPubkey() && !isSharing()) {
      handleShare();
    }
  };

  return (
    <div class="modal-overlay" onClick={props.onClose} onKeyDown={handleKeyDown}>
      <div class="share-dialog" onClick={(e) => e.stopPropagation()}>
        <div class="share-dialog-header">
          <h3>Share Document</h3>
          <button class="modal-close" onClick={props.onClose}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <div class="share-dialog-body">
          {/* Document preview */}
          <div class="share-document-preview">
            <div class="share-document-icon">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                <polyline points="14 2 14 8 20 8"></polyline>
                <line x1="16" y1="13" x2="8" y2="13"></line>
                <line x1="16" y1="17" x2="8" y2="17"></line>
                <polyline points="10 9 9 9 8 9"></polyline>
              </svg>
            </div>
            <div class="share-document-info">
              <div class="share-document-title">{props.title}</div>
              <div class="share-document-size">{props.content.length} characters</div>
            </div>
          </div>

          {/* Recipient input */}
          <div class="share-recipient-section">
            <label class="share-label">Share with</label>
            <div class="share-input-wrapper">
              <input
                type="text"
                class={`share-input ${validationError() ? 'error' : ''} ${recipientPubkey() ? 'valid' : ''}`}
                placeholder="npub1..., user@domain.com, or hex pubkey"
                value={recipientInput()}
                onInput={(e) => setRecipientInput(e.currentTarget.value)}
                disabled={isSharing() || shareSuccess()}
                autofocus
              />
              <Show when={isValidating()}>
                <div class="share-input-spinner">
                  <div class="spinner small"></div>
                </div>
              </Show>
              <Show when={recipientPubkey() && !isValidating()}>
                <div class="share-input-check">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                </div>
              </Show>
            </div>

            <Show when={validationError()}>
              <div class="share-error">{validationError()}</div>
            </Show>

            <Show when={recipientProfile() && recipientPubkey()}>
              <div class="share-recipient-preview">
                <div class="share-recipient-avatar">
                  <Show when={recipientProfile()?.picture} fallback={
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                      <circle cx="12" cy="7" r="4"></circle>
                    </svg>
                  }>
                    <img src={recipientProfile()!.picture} alt="" />
                  </Show>
                </div>
                <div class="share-recipient-info">
                  <Show when={recipientProfile()?.name}>
                    <div class="share-recipient-name">{recipientProfile()!.name}</div>
                  </Show>
                  <div class="share-recipient-pubkey">{formatPubkey(recipientPubkey()!, 12)}</div>
                </div>
              </div>
            </Show>
          </div>

          <Show when={shareError()}>
            <div class="share-error-message">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="15" y1="9" x2="9" y2="15"></line>
                <line x1="9" y1="9" x2="15" y2="15"></line>
              </svg>
              {shareError()}
            </div>
          </Show>

          <Show when={shareSuccess()}>
            <div class="share-success-message">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="20 6 9 17 4 12"></polyline>
              </svg>
              Document shared successfully!
            </div>
          </Show>
        </div>

        <div class="share-dialog-footer">
          <button class="setting-button secondary" onClick={props.onClose} disabled={isSharing()}>
            Cancel
          </button>
          <button
            class="setting-button"
            onClick={handleShare}
            disabled={!recipientPubkey() || isSharing() || shareSuccess()}
          >
            <Show when={isSharing()}>
              <div class="spinner small"></div>
            </Show>
            <Show when={!isSharing() && !shareSuccess()}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8"></path>
                <polyline points="16 6 12 2 8 6"></polyline>
                <line x1="12" y1="2" x2="12" y2="15"></line>
              </svg>
              Share
            </Show>
            <Show when={shareSuccess()}>
              Shared!
            </Show>
          </button>
        </div>
      </div>
    </div>
  );
};

export default ShareDialog;
