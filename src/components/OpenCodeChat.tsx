/**
 * OpenCodeChat - Chat interface for OpenCode AI assistant
 */

import { Component, createSignal, createEffect, onMount, onCleanup, For, Show } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-shell';
import {
  initClient,
  isServerRunning,
  createSession,
  getSessionMessages,
  sendPromptAsync,
  subscribeToEvents,
  abortSession,
  respondToQuestion,
  respondToToolPermission,
  getCurrentModel,
  type ChatMessage,
  type MessagePart,
  type SessionInfo,
  type ActiveTool,
  type ToolStatus,
  type Question,
  type ToolPermission,
} from '../lib/opencode/client';
import { getCurrentLogin, getSavedProfile, type UserProfile } from '../lib/nostr/login';
import { sanitizeImageUrl, sanitizeUrl } from '../lib/security';

// Install progress payload from Rust backend
interface InstallProgress {
  stage: 'checking' | 'downloading' | 'extracting' | 'configuring' | 'complete' | 'error';
  progress: number;
  bytes_downloaded?: number;
  total_bytes?: number;
  message: string;
}

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
  
  // Links - sanitize URLs to prevent javascript: and other dangerous protocols
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_match, text, url) => {
    const safeUrl = sanitizeUrl(url);
    return `<a href="${safeUrl}" target="_blank" rel="noopener noreferrer">${text}</a>`;
  });
  
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

interface VaultFile {
  path: string;
  name: string;
}

interface OpenCodeChatProps {
  vaultPath: string | null;
  currentFile?: { path: string; content: string } | null;
  vaultFiles?: VaultFile[];
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
  
  // Installer state
  const [isInstalling, setIsInstalling] = createSignal(false);
  const [installProgress, setInstallProgress] = createSignal<InstallProgress | null>(null);
  const [installError, setInstallError] = createSignal<string | null>(null);
  
  // Track if we've already sent context for the current file in this session
  // We track both the path and a hash of the content so we re-send if the file changed
  const [contextSentForFile, setContextSentForFile] = createSignal<string | null>(null);
  
  // Lazy loading: only show recent messages initially
  const INITIAL_MESSAGES_SHOWN = 50;
  const [showAllMessages, setShowAllMessages] = createSignal(false);
  
  // Active tools being executed (for real-time display)
  const [activeTools, setActiveTools] = createSignal<ActiveTool[]>([]);
  
  // Session status for retry/busy states
  const [sessionStatus, setSessionStatus] = createSignal<{ type: 'idle' | 'busy' | 'retry'; message?: string; attempt?: number } | null>(null);
  
  // @file mention autocomplete state
  const [mentionedFiles, setMentionedFiles] = createSignal<VaultFile[]>([]);
  const [showFilePicker, setShowFilePicker] = createSignal(false);
  const [fileSearchQuery, setFileSearchQuery] = createSignal('');
  const [selectedFileIndex, setSelectedFileIndex] = createSignal(0);
  
  // Active question from OpenCode (permission.updated event)
  const [activeQuestion, setActiveQuestion] = createSignal<Question | null>(null);
  const [selectedAnswers, setSelectedAnswers] = createSignal<Set<string>>(new Set());
  const [customAnswer, setCustomAnswer] = createSignal('');
  
  // Tool permission requests (file edits, bash commands, etc.)
  const [activePermission, setActivePermission] = createSignal<ToolPermission | null>(null);
  
  // Simple hash function for detecting content changes
  const hashContent = (content: string): string => {
    let hash = 0;
    for (let i = 0; i < content.length; i++) {
      const char = content.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash; // Convert to 32-bit integer
    }
    return hash.toString(16);
  };
  
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
    // Clear any previous install errors when retrying
    setInstallError(null);
    
