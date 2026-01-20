import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';

export const headingPluginKey = new PluginKey<HeadingInfo[]>('headingExtract');

export interface HeadingInfo {
  text: string;
  level: number;
  id: string;
  pos: number;  // Document position for scroll sync
}

function extractHeadingsFromDoc(doc: any): HeadingInfo[] {
  const headings: HeadingInfo[] = [];
  doc.descendants((node: any, pos: number) => {
    if (node.type.name === 'heading' && node.attrs.level) {
      headings.push({
        text: node.textContent,
        level: node.attrs.level,
        id: node.attrs.id || `heading-${pos}`,
        pos: pos
      });
    }
  });
  return headings;
}

// Create the ProseMirror plugin for heading extraction
export const headingPlugin = $prose(() => {
  return new Plugin({
    key: headingPluginKey,
    state: {
      init(_, { doc }) {
        return extractHeadingsFromDoc(doc);
      },
      apply(tr, oldState) {
        if (tr.docChanged) {
          return extractHeadingsFromDoc(tr.doc);
        }
        return oldState;
      }
    }
  });
});
