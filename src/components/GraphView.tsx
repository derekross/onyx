import { Component, createSignal, createEffect, onCleanup, onMount, Show } from 'solid-js';
import { Network, Options } from 'vis-network';
import { DataSet } from 'vis-data';
import { NoteGraph, NoteIndex, buildNoteGraph, buildLocalGraph } from '../lib/editor/note-index';
import { invoke } from '@tauri-apps/api/core';

interface GraphViewProps {
  vaultPath: string | null;
  noteIndex: NoteIndex | null;
  currentFile: string | null;
  onNodeClick: (path: string) => void;
}

const GraphView: Component<GraphViewProps> = (props) => {
  const [loading, setLoading] = createSignal(true); // Start loading
  const [localMode, setLocalMode] = createSignal(false);
  const [depth, setDepth] = createSignal(1);
  const [graphData, setGraphData] = createSignal<NoteGraph | null>(null);
  const [nodeCount, setNodeCount] = createSignal(0);
  const [linkCount, setLinkCount] = createSignal(0);
  const [containerReady, setContainerReady] = createSignal(false);

  let containerRef: HTMLDivElement | undefined;
  let networkInstance: Network | null = null;

  // Read file helper
  const readFile = async (path: string): Promise<string> => {
    return await invoke<string>('read_file', { path });
  };

  // Build the graph when vault/index changes
  const rebuildGraph = async () => {
    if (!props.vaultPath || !props.noteIndex) {
      setGraphData(null);
      setLoading(false);
      return;
    }

    setLoading(true);
    try {
      const graph = await buildNoteGraph(props.vaultPath, props.noteIndex, readFile);
      setGraphData(graph);
      setNodeCount(graph.nodes.length);
      setLinkCount(graph.links.length);
    } catch (err) {
      console.error('Failed to build graph:', err);
    } finally {
      setLoading(false);
    }
  };

  // Initialize container ref
  const initContainer = (el: HTMLDivElement) => {
    containerRef = el;
    setContainerReady(true);
  };

  // Get the graph to display (filtered for local mode)
  const getDisplayGraph = (): NoteGraph | null => {
    const fullGraph = graphData();
    if (!fullGraph) return null;

    if (localMode() && props.currentFile) {
      return buildLocalGraph(props.currentFile, fullGraph, depth());
    }

    return fullGraph;
  };

  // Render the graph using vis-network
  const renderGraph = () => {
    if (!containerRef) return;

    const displayGraph = getDisplayGraph();
    if (!displayGraph) {
      if (networkInstance) {
        networkInstance.destroy();
        networkInstance = null;
      }
      return;
    }

    // Convert to vis-network format
    const nodes = new DataSet(
      displayGraph.nodes.map((node) => ({
        id: node.id,
        label: node.name,
        title: `${node.name}\nIncoming: ${node.incomingCount}\nOutgoing: ${node.outgoingCount}`,
        // Size based on incoming links (min 10, max 40)
        size: Math.min(40, Math.max(10, 10 + node.incomingCount * 3)),
        color: {
          background: node.id === props.currentFile ? '#a78bfa' : '#6d6d80',
          border: node.id === props.currentFile ? '#c4b5fd' : '#8b8b9e',
          highlight: {
            background: '#a78bfa',
            border: '#c4b5fd',
          },
          hover: {
            background: '#8b7cc9',
            border: '#a78bfa',
          },
        },
        font: {
          color: '#e4e4e7',
          size: 12,
        },
      }))
    );

    const edges = new DataSet(
      displayGraph.links
        .filter((link) => link.exists) // Only show links to existing notes
        .map((link, index) => ({
          id: index,
          from: link.from,
          to: link.to,
          color: {
            color: '#52525b',
            highlight: '#a78bfa',
            hover: '#71717a',
          },
          width: 1,
        }))
    );

    const options: Options = {
      nodes: {
        shape: 'dot',
        borderWidth: 2,
        shadow: false,
      },
      edges: {
        smooth: {
          enabled: true,
          type: 'continuous',
          roundness: 0.5,
        },
        arrows: {
          to: {
            enabled: false,
          },
        },
      },
      physics: {
        enabled: true,
        solver: 'forceAtlas2Based',
        forceAtlas2Based: {
          gravitationalConstant: -50,
          centralGravity: 0.01,
          springLength: 100,
          springConstant: 0.08,
          damping: 0.4,
          avoidOverlap: 0.5,
        },
        stabilization: {
          enabled: true,
          iterations: 200,
          updateInterval: 25,
        },
      },
      interaction: {
        hover: true,
        tooltipDelay: 200,
        zoomView: true,
        dragView: true,
      },
    };

    if (networkInstance) {
      networkInstance.destroy();
    }

    networkInstance = new Network(containerRef, { nodes, edges }, options);

    // Handle node clicks
    networkInstance.on('click', (params) => {
      if (params.nodes.length > 0) {
        const nodeId = params.nodes[0] as string;
        props.onNodeClick(nodeId);
      }
    });

    // Handle double-click to focus
    networkInstance.on('doubleClick', (params) => {
      if (params.nodes.length > 0) {
        networkInstance?.focus(params.nodes[0], {
          scale: 1.5,
          animation: {
            duration: 500,
            easingFunction: 'easeInOutQuad',
          },
        });
      }
    });
  };

  // Build graph on mount and when vault/index changes
  onMount(() => {
    if (props.vaultPath && props.noteIndex) {
      rebuildGraph();
    }
  });

  // Rebuild graph when vault or index changes
  createEffect(() => {
    const vp = props.vaultPath;
    const ni = props.noteIndex;
    if (vp && ni) {
      rebuildGraph();
    }
  });

  // Re-render when graph data, mode, depth, current file, or container changes
  createEffect(() => {
    const data = graphData();
    const mode = localMode();
    const d = depth();
    const file = props.currentFile;
    const ready = containerReady();

    // Only render when container is ready and we have data
    if (ready && data) {
      renderGraph();
    }
  });

  // Cleanup on unmount
  onCleanup(() => {
    if (networkInstance) {
      networkInstance.destroy();
      networkInstance = null;
    }
  });

  return (
    <div class="graph-view">
      <div class="graph-header">
        <span class="graph-title">Graph View</span>
        <button
          class="graph-refresh-btn"
          onClick={rebuildGraph}
          disabled={loading()}
          title="Refresh graph"
        >
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M23 4v6h-6"></path>
            <path d="M1 20v-6h6"></path>
            <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
          </svg>
        </button>
      </div>

      <div class="graph-controls">
        <div class="graph-mode-toggle">
          <button
            class={`graph-mode-btn ${!localMode() ? 'active' : ''}`}
            onClick={() => setLocalMode(false)}
          >
            Global
          </button>
          <button
            class={`graph-mode-btn ${localMode() ? 'active' : ''}`}
            onClick={() => setLocalMode(true)}
            disabled={!props.currentFile}
          >
            Local
          </button>
        </div>

        <Show when={localMode()}>
          <div class="graph-depth-control">
            <label>Depth:</label>
            <input
              type="range"
              min="1"
              max="3"
              value={depth()}
              onInput={(e) => setDepth(parseInt(e.currentTarget.value))}
            />
            <span>{depth()}</span>
          </div>
        </Show>
      </div>

      <div class="graph-stats">
        <span>{nodeCount()} notes</span>
        <span>{linkCount()} links</span>
      </div>

      <Show when={loading()}>
        <div class="graph-loading">
          <span>Building graph...</span>
        </div>
      </Show>

      <Show when={!props.vaultPath}>
        <div class="graph-empty">
          <p>Open a vault to view the graph</p>
        </div>
      </Show>

      <Show when={props.vaultPath}>
        <div class="graph-container" ref={initContainer} />
      </Show>
    </div>
  );
};

export default GraphView;