    try {
      initClient();
      const running = await isServerRunning();
      
      if (running) {
        setServerStatus('running');
        await initializeSession();
      } else {
        // Check if OpenCode is installed (including auto-detection)
        let opencodePath = localStorage.getItem('opencode_path');
        
        if (!opencodePath) {
          // Try to auto-detect OpenCode installation
          try {
            const detectedPath = await invoke<string | null>('check_opencode_installed');
            if (detectedPath) {
              opencodePath = detectedPath;
              localStorage.setItem('opencode_path', detectedPath);
              console.log('[OpenCodeChat] Auto-detected OpenCode at:', detectedPath);
            }
          } catch (err) {
            console.log('[OpenCodeChat] Could not auto-detect OpenCode:', err);
          }
        }
        
        if (opencodePath || await commandExists('opencode')) {
          setServerStatus('starting');
          await startOpenCodeServer();
        } else {
          setServerStatus('not-installed');
        }
      }
    } catch (err) {
      console.error('[OpenCodeChat] Failed to check server status:', err);
      setServerStatus('not-installed');
    }
  };
  
  // Check if a command exists in PATH
  const commandExists = async (_cmd: string): Promise<boolean> => {
    try {
      const result = await invoke<string | null>('check_opencode_installed');
      return result !== null;
    } catch {
      return false;
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
        const part = event.properties?.part as { type?: string; text?: string; tool?: string; state?: { status?: string; title?: string }; callID?: string; id?: string } | undefined;
        
        // Handle tool part updates (for showing active tools)
        if (part?.type === 'tool' && part.tool) {
          const toolStatus = (part.state?.status || 'pending') as ToolStatus;
          const toolId = part.id || part.callID || '';
          const toolName = part.tool;
          const title = part.state?.title;
          
          // Note: Question handling is done via the 'question.asked' event, not here.
          // The 'message.part.updated' event for the question tool doesn't contain
          // the proper requestId needed to respond to questions.
          // Question clearing is handled by 'question.replied' / 'question.rejected' events.
          
          setActiveTools(prev => {
            // Remove completed/error tools, update or add others
            if (toolStatus === 'completed' || toolStatus === 'error') {
              return prev.filter(t => t.id !== toolId);
            }
            
            const existing = prev.find(t => t.id === toolId);
            if (existing) {
              return prev.map(t => t.id === toolId ? { ...t, status: toolStatus, title } : t);
            }
            
            return [...prev, {
              id: toolId,
              callId: part.callID || '',
              toolName,
              status: toolStatus,
              title,
              startTime: Date.now(),
            }];
          });
          break;
        }
        
        // Only process if we have actual delta content for text
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
        const status = event.properties?.status as { type?: string; message?: string; attempt?: number } | undefined;
        if (eventSessionId === currentSessionId) {
          if (status?.type === 'idle') {
            setIsStreaming(false);
            setIsLoading(false);
            setStreamingContent('');
            setActiveTools([]);
            setSessionStatus(null);
            refreshMessages();
          } else if (status?.type === 'busy') {
            setSessionStatus({ type: 'busy' });
          } else if (status?.type === 'retry') {
            setSessionStatus({ 
              type: 'retry', 
              message: status.message,
              attempt: status.attempt 
            });
          }
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
          setActiveTools([]);
          setSessionStatus(null);
          refreshMessages();
        }
        break;
      }
      
      case 'session.error': {
        const errorMsg = (event.properties?.error || event.properties?.message) as string | undefined;
        if (!eventSessionId || eventSessionId === currentSessionId) {
          setIsStreaming(false);
          setIsLoading(false);
          setActiveTools([]);
          setSessionStatus(null);
          setError(errorMsg || 'An error occurred');
        }
        break;
      }
      
      // Config updated - refresh model from localStorage
      case 'config.updated': {
        setCurrentModel(getCurrentModel());
        break;
      }
      
      // Permission/Question from OpenCode (v1 API)
      case 'permission.updated': {
        const permission = event.properties as {
          id?: string;
          sessionID?: string;
          type?: string;
          title?: string;
          metadata?: Record<string, unknown>;
        };
        
        
        
        // Only handle permissions for our session
        if (permission.sessionID !== currentSessionId) break;
        
        // Check if this is a question (from the question tool)
        const metadata = permission.metadata || {};
        const questions = metadata.questions as Array<{
          question?: string;
          header?: string;
          options?: Array<{ label?: string; description?: string }>;
          multiple?: boolean;
        }> | undefined;
        
        if (questions && questions.length > 0) {
          const q = questions[0]; // Handle first question
          setActiveQuestion({
            requestId: permission.id || '', // v1 API uses permission.id as the request ID
            sessionId: permission.sessionID || '',
            header: q.header,
            question: q.question || permission.title || 'OpenCode needs your input',
            options: (q.options || []).map(o => ({
              label: o.label || '',
              description: o.description,
            })),
            multiple: q.multiple,
            custom: metadata.custom !== false, // Default to allowing custom input
          });
          setSelectedAnswers(new Set<string>());
          setCustomAnswer('');
        } else {
          // This is a tool permission (file edit, bash, etc.)
          const permType = permission.type || 'unknown';
          
          // Extract details from metadata based on permission type
          let filePath: string | undefined;
          let command: string | undefined;
          let description: string | undefined;
          const remember = metadata.remember as string[] | undefined;
          
          if (permType === 'edit' || permType === 'write' || permType === 'read') {
            filePath = metadata.path as string || metadata.filePath as string;
            description = `${permType === 'read' ? 'Read' : 'Edit'} file: ${filePath}`;
          } else if (permType === 'bash') {
            command = metadata.command as string || metadata.input as string;
            description = `Run command: ${command}`;
          } else if (permType === 'external_directory') {
            filePath = metadata.path as string;
            description = `Access external directory: ${filePath}`;
          } else {
            description = permission.title || `Permission: ${permType}`;
          }
          
          setActivePermission({
            id: permission.id || '',
            sessionId: permission.sessionID || '',
            type: permType,
            title: permission.title || `Allow ${permType}?`,
            description,
            filePath,
            command,
            remember,
          });
        }
        break;
      }
      
      // Permission from OpenCode (v2 API - permission.asked)
      case 'permission.asked': {
        const permission = event.properties as {
          id?: string;
          sessionID?: string;
          permission?: string; // v2 uses 'permission' instead of 'type'
          patterns?: string[];
          metadata?: Record<string, unknown>;
          always?: string[]; // v2 uses 'always' instead of 'remember'
        };
        
        
        
        // Only handle permissions for our session
        if (permission.sessionID !== currentSessionId) break;
        
        const metadata = permission.metadata || {};
        const permType = permission.permission || 'unknown';
        
        // Extract details from metadata based on permission type
        let filePath: string | undefined;
        let command: string | undefined;
        let description: string | undefined;
        const remember = permission.always;
        
        // Check for bash/shell permissions
        if (permType === 'bash' || permType === 'shell' || permType.includes('bash') || permType.includes('command')) {
          command = metadata.command as string || metadata.input as string || (permission.patterns?.[0]);
          description = `Run command: ${command || 'unknown'}`;
        } else if (permType === 'edit' || permType === 'write' || permType === 'file:write') {
          filePath = metadata.path as string || metadata.filePath as string || (permission.patterns?.[0]);
          description = `Edit file: ${filePath || 'unknown'}`;
        } else if (permType === 'read' || permType === 'file:read') {
          filePath = metadata.path as string || metadata.filePath as string || (permission.patterns?.[0]);
          description = `Read file: ${filePath || 'unknown'}`;
        } else if (permType === 'external_directory' || permType.includes('directory')) {
          filePath = metadata.path as string || (permission.patterns?.[0]);
          description = `Access directory: ${filePath || 'unknown'}`;
        } else {
          // Generic permission - try to extract useful info from patterns
          const pattern = permission.patterns?.[0];
          description = pattern ? `${permType}: ${pattern}` : `Permission: ${permType}`;
        }
        
        setActivePermission({
          id: permission.id || '',
          sessionId: permission.sessionID || '',
          type: permType,
          title: `Allow ${permType}?`,
          description,
          filePath,
          command,
          remember,
        });
        break;
      }

      // Question from OpenCode (v2 API - question.asked)
      case 'question.asked': {
        const questionRequest = event.properties as {
          id?: string;
          sessionID?: string;
          questions?: Array<{
            question?: string;
            header?: string;
            options?: Array<{ label?: string; description?: string }>;
            multiple?: boolean;
          }>;
        };

        // Only handle questions for our session
        if (questionRequest.sessionID !== currentSessionId) break;

        const questions = questionRequest.questions;
        if (questions && questions.length > 0) {
          const q = questions[0]; // Handle first question
          setActiveQuestion({
            requestId: questionRequest.id || '',
            sessionId: questionRequest.sessionID || '',
            header: q.header,
            question: q.question || 'OpenCode needs your input',
            options: (q.options || []).map(o => ({
              label: o.label || '',
              description: o.description,
            })),
            multiple: q.multiple,
            custom: true, // Default to allowing custom input
          });
          setSelectedAnswers(new Set<string>());
          setCustomAnswer('');
        }
        break;
      }

      // Question replied/rejected - clear the question UI
      case 'question.replied':
      case 'question.rejected': {
        const questionEvent = event.properties as {
          sessionID?: string;
          requestID?: string;
        };
        if (questionEvent.sessionID === currentSessionId) {
          setActiveQuestion(null);
          setSelectedAnswers(new Set<string>());
          setCustomAnswer('');
        }
        break;
      }
      
      case 'permission.replied': {
        const permReplyEvent = event.properties as { sessionID?: string };
        // Only clear for our session
        if (!permReplyEvent.sessionID || permReplyEvent.sessionID === currentSessionId) {
          setActivePermission(null);
        }
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

  let reconnectAttempts = 0;
  const handleEventError = (err: Error) => {
    console.error('Event stream error:', err);
    // Reconnect with exponential backoff (2s, 4s, 8s, 16s, max 30s)
    const delay = Math.min(2000 * Math.pow(2, reconnectAttempts), 30000);
    reconnectAttempts++;
    setTimeout(async () => {
      if (session()) {
        try {
          eventCleanup = await subscribeToEvents(handleServerEvent, handleEventError);
          reconnectAttempts = 0; // Reset on successful reconnect
        } catch {
          handleEventError(new Error('Reconnection failed'));
        }
      }
    }, delay);
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
        
        // Check if this message has our context prefix (current file context)
        // Handles both old format "[Context: Working on "filename"]" and new "[Context: Working on file "path"]"
        if (displayText.startsWith('[Context: Working on')) {
          const separatorIndex = displayText.indexOf('\n\n---\n\n');
          if (separatorIndex !== -1) {
            displayText = displayText.slice(separatorIndex + 7); // 7 = length of '\n\n---\n\n'
          }
        }
        // Check for referenced files context (@mentions)
        else if (displayText.startsWith('[Referenced files]')) {
          const separatorIndex = displayText.indexOf('\n\n---\n\n');
          if (separatorIndex !== -1) {
            displayText = displayText.slice(separatorIndex + 7);
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
    const filesToMention = mentionedFiles();
    
    if (!text || !sessionId || isLoading()) return;
    
    setInputText('');
    setMentionedFiles([]); // Clear mentioned files after sending
    setError(null);
    setStreamingContent(''); // Clear any previous streaming content
    setIsLoading(true);
    setIsStreaming(true);
    
    // Build display text with mentioned files indicator
    let displayText = text;
    if (filesToMention.length > 0) {
      displayText = `[${filesToMention.map(f => f.name).join(', ')}] ${text}`;
    }
    
    // Add user message immediately (just the text, not the context)
    const userMessage: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text: displayText }],
      timestamp: Date.now(),
    };
    setMessages(prev => [...prev, userMessage]);
    
    try {
      // Build prompt with optional context
      let prompt = text;
      const file = props.currentFile;
      
      // Include mentioned files context
      if (filesToMention.length > 0) {
        const fileContexts: string[] = [];
        for (const f of filesToMention) {
          try {
            const content = await invoke<string>('read_file', { path: f.path });
            const truncated = content.length > 50000 ? content.slice(0, 50000) + '\n[...truncated]' : content;
            // Include full path so OpenCode can edit the correct file
            fileContexts.push(`=== File: ${f.path} ===\n${truncated}`);
          } catch (err) {
            console.error(`Failed to read file ${f.path}:`, err);
            fileContexts.push(`=== File: ${f.path} ===\n[Error: Could not read file]`);
          }
        }
        prompt = `[Referenced files]\n\n${fileContexts.join('\n\n')}\n\n---\n\n${text}`;
      }
      // Include file context only on first message for this file (or if file changed)
      // This avoids sending the full file content with every message
      // We use path + content hash to detect if the file was edited
      else {
        const fileKey = file ? `${file.path}:${hashContent(file.content)}` : null;
        if (file && includeContext() && contextSentForFile() !== fileKey) {
          // Include full path so OpenCode can edit the correct file
          const filePath = file.path;
          
          // Truncate large files to avoid excessive token usage
          const MAX_CONTEXT_LINES = 500;
          const MAX_CONTEXT_CHARS = 50000; // ~12.5k tokens
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
          
          const truncateNote = truncated ? `\n\n[Note: File truncated - showing first ${MAX_CONTEXT_LINES} lines or ${Math.round(MAX_CONTEXT_CHARS/1000)}k chars]` : '';
          prompt = `[Context: Working on file "${filePath}"]${truncateNote}\n\n${content}\n\n---\n\n${text}`;
          setContextSentForFile(fileKey);
        }
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

  // Get filtered files for the file picker
  const filteredFiles = () => {
    const query = fileSearchQuery().toLowerCase();
    const files = props.vaultFiles || [];
    if (!query) return files.slice(0, 10); // Show first 10 when no query
    return files
      .filter(f => f.name.toLowerCase().includes(query) || f.path.toLowerCase().includes(query))
      .slice(0, 10);
  };

  // Handle keyboard shortcuts
  const handleKeyDown = (e: KeyboardEvent) => {
    // Handle file picker navigation
    if (showFilePicker()) {
      const files = filteredFiles();
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedFileIndex(i => Math.min(i + 1, files.length - 1));
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedFileIndex(i => Math.max(i - 1, 0));
        return;
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault();
        const selected = files[selectedFileIndex()];
        if (selected) {
          selectFile(selected);
        }
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowFilePicker(false);
        setFileSearchQuery('');
        return;
      }
    }
    
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
    if (e.key === 'Escape' && isStreaming()) {
      handleAbort();
    }
  };
  
  // Select a file from the picker
  const selectFile = (file: VaultFile) => {
    // Add to mentioned files if not already there
    setMentionedFiles(prev => {
      if (prev.some(f => f.path === file.path)) return prev;
      return [...prev, file];
    });
    
    // Remove the @query from input and close picker
    const text = inputText();
    const atIndex = text.lastIndexOf('@');
    if (atIndex !== -1) {
      setInputText(text.substring(0, atIndex));
    }
    
    setShowFilePicker(false);
    setFileSearchQuery('');
    setSelectedFileIndex(0);
    inputRef?.focus();
  };
  
  // Remove a mentioned file
  const removeMentionedFile = (path: string) => {
    setMentionedFiles(prev => prev.filter(f => f.path !== path));
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

  // Debounced textarea resize to avoid excessive layout recalculations
  let resizeTimeout: ReturnType<typeof setTimeout> | null = null;
  const handleInput = (e: Event) => {
    const target = e.target as HTMLTextAreaElement;
    const value = target.value;
    setInputText(value);
    
    // Check for @ mention trigger
    const cursorPos = target.selectionStart || 0;
    const textBeforeCursor = value.substring(0, cursorPos);
    const atIndex = textBeforeCursor.lastIndexOf('@');
    
    if (atIndex !== -1 && (atIndex === 0 || textBeforeCursor[atIndex - 1] === ' ' || textBeforeCursor[atIndex - 1] === '\n')) {
      // Check if we're still in the @ mention (no space after @)
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
    
    // Debounce the resize operation
    if (resizeTimeout) clearTimeout(resizeTimeout);
    resizeTimeout = setTimeout(() => {
      target.style.height = 'auto';
      target.style.height = Math.min(target.scrollHeight, 200) + 'px';
    }, 16); // ~1 frame at 60fps
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
    setContextSentForFile(null); // Reset context tracking for new session
    setShowAllMessages(false); // Reset to show only recent messages
    
    // Create a new session
    try {
      const newSession = await createSession('Onyx Chat');
      setSession(newSession);
    } catch (err) {
      console.error('Failed to create new session:', err);
      setError('Failed to clear chat');
    }
  };

  // Install OpenCode automatically
  const handleInstallOpenCode = async () => {
    setIsInstalling(true);
    setInstallError(null);
    setInstallProgress({
      stage: 'checking',
      progress: 0,
      message: 'Preparing installation...'
    });

    // Listen for progress events
    const unlisten = await listen<InstallProgress>('opencode-install-progress', (event) => {
      setInstallProgress(event.payload);
      
      if (event.payload.stage === 'error') {
        setInstallError(event.payload.message);
        setIsInstalling(false);
      }
    });

    try {
      const installedPath = await invoke<string>('install_opencode');
      
      // Save the path to localStorage
      localStorage.setItem('opencode_path', installedPath);
      
      // Clean up listener
      unlisten();
      
      // Wait a moment then try to connect
      setInstallProgress({
        stage: 'complete',
        progress: 100,
        message: 'OpenCode installed successfully! Starting server...'
      });
      
      // Brief delay to show success message
      await new Promise(resolve => setTimeout(resolve, 1500));
      
      setIsInstalling(false);
      setInstallProgress(null);
      
      // Try to start the server
      checkAndStartServer();
    } catch (err) {
      console.error('Failed to install OpenCode:', err);
      unlisten();
      setInstallError(err instanceof Error ? err.message : String(err));
      setIsInstalling(false);
    }
  };

  // Handler for model changes from Settings
  const handleModelChanged = (event: Event) => {
    const customEvent = event as CustomEvent<{ model: string }>;
    setCurrentModel(customEvent.detail.model);
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
    
    // Listen for model changes from Settings
    window.addEventListener('opencode-model-changed', handleModelChanged);
    
    checkAndStartServer();
    inputRef?.focus();
  });

  onCleanup(() => {
    eventCleanup?.();
    window.removeEventListener('opencode-model-changed', handleModelChanged);
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
          {/* Installing State */}
          <Show when={isInstalling()}>
            <div class="opencode-installer">
              <div class="opencode-installer-icon">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                  <polyline points="7 10 12 15 17 10"></polyline>
                  <line x1="12" y1="15" x2="12" y2="3"></line>
                </svg>
              </div>
              <h3>Installing OpenCode</h3>
              
              {/* Progress bar */}
              <div class="opencode-install-progress">
                <div 
                  class="opencode-install-progress-bar" 
                  style={{ width: `${installProgress()?.progress || 0}%` }}
                />
              </div>
              
              {/* Status message */}
              <p class="opencode-install-status">
                {installProgress()?.message || 'Preparing...'}
              </p>
              
              {/* Download details */}
              <Show when={installProgress()?.bytes_downloaded && installProgress()?.total_bytes}>
                <p class="opencode-install-details">
                  {((installProgress()?.bytes_downloaded || 0) / 1_000_000).toFixed(1)} MB / 
                  {((installProgress()?.total_bytes || 0) / 1_000_000).toFixed(1)} MB
                </p>
              </Show>
            </div>
          </Show>

          {/* Install Error State */}
          <Show when={!isInstalling() && installError()}>
            <div class="opencode-not-installed-icon error">
              <svg width="64" height="64" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="15" y1="9" x2="9" y2="15"></line>
                <line x1="9" y1="9" x2="15" y2="15"></line>
              </svg>
            </div>
            <h3>Installation Failed</h3>
            <p class="error-message">{installError()}</p>
            <button
              class="opencode-install-btn"
              onClick={handleInstallOpenCode}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="23 4 23 10 17 10"></polyline>
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
              </svg>
              Try Again
            </button>
            <button
              class="opencode-manual-btn"
              onClick={() => open('https://opencode.ai/download')}
            >
              Install Manually
            </button>
          </Show>

          {/* Default Not Installed State */}
          <Show when={!isInstalling() && !installError()}>
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
            <h3>OpenCode Not Found</h3>
            <p>OpenCode is an AI coding assistant that powers the chat features in Onyx.</p>
            
            <button
              class="opencode-install-btn primary"
              onClick={handleInstallOpenCode}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
                <polyline points="7 10 12 15 17 10"></polyline>
                <line x1="12" y1="15" x2="12" y2="3"></line>
              </svg>
              Install OpenCode Automatically
            </button>
            <p class="opencode-install-hint">Downloads ~30-50 MB to ~/.opencode/bin/</p>
            
            <div class="opencode-install-divider">
              <span>or</span>
            </div>
            
            <button
              class="opencode-manual-btn"
              onClick={() => open('https://opencode.ai/download')}
            >
              Download Manually
            </button>
            <button class="opencode-retry-btn" onClick={checkAndStartServer}>
              Already installed? Check again
            </button>
          </Show>
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

          {/* Lazy loading: show "Load more" if there are many messages */}
          {(() => {
            const allMessages = messages().filter(hasVisibleContent);
            const hiddenCount = showAllMessages() ? 0 : Math.max(0, allMessages.length - INITIAL_MESSAGES_SHOWN);
            const visibleMessages = showAllMessages() ? allMessages : allMessages.slice(-INITIAL_MESSAGES_SHOWN);
            
            return (
              <>
                <Show when={hiddenCount > 0}>
                  <button class="chat-load-more" onClick={() => setShowAllMessages(true)}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="18 15 12 9 6 15"></polyline>
                    </svg>
                    Load {hiddenCount} earlier message{hiddenCount > 1 ? 's' : ''}
                  </button>
                </Show>
                
                <For each={visibleMessages}>
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
              </>
            );
          })()}

          {/* Streaming indicator */}
          <Show when={isStreaming()}>
            <div class="chat-message assistant streaming">
              <div class="chat-message-avatar">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
                </svg>
              </div>
              <div class="chat-message-content">
                {/* Show active tools */}
                <Show when={activeTools().length > 0}>
                  <div class="chat-active-tools">
                    <For each={activeTools()}>
                      {(tool) => (
                        <div class={`chat-active-tool ${tool.status}`}>
                          <div class="tool-spinner"></div>
                          <span class="tool-name">{tool.toolName}</span>
                          <Show when={tool.title}>
                            <span class="tool-title">{tool.title}</span>
                          </Show>
                        </div>
                      )}
                    </For>
                  </div>
                </Show>
                
                {/* Show retry status */}
                <Show when={sessionStatus()?.type === 'retry'}>
                  <div class="chat-retry-status">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="23 4 23 10 17 10"></polyline>
                      <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"></path>
                    </svg>
                    <span>Retrying{sessionStatus()?.attempt ? ` (attempt ${sessionStatus()!.attempt})` : ''}...</span>
                    <Show when={sessionStatus()?.message}>
                      <span class="retry-message">{sessionStatus()!.message}</span>
                    </Show>
                  </div>
                </Show>
                
                {/* Only show actual content, not echo marker content */}
                <Show when={streamingContent().length > 0 && !streamingContent().startsWith('\x00ECHO\x00')} fallback={
                  <Show when={activeTools().length === 0 && sessionStatus()?.type !== 'retry'}>
                    <div class="typing-indicator">
                      <span></span>
                      <span></span>
                      <span></span>
                    </div>
                  </Show>
                }>
                  <div class="chat-message-text markdown" innerHTML={markdownToHtml(streamingContent())} />
                </Show>
              </div>
            </div>
          </Show>

          {/* Question from OpenCode */}
          <Show when={activeQuestion()}>
            <div class="chat-question">
              <div class="chat-question-header">
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <circle cx="12" cy="12" r="10"></circle>
                  <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3"></path>
                  <line x1="12" y1="17" x2="12.01" y2="17"></line>
                </svg>
                <span>{activeQuestion()!.header || 'OpenCode needs your input'}</span>
              </div>
              <div class="chat-question-body">
                <p>{activeQuestion()!.question}</p>
                <div class="chat-question-options">
                  <For each={activeQuestion()!.options}>
                    {(option) => (
                      <button
                        class={`chat-question-option ${selectedAnswers().has(option.label) ? 'selected' : ''}`}
                        onClick={() => {
                          const q = activeQuestion();
                          if (!q) return;
                          
                          if (q.multiple) {
                            // Toggle selection for multiple choice
                            setSelectedAnswers(prev => {
                              const next = new Set(prev);
                              if (next.has(option.label)) {
                                next.delete(option.label);
                              } else {
                                next.add(option.label);
                              }
                              return next;
                            });
                          } else {
                            // Single selection - submit immediately
                            respondToQuestion(q.requestId, [option.label])
                              .then(() => {
                                setActiveQuestion(null);
                              })
                              .catch(err => {
                                console.error('Failed to respond to question:', err);
                                setError('Failed to respond to question');
                              });
                          }
                        }}
                      >
                        <span class="option-label">{option.label}</span>
                        <Show when={option.description}>
                          <span class="option-description">{option.description}</span>
                        </Show>
                      </button>
                    )}
                  </For>
                </div>
                
                {/* Custom answer input */}
                <Show when={activeQuestion()!.custom}>
                  <div class="chat-question-custom">
                    <input
                      type="text"
                      placeholder="Type your own answer..."
                      value={customAnswer()}
                      onInput={(e) => setCustomAnswer(e.currentTarget.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && customAnswer().trim()) {
                          const q = activeQuestion();
                          if (!q) return;
                          respondToQuestion(q.requestId, [customAnswer().trim()])
                            .then(() => {
                              setActiveQuestion(null);
                              setCustomAnswer('');
                            })
                            .catch(err => {
                              console.error('Failed to respond to question:', err);
                              setError('Failed to respond to question');
                            });
                        }
                      }}
                    />
                  </div>
                </Show>
                
                {/* Submit button for multiple choice */}
                <Show when={activeQuestion()!.multiple && selectedAnswers().size > 0}>
                  <button
                    class="chat-question-submit"
                    onClick={() => {
                      const q = activeQuestion();
                      if (!q) return;
                      respondToQuestion(q.requestId, Array.from(selectedAnswers()))
                        .then(() => {
                          setActiveQuestion(null);
                          setSelectedAnswers(new Set<string>());
                        })
                        .catch(err => {
                          console.error('Failed to respond to question:', err);
                          setError('Failed to respond to question');
                        });
                    }}
                  >
                    Submit ({selectedAnswers().size} selected)
                  </button>
                </Show>
              </div>
            </div>
          </Show>

          {/* Tool Permission Request (file edits, bash commands, etc.) */}
          <Show when={activePermission()}>
            <div class="chat-permission">
              <div class="chat-permission-header">
                <Show when={activePermission()!.type === 'bash'} fallback={
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
                    <polyline points="14 2 14 8 20 8"></polyline>
                    <line x1="12" y1="18" x2="12" y2="12"></line>
                    <line x1="9" y1="15" x2="15" y2="15"></line>
                  </svg>
                }>
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="4 17 10 11 4 5"></polyline>
                    <line x1="12" y1="19" x2="20" y2="19"></line>
                  </svg>
                </Show>
                <span>{activePermission()!.title}</span>
              </div>
              <div class="chat-permission-body">
                <Show when={activePermission()!.description}>
                  <p class="chat-permission-description">{activePermission()!.description}</p>
                </Show>
                <Show when={activePermission()!.filePath}>
                  <code class="chat-permission-path">{activePermission()!.filePath}</code>
                </Show>
                <Show when={activePermission()!.command}>
                  <code class="chat-permission-command">{activePermission()!.command}</code>
                </Show>
                <div class="chat-permission-actions">
                  <button
                    class="chat-permission-btn allow"
                    onClick={() => {
                      const p = activePermission();
                      if (!p) return;
                      respondToToolPermission(p.sessionId, p.id, 'once')
                        .then(() => setActivePermission(null))
                        .catch(err => {
                          console.error('Failed to approve permission:', err);
                          setError('Failed to approve permission');
                        });
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <polyline points="20 6 9 17 4 12"></polyline>
                    </svg>
                    Allow
                  </button>
                  <button
                    class="chat-permission-btn always"
                    onClick={() => {
                      const p = activePermission();
                      if (!p) return;
                      respondToToolPermission(p.sessionId, p.id, 'always')
                        .then(() => setActivePermission(null))
                        .catch(err => {
                          console.error('Failed to approve permission:', err);
                          setError('Failed to approve permission');
                        });
                    }}
                    title={activePermission()!.remember?.length ? `Remember: ${activePermission()!.remember!.join(', ')}` : 'Allow for this session'}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"></path>
                      <polyline points="22 4 12 14.01 9 11.01"></polyline>
                    </svg>
                    Always
                  </button>
                  <button
                    class="chat-permission-btn deny"
                    onClick={() => {
                      const p = activePermission();
                      if (!p) return;
                      respondToToolPermission(p.sessionId, p.id, 'reject')
                        .then(() => setActivePermission(null))
                        .catch(err => {
                          console.error('Failed to deny permission:', err);
                          setError('Failed to deny permission');
                        });
                    }}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                      <line x1="18" y1="6" x2="6" y2="18"></line>
                      <line x1="6" y1="6" x2="18" y2="18"></line>
                    </svg>
                    Deny
                  </button>
                </div>
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
                <span>{props.currentFile!.path.replace(/\\/g, '/').split('/').pop()}</span>
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
          {/* Mentioned files chips */}
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
                    <button 
                      class="remove-file-btn"
                      onClick={() => removeMentionedFile(file.path)}
                      title="Remove file"
                    >
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
            {/* File picker dropdown */}
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
              placeholder="Ask OpenCode anything... (type @ to reference files)"
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
