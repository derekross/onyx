/**
 * Remark Embed Plugin
 *
 * Parses Obsidian-style ![[embed]] syntax and converts them to embed AST nodes.
 * Supports: ![[target]], ![[target#anchor]], ![[target|size]], ![[target#anchor|size]]
 */

import { $remark } from '@milkdown/utils';

// Regex to match embeds: ![[target]] or ![[target#anchor]] or ![[target|size]] or ![[target#anchor|size]]
// - target: the file path or note name (required)
// - anchor: optional, starts with # (heading or ^blockid)
// - size: optional, starts with | (width or widthxheight)
const EMBED_REGEX = /!\[\[([^\]#|]+)(?:#([^\]|]+))?(?:\|([^\]]+))?\]\]/g;

/**
 * Parse the size string into width and height
 * Supports: "100" (width only) or "100x145" (width x height)
 */
function parseSize(sizeStr: string | undefined): { width: number | null; height: number | null } {
  if (!sizeStr) {
    return { width: null, height: null };
  }

  const trimmed = sizeStr.trim();
  if (trimmed.includes('x')) {
    const parts = trimmed.split('x');
    const width = parseInt(parts[0], 10);
    const height = parseInt(parts[1], 10);
    return {
      width: isNaN(width) ? null : width,
      height: isNaN(height) ? null : height,
    };
  }

  const width = parseInt(trimmed, 10);
  return {
    width: isNaN(width) ? null : width,
    height: null,
  };
}

/**
 * Check if a line contains only an embed (for block-level treatment)
 */
function isBlockEmbed(text: string): boolean {
  const trimmed = text.trim();
  EMBED_REGEX.lastIndex = 0;
  const match = EMBED_REGEX.exec(trimmed);
  if (!match) return false;
  // Check if the embed spans the entire trimmed text
  return match[0] === trimmed;
}

/**
 * Create the remark plugin that transforms embed syntax into embed nodes
 */
function remarkEmbed() {
  return (tree: any) => {
    // Process the tree using a simple visitor pattern
    visitAndTransform(tree);
  };
}

/**
 * Visit all nodes and transform text containing embeds
 */
function visitAndTransform(node: any): void {
  if (!node.children) return;

  const newChildren: any[] = [];

  for (const child of node.children) {
    if (child.type === 'paragraph') {
      // Check if paragraph contains embeds
      const transformedParagraph = transformParagraph(child);
      if (transformedParagraph) {
        newChildren.push(...transformedParagraph);
      } else {
        newChildren.push(child);
      }
    } else if (child.type === 'text') {
      // Transform text nodes containing embeds
      const transformed = transformTextNode(child);
      newChildren.push(...transformed);
    } else {
      // Recursively process other nodes
      visitAndTransform(child);
      newChildren.push(child);
    }
  }

  node.children = newChildren;
}

/**
 * Transform a paragraph that might contain embeds
 * Returns null if no transformation needed, or array of nodes if transformed
 */
function transformParagraph(paragraph: any): any[] | null {
  if (!paragraph.children || paragraph.children.length === 0) {
    return null;
  }

  // Check if this is a single-embed paragraph (block embed)
  if (paragraph.children.length === 1 && paragraph.children[0].type === 'text') {
    const textNode = paragraph.children[0];
    const text = textNode.value || '';

    if (isBlockEmbed(text)) {
      EMBED_REGEX.lastIndex = 0;
      const match = EMBED_REGEX.exec(text.trim());
      if (match) {
        const target = match[1].trim();
        const anchor = match[2]?.trim() || null;
        const { width, height } = parseSize(match[3]);

        return [{
          type: 'embed',
          target,
          anchor,
          width,
          height,
        }];
      }
    }
  }

  // For paragraphs with multiple children or inline embeds,
  // transform each text node
  const newChildren: any[] = [];
  let hasEmbeds = false;

  for (const child of paragraph.children) {
    if (child.type === 'text') {
      const transformed = transformTextNode(child);
      if (transformed.length > 1 || (transformed.length === 1 && transformed[0].type !== 'text')) {
        hasEmbeds = true;
      }
      newChildren.push(...transformed);
    } else {
      newChildren.push(child);
    }
  }

  if (hasEmbeds) {
    // Check if all children are now embeds (no text content left)
    const allEmbeds = newChildren.every(c =>
      c.type === 'embed' || (c.type === 'text' && !c.value?.trim())
    );

    if (allEmbeds) {
      // Return embeds as block-level nodes
      return newChildren.filter(c => c.type === 'embed');
    }

    // Otherwise return modified paragraph
    return [{
      ...paragraph,
      children: newChildren,
    }];
  }

  return null;
}

/**
 * Transform a text node that might contain embeds
 * Returns array of nodes (text nodes and embed nodes)
 */
function transformTextNode(textNode: any): any[] {
  const text = textNode.value || '';
  const results: any[] = [];
  let lastIndex = 0;

  EMBED_REGEX.lastIndex = 0;
  let match;

  while ((match = EMBED_REGEX.exec(text)) !== null) {
    // Add text before the match
    if (match.index > lastIndex) {
      results.push({
        type: 'text',
        value: text.slice(lastIndex, match.index),
      });
    }

    // Add the embed node
    const target = match[1].trim();
    const anchor = match[2]?.trim() || null;
    const { width, height } = parseSize(match[3]);

    results.push({
      type: 'embed',
      target,
      anchor,
      width,
      height,
    });

    lastIndex = match.index + match[0].length;
  }

  // Add remaining text after last match
  if (lastIndex < text.length) {
    results.push({
      type: 'text',
      value: text.slice(lastIndex),
    });
  }

  // If no embeds found, return original node
  if (results.length === 0) {
    return [textNode];
  }

  return results;
}

/**
 * Export the remark plugin wrapped for Milkdown
 */
export const remarkEmbedPlugin = $remark('remarkEmbed', () => remarkEmbed);
