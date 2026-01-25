import { Component, createSignal, onMount, onCleanup, Show } from 'solid-js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';
import { open } from '@tauri-apps/plugin-shell';

import '@xterm/xterm/css/xterm.css';

interface OpenCodeTerminalProps {
  vaultPath: string | null;
}

const OpenCodeTerminal: Component<OpenCodeTerminalProps> = (props) => {
  const [sessionId, setSessionId] = createSignal<string | null>(null);
  const [isConnected, setIsConnected] = createSignal(false);
  const [notInstalled, setNotInstalled] = createSignal(false);
  let terminalRef: HTMLDivElement | undefined;
  let terminal: Terminal | null = null;
  let fitAddon: FitAddon | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let outputUnlisten: UnlistenFn | null = null;
  let exitUnlisten: UnlistenFn | null = null;

  const initTerminal = async () => {
    if (!terminalRef) return;

    // Create terminal instance
    terminal = new Terminal({
      cursorBlink: true,
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, Consolas, "Cascadia Mono", "Lucida Console", "Courier New", monospace',
      theme: {
        background: '#1e1e1e',
        foreground: '#cccccc',
        cursor: '#0078d4',
        cursorAccent: '#1e1e1e',
        selectionBackground: '#264f78',
        black: '#1e1e1e',
        red: '#f44747',
        green: '#6a9955',
        yellow: '#dcdcaa',
        blue: '#569cd6',
        magenta: '#c586c0',
        cyan: '#4ec9b0',
        white: '#d4d4d4',
        brightBlack: '#808080',
        brightRed: '#f44747',
        brightGreen: '#6a9955',
        brightYellow: '#dcdcaa',
        brightBlue: '#569cd6',
        brightMagenta: '#c586c0',
        brightCyan: '#4ec9b0',
        brightWhite: '#ffffff',
      },
    });

    fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.open(terminalRef);
    fitAddon.fit();

    // Handle terminal input
    terminal.onData((data) => {
      const sid = sessionId();
      if (sid) {
        invoke('write_pty', { sessionId: sid, data }).catch(console.error);
      }
    });

    // Handle resize
    terminal.onResize(({ cols, rows }) => {
      const sid = sessionId();
      if (sid) {
        invoke('resize_pty', { sessionId: sid, cols, rows }).catch(console.error);
      }
    });

    // Setup resize observer
    resizeObserver = new ResizeObserver(() => {
      if (fitAddon && terminal) {
        fitAddon.fit();
      }
    });
    resizeObserver.observe(terminalRef);

    // Start opencode
    await startOpenCode();
  };

  const startOpenCode = async () => {
    if (!terminal || !fitAddon) return;

    const dims = fitAddon.proposeDimensions();
    const cols = dims?.cols || 80;
    const rows = dims?.rows || 24;

    // Get custom OpenCode path from settings, or use default 'opencode'
    const customPath = localStorage.getItem('opencode_path');
    const openCodeCommand = customPath && customPath.trim() ? customPath.trim() : 'opencode';

    try {
      // Spawn opencode in PTY
      const sid = await invoke<string>('spawn_pty', {
        command: openCodeCommand,
        cwd: props.vaultPath || undefined,
        cols,
        rows,
      });

      setSessionId(sid);
      setIsConnected(true);

      // Listen for output events
      outputUnlisten = await listen<string>(`pty-output-${sid}`, (event) => {
        if (terminal) {
          terminal.write(event.payload);
        }
      });

      // Listen for exit events
      exitUnlisten = await listen(`pty-exit-${sid}`, () => {
        setIsConnected(false);
        if (terminal) {
          terminal.write('\r\n\x1b[33m[Process exited. Press any key to restart...]\x1b[0m\r\n');
        }
      });

      terminal.focus();
    } catch (err) {
      console.error('Failed to start opencode:', err);
      const errorStr = String(err).toLowerCase();
      // Check if error indicates opencode is not found
      if (errorStr.includes('not found') || errorStr.includes('no such file') || errorStr.includes('command not found')) {
        setNotInstalled(true);
      } else if (terminal) {
        terminal.write(`\x1b[31mFailed to start opencode: ${err}\x1b[0m\r\n`);
        terminal.write('\x1b[33mMake sure opencode is installed and in your PATH.\x1b[0m\r\n');
      }
    }
  };

  const restartOpenCode = async () => {
    // Cleanup old session
    const oldSid = sessionId();
    if (oldSid) {
      if (outputUnlisten) {
        outputUnlisten();
        outputUnlisten = null;
      }
      if (exitUnlisten) {
        exitUnlisten();
        exitUnlisten = null;
      }
      await invoke('kill_pty', { sessionId: oldSid }).catch(() => {});
      setSessionId(null);
    }

    if (terminal) {
      terminal.clear();
    }

    await startOpenCode();
  };

  const handleKeyDown = async (e: KeyboardEvent) => {
    // Restart on any key if not connected
    if (!isConnected() && sessionId() === null) {
      e.preventDefault();
      await restartOpenCode();
    }
  };

  onMount(() => {
    initTerminal();
  });

  onCleanup(async () => {
    // Cleanup listeners
    if (outputUnlisten) outputUnlisten();
    if (exitUnlisten) exitUnlisten();

    // Cleanup PTY session
    const sid = sessionId();
    if (sid) {
      await invoke('kill_pty', { sessionId: sid }).catch(() => {});
    }

    // Cleanup resize observer
    if (resizeObserver) {
      resizeObserver.disconnect();
    }

    // Cleanup terminal
    if (terminal) {
      terminal.dispose();
    }
  });

  return (
    <div class="opencode-terminal-panel">
      <Show when={notInstalled()}>
        <div class="opencode-not-installed">
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
          <button
            class="opencode-retry-btn"
            onClick={() => {
              setNotInstalled(false);
              restartOpenCode();
            }}
          >
            I've installed it - try again
          </button>
        </div>
      </Show>
      <Show when={!notInstalled()}>
        <div
          class="opencode-terminal-container"
          ref={terminalRef}
          onKeyDown={handleKeyDown}
        />
      </Show>
    </div>
  );
};

export default OpenCodeTerminal;
