/**
 * OpenCodeChat - Chat interface for OpenCode AI assistant
 */

import { Component, createSignal, createEffect, onMount, onCleanup, For, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-shell';
import {
  initClient,
  isServerRunning,
  createSession,
  getSessionMessages,
  sendPromptAsync,
  subscribeToEvents,
  abortSession,
  getCurrentModel,
  type ChatMessage,
  type MessagePart,
  type SessionInfo,
} from '../lib/opencode/client';
import { getCurrentLogin, getSavedProfile, type UserProfile } from '../lib/nostr/login';
import { sanitizeImageUrl } from '../lib/security';

/**
 * Convert markdown to HTML for chat display
 */
function markdownToHtml(markdown: string): string {
  let html = markdown
    // Escape HTML first
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
  
  // Code blocks (must be before inline code)
  html = html.replace(/```(\w*)\n([\s\S]*?)```/g, (_match, lang, code) => {
    const langClass = lang ? ` class="language-${lang}"` : '';
    return `<pre><code${langClass}>${code.trim()}</code></pre>`;
  });
  
  // Inline code
  html = html.replace(/`([^`]+)`/g, '<code>$1</code>');
  
  // Headers
  html = html.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  html = html.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  html = html.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  
  // Bold and italic
  html = html.replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>');
  html = html.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  html = html.replace(/\*(.+?)\*/g, '<em>$1</em>');
  
  // Links
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
  
  // Unordered lists
  html = html.replace(/^[\-\*] (.+)$/gm, '<li>$1</li>');
  html = html.replace(/(<li>.*<\/li>\n?)+/g, '<ul>$&</ul>');
  
  // Ordered lists
  html = html.replace(/^\d+\. (.+)$/gm, '<li>$1</li>');
  
  // Paragraphs - wrap remaining text blocks
  html = html.replace(/\n\n+/g, '</p><p>');
  html = html.replace(/\n/g, '<br>');
  
  // Wrap in paragraph if not already wrapped in block element
  if (!html.startsWith('<')) {
    html = '<p>' + html + '</p>';
  }
  
  // Clean up empty paragraphs
  html = html.replace(/<p>\s*<\/p>/g, '');
  html = html.replace(/<p>(<(?:pre|ul|ol|h[1-6]|blockquote))/g, '$1');
  html = html.replace(/(<\/(?:pre|ul|ol|h[1-6]|blockquote)>)<\/p>/g, '$1');
  
  return html;
}

interface OpenCodeChatProps {
  vaultPath: string | null;
  currentFile?: { path: string; content: string } | null;
}

const OpenCodeChat: Component<OpenCodeChatProps> = (props) => {
  const [messages, setMessages] = createSignal<ChatMessage[]>([]);
  const [inputText, setInputText] = createSignal('');
  const [isLoading, setIsLoading] = createSignal(false);
  const [isStreaming, setIsStreaming] = createSignal(false);
  const [session, setSession] = createSignal<SessionInfo | null>(null);
  const [serverStatus, setServerStatus] = createSignal<'checking' | 'running' | 'starting' | 'not-installed' | 'error'>('checking');
  const [error, setError] = createSignal<string | null>(null);
  const [streamingContent, setStreamingContent] = createSignal<string>('');
  const [lastSentMessage, setLastSentMessage] = createSignal<string>('');
  const [includeContext, setIncludeContext] = createSignal<boolean>(
    localStorage.getItem('opencode_include_context') !== 'false' // Default to true
  );
  const [userProfile, setUserProfile] = createSignal<UserProfile | null>(null);
  const [currentModel, setCurrentModel] = createSignal<string | null>(null);
  
  // Format model name for display (e.g., "anthropic/claude-3-5-sonnet" -> "Claude 3.5 Sonnet")
  const displayModelName = () => {
    const model = currentModel();
    if (!model) return 'Using default model';
    
    // Extract model ID (after the provider/)
    const parts = model.split('/');
    const modelId = parts.length > 1 ? parts.slice(1).join('/') : model;
    
    // Clean up common model name patterns
    return modelId
      .replace(/-/g, ' ')
      .replace(/\./g, '.')
      .replace(/\b\w/g, c => c.toUpperCase()) // Capitalize words
      .replace(/(\d+) (\d+)/g, '$1.$2') // "3 5" -> "3.5"
      .replace(/Latest/gi, '')
      .trim();
  };

  let messagesEndRef: HTMLDivElement | undefined;
  let inputRef: HTMLTextAreaElement | undefined;
  let eventCleanup: (() => void) | null = null;

  // Scroll to bottom when messages change
  createEffect(() => {
    messages(); // Track messages
    streamingContent(); // Track streaming content
    messagesEndRef?.scrollIntoView({ behavior: 'smooth' });
  });

  // Check server status and start if needed
  const checkAndStartServer = async () => {
    setServerStatus('checking');
    
    try {
      initClient();
      const running = await isServerRunning();
      
      if (running) {
        setServerStatus('running');
        await initializeSession();
      } else {
        setServerStatus('starting');
        await startOpenCodeServer();
      }
    } catch (err) {
      console.error('[OpenCodeChat] Failed to check server status:', err);
      setServerStatus('not-installed');
    }
  };

  // Start the OpenCode server in the background
  const startOpenCodeServer = async () => {
    try {
      // Get custom OpenCode path from settings
      const customPath = localStorage.getItem('opencode_path');
      const openCodeCommand = customPath && customPath.trim() ? customPath.trim() : 'opencode';
      
      // Start opencode serve in the background via Tauri
      await invoke('start_opencode_server', {
        command: openCodeCommand,
        cwd: props.vaultPath || undefined,
        port: 4096,
      });
      
      // Wait a bit for server to start
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Check if it's running now
      const running = await isServerRunning();
      if (running) {
        setServerStatus('running');
        await initializeSession();
      } else {
        // Try a few more times
        for (let i = 0; i < 5; i++) {
          await new Promise(resolve => setTimeout(resolve, 1000));
          const isRunning = await isServerRunning();
          if (isRunning) {
            setServerStatus('running');
            await initializeSession();
            return;
          }
        }
        setServerStatus('error');
        setError('OpenCode server started but not responding');
      }
    } catch (err) {
      console.error('Failed to start OpenCode server:', err);
      const errorStr = String(err).toLowerCase();
      if (errorStr.includes('not found') || errorStr.includes('no such file')) {
        setServerStatus('not-installed');
      } else {
        setServerStatus('error');
        setError(String(err));
      }
    }
  };

  // Initialize or resume a session
  const initializeSession = async () => {
    try {
      const newSession = await createSession('Onyx Chat');
      setSession(newSession);
      
      // Load any existing messages
      const existingMessages = await getSessionMessages(newSession.id);
      setMessages(existingMessages);
      
      // Load current model from localStorage
      const model = getCurrentModel();
      setCurrentModel(model);
      
      // Subscribe to events
      eventCleanup = await subscribeToEvents(handleServerEvent, handleEventError);
    } catch (err) {
      console.error('[OpenCodeChat] Failed to initialize session:', err);
      setError('Failed to create chat session');
    }
  };

  // Handle server-sent events
  const handleServerEvent = (event: { type: string; properties: Record<string, unknown> }) => {
    const currentSessionId = session()?.id;
    
    // Extract session ID from various possible locations in the event
    const eventSessionId = (event.properties?.sessionID || event.properties?.session_id || event.properties?.id) as string | undefined;
    
    switch (event.type) {
      case 'message.part.updated': {
        // The delta text comes directly in properties.delta
        const delta = event.properties?.delta as string | undefined;
        const part = event.properties?.part as { type?: string; text?: string } | undefined;
        
        // Only process if we have actual delta content
        if (!delta && !(part?.type === 'text' && part?.text)) {
          break;
        }
        
        if (delta) {
          const lastSent = lastSentMessage();
          const currentStreaming = streamingContent();
          
          // If we haven't started streaming yet and this looks like user message echo, skip
          if (lastSent && currentStreaming === '') {
            // Check if delta starts the user's message
            if (lastSent.startsWith(delta) || delta === lastSent) {
              // Mark that we're in echo phase by setting a marker
              setStreamingContent('\x00ECHO\x00' + delta);
              break;
            }
          }
          
          // If we're in echo phase, check if we're still echoing
          if (currentStreaming.startsWith('\x00ECHO\x00')) {
            const echoContent = currentStreaming.slice(7); // Remove marker
            const newEchoContent = echoContent + delta;
            
            // Still echoing?
            if (lastSent.startsWith(newEchoContent) || newEchoContent === lastSent) {
              setStreamingContent('\x00ECHO\x00' + newEchoContent);
              break;
            } else {
              // Echo phase is over, this is real assistant content
              // Clear the echo and start fresh with this delta
              setStreamingContent(delta);
              setLastSentMessage(''); // Clear tracking
              break;
            }
          }
          
          // Normal streaming - append delta
          setStreamingContent(prev => prev + delta);
        } else if (part?.type === 'text' && part?.text) {
          const lastSent = lastSentMessage();
          // Skip if this is just the user message
          if (lastSent && part.text.trim() === lastSent.trim()) {
            break;
          }
          setStreamingContent(part.text);
        }
        break;
      }
      
      case 'session.status': {
        const status = event.properties?.status as { type?: string } | undefined;
        if (eventSessionId === currentSessionId && status?.type === 'idle') {
          setIsStreaming(false);
          setIsLoading(false);
          setStreamingContent('');
          refreshMessages();
        }
        break;
      }
      
      case 'session.updated': {
        // Don't refresh on every update - wait for idle
        break;
      }
      
      case 'session.idle': {
        if (!eventSessionId || eventSessionId === currentSessionId) {
          setIsStreaming(false);
          setIsLoading(false);
          setStreamingContent('');
          refreshMessages();
        }
        break;
      }
      
      case 'session.error': {
        const errorMsg = (event.properties?.error || event.properties?.message) as string | undefined;
        if (!eventSessionId || eventSessionId === currentSessionId) {
          setIsStreaming(false);
          setIsLoading(false);
          setError(errorMsg || 'An error occurred');
        }
        break;
      }
      
      // Config updated - refresh model from localStorage
      case 'config.updated': {
        setCurrentModel(getCurrentModel());
        break;
      }
      
      // Ignore these events
      case 'server.connected':
      case 'server.heartbeat':
      case 'session.created':
      case 'session.diff':
      case 'message.updated':
        break;
    }
  };

  const handleEventError = (err: Error) => {
    console.error('Event stream error:', err);
    // Try to reconnect
    setTimeout(async () => {
      if (session()) {
        eventCleanup = await subscribeToEvents(handleServerEvent, handleEventError);
      }
    }, 2000);
  };

  // Strip context from a message's text parts
  const stripContextFromMessage = (msg: ChatMessage): ChatMessage => {
    if (msg.role !== 'user') return msg;
    
    return {
      ...msg,
      parts: msg.parts.map(part => {
        if (part.type !== 'text') return part;
        
        const originalText = part.text;
        let displayText = originalText;
        
        // Check if this message has our context prefix
        if (displayText.startsWith('[Context: Working on "')) {
          // Find the separator and extract just the user's question after it
          const separatorIndex = displayText.indexOf('\n\n---\n\n');
          if (separatorIndex !== -1) {
            displayText = displayText.slice(separatorIndex + 7); // 7 = length of '\n\n---\n\n'
            console.log('[OpenCodeChat] Stripped context, before:', originalText.slice(0, 100), '... after:', displayText);
          }
        }
        
        return { ...part, text: displayText };
      })
    };
  };

  // Refresh messages from server
  const refreshMessages = async () => {
    const sessionId = session()?.id;
    if (!sessionId) return;
    
    try {
      const msgs = await getSessionMessages(sessionId);
      // Strip context prefix from user messages for display
      const cleanedMsgs = msgs.map(stripContextFromMessage);
      setMessages(cleanedMsgs);
    } catch (err) {
      console.error('Failed to refresh messages:', err);
    }
  };

  // Send a message
  const handleSend = async () => {
    const text = inputText().trim();
    const sessionId = session()?.id;
    
    if (!text || !sessionId || isLoading()) return;
    
    setInputText('');
    setError(null);
    setStreamingContent(''); // Clear any previous streaming content
    setIsLoading(true);
    setIsStreaming(true);
    
    // Add user message immediately (just the text, not the context)
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text }],
      timestamp: Date.now(),
    };
    setMessages(prev => [...prev, userMessage]);
    
    try {
      // Build prompt with optional context
      let prompt = text;
      const file = props.currentFile;
      
      // Include file context if toggle is on and we have a file open
      if (file && includeContext()) {
        const filename = file.path.split('/').pop() || file.path;
        prompt = `[Context: Working on "${filename}"]\n\n${file.content}\n\n---\n\n${text}`;
      }
      
      // Track the full prompt to filter echoes (including context)
      setLastSentMessage(prompt);
      
      // Get selected model from localStorage
      const selectedModel = getCurrentModel();
      
      await sendPromptAsync(sessionId, prompt, selectedModel || undefined);
    } catch (err) {
      console.error('[OpenCodeChat] Failed to send message:', err);
      setError('Failed to send message');
      setIsLoading(false);
      setIsStreaming(false);
    }
  };

  // Handle keyboard shortcuts
  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    if (e.key === 'Escape' && isStreaming()) {
      handleAbort();
    }
  };

  // Abort current operation
  const handleAbort = async () => {
    const sessionId = session()?.id;
    if (!sessionId) return;
    
    try {
      await abortSession(sessionId);
      setIsStreaming(false);
      setIsLoading(false);
    } catch (err) {
      console.error('Failed to abort:', err);
    }
  };

  // Auto-resize textarea
  const handleInput = (e: Event) => {
    const target = e.target as HTMLTextAreaElement;
    setInputText(target.value);
    target.style.height = 'auto';
    target.style.height = Math.min(target.scrollHeight, 200) + 'px';
  };

  // Toggle context inclusion
  const toggleContext = () => {
    const newValue = !includeContext();
    setIncludeContext(newValue);
    localStorage.setItem('opencode_include_context', String(newValue));
  };

  // Clear chat and start a new session
  const clearChat = async () => {
    setMessages([]);
    setStreamingContent('');
    setError(null);
    setIsLoading(false);
    setIsStreaming(false);
    
    // Create a new session
    try {
      const newSession = await createSession('Onyx Chat');
      setSession(newSession);
    } catch (err) {
      console.error('Failed to create new session:', err);
      setError('Failed to clear chat');
    }
  };

  onMount(async () => {
    // Load user profile if logged in
    const login = await getCurrentLogin();
    if (login) {
      const profile = await getSavedProfile();
      if (profile) {
        setUserProfile(profile);
      }
    }
    
    checkAndStartServer();
    inputRef?.focus();
  });

  onCleanup(() => {
    eventCleanup?.();
  });

  // Check if a message has any visible content
  const hasVisibleContent = (message: ChatMessage): boolean => {
    return message.parts.some(part => {
      if (part.type === 'text') {
        return part.text && part.text.trim() !== '';
      }
      if (part.type === 'tool-call' || part.type === 'tool-result') {
        return true; // Tool calls/results are always visible
      }
      return false;
    });
  };

  // Render a message part
  const renderPart = (part: MessagePart, _index: number, role: 'user' | 'assistant') => {
    if (part.type === 'text') {
      // Skip empty text parts
      if (!part.text || part.text.trim() === '') {
        return null;
      }
      // Render markdown for assistant messages, plain text for user
      if (role === 'assistant') {
        return <div class="chat-message-text markdown" innerHTML={markdownToHtml(part.text)} />;
      }
      return <div class="chat-message-text">{part.text}</div>;
    }
    
    if (part.type === 'tool-call') {
      return (
        <div class="chat-tool-call">
          <div class="tool-call-header">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z"></path>
            </svg>
            <span class="tool-name">{part.toolName}</span>
          </div>
        </div>
      );
    }
    
    if (part.type === 'tool-result') {
      return (
        <div class="chat-tool-result">
          <div class="tool-result-header">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
            <span>{part.toolName} completed</span>
          </div>
        </div>
      );
    }
    
    return null;
  };

  return (
    <div class="opencode-chat">
      {/* Not Installed State */}
      <Show when={serverStatus() === 'not-installed'}>
        <div class="opencode-chat-empty">
          <div class="opencode-not-installed-icon">
            <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
              <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
              <polyline points="7.5 4.21 12 6.81 16.5 4.21"></polyline>
              <polyline points="7.5 19.79 7.5 14.6 3 12"></polyline>
              <polyline points="21 12 16.5 14.6 16.5 19.79"></polyline>
              <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
              <line x1="12" y1="22.08" x2="12" y2="12"></line>
            </svg>
          </div>
          <h3>OpenCode Not Installed</h3>
          <p>OpenCode is an AI coding assistant that helps you write and edit code directly in your vault.</p>
          <button
            class="opencode-install-btn"
            onClick={() => open('https://opencode.ai/download')}
          >
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
              <polyline points="7 10 12 15 17 10"></polyline>
              <line x1="12" y1="15" x2="12" y2="3"></line>
            </svg>
            Download OpenCode
          </button>
          <button class="opencode-retry-btn" onClick={checkAndStartServer}>
            I've installed it - try again
          </button>
        </div>
      </Show>

      {/* Checking/Starting State */}
      <Show when={serverStatus() === 'checking' || serverStatus() === 'starting'}>
        <div class="opencode-chat-loading">
          <div class="spinner"></div>
          <span>{serverStatus() === 'checking' ? 'Connecting to OpenCode...' : 'Starting OpenCode...'}</span>
        </div>
      </Show>

      {/* Error State */}
      <Show when={serverStatus() === 'error'}>
        <div class="opencode-chat-error">
          <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
            <circle cx="12" cy="12" r="10"></circle>
            <line x1="15" y1="9" x2="9" y2="15"></line>
            <line x1="9" y1="9" x2="15" y2="15"></line>
          </svg>
          <h3>Connection Error</h3>
          <p>{error() || 'Failed to connect to OpenCode'}</p>
          <button class="opencode-retry-btn" onClick={checkAndStartServer}>
            Try Again
          </button>
        </div>
      </Show>

      {/* Chat Interface */}
      <Show when={serverStatus() === 'running'}>
        {/* Messages */}
        <div class="opencode-chat-messages">
          <Show when={messages().length === 0 && !isStreaming()}>
            <div class="opencode-chat-welcome">
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"></path>
              </svg>
              <h3>How can I help?</h3>
              <p>Ask me to help with writing, planning, brainstorming, or organizing your notes.</p>
            </div>
          </Show>

          <For each={messages().filter(hasVisibleContent)}>
            {(message) => (
              <div class={`chat-message ${message.role}`}>
                <div class="chat-message-avatar">
                  <Show when={message.role === 'user'} fallback={
                    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
                    </svg>
                  }>
                    <Show when={sanitizeImageUrl(userProfile()?.picture)} fallback={
                      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"></path>
                        <circle cx="12" cy="7" r="4"></circle>
                      </svg>
                    }>
                      <img 
                        src={sanitizeImageUrl(userProfile()!.picture)!} 
                        alt="" 
                        class="chat-avatar-img" 
                      />
                    </Show>
                  </Show>
                </div>
                <div class="chat-message-content">
                  <For each={message.parts}>
                    {(part, index) => renderPart(part, index(), message.role)}
                  </For>
                </div>
              </div>
            )}
          </For>

          {/* Streaming indicator */}
          <Show when={isStreaming()}>
            <div class="chat-message assistant streaming">
              <div class="chat-message-avatar">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
                </svg>
              </div>
              <div class="chat-message-content">
                {/* Only show actual content, not echo marker content */}
                <Show when={streamingContent().length > 0 && !streamingContent().startsWith('\x00ECHO\x00')} fallback={
                  <div class="typing-indicator">
                    <span></span>
                    <span></span>
                    <span></span>
                  </div>
                }>
                  <div class="chat-message-text markdown" innerHTML={markdownToHtml(streamingContent())} />
                </Show>
              </div>
            </div>
          </Show>

          <div ref={messagesEndRef} />
        </div>

        {/* Error banner */}
        <Show when={error()}>
          <div class="opencode-chat-error-banner">
            <span>{error()}</span>
            <button onClick={() => setError(null)}>×</button>
          </div>
        </Show>

        {/* Input */}
        <div class="opencode-chat-input-container">
          <div class="chat-input-toolbar">
            <Show when={props.currentFile}>
              <button 
                class={`chat-context-toggle ${includeContext() ? 'active' : ''}`}
                onClick={toggleContext}
                title={includeContext() ? 'Document context included - click to disable' : 'Document context not included - click to enable'}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                  <polyline points="14 2 14 8 20 8"></polyline>
                </svg>
                <span>{props.currentFile!.path.split('/').pop()}</span>
                <Show when={includeContext()}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3">
                    <polyline points="20 6 9 17 4 12"></polyline>
                  </svg>
                </Show>
              </button>
            </Show>
            <Show when={messages().length > 0}>
              <button 
                class="chat-clear-btn"
                onClick={clearChat}
                title="Clear chat and start new conversation"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <polyline points="3 6 5 6 21 6"></polyline>
                  <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                </svg>
                <span>Clear</span>
              </button>
            </Show>
            {/* Model indicator - pushed to the right */}
            <div class="chat-model-indicator" title={currentModel() ? `Model: ${currentModel()}` : 'Using OpenCode default model'}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 2L2 7l10 5 10-5-10-5z"></path>
                <path d="M2 17l10 5 10-5"></path>
                <path d="M2 12l10 5 10-5"></path>
              </svg>
              <span>{displayModelName()}</span>
            </div>
          </div>
          <div class="chat-input-wrapper">
            <textarea
              ref={inputRef}
              class="chat-input"
              placeholder="Ask OpenCode anything..."
              value={inputText()}
              onInput={handleInput}
              onKeyDown={handleKeyDown}
              disabled={isLoading() && !isStreaming()}
              rows={1}
            />
            <Show when={isStreaming()} fallback={
              <button 
                class="chat-send-btn" 
                onClick={handleSend}
                disabled={!inputText().trim() || isLoading()}
                title="Send (Enter)"
              >
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <line x1="22" y1="2" x2="11" y2="13"></line>
                  <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
                </svg>
              </button>
            }>
              <button 
                class="chat-abort-btn" 
                onClick={handleAbort}
                title="Stop (Escape)"
              >
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

export default OpenCodeChat;
