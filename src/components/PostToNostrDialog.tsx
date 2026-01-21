import { Component, createSignal, Show, For } from 'solid-js';

interface PostToNostrDialogProps {
  filePath: string;
  content: string;
  title: string;
  onClose: () => void;
  onPublish: (options: {
    title: string;
    summary: string;
    image: string;
    tags: string[];
    isDraft: boolean;
  }) => Promise<{ eventId: string; naddr: string } | null>;
}

const PostToNostrDialog: Component<PostToNostrDialogProps> = (props) => {
  const [title, setTitle] = createSignal(props.title);
  const [summary, setSummary] = createSignal('');
  const [image, setImage] = createSignal('');
  const [tagsInput, setTagsInput] = createSignal('');
  const [isDraft, setIsDraft] = createSignal(false);
  const [isPublishing, setIsPublishing] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [result, setResult] = createSignal<{ eventId: string; naddr: string } | null>(null);
  const [copiedField, setCopiedField] = createSignal<string | null>(null);

  // Extract first paragraph as default summary
  const getDefaultSummary = () => {
    // Strip HTML tags first (in case content has HTML from editor)
    const plainText = props.content.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ');
    const lines = plainText.split('\n').filter(l => l.trim() && !l.startsWith('#'));
    return lines[0]?.trim().slice(0, 200) || '';
  };

  // Extract hashtags from content as suggested tags
  const extractHashtags = (): string[] => {
    const matches = props.content.match(/#[\w-]+/g) || [];
    return [...new Set(matches.map(t => t.slice(1).toLowerCase()))];
  };

  const suggestedTags = extractHashtags();

  const handleAddSuggestedTag = (tag: string) => {
    const current = tagsInput().split(',').map(t => t.trim()).filter(Boolean);
    if (!current.includes(tag)) {
      setTagsInput([...current, tag].join(', '));
    }
  };

  const handlePublish = async () => {
    if (!title().trim()) {
      setError('Title is required');
      return;
    }

    setIsPublishing(true);
    setError(null);

    try {
      const tags = tagsInput()
        .split(',')
        .map(t => t.trim().toLowerCase())
        .filter(Boolean);

      const publishResult = await props.onPublish({
        title: title().trim(),
        summary: summary().trim() || getDefaultSummary(),
        image: image().trim(),
        tags,
        isDraft: isDraft(),
      });

      if (publishResult) {
        setResult(publishResult);
      } else {
        setError('Failed to publish. Please try again.');
      }
    } catch (err: any) {
      setError(err.message || 'Failed to publish');
    } finally {
      setIsPublishing(false);
    }
  };

  const copyToClipboard = async (text: string, field: string) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopiedField(field);
      setTimeout(() => setCopiedField(null), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  // Word count
  const wordCount = () => {
    const text = props.content.trim();
    if (!text) return 0;
    return text.split(/\s+/).length;
  };

  // Reading time estimate (200 words per minute)
  const readingTime = () => {
    const minutes = Math.ceil(wordCount() / 200);
    return minutes === 1 ? '1 min read' : `${minutes} min read`;
  };

  return (
    <div class="modal-overlay" onClick={props.onClose}>
      <div class="modal-dialog post-to-nostr-dialog" onClick={(e) => e.stopPropagation()}>
        <div class="modal-header">
          <h3>{result() ? 'Published Successfully' : 'Publish to Nostr'}</h3>
          <button class="modal-close" onClick={props.onClose}>
            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>

        <div class="modal-body post-nostr-content">
          <Show when={!result()}>
            {/* Article Preview Section */}
            <div class="post-nostr-section">
              <div class="post-nostr-section-header">
                <div class="post-nostr-section-icon article">
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                    <path d="M14 2v6h6"></path>
                    <line x1="16" y1="13" x2="8" y2="13"></line>
                    <line x1="16" y1="17" x2="8" y2="17"></line>
                  </svg>
                </div>
                <div class="post-nostr-section-title">
                  <span>Article Details</span>
                  <span class="post-nostr-section-subtitle">{props.filePath.split('/').pop()}</span>
                </div>
                <div class="post-nostr-article-meta">
                  <span class="post-nostr-meta-badge">{wordCount()} words</span>
                  <span class="post-nostr-meta-badge">{readingTime()}</span>
                </div>
              </div>

              {/* Title Input */}
              <div class="post-nostr-field">
                <label class="post-nostr-label">
                  Title <span class="post-nostr-required">*</span>
                </label>
                <input
                  type="text"
                  class="post-nostr-input"
                  value={title()}
                  onInput={(e) => setTitle(e.currentTarget.value)}
                  placeholder="Article title"
                />
              </div>

              {/* Summary Input */}
              <div class="post-nostr-field">
                <label class="post-nostr-label">Summary</label>
                <textarea
                  class="post-nostr-textarea"
                  value={summary()}
                  onInput={(e) => setSummary(e.currentTarget.value)}
                  placeholder={getDefaultSummary() || 'Brief summary of your article...'}
                  rows={3}
                />
                <span class="post-nostr-hint">Leave empty to auto-generate from first paragraph</span>
              </div>

              {/* Hero Image Input */}
              <div class="post-nostr-field">
                <label class="post-nostr-label">Hero Image</label>
                <input
                  type="url"
                  class="post-nostr-input"
                  value={image()}
                  onInput={(e) => setImage(e.currentTarget.value)}
                  placeholder="https://example.com/image.jpg"
                />
                <span class="post-nostr-hint">Optional banner image URL</span>
              </div>
            </div>

            {/* Divider */}
            <div class="post-nostr-divider"></div>

            {/* Publishing Options Section */}
            <div class="post-nostr-section">
              <div class="post-nostr-section-header">
                <div class={`post-nostr-section-icon ${isDraft() ? 'draft' : 'publish'}`}>
                  <Show when={isDraft()} fallback={
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M22 2L11 13"></path>
                      <path d="M22 2l-7 20-4-9-9-4 20-7z"></path>
                    </svg>
                  }>
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M12 20h9"></path>
                      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z"></path>
                    </svg>
                  </Show>
                </div>
                <div class="post-nostr-section-title">
                  <span>Publishing Options</span>
                  <span class="post-nostr-section-subtitle">
                    {isDraft() ? 'Draft (kind 30024)' : 'Public Article (kind 30023)'}
                  </span>
                </div>
              </div>

              {/* Tags Input */}
              <div class="post-nostr-field">
                <label class="post-nostr-label">Tags</label>
                <input
                  type="text"
                  class="post-nostr-input"
                  value={tagsInput()}
                  onInput={(e) => setTagsInput(e.currentTarget.value)}
                  placeholder="nostr, writing, tutorial"
                />
                <span class="post-nostr-hint">Comma-separated topics for discovery</span>
                
                {/* Suggested tags from content */}
                <Show when={suggestedTags.length > 0}>
                  <div class="post-nostr-suggested-tags">
                    <span class="post-nostr-suggested-label">Suggested:</span>
                    <For each={suggestedTags.slice(0, 8)}>
                      {(tag) => (
                        <button
                          class="post-nostr-tag-btn"
                          onClick={() => handleAddSuggestedTag(tag)}
                          title={`Add #${tag}`}
                        >
                          #{tag}
                        </button>
                      )}
                    </For>
                  </div>
                </Show>
              </div>

              {/* Draft Toggle */}
              <div class="post-nostr-toggle-row">
                <div class="post-nostr-toggle-info">
                  <span class="post-nostr-toggle-label">Save as draft</span>
                  <span class="post-nostr-toggle-desc">Drafts are not publicly visible</span>
                </div>
                <label class="setting-toggle">
                  <input
                    type="checkbox"
                    checked={isDraft()}
                    onChange={(e) => setIsDraft(e.currentTarget.checked)}
                  />
                  <span class="toggle-slider"></span>
                </label>
              </div>

              {/* Error Message */}
              <Show when={error()}>
                <div class="post-nostr-error">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="15" y1="9" x2="9" y2="15"></line>
                    <line x1="9" y1="9" x2="15" y2="15"></line>
                  </svg>
                  {error()}
                </div>
              </Show>
            </div>
          </Show>

          {/* Success Result */}
          <Show when={result()}>
            <div class="post-nostr-success">
              <div class="post-nostr-success-icon">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                  <polyline points="22 4 12 14.01 9 11.01"></polyline>
                </svg>
              </div>
              <h4>Your {isDraft() ? 'draft' : 'article'} is live!</h4>
              <p class="post-nostr-success-subtitle">
                Published to your connected Nostr relays
              </p>

              <div class="post-nostr-result-grid">
                <div class="post-nostr-result-item">
                  <div class="post-nostr-result-label">Event ID</div>
                  <div class="post-nostr-result-value">
                    <span>{result()!.eventId.slice(0, 12)}...{result()!.eventId.slice(-6)}</span>
                    <button 
                      class="file-info-copy-btn" 
                      onClick={() => copyToClipboard(result()!.eventId, 'eventId')}
                      title="Copy event ID"
                    >
                      <Show when={copiedField() === 'eventId'} fallback={
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
                      }>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <polyline points="20 6 9 17 4 12"></polyline>
                        </svg>
                      </Show>
                    </button>
                  </div>
                </div>
                <div class="post-nostr-result-item">
                  <div class="post-nostr-result-label">Shareable Link (naddr)</div>
                  <div class="post-nostr-result-value">
                    <span>{result()!.naddr.slice(0, 20)}...{result()!.naddr.slice(-6)}</span>
                    <button 
                      class="file-info-copy-btn" 
                      onClick={() => copyToClipboard(result()!.naddr, 'naddr')}
                      title="Copy naddr"
                    >
                      <Show when={copiedField() === 'naddr'} fallback={
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                          <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                        </svg>
                      }>
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                          <polyline points="20 6 9 17 4 12"></polyline>
                        </svg>
                      </Show>
                    </button>
                  </div>
                </div>
              </div>

              <div class="post-nostr-success-hint">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"></circle>
                  <line x1="12" y1="16" x2="12" y2="12"></line>
                  <line x1="12" y1="8" x2="12.01" y2="8"></line>
                </svg>
                Share the naddr link to let others read your article in any Nostr client
              </div>
            </div>
          </Show>
        </div>

        <div class="modal-footer">
          <Show when={!result()}>
            <button class="setting-button secondary" onClick={props.onClose}>
              Cancel
            </button>
            <button
              class={`setting-button ${isDraft() ? 'draft' : ''}`}
              onClick={handlePublish}
              disabled={isPublishing() || !title().trim()}
            >
              <Show when={isPublishing()}>
                <div class="spinner small"></div>
              </Show>
              <Show when={!isPublishing()}>
                <Show when={isDraft()} fallback={
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M22 2L11 13"></path>
                    <path d="M22 2l-7 20-4-9-9-4 20-7z"></path>
                  </svg>
                }>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"></path>
                    <polyline points="17 21 17 13 7 13 7 21"></polyline>
                    <polyline points="7 3 7 8 15 8"></polyline>
                  </svg>
                </Show>
              </Show>
              {isPublishing() ? 'Publishing...' : (isDraft() ? 'Save Draft' : 'Publish')}
            </button>
          </Show>
          <Show when={result()}>
            <button class="setting-button" onClick={props.onClose}>
              Done
            </button>
          </Show>
        </div>
      </div>
    </div>
  );
};

export default PostToNostrDialog;
