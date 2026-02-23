/**
 * CustomProviderChat - Chat interface for any OpenAI-compatible API provider
 * Works with MapleAI Proxy, Ollama, LM Studio, vLLM, or any OpenAI-compatible endpoint.
 * Communicates via standard OpenAI API (POST /v1/chat/completions)
 */

import { Component, createSignal, createEffect, onMount, onCleanup, For, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { sanitizeUrl } from '../lib/security';

// --- Types ---

interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

interface VaultFile {
  path: string;
  name: string;
}

interface CustomProviderChatProps {
  onClose: () => void;
  onOpenSettings: () => void;
  vaultPath: string | null;
  currentFile?: { path: string; content: string } | null;
  vaultFiles?: VaultFile[];
}

// --- Markdown rendering ---

function markdownToHtml(markdown: string): string {
  let html = markdown
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const langClass = lang ? ` class="language-${lang}"` : '';
    return `<pre><code${langClass}>${code.trim()}</code></pre>`;
  });

  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');

  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text, url) => {
    const safeUrl = sanitizeUrl(url);
    return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });

  html = html.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  html = html.replace(/\n\n+/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');

  if (!html.startsWith('<')) {
    html = '<p>' + html + '</p>';
  }

  html = html.replace(/<p>\s*<\/p>/g, '');
  html = html.replace(/<p>(<(?:pre|ul|ol|h[1-6]|blockquote))/g, '$1');
  html = html.replace(/(<\/(?:pre|ul|ol|h[1-6]|blockquote)>)<\/p>/g, '$1');

  return html;
}

// --- Component ---

