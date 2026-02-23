/**
 * OpenClawChat - Chat interface for OpenClaw AI assistant
 * Communicates via OpenAI-compatible API (POST /v1/chat/completions)
 *
 * File operations use a structured output convention:
 * The system prompt instructs OpenClaw to emit ~~~action JSON ~~~ blocks
 * when it needs to perform local file operations. The app parses these
 * from the response text and executes them via Tauri commands.
 */

import { Component, createSignal, createEffect, onMount, onCleanup, For, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { sanitizeUrl } from '../lib/security';

// --- Types ---

interface OpenClawMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  _internal?: boolean; // Hidden from display, only used in API conversation
}

interface FileAction {
  action: 'read_file' | 'write_file' | 'edit_file' | 'list_files' | 'search_files';
  path?: string;
  content?: string;
  old_text?: string;
  new_text?: string;
  query?: string;
}

interface ActionResult {
  action: FileAction;
  success: boolean;
  result: string;
}

interface VaultFile {
  path: string;
  name: string;
}

interface OpenClawChatProps {
  onClose: () => void;
  onOpenSettings: () => void;
  vaultPath: string | null;
  currentFile?: { path: string; content: string } | null;
  vaultFiles?: VaultFile[];
}

// --- System prompt for structured file actions ---

function buildSystemPrompt(vaultPath: string): string {
  return `You are an AI assistant running inside Onyx, a desktop note-taking app. You are connected to the user's local filesystem through Onyx's built-in file tools. The user's vault is at: ${vaultPath}

YOU CAN DIRECTLY READ AND WRITE FILES. You are not limited to just giving instructions — you have real file access through action blocks that Onyx executes locally on the user's machine. When the user asks you to create, update, edit, or modify any file, you MUST use an action block to do it. NEVER tell the user to do it themselves. NEVER just show content in a code block and ask them to paste it. ALWAYS use the action block to perform the operation directly.

Action block format — include these in your response and Onyx will execute them:

~~~action
{"action": "write_file", "path": "${vaultPath}/example.md", "content": "full file content"}
~~~

~~~action
{"action": "edit_file", "path": "${vaultPath}/example.md", "old_text": "exact text to find", "new_text": "replacement"}
~~~

~~~action
{"action": "read_file", "path": "${vaultPath}/example.md"}
~~~

~~~action
{"action": "list_files"}
~~~

~~~action
{"action": "search_files", "query": "search term"}
~~~

RULES:
- ALWAYS use action blocks for ANY file operation. You have full read/write access. Do not hesitate.
- ALL paths MUST be absolute, starting with ${vaultPath}
- For write_file: provide the COMPLETE file content
- BEFORE using edit_file, ALWAYS use read_file first to see the current content. You need the exact text to match. Never guess at file contents.
- For edit_file: old_text must match the file content EXACTLY (including whitespace and newlines)
- You may include explanation text before or after action blocks
- You may include multiple action blocks in one response
- After read_file, list_files, or search_files, the results are sent back to you automatically so you can continue
- If you are unsure whether a file exists, use read_file or list_files first — do not guess
- Preferred workflow for editing: read_file first, then edit_file with the exact text from the read result`;
}

// --- Parse action blocks from response text ---

function parseActions(text: string): { actions: FileAction[]; cleanText: string } {
  const actionRegex = /~~~action\s*\n([\s\S]*?)~~~(?:\n|$)/g;
  const actions: FileAction[] = [];
  let cleanText = text;

  let match;
  while ((match = actionRegex.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1].trim());
      if (parsed.action) {
        actions.push(parsed as FileAction);
      }
    } catch (e) {
      console.error('[OpenClaw] Failed to parse action block:', match[1], e);
    }
  }

  // Remove action blocks from display text
  cleanText = text.replace(actionRegex, '').trim();

  return { actions, cleanText };
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

