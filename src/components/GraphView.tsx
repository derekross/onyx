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
    return await invoke<string>('read_file', { path, vaultPath: props.vaultPath });
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

  // Color helpers for connectivity-based gradient
  // Lerp between two hex colors
  const lerpColor = (a: string, b: string, t: number): string => {
    const ah = parseInt(a.replace('#', ''), 16);
    const bh = parseInt(b.replace('#', ''), 16);
    const ar = (ah >> 16) & 0xff, ag = (ah >> 8) & 0xff, ab = ah & 0xff;
    const br = (bh >> 16) & 0xff, bg = (bh >> 8) & 0xff, bb = bh & 0xff;
    const rr = Math.round(ar + (br - ar) * t);
    const rg = Math.round(ag + (bg - ag) * t);
    const rb = Math.round(ab + (bb - ab) * t);
    return `#${((rr << 16) | (rg << 8) | rb).toString(16).padStart(6, '0')}`;
  };

  // Get node color based on connectivity (0..1 normalized)
  const getNodeColors = (t: number, isCurrentFile: boolean) => {
    // Color stops: dim gray -> muted purple -> vibrant purple
    const bgLow = '#55556a';
    const bgMid = '#7b6b9e';
    const bgHigh = '#a78bfa';
    const borderLow = '#6b6b80';
    const borderMid = '#9580b8';
    const borderHigh = '#c4b5fd';

    if (isCurrentFile) {
      return {
        background: '#c084fc',
        border: '#d8b4fe',
        highlight: { background: '#c084fc', border: '#e9d5ff' },
        hover: { background: '#b175eb', border: '#d8b4fe' },
      };
    }

    // Two-segment gradient: 0-0.5 = low->mid, 0.5-1.0 = mid->high
    const bg = t < 0.5
      ? lerpColor(bgLow, bgMid, t * 2)
      : lerpColor(bgMid, bgHigh, (t - 0.5) * 2);
    const border = t < 0.5
      ? lerpColor(borderLow, borderMid, t * 2)
      : lerpColor(borderMid, borderHigh, (t - 0.5) * 2);

    return {
      background: bg,
      border: border,
      highlight: {
        background: lerpColor(bg, '#c084fc', 0.5),
        border: lerpColor(border, '#e9d5ff', 0.5),
      },
      hover: {
        background: lerpColor(bg, '#a78bfa', 0.3),
        border: lerpColor(border, '#c4b5fd', 0.3),
      },
    };
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

    // Calculate connectivity score for each node (incoming + outgoing)
    const connectionCounts = new Map<string, number>();
    let maxConnections = 1;
    for (const node of displayGraph.nodes) {
      const total = node.incomingCount + node.outgoingCount;
      connectionCounts.set(node.id, total);
      if (total > maxConnections) maxConnections = total;
    }

    // Determine top ~20% threshold for glow effect
    const sortedCounts = Array.from(connectionCounts.values()).sort((a, b) => b - a);
    const topThresholdIndex = Math.max(0, Math.ceil(sortedCounts.length * 0.2) - 1);
    const topThreshold = sortedCounts[topThresholdIndex] || maxConnections;

    // Convert to vis-network format
    const nodes = new DataSet(
      displayGraph.nodes.map((node) => {
        const totalConnections = connectionCounts.get(node.id) || 0;
        // Normalize using square root for a smoother curve (avoids a few
        // mega-hubs dominating the entire scale)
        const t = Math.sqrt(totalConnections / maxConnections);
        const isCurrentFile = node.id === props.currentFile;
        const isTopNode = totalConnections >= topThreshold && totalConnections > 0;

        return {
          id: node.id,
          label: node.name,
          title: `${node.name}\nConnections: ${totalConnections} (in: ${node.incomingCount}, out: ${node.outgoingCount})`,
          // Size: base 8, scales up with connections
          size: Math.min(45, Math.max(8, 8 + Math.sqrt(totalConnections) * 5)),
          color: getNodeColors(t, isCurrentFile),
          // Top nodes and current file get a glow
          shadow: isTopNode || isCurrentFile ? {
            enabled: true,
            color: isCurrentFile ? 'rgba(192, 132, 252, 0.6)' : 'rgba(167, 139, 250, 0.4)',
            size: isCurrentFile ? 15 : 10,
            x: 0,
            y: 0,
          } : {
            enabled: false,
          },
          font: {
            color: isTopNode || isCurrentFile ? '#f4f4f5' : '#a1a1aa',
            size: Math.min(16, Math.max(11, 11 + Math.sqrt(totalConnections))),
            strokeWidth: isTopNode ? 2 : 0,
            strokeColor: 'rgba(0, 0, 0, 0.5)',
          },
          borderWidth: isCurrentFile ? 3 : isTopNode ? 2.5 : 1.5,
        };
      })
    );

    // Build a lookup for node connection counts for edge styling
    const edges = new DataSet(
      displayGraph.links
        .filter((link) => link.exists)
        .map((link, index) => {
          const fromCount = connectionCounts.get(link.from) || 0;
          const toCount = connectionCounts.get(link.to) || 0;
          // Edge importance = average of connected nodes
          const avgConnections = (fromCount + toCount) / 2;
          const edgeT = Math.sqrt(avgConnections / maxConnections);

          return {
            id: index,
            from: link.from,
            to: link.to,
            color: {
              color: lerpColor('#3f3f50', '#8b7cc9', edgeT),
              highlight: '#c084fc',
              hover: lerpColor('#52525b', '#a78bfa', edgeT),
            },
            width: Math.max(0.5, 0.5 + edgeT * 2.5),
          };
        })
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
    // Track reactive dependencies
    graphData();
    localMode();
    depth();
    void props.currentFile;
    const ready = containerReady();

    // Only render when container is ready and we have data
    if (ready && graphData()) {
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
        <span class="graph-legend">
          <span class="graph-legend-dot graph-legend-low" />
          <span class="graph-legend-dot graph-legend-mid" />
          <span class="graph-legend-dot graph-legend-high" />
          <span>connections</span>
        </span>
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
