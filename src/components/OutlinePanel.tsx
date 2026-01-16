import { Component, For, Show, createSignal, createMemo, createEffect } from 'solid-js';
import { HeadingInfo } from '../lib/editor/heading-plugin';

interface OutlinePanelProps {
  headings: HeadingInfo[];
  activeHeadingId: string | null;
  onHeadingClick: (id: string) => void;
  onClose: () => void;
}

const OutlinePanel: Component<OutlinePanelProps> = (props) => {
  const [searchQuery, setSearchQuery] = createSignal('');
  let activeItemRef: HTMLDivElement | undefined;
  let contentRef: HTMLDivElement | undefined;

  const filteredHeadings = createMemo(() => {
    const q = searchQuery().toLowerCase();
    if (!q) return props.headings;
    return props.headings.filter(h => h.text.toLowerCase().includes(q));
  });

  // Auto-scroll to keep active heading visible in the panel
  createEffect(() => {
    const activeId = props.activeHeadingId;
    if (activeId && activeItemRef && contentRef) {
      const itemRect = activeItemRef.getBoundingClientRect();
      const containerRect = contentRef.getBoundingClientRect();

      // Check if item is outside visible area
      if (itemRect.top < containerRect.top || itemRect.bottom > containerRect.bottom) {
        activeItemRef.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
  });

  return (
    <div class="outline-panel">
      <div class="outline-header">
        <span class="outline-header-title">Outline</span>
        <button class="outline-close" onClick={props.onClose} title="Close">
          ×
        </button>
      </div>

      <div class="outline-search">
        <input
          type="text"
          placeholder="Filter headings..."
          value={searchQuery()}
          onInput={(e) => setSearchQuery(e.currentTarget.value)}
        />
      </div>

      <div class="outline-content" ref={contentRef}>
        <Show
          when={filteredHeadings().length > 0}
          fallback={
            <div class="outline-empty">
              {searchQuery() ? 'No matching headings' : 'No headings in this note'}
            </div>
          }
        >
          <For each={filteredHeadings()}>
            {(heading) => {
              const isActive = () => props.activeHeadingId === heading.id;
              return (
                <div
                  ref={(el) => { if (isActive()) activeItemRef = el; }}
                  class={`outline-item outline-level-${heading.level} ${isActive() ? 'active' : ''}`}
                  onClick={() => props.onHeadingClick(heading.id)}
                  style={{ 'padding-left': `${12 + (heading.level - 1) * 16}px` }}
                >
                  <span class="outline-marker">H{heading.level}</span>
                  <span class="outline-text">{heading.text || '(empty)'}</span>
                </div>
              );
            }}
          </For>
        </Show>
      </div>
    </div>
  );
};

export default OutlinePanel;