const CustomProviderChat: Component<CustomProviderChatProps> = (props) => {
  const [messages, setMessages] = createSignal<ChatMessage[]>([]);
  const [inputText, setInputText] = createSignal('');
  const [isStreaming, setIsStreaming] = createSignal(false);
  const [streamingContent, setStreamingContent] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  const [isConfigured, setIsConfigured] = createSignal(false);

  // Model selection
  const [selectedModel, setSelectedModel] = createSignal<string>(
    localStorage.getItem('custom_provider_model') || ''
  );
  const [showModelDropdown, setShowModelDropdown] = createSignal(false);

  // File context state
  const [includeContext, setIncludeContext] = createSignal<boolean>(
    localStorage.getItem('custom_provider_include_context') !== 'false'
  );
  const [contextSentForFile, setContextSentForFile] = createSignal<string | null>(null);

  // @file mention state
  const [mentionedFiles, setMentionedFiles] = createSignal<VaultFile[]>([]);
  const [showFilePicker, setShowFilePicker] = createSignal(false);
  const [fileSearchQuery, setFileSearchQuery] = createSignal('');
  const [selectedFileIndex, setSelectedFileIndex] = createSignal(0);

  let inputRef: HTMLTextAreaElement | undefined;
  let messagesEndRef: HTMLDivElement | undefined;
  let streamCleanup: (() => void) | null = null;

  const getConfig = () => {
    const url = localStorage.getItem('custom_provider_url') || '';
    const apiKey = localStorage.getItem('custom_provider_api_key') || '';
    const model = selectedModel();
    return { url, apiKey, model };
  };

  const checkConfiguration = () => {
    const url = localStorage.getItem('custom_provider_url') || '';
    // API key is optional (Ollama doesn't need one)
    setIsConfigured(!!url);
  };

  const getAvailableModels = (): string[] => {
    try {
      const stored = localStorage.getItem('custom_provider_models');
      return stored ? JSON.parse(stored) : [];
    } catch {
      return [];
    }
  };

  const hashContent = (content: string): string => {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return hash.toString(16);
  };

  onMount(() => {
    checkConfiguration();
    inputRef?.focus();
    const handleSettingsChanged = () => {
      checkConfiguration();
      // Re-read model if it changed
      const newModel = localStorage.getItem('custom_provider_model') || '';
      if (newModel !== selectedModel()) {
        setSelectedModel(newModel);
      }
    };
    window.addEventListener('custom-provider-settings-changed', handleSettingsChanged);
    onCleanup(() => {
      window.removeEventListener('custom-provider-settings-changed', handleSettingsChanged);
    });
  });

  const scrollToBottom = () => {
    requestAnimationFrame(() => {
      messagesEndRef?.scrollIntoView({ behavior: 'smooth' });
    });
  };

  createEffect(() => {
    messages();
    streamingContent();
    scrollToBottom();
  });

  // --- @file mention helpers ---

  const filteredFiles = () => {
    const query = fileSearchQuery().toLowerCase();
    const files = props.vaultFiles || [];
    if (!query) return files.slice(0, 10);
    return files
      .filter(f => f.name.toLowerCase().includes(query) || f.path.toLowerCase().includes(query))
      .slice(0, 10);
  };

  const selectFile = (file: VaultFile) => {
    setMentionedFiles(prev => {
      if (prev.some(f => f.path === file.path)) return prev;
      return [...prev, file];
    });
    const text = inputText();
    const atIndex = text.lastIndexOf('@');
    if (atIndex !== -1) setInputText(text.substring(0, atIndex));
    setShowFilePicker(false);
    setFileSearchQuery('');
    setSelectedFileIndex(0);
    inputRef?.focus();
  };

  const removeMentionedFile = (path: string) => {
    setMentionedFiles(prev => prev.filter(f => f.path !== path));
  };

  const toggleContext = () => {
    const newValue = !includeContext();
    setIncludeContext(newValue);
    localStorage.setItem('custom_provider_include_context', String(newValue));
  };

  // --- Model selection ---

  const handleModelChange = (model: string) => {
    setSelectedModel(model);
    localStorage.setItem('custom_provider_model', model);
    setShowModelDropdown(false);
    window.dispatchEvent(new CustomEvent('custom-provider-settings-changed'));
  };

  // --- Streaming ---

  const streamCompletion = async (apiMessages: Array<{ role: string; content: string }>): Promise<string> => {
    const { url, apiKey, model } = getConfig();
    const baseUrl = url.replace(/\/+$/, '');
    const fullUrl = `${baseUrl}/v1/chat/completions`;
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const body = JSON.stringify({
      model: model || 'default',
      messages: apiMessages,
      stream: true,
    });

    let accumulated = '';
    let buffer = '';

    return new Promise<string>((resolve, reject) => {
      let resolved = false;

      listen<string>(`custom-provider-stream-${requestId}`, (event) => {
        const data = event.payload;

        if (data === '__DONE__') {
          resolved = true;
          resolve(accumulated);
          return;
        }

        if (data.startsWith('__ERROR__:')) {
          resolved = true;
          reject(new Error(data.slice(10)));
          return;
        }

        buffer += data;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') continue;

          if (trimmed.startsWith('data: ')) {
            try {
              const json = JSON.parse(trimmed.slice(6));
              const delta = json.choices?.[0]?.delta;
              if (delta?.content) {
                accumulated += delta.content;
                setStreamingContent(accumulated);
              }
            } catch {
              // Skip malformed JSON
            }
          }
        }
      }).then((unlisten) => {
        streamCleanup = () => {
          unlisten();
          if (!resolved) {
            resolved = true;
            resolve(accumulated);
          }
          setIsStreaming(false);
          setStreamingContent('');
          streamCleanup = null;
        };

        invoke('custom_provider_stream', {
          requestId,
          url: fullUrl,
          apiKey,
          body,
        }).catch((err) => {
          if (!resolved) {
            resolved = true;
            reject(err);
          }
        });
      });
    });
  };

  // --- Main send handler ---

  const handleSend = async () => {
    const text = inputText().trim();
    if (!text || isStreaming()) return;

    const { url } = getConfig();
    if (!url) {
      setError('Custom provider is not configured. Please configure it in Settings.');
      return;
    }

    const filesToMention = mentionedFiles();

    // Display text
    let displayText = text;
    if (filesToMention.length > 0) {
      displayText = `[${filesToMention.map(f => f.name).join(', ')}] ${text}`;
    }

    setMessages(prev => [...prev, { role: 'user', content: displayText }]);
    setInputText('');
    setMentionedFiles([]);
    setError(null);
    setIsStreaming(true);
    setStreamingContent('');

    if (inputRef) inputRef.style.height = 'auto';

    // Build the full prompt with context
    let prompt = text;
    const file = props.currentFile;

    if (filesToMention.length > 0) {
      const fileContexts: string[] = [];
      for (const f of filesToMention) {
        try {
          const content = await invoke<string>('read_file', { path: f.path, vaultPath: props.vaultPath });
          const truncated = content.length > 50000 ? content.slice(0, 50000) + '\n[...truncated]' : content;
          fileContexts.push(`=== File: ${f.path} ===\n${truncated}`);
        } catch (err) {
          console.error(`Failed to read file ${f.path}:`, err);
          fileContexts.push(`=== File: ${f.path} ===\n[Error: Could not read file]`);
        }
      }
      prompt = `[Referenced files]\n\n${fileContexts.join('\n\n')}\n\n---\n\n${text}`;
    } else {
      const fileKey = file ? `${file.path}:${hashContent(file.content)}` : null;
      if (file && includeContext() && contextSentForFile() !== fileKey) {
        const MAX_CONTEXT_LINES = 500;
        const MAX_CONTEXT_CHARS = 50000;
        let content = file.content;
        let truncated = false;

        const lines = content.split('\n');
        if (lines.length > MAX_CONTEXT_LINES) {
          content = lines.slice(0, MAX_CONTEXT_LINES).join('\n');
          truncated = true;
        }
        if (content.length > MAX_CONTEXT_CHARS) {
          content = content.slice(0, MAX_CONTEXT_CHARS);
          truncated = true;
        }

        const truncateNote = truncated ? `\n\n[Note: File truncated]` : '';
        prompt = `[Context: Working on file "${file.path}"]${truncateNote}\n\n${content}\n\n---\n\n${text}`;
        setContextSentForFile(fileKey);
      }
    }

    try {
      const apiMessages: Array<{ role: string; content: string }> = [];

      // System prompt
      if (props.vaultPath) {
        apiMessages.push({
          role: 'system',
          content: `You are a helpful AI assistant running inside Onyx, a note-taking app. The user's vault is at: ${props.vaultPath}. Help the user with their questions and tasks.`
        });
      }

      // Conversation history (except the last user message we just added)
      const allMsgs = messages();
      for (let i = 0; i < allMsgs.length - 1; i++) {
        apiMessages.push({ role: allMsgs[i].role, content: allMsgs[i].content });
      }

      // Last user message with full prompt (including context)
      apiMessages.push({ role: 'user', content: prompt });

      const fullText = await streamCompletion(apiMessages);
      setStreamingContent('');

      // Add assistant response
      if (fullText.trim()) {
        setMessages(prev => [...prev, { role: 'assistant', content: fullText }]);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message || 'Failed to communicate with provider');
    } finally {
      setIsStreaming(false);
      setStreamingContent('');
      streamCleanup = null;
    }
  };

  const handleAbort = () => {
    if (streamCleanup) streamCleanup();
  };

  const clearChat = () => {
    setMessages([]);
    setStreamingContent('');
    setError(null);
    setContextSentForFile(null);
    setMentionedFiles([]);
    inputRef?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (showFilePicker()) {
      const files = filteredFiles();
      if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedFileIndex(i => Math.min(i + 1, files.length - 1)); return; }
      if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedFileIndex(i => Math.max(i - 1, 0)); return; }
      if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); const s = files[selectedFileIndex()]; if (s) selectFile(s); return; }
      if (e.key === 'Escape') { e.preventDefault(); setShowFilePicker(false); setFileSearchQuery(''); return; }
    }
    if (showModelDropdown() && e.key === 'Escape') { e.preventDefault(); setShowModelDropdown(false); return; }
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
    if (e.key === 'Escape' && isStreaming()) { handleAbort(); }
  };

  const handleInput = (e: Event) => {
    const target = e.target as HTMLTextAreaElement;
    const value = target.value;
    setInputText(value);

    const cursorPos = target.selectionStart || 0;
    const textBeforeCursor = value.substring(0, cursorPos);
    const atIndex = textBeforeCursor.lastIndexOf('@');

    if (atIndex !== -1 && (atIndex === 0 || textBeforeCursor[atIndex - 1] === ' ' || textBeforeCursor[atIndex - 1] === '\n')) {
      const afterAt = textBeforeCursor.substring(atIndex + 1);
      if (!afterAt.includes(' ') && !afterAt.includes('\n')) {
        setFileSearchQuery(afterAt);
        setShowFilePicker(true);
        setSelectedFileIndex(0);
      } else {
        setShowFilePicker(false);
      }
    } else {
      setShowFilePicker(false);
    }

    target.style.height = 'auto';
    target.style.height = Math.min(target.scrollHeight, 150) + 'px';
  };

  const ProviderIcon = () => (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
      <path d="M2 17l10 5 10-5"></path>
      <path d="M2 12l10 5 10-5"></path>
    </svg>
  );

  const providerName = () => {
    return localStorage.getItem('custom_provider_name') || 'Custom Provider';
  };

  // --- Render ---

  return (
    <div class="custom-provider-panel">
      {/* Header */}
      <div class="custom-provider-panel-header">
        <div class="custom-provider-panel-title">
          <ProviderIcon />
          <span>{providerName()}</span>
        </div>
        <div class="custom-provider-panel-actions">
          <Show when={messages().length > 0}>
            <button class="custom-provider-action-btn" onClick={clearChat} title="Clear chat">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
            </button>
          </Show>
          <button class="custom-provider-action-btn" onClick={props.onOpenSettings} title="Provider Settings">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg>
          </button>
          <button class="custom-provider-action-btn" onClick={props.onClose} title="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      </div>

      {/* Not configured */}
      <Show when={!isConfigured()}>
        <div class="custom-provider-not-configured">
          <div class="custom-provider-setup-icon"><ProviderIcon /></div>
          <h3>Provider Not Configured</h3>
          <p>Set up your OpenAI-compatible provider URL to start chatting. Works with MapleAI Proxy, Ollama, LM Studio, and more.</p>
          <button class="setting-button primary" onClick={props.onOpenSettings}>Configure Provider</button>
        </div>
      </Show>

      {/* Chat */}
      <Show when={isConfigured()}>
        <div class="custom-provider-messages">
          <Show when={messages().length === 0 && !isStreaming()}>
            <div class="custom-provider-welcome">
              <div class="custom-provider-welcome-icon"><ProviderIcon /></div>
              <h3>{providerName()}</h3>
              <p>Ask anything. Type @ to reference files from your vault.</p>
              <Show when={selectedModel()}>
                <div class="custom-provider-welcome-model">Model: {selectedModel()}</div>
              </Show>
            </div>
          </Show>

          <For each={messages()}>
            {(message) => (
              <div class={`custom-provider-message ${message.role}`}>
                <Show when={message.role === 'assistant'}>
                  <div class="custom-provider-message-avatar"><ProviderIcon /></div>
                </Show>
                <div class="custom-provider-message-content">
                  <Show when={message.role === 'assistant'} fallback={
                    <div class="custom-provider-message-text">{message.content}</div>
                  }>
                    <div class="custom-provider-message-text markdown" innerHTML={markdownToHtml(message.content)} />
                  </Show>
                </div>
              </div>
            )}
          </For>

          {/* Streaming message */}
          <Show when={isStreaming() && streamingContent()}>
            <div class="custom-provider-message assistant">
              <div class="custom-provider-message-avatar"><ProviderIcon /></div>
              <div class="custom-provider-message-content">
                <div class="custom-provider-message-text markdown" innerHTML={markdownToHtml(streamingContent())} />
              </div>
            </div>
          </Show>

          {/* Typing indicator */}
          <Show when={isStreaming() && !streamingContent()}>
            <div class="custom-provider-message assistant">
              <div class="custom-provider-message-avatar"><ProviderIcon /></div>
              <div class="custom-provider-message-content">
                <div class="custom-provider-typing">
                  <span></span><span></span><span></span>
                </div>
              </div>
            </div>
          </Show>

          <div ref={messagesEndRef} />
        </div>

        {/* Error banner */}
        <Show when={error()}>
          <div class="custom-provider-error-banner">
            <span>{error()}</span>
            <button onClick={() => setError(null)}>x</button>
          </div>
        </Show>

        {/* Input */}
        <div class="custom-provider-input-container">
          <div class="custom-provider-input-toolbar">
            <Show when={props.currentFile}>
              <button
                class={`chat-context-toggle ${includeContext() ? 'active' : ''}`}
                onClick={toggleContext}
                title={includeContext() ? 'Document context included' : 'Document context not included'}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                  <polyline points="14 2 14 8 20 8"></polyline>
                </svg>
                <span>{props.currentFile!.path.replace(/\\/g, '/').split('/').pop()}</span>
                <Show when={includeContext()}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                </Show>
              </button>
            </Show>
            <Show when={messages().length > 0}>
              <button class="chat-clear-btn" onClick={clearChat} title="Clear chat">
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6"></polyline>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
                <span>Clear</span>
              </button>
            </Show>

            {/* Model selector */}
            <div class="custom-provider-model-selector" style={{ position: 'relative' }}>
              <button
                class="chat-model-indicator"
                onClick={() => setShowModelDropdown(!showModelDropdown())}
                title="Select model"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
                  <path d="M2 17l10 5 10-5"></path>
                  <path d="M2 12l10 5 10-5"></path>
                </svg>
                <span>{selectedModel() || 'Select model'}</span>
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="6 9 12 15 18 9"></polyline>
                </svg>
              </button>
              <Show when={showModelDropdown()}>
                <div class="custom-provider-model-dropdown">
                  <For each={getAvailableModels()}>
                    {(model) => (
                      <button
                        class={`custom-provider-model-option ${model === selectedModel() ? 'active' : ''}`}
                        onClick={() => handleModelChange(model)}
                      >
                        {model}
                      </button>
                    )}
                  </For>
                  <Show when={getAvailableModels().length === 0}>
                    <div class="custom-provider-model-empty">
                      No models found. Check provider settings.
                    </div>
                  </Show>
                </div>
              </Show>
            </div>
          </div>

          {/* Mentioned files */}
          <Show when={mentionedFiles().length > 0}>
            <div class="chat-mentioned-files">
              <For each={mentionedFiles()}>
                {(file) => (
                  <div class="mentioned-file-chip">
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                      <polyline points="14 2 14 8 20 8"></polyline>
                    </svg>
                    <span>{file.name}</span>
                    <button class="remove-file-btn" onClick={() => removeMentionedFile(file.path)} title="Remove file">
                      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="18" y1="6" x2="6" y2="18"></line>
                        <line x1="6" y1="6" x2="18" y2="18"></line>
                      </svg>
                    </button>
                  </div>
                )}
              </For>
            </div>
          </Show>

          <div class="chat-input-wrapper">
            <Show when={showFilePicker() && filteredFiles().length > 0}>
              <div class="chat-file-picker">
                <div class="file-picker-header">
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="11" cy="11" r="8"></circle>
                    <path d="m21 21-4.35-4.35"></path>
                  </svg>
                  <span>Select a file to reference</span>
                </div>
                <For each={filteredFiles()}>
                  {(file, index) => (
                    <div
                      class={`file-picker-item ${index() === selectedFileIndex() ? 'selected' : ''}`}
                      onClick={() => selectFile(file)}
                      onMouseEnter={() => setSelectedFileIndex(index())}
                    >
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                        <polyline points="14 2 14 8 20 8"></polyline>
                      </svg>
                      <span class="file-name">{file.name}</span>
                      <span class="file-path">{file.path.replace(/\\/g, '/').split('/').slice(-2, -1)[0] || ''}</span>
                    </div>
                  )}
                </For>
              </div>
            </Show>

            <textarea
              ref={inputRef}
              class="chat-input"
              placeholder={`Ask ${providerName()} anything... (type @ to reference files)`}
              value={inputText()}
              onInput={handleInput}
              onKeyDown={handleKeyDown}
              disabled={isStreaming()}
              rows={1}
            />
            <Show when={isStreaming()} fallback={
              <button
                class="chat-send-btn"
                onClick={handleSend}
                disabled={!inputText().trim() || isStreaming()}
                title="Send (Enter)"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="22" y1="2" x2="11" y2="13"></line>
                  <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                </svg>
              </button>
            }>
              <button class="chat-abort-btn" onClick={handleAbort} title="Stop (Escape)">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <rect x="6" y="6" width="12" height="12"></rect>
                </svg>
              </button>
            </Show>
          </div>
        </div>
      </Show>
    </div>
  );
};

export default CustomProviderChat;
