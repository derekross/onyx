import { Component, createSignal, onMount, onCleanup } from 'solid-js';
import { invoke } from '@tauri-apps/api/core';

interface TerminalProps {
  vaultPath: string | null;
  onClose: () => void;
}

const Terminal: Component<TerminalProps> = (props) => {
  const [output, setOutput] = createSignal<string[]>([]);
  const [isRunning, setIsRunning] = createSignal(false);
  let outputRef: HTMLDivElement | undefined;

  const addOutput = (line: string) => {
    setOutput(prev => [...prev, line]);
    // Scroll to bottom
    setTimeout(() => {
      if (outputRef) {
        outputRef.scrollTop = outputRef.scrollHeight;
      }
    }, 10);
  };

  const launchOpencode = async () => {
    if (isRunning()) return;

    setIsRunning(true);
    setOutput([]);
    addOutput('$ opencode');
    addOutput('Starting opencode...');

    try {
      await invoke('run_terminal_command', {
        command: 'opencode',
        cwd: props.vaultPath || undefined,
      });
      addOutput('opencode launched successfully');
    } catch (err) {
      addOutput(`Error: ${err}`);
    } finally {
      setIsRunning(false);
    }
  };

  const runCommand = async (command: string) => {
    if (isRunning() || !command.trim()) return;

    setIsRunning(true);
    addOutput(`$ ${command}`);

    try {
      const result = await invoke<string>('run_terminal_command', {
        command,
        cwd: props.vaultPath || undefined,
      });
      if (result) {
        result.split('\n').forEach(line => addOutput(line));
      }
    } catch (err) {
      addOutput(`Error: ${err}`);
    } finally {
      setIsRunning(false);
    }
  };

  return (
    <div class="terminal-panel">
      <div class="terminal-header">
        <span>Terminal</span>
        <div class="terminal-actions">
          <button
            class="terminal-btn opencode-btn"
            onClick={launchOpencode}
            disabled={isRunning()}
          >
            Launch opencode
          </button>
          <button class="terminal-btn" onClick={props.onClose}>×</button>
        </div>
      </div>
      <div class="terminal-output" ref={outputRef}>
        {output().map((line, i) => (
          <div class="terminal-line" key={i}>{line}</div>
        ))}
        {output().length === 0 && (
          <div class="terminal-placeholder">
            Click "Launch opencode" to start, or press Ctrl+` to toggle terminal
          </div>
        )}
      </div>
    </div>
  );
};

export default Terminal;
