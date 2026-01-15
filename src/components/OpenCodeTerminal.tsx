import { Component, createSignal, onMount, onCleanup } from 'solid-js';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import { invoke } from '@tauri-apps/api/core';
import { listen, UnlistenFn } from '@tauri-apps/api/event';

import '@xterm/xterm/css/xterm.css';

interface OpenCodeTerminalProps {
  vaultPath: string | null;
  onClose: () => void;
}

const OpenCodeTerminal: Component<OpenCodeTerminalProps> = (props) => {
  const [sessionId, setSessionId] = createSignal<string | null>(null);
  const [isConnected, setIsConnected] = createSignal(false);
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
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
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

    try {
      // Spawn opencode in PTY
      const sid = await invoke<string>('spawn_pty', {
        command: 'opencode',
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
      if (terminal) {
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
      <div class="opencode-terminal-header">
        <span>OpenCode</span>
        <div class="opencode-terminal-actions">
          <button
            class="terminal-btn"
            onClick={restartOpenCode}
            title="Restart OpenCode"
          >
            ↻
          </button>
          <button class="terminal-btn" onClick={props.onClose}>×</button>
        </div>
      </div>
      <div
        class="opencode-terminal-container"
        ref={terminalRef}
        onKeyDown={handleKeyDown}
      />
    </div>
  );
};

export default OpenCodeTerminal;
