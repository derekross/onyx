import { Component, createSignal, createEffect, For, onMount } from 'solid-js';

interface Command {
  id: string;
  name: string;
  shortcut?: string;
  action: () => void;
}

interface CommandPaletteProps {
  commands: Command[];
  onClose: () => void;
}

const CommandPalette: Component<CommandPaletteProps> = (props) => {
  const [query, setQuery] = createSignal('');
  const [filtered, setFiltered] = createSignal<Command[]>(props.commands);
  const [selectedIndex, setSelectedIndex] = createSignal(0);
  let inputRef: HTMLInputElement | undefined;

  onMount(() => {
    inputRef?.focus();
  });

  createEffect(() => {
    const q = query().toLowerCase();
    if (!q) {
      setFiltered(props.commands);
    } else {
      setFiltered(
        props.commands.filter(c =>
          c.name.toLowerCase().includes(q) ||
          c.id.toLowerCase().includes(q)
        )
      );
    }
    setSelectedIndex(0);
  });

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSelectedIndex(Math.min(selectedIndex() + 1, filtered().length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSelectedIndex(Math.max(selectedIndex() - 1, 0));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const selected = filtered()[selectedIndex()];
      if (selected) {
        selected.action();
        props.onClose();
      }
    } else if (e.key === 'Escape') {
      props.onClose();
    }
  };

  const executeCommand = (cmd: Command) => {
    cmd.action();
    props.onClose();
  };

  return (
    <div class="modal-overlay" onClick={props.onClose}>
      <div class="command-palette" onClick={(e) => e.stopPropagation()}>
        <input
          ref={inputRef}
          type="text"
          class="command-palette-input"
          placeholder="Type a command..."
          value={query()}
          onInput={(e) => setQuery(e.currentTarget.value)}
          onKeyDown={handleKeyDown}
        />
        <div class="command-palette-results">
          <For each={filtered()}>
            {(cmd, index) => (
              <div
                class={`command-palette-item ${index() === selectedIndex() ? 'selected' : ''}`}
                onClick={() => executeCommand(cmd)}
                onMouseEnter={() => setSelectedIndex(index())}
              >
                <span class="command-name">{cmd.name}</span>
                {cmd.shortcut && <span class="command-shortcut">{cmd.shortcut}</span>}
              </div>
            )}
          </For>
          {filtered().length === 0 && (
            <div class="command-palette-empty">No commands found</div>
          )}
        </div>
      </div>
    </div>
  );
};

export default CommandPalette;