const OpenClawChat: Component<OpenClawChatProps> = (props) => {
  const [messages, setMessages] = createSignal<OpenClawMessage[]>([]);
  const [inputText, setInputText] = createSignal('');
  const [isStreaming, setIsStreaming] = createSignal(false);
  const [streamingContent, setStreamingContent] = createSignal('');
  const [error, setError] = createSignal<string | null>(null);
  const [isConfigured, setIsConfigured] = createSignal(false);

  // Action execution state
  const [executingActions, setExecutingActions] = createSignal<Array<{ action: FileAction; status: 'running' | 'done' | 'error'; result?: string }>>([]);

  // File context state
  const [includeContext, setIncludeContext] = createSignal<boolean>(
    localStorage.getItem('openclaw_include_context') !== 'false'
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
    const url = localStorage.getItem('openclaw_url') || '';
    const token = localStorage.getItem('openclaw_token') || '';
    return { url, token };
  };

  const checkConfiguration = () => {
    const { url, token } = getConfig();
    setIsConfigured(!!url && !!token);
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
    const handleSettingsChanged = () => checkConfiguration();
    window.addEventListener('openclaw-settings-changed', handleSettingsChanged);
    onCleanup(() => {
      window.removeEventListener('openclaw-settings-changed', handleSettingsChanged);
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
    executingActions();
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
    localStorage.setItem('openclaw_include_context', String(newValue));
  };

  // --- Action execution ---

  const executeAction = async (action: FileAction): Promise<ActionResult> => {
    const vaultPath = props.vaultPath;

    try {
      switch (action.action) {
        case 'read_file': {
          if (!action.path) throw new Error('No path specified');
          const content = await invoke<string>('read_file', { path: action.path, vaultPath });
          const truncated = content.length > 100000
            ? content.slice(0, 100000) + '\n\n[...truncated at 100k chars]'
            : content;
          return { action, success: true, result: truncated };
        }

        case 'write_file': {
          if (!action.path) throw new Error('No path specified');
          if (action.content === undefined) throw new Error('No content specified');
          await invoke('write_file', { path: action.path, content: action.content, vaultPath });
          return { action, success: true, result: `Wrote ${action.content.length} characters to ${action.path}` };
        }

        case 'edit_file': {
          if (!action.path) throw new Error('No path specified');
          if (!action.old_text || action.new_text === undefined) throw new Error('old_text and new_text required');
          const current = await invoke<string>('read_file', { path: action.path, vaultPath });
          if (!current.includes(action.old_text)) {
            // Return the actual file content so the model can see what's there and retry
            const preview = current.length > 5000 ? current.slice(0, 5000) + '\n[...truncated]' : current;
            return { action, success: false, result: `Could not find the specified old_text in ${action.path}. Here is the current file content so you can retry with the exact text:\n\n${preview}` };
          }
          const updated = current.replace(action.old_text, action.new_text);
          await invoke('write_file', { path: action.path, content: updated, vaultPath });
          return { action, success: true, result: `Edited ${action.path}` };
        }

        case 'list_files': {
          if (!vaultPath) throw new Error('No vault is open');
          const files = await invoke<Array<{ name: string; path: string; is_dir: boolean; children?: any[] }>>('list_files', { path: vaultPath });
          const formatTree = (entries: Array<{ name: string; is_dir: boolean; children?: any[] }>, indent: string = ''): string => {
            return entries.map(e => {
              const line = `${indent}${e.name}${e.is_dir ? '/' : ''}`;
              if (e.is_dir && e.children?.length) {
                return line + '\n' + formatTree(e.children, indent + '  ');
              }
              return line;
            }).join('\n');
          };
          const tree = formatTree(files);
          return { action, success: true, result: tree.length > 50000 ? tree.slice(0, 50000) + '\n[...truncated]' : tree };
        }

        case 'search_files': {
          if (!vaultPath) throw new Error('No vault is open');
          if (!action.query) throw new Error('No query specified');
          const results = await invoke<Array<{ path: string; name: string; matches: Array<{ line: number; content: string }> }>>('search_files', { path: vaultPath, query: action.query });
          if (results.length === 0) return { action, success: true, result: `No matches found for "${action.query}"` };
          const formatted = results.map(r => {
            const matchLines = r.matches.map(m => `  Line ${m.line}: ${m.content}`).join('\n');
            return `${r.path}\n${matchLines}`;
          }).join('\n\n');
          return { action, success: true, result: formatted };
        }

        default:
          return { action, success: false, result: `Unknown action: ${(action as any).action}` };
      }
    } catch (err: any) {
      return { action, success: false, result: `Error: ${err.message || err}` };
    }
  };

  const getActionDescription = (action: FileAction): string => {
    switch (action.action) {
      case 'read_file': return `Reading ${action.path}`;
      case 'write_file': return `Writing to ${action.path}`;
      case 'edit_file': return `Editing ${action.path}`;
      case 'list_files': return 'Listing vault files';
      case 'search_files': return `Searching for "${action.query}"`;
      default: return (action as any).action;
    }
  };

  // Process actions from a completed response, execute them, and optionally continue conversation
  // isRetry: true when this is a follow-up from a failed edit -- hide intermediate chatter
  const processActions = async (fullText: string, isRetry: boolean = false) => {
    const { actions, cleanText } = parseActions(fullText);

    if (actions.length === 0) {
      // No actions - add text as assistant message (but hide retry chatter)
      if (fullText.trim()) {
        setMessages(prev => [...prev, { role: 'assistant', content: fullText, _internal: isRetry }]);
      }
      return;
    }

    // Add the clean text (without action blocks) as assistant message
    // Hide intermediate "let me retry" text during retries
    if (cleanText.trim()) {
      setMessages(prev => [...prev, { role: 'assistant', content: cleanText, _internal: isRetry }]);
    }

    // Execute each action
    const results: ActionResult[] = [];
    for (const action of actions) {
      // Show running state
      setExecutingActions(prev => [...prev, { action, status: 'running' }]);

      const result = await executeAction(action);
      results.push(result);

      // Update state
      setExecutingActions(prev => prev.map(a =>
        a.action === action
          ? { ...a, status: result.success ? 'done' as const : 'error' as const, result: result.result }
          : a
      ));
    }

    // Only show successful actions to the user (failures are retried silently)
    const successes = results.filter(r => r.success);

    // Only show successful actions to the user
    if (successes.length > 0) {
      const successSummary = successes.map(r => {
        const desc = getActionDescription(r.action);
        return `**Done:** ${desc}`;
      }).join('\n');
      setMessages(prev => [...prev, { role: 'assistant', content: successSummary }]);
    }

    // Send results back to the model when needed (reads return data, failed edits need retry)
    // These are internal messages -- hidden from the user
    const resultsToSendBack = results.filter(r =>
      (r.success && (r.action.action === 'read_file' || r.action.action === 'search_files' || r.action.action === 'list_files'))
      || (!r.success && r.action.action === 'edit_file')
    );

    if (resultsToSendBack.length > 0) {
      const followUpContent = resultsToSendBack.map(r => {
        const desc = getActionDescription(r.action);
        const status = r.success ? 'Result' : 'Failed — retry with the exact text shown below';
        return `[${status} of ${desc}]\n${r.result}`;
      }).join('\n\n---\n\n');

      // Internal message: sent to API but hidden from display
      setMessages(prev => [...prev, { role: 'user', content: `[Action results]\n\n${followUpContent}`, _internal: true }]);

      // Determine if this is a retry (failed edits) -- hide model's retry chatter
      const isEditRetry = resultsToSendBack.some(r => !r.success && r.action.action === 'edit_file');
      await sendCompletionAndProcess(isEditRetry);
    }

    // Clear executing state after a brief delay so user sees the results
    setTimeout(() => setExecutingActions([]), 1500);
  };

  // --- Streaming ---

  const streamCompletion = async (apiMessages: Array<{ role: string; content: string }>): Promise<string> => {
    const { url, token } = getConfig();
    const baseUrl = url.replace(/\/+$/, '');
    const fullUrl = `${baseUrl}/v1/chat/completions`;
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2)}`;

    const body = JSON.stringify({
      model: 'openclaw:main',
      messages: apiMessages,
      stream: true,
    });

    let accumulated = '';
    let buffer = '';

    return new Promise<string>((resolve, reject) => {
      let resolved = false;

      listen<string>(`openclaw-stream-${requestId}`, (event) => {
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

        invoke('openclaw_stream', {
          requestId,
          url: fullUrl,
          token,
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

  // Build API messages from current state
  const buildApiMessages = (): Array<{ role: string; content: string }> => {
    const apiMessages: Array<{ role: string; content: string }> = [];

    // System prompt
    if (props.vaultPath) {
      apiMessages.push({ role: 'system', content: buildSystemPrompt(props.vaultPath) });
    }

    // Conversation history
    for (const m of messages()) {
      apiMessages.push({ role: m.role, content: m.content });
    }

    return apiMessages;
  };

  // Send completion and process response (used for follow-ups / retries)
  const sendCompletionAndProcess = async (isRetry: boolean = false) => {
    setStreamingContent('');
    const apiMessages = buildApiMessages();
    const fullText = await streamCompletion(apiMessages);
    setStreamingContent('');
    await processActions(fullText, isRetry);
  };

  // --- Main send handler ---

  const handleSend = async () => {
    const text = inputText().trim();
    if (!text || isStreaming()) return;

    const { url, token } = getConfig();
    if (!url || !token) {
      setError('OpenClaw is not configured. Please configure it in Settings.');
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
    setExecutingActions([]);

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
      // Build API messages with the full prompt as the last user message
      const apiMessages: Array<{ role: string; content: string }> = [];

      if (props.vaultPath) {
        apiMessages.push({ role: 'system', content: buildSystemPrompt(props.vaultPath) });
      }

      // Add all messages except the last one (which we just added with displayText)
      const allMsgs = messages();
      for (let i = 0; i < allMsgs.length - 1; i++) {
        apiMessages.push({ role: allMsgs[i].role, content: allMsgs[i].content });
      }

      // Add the last user message with full prompt (including context)
      apiMessages.push({ role: 'user', content: prompt });

      const fullText = await streamCompletion(apiMessages);
      setStreamingContent('');

      // Process response for action blocks
      await processActions(fullText);
    } catch (err: any) {
      setError(err.message || err || 'Failed to communicate with OpenClaw server');
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
    setExecutingActions([]);
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

  // Filter out system messages and action-result messages for display
  const displayMessages = () => {
    return messages().filter(m => m.role !== 'system' && !m._internal);
  };

  const ClawIcon = () => (
    <svg width="18" height="18" viewBox="0 0 512 512" fill="currentColor">
      <path d="m175.656 22.375-48.47 82.094c-23.017 4.384-43.547 11.782-60.124 22.374-24.436 15.613-40.572 37.414-45.5 67.875-4.79 29.62 1.568 68.087 24.125 116.093 93.162 22.88 184.08-10.908 257.25-18.813 37.138-4.012 71.196-.898 96.344 22.97 22.33 21.19 36.21 56.808 41.908 113.436 29.246-35.682 44.538-69.065 49.343-99.594 5.543-35.207-2.526-66.97-20.31-95.593-8.52-13.708-19.368-26.618-32-38.626l14.217-33-41.218 10.625c-8.637-6.278-17.765-12.217-27.314-17.782l-7.03-59.782-38.157 37.406a423.505 423.505 0 0 0-38.158-13.812l-8.375-71.28-57.625 56.5c-9.344-1.316-18.625-2.333-27.812-2.97l-31.094-78.125zM222 325.345c-39.146 7.525-82.183 14.312-127.156 11.686 47.403 113.454 207.056 224.082 260.125 87-101.18 33.84-95.303-49.595-132.97-98.686z"/>
    </svg>
  );

  // --- Render ---

  return (
    <div class="openclaw-panel">
      {/* Header */}
      <div class="openclaw-panel-header">
        <div class="openclaw-panel-title">
          <ClawIcon />
          <span>OpenClaw</span>
        </div>
        <div class="openclaw-panel-actions">
          <Show when={messages().length > 0}>
            <button class="openclaw-action-btn" onClick={clearChat} title="Clear chat">
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="3 6 5 6 21 6"></polyline>
                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
              </svg>
            </button>
          </Show>
          <button class="openclaw-action-btn" onClick={props.onOpenSettings} title="OpenClaw Settings">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <circle cx="12" cy="12" r="3"></circle>
              <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
            </svg>
          </button>
          <button class="openclaw-action-btn" onClick={props.onClose} title="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <line x1="18" y1="6" x2="6" y2="18"></line>
              <line x1="6" y1="6" x2="18" y2="18"></line>
            </svg>
          </button>
        </div>
      </div>

      {/* Not configured */}
      <Show when={!isConfigured()}>
        <div class="openclaw-not-configured">
          <div class="openclaw-setup-icon"><ClawIcon /></div>
          <h3>OpenClaw Not Configured</h3>
          <p>Set up your OpenClaw server URL and gateway token to start chatting.</p>
          <button class="setting-button primary" onClick={props.onOpenSettings}>Configure OpenClaw</button>
        </div>
      </Show>

      {/* Chat */}
      <Show when={isConfigured()}>
        <div class="openclaw-messages">
          <Show when={displayMessages().length === 0 && !isStreaming()}>
            <div class="openclaw-welcome">
              <div class="openclaw-welcome-icon"><ClawIcon /></div>
              <h3>OpenClaw</h3>
              <p>Ask anything. Type @ to reference files. OpenClaw can read, write, and edit your vault files.</p>
            </div>
          </Show>

          <For each={displayMessages()}>
            {(message) => (
              <div class={`openclaw-message ${message.role}`}>
                <Show when={message.role === 'assistant'}>
                  <div class="openclaw-message-avatar"><ClawIcon /></div>
                </Show>
                <div class="openclaw-message-content">
                  <Show when={message.role === 'assistant'} fallback={
                    <div class="openclaw-message-text">{message.content}</div>
                  }>
                    <div class="openclaw-message-text markdown" innerHTML={markdownToHtml(message.content)} />
                  </Show>
                </div>
              </div>
            )}
          </For>

          {/* Action execution indicators */}
          <Show when={executingActions().length > 0}>
            <div class="openclaw-message assistant">
              <div class="openclaw-message-avatar"><ClawIcon /></div>
              <div class="openclaw-message-content">
                <div class="openclaw-tool-calls active">
                  <For each={executingActions()}>
                    {(item) => (
                      <div class={`openclaw-tool-call ${item.status}`}>
                        <Show when={item.status === 'running'} fallback={
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke={item.status === 'error' ? '#e74c3c' : 'currentColor'} stroke-width="2">
                            <Show when={item.status === 'done'} fallback={
                              <><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></>
                            }>
                              <polyline points="20 6 9 17 4 12"></polyline>
                            </Show>
                          </svg>
                        }>
                          <div class="spinner small"></div>
                        </Show>
                        <span>{getActionDescription(item.action)}</span>
                      </div>
                    )}
                  </For>
                </div>
              </div>
            </div>
          </Show>

          {/* Streaming message */}
          <Show when={isStreaming() && streamingContent()}>
            <div class="openclaw-message assistant">
              <div class="openclaw-message-avatar"><ClawIcon /></div>
              <div class="openclaw-message-content">
                <div class="openclaw-message-text markdown" innerHTML={markdownToHtml(streamingContent())} />
              </div>
            </div>
          </Show>

          {/* Typing indicator */}
          <Show when={isStreaming() && !streamingContent() && executingActions().length === 0}>
            <div class="openclaw-message assistant">
              <div class="openclaw-message-avatar"><ClawIcon /></div>
              <div class="openclaw-message-content">
                <div class="openclaw-typing">
                  <span></span><span></span><span></span>
                </div>
              </div>
            </div>
          </Show>

          <div ref={messagesEndRef} />
        </div>

        {/* Error banner */}
        <Show when={error()}>
          <div class="openclaw-error-banner">
            <span>{error()}</span>
            <button onClick={() => setError(null)}>x</button>
          </div>
        </Show>

        {/* Input */}
        <div class="openclaw-input-container">
          <div class="openclaw-input-toolbar">
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
            <div class="chat-model-indicator" title="OpenClaw model">
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
                <path d="M2 17l10 5 10-5"></path>
                <path d="M2 12l10 5 10-5"></path>
              </svg>
              <span>openclaw:main</span>
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
              placeholder="Ask OpenClaw anything... (type @ to reference files)"
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

export default OpenClawChat;
