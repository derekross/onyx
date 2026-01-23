/**
 * Milkdown Embed Schema
 *
 * Defines the ProseMirror node schema for Obsidian-style embeds (![[target]])
 * Supports images, audio, video, PDF, and note transclusion.
 */

import { $nodeSchema } from '@milkdown/utils';

/**
 * Define the embed node schema
 * - inline: false - embeds are block-level
 * - group: 'block' - can be used where block content is expected
 * - atom: true - treated as single unit, cursor cannot enter
 * - selectable: true - can be selected
 * - draggable: true - can be drag-and-dropped
 */
export const embedSchema = $nodeSchema('embed', () => ({
  inline: false,
  group: 'block',
  selectable: true,
  draggable: true,
  atom: true,
  marks: '',
  attrs: {
    target: { default: '' },
    anchor: { default: null },
    width: { default: null },
    height: { default: null },
  },
  parseDOM: [{
    tag: 'div[data-type="embed"]',
    getAttrs: (dom: HTMLElement) => ({
      target: dom.getAttribute('data-target') || '',
      anchor: dom.getAttribute('data-anchor') || null,
      width: dom.getAttribute('data-width') ? parseInt(dom.getAttribute('data-width')!, 10) : null,
      height: dom.getAttribute('data-height') ? parseInt(dom.getAttribute('data-height')!, 10) : null,
    }),
  }],
  toDOM: (node) => ['div', {
    'data-type': 'embed',
    'data-target': node.attrs.target,
    'data-anchor': node.attrs.anchor,
    'data-width': node.attrs.width,
    'data-height': node.attrs.height,
    'class': 'milkdown-embed',
  }],
  parseMarkdown: {
    match: ({ type }) => type === 'embed',
    runner: (state, node, type) => {
      state.addNode(type, {
        target: node.target as string,
        anchor: node.anchor as string | null,
        width: node.width as number | null,
        height: node.height as number | null,
      });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'embed',
    runner: (state, node) => {
      // Serialize back to ![[target#anchor|size]] format
      let text = `![[${node.attrs.target}`;

      if (node.attrs.anchor) {
        text += `#${node.attrs.anchor}`;
      }

      if (node.attrs.width) {
        text += `|${node.attrs.width}`;
        if (node.attrs.height) {
          text += `x${node.attrs.height}`;
        }
      }

      text += ']]';

      // Use 'html' node type to avoid markdown escaping of brackets and pipes
      state.addNode('html', undefined, text);
    },
  },
}));
