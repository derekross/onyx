/**
 * Milkdown Nostr Embed Plugin
 *
 * Renders NIP-21 `nostr:` URIs embedded in documents:
 *   - nostr:note1 / nostr:nevent1  -> kind-1 note block card
 *   - nostr:naddr1                 -> long-form (kind-30023) article card
 *   - nostr:npub1 / nostr:nprofile1 -> inline @name mention chip
 *
 * Mirrors the architecture of embed-plugin.ts: a ProseMirror node schema, a
 * custom node view whose DOM is mutated by an async render function, and a
 * `$prose` plugin that converts `nostr:` text into nodes on load and on edit.
 *
 * The markdown source always keeps the raw `nostr:` URI text; only the live
 * editor view renders the card/chip (toMarkdown re-emits the URI verbatim).
 */

import { $prose, $nodeSchema, $view } from '@milkdown/utils';
import { Plugin, PluginKey, type EditorState, type Transaction } from '@milkdown/prose/state';
import type { NodeViewConstructor } from '@milkdown/prose/view';
import type { Node as ProseNode } from '@milkdown/prose/model';
import { nip19, type Event } from 'nostr-tools';
import { getSyncEngine } from '../nostr/sync';
import {
  escapeHtml,
  escapeHtmlAttr,
  sanitizeUrl,
  sanitizeImageUrl,
  unescapeHtml,
} from '../security';
import { platform } from '@platform';
import {
  NOSTR_DETECT_REGEX,
  parseNostrEntity,
  truncateBech32,
  type NotePointer,
  type ArticlePointer,
} from '../nostr/entity';

// Plugin key
export const nostrPluginKey = new PluginKey('nostr-embed');

const NJUMP = 'https://njump.me/';

// ============================================================================
// Caching - module-level, Promise-valued so concurrent renders of the same
// reference share a single network round-trip.
// ============================================================================

interface NostrProfile {
  name?: string;
  display_name?: string;
  displayName?: string;
  picture?: string;
  nip05?: string;
}

const eventCache = new Map<string, Promise<Event | null>>();
const profileCache = new Map<string, Promise<NostrProfile | null>>();

function cachedEvent(key: string, fetcher: () => Promise<Event | null>): Promise<Event | null> {
  let p = eventCache.get(key);
  if (!p) {
    p = fetcher().catch((e) => {
      console.error('[nostr-embed] event fetch failed:', e);
      eventCache.delete(key); // allow a retry on the next render
      return null;
    });
    eventCache.set(key, p);
  }
  return p;
}

function cachedProfile(pubkey: string, relayHints: string[]): Promise<NostrProfile | null> {
  let p = profileCache.get(pubkey);
  if (!p) {
    p = getSyncEngine()
      .fetchProfileEvent(pubkey, relayHints)
      .then((ev) => {
        if (!ev) return null;
        try {
          return JSON.parse(ev.content) as NostrProfile;
        } catch {
          return null;
        }
      })
      .catch((e) => {
        console.error('[nostr-embed] profile fetch failed:', e);
        profileCache.delete(pubkey);
        return null;
      });
    profileCache.set(pubkey, p);
  }
  return p;
}

function fetchPointerEvent(pointer: NotePointer | ArticlePointer): Promise<Event | null> {
  if (pointer.kind === 'note') {
    return cachedEvent(`id:${pointer.id}`, () =>
      getSyncEngine().fetchEventByFilter({ ids: [pointer.id], limit: 1 }, pointer.relays)
    );
  }
  const key = `addr:${pointer.eventKind}:${pointer.pubkey}:${pointer.identifier}`;
  return cachedEvent(key, () =>
    getSyncEngine().fetchEventByFilter(
      {
        kinds: [pointer.eventKind],
        authors: [pointer.pubkey],
        '#d': [pointer.identifier],
        limit: 1,
      },
      pointer.relays
    )
  );
}

// ============================================================================
// Display helpers
// ============================================================================

function profileName(profile: NostrProfile | null, pubkey: string): string {
  const name = profile?.display_name || profile?.displayName || profile?.name;
  if (name && name.trim()) return name.trim();
  try {
    return truncateBech32(nip19.npubEncode(pubkey), 10, 4);
  } catch {
    return truncateBech32(pubkey, 10, 4);
  }
}

function formatRelativeTime(createdAt: number): string {
  const diff = Math.max(0, Date.now() / 1000 - createdAt);
  const mins = Math.floor(diff / 60);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.floor(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

function openInClient(bech32: string): void {
  platform.shell.openExternal(`${NJUMP}${bech32}`).catch(() => {});
}

// ============================================================================
// Note content rendering - content is untrusted public data, so escape first
// then carefully re-introduce only sanitized markup (same pattern as
// embed-plugin.ts's simpleMarkdownToHtml).
// ============================================================================

const IMAGE_URL_RE = /https?:\/\/[^\s<]+\.(?:png|jpe?g|gif|webp|avif|bmp|svg)(?:\?[^\s<]*)?/gi;
const URL_RE = /https?:\/\/[^\s<]+/gi;

// Private-use sentinel used to stash finished markup so later passes don't
// reprocess URLs that already live inside an <img>/<a> we created. escapeHtml
// never touches it, and it is stripped from incoming content first.
const SENTINEL = String.fromCharCode(0xe000);

function renderNoteContent(content: string): string {
  let html = escapeHtml(content.split(SENTINEL).join(''));

  const tokens: string[] = [];
  const stash = (markup: string): string => {
    tokens.push(markup);
    return `${SENTINEL}${tokens.length - 1}${SENTINEL}`;
  };

  // 1. Inline images (before generic links so image URLs aren't double-linkified).
  html = html.replace(IMAGE_URL_RE, (m) => {
    const safe = sanitizeImageUrl(unescapeHtml(m));
    if (!safe) return m;
    return stash(`<img class="nostr-note-img" src="${escapeHtmlAttr(safe)}" alt="" loading="lazy" />`);
  });

  // 2. Nested nostr: references -> short, non-recursive links (no nested cards).
  NOSTR_DETECT_REGEX.lastIndex = 0;
  html = html.replace(NOSTR_DETECT_REGEX, (_m, bech32: string) =>
    stash(
      `<a class="nostr-inline-ref" data-bech32="${escapeHtmlAttr(bech32)}">@${escapeHtml(
        truncateBech32(bech32, 10, 4)
      )}</a>`
    )
  );

  // 3. Linkify remaining URLs (the matched text is already HTML-escaped).
  html = html.replace(URL_RE, (m) => {
    const href = escapeHtmlAttr(sanitizeUrl(unescapeHtml(m)));
    return stash(`<a href="${href}" rel="noopener noreferrer">${m}</a>`);
  });

  // 4. Newlines -> <br>.
  html = html.replace(/\n/g, '<br>');

  // Restore stashed markup.
  const restoreRe = new RegExp(`${SENTINEL}(\\d+)${SENTINEL}`, 'g');
  return html.replace(restoreRe, (_m, i) => tokens[Number(i)] ?? '');
}

// ============================================================================
// Node view rendering
// ============================================================================

function clear(el: HTMLElement): void {
  el.textContent = '';
}

function renderLoading(container: HTMLElement, label: string): void {
  clear(container);
  const div = document.createElement('div');
  div.className = 'nostr-loading';
  div.textContent = label;
  container.appendChild(div);
}

function renderBroken(container: HTMLElement, bech32: string, message: string): void {
  clear(container);
  const broken = document.createElement('div');
  broken.className = 'nostr-broken';

  const text = document.createElement('span');
  text.className = 'nostr-broken-text';
  text.textContent = message;
  broken.appendChild(text);

  const link = document.createElement('a');
  link.className = 'nostr-open-link';
  link.textContent = 'Open';
  link.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openInClient(bech32);
  });
  broken.appendChild(link);

  container.appendChild(broken);
}

function buildAvatar(pictureUrl: string | undefined): HTMLElement {
  const safe = sanitizeImageUrl(pictureUrl);
  if (safe) {
    const img = document.createElement('img');
    img.className = 'nostr-note-avatar';
    img.src = safe;
    img.alt = '';
    img.addEventListener('error', () => {
      const fallback = document.createElement('div');
      fallback.className = 'nostr-note-avatar';
      img.replaceWith(fallback);
    });
    return img;
  }
  const div = document.createElement('div');
  div.className = 'nostr-note-avatar';
  return div;
}

async function renderNoteCard(container: HTMLElement, bech32: string, pointer: NotePointer): Promise<void> {
  renderLoading(container, 'Loading note...');
  const event = await fetchPointerEvent(pointer);
  if (!event) {
    renderBroken(container, bech32, 'Note not found');
    return;
  }

  const profile = await cachedProfile(event.pubkey, pointer.relays);

  clear(container);
  const card = document.createElement('div');
  card.className = 'nostr-note';

  // Header: avatar + name + time + open link
  const header = document.createElement('div');
  header.className = 'nostr-note-header';
  header.appendChild(buildAvatar(profile?.picture));

  const meta = document.createElement('div');
  meta.className = 'nostr-note-meta';
  const name = document.createElement('span');
  name.className = 'nostr-note-name';
  name.textContent = profileName(profile, event.pubkey);
  meta.appendChild(name);
  const time = document.createElement('span');
  time.className = 'nostr-note-time';
  time.textContent = formatRelativeTime(event.created_at);
  meta.appendChild(time);
  header.appendChild(meta);

  const open = document.createElement('a');
  open.className = 'nostr-open-link';
  open.textContent = 'Open';
  open.title = 'Open in Nostr client';
  open.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    openInClient(bech32);
  });
  header.appendChild(open);
  card.appendChild(header);

  // Content
  const body = document.createElement('div');
  body.className = 'nostr-note-content';
  body.innerHTML = renderNoteContent(event.content);
  // Nested nostr refs -> open in client
  body.querySelectorAll<HTMLAnchorElement>('a.nostr-inline-ref').forEach((a) => {
    const b = a.getAttribute('data-bech32') || '';
    a.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openInClient(b);
    });
  });
  // External links -> open externally
  body.querySelectorAll<HTMLAnchorElement>('a[href]').forEach((a) => {
    a.addEventListener('click', (e) => {
      const href = a.getAttribute('href') || '';
      if (href.startsWith('#')) return;
      e.preventDefault();
      e.stopPropagation();
      platform.shell.openExternal(href).catch(() => {});
    });
  });
  card.appendChild(body);

  container.appendChild(card);
}

async function renderArticleCard(
  container: HTMLElement,
  bech32: string,
  pointer: ArticlePointer
): Promise<void> {
  renderLoading(container, 'Loading article...');
  const event = await fetchPointerEvent(pointer);
  if (!event) {
    renderBroken(container, bech32, 'Article not found');
    return;
  }

  const tags = new Map<string, string>();
  for (const t of event.tags) {
    if (t.length >= 2 && !tags.has(t[0])) tags.set(t[0], t[1]);
  }
  const title = tags.get('title') || 'Untitled';
  const summary = tags.get('summary') || '';
  const image = sanitizeImageUrl(tags.get('image'));

  const profile = await cachedProfile(event.pubkey, pointer.relays);

  clear(container);
  const card = document.createElement('div');
  card.className = 'nostr-article';
  card.addEventListener('click', () => openInClient(bech32));

  if (image) {
    const img = document.createElement('img');
    img.className = 'nostr-article-image';
    img.src = image;
    img.alt = '';
    img.addEventListener('error', () => img.remove());
    card.appendChild(img);
  }

  const bodyWrap = document.createElement('div');
  bodyWrap.className = 'nostr-article-body';

  const titleEl = document.createElement('div');
  titleEl.className = 'nostr-article-title';
  titleEl.textContent = title;
  bodyWrap.appendChild(titleEl);

  if (summary) {
    const sum = document.createElement('div');
    sum.className = 'nostr-article-summary';
    sum.textContent = summary;
    bodyWrap.appendChild(sum);
  }

  const byline = document.createElement('div');
  byline.className = 'nostr-article-byline';
  byline.textContent = `${profileName(profile, event.pubkey)} - ${formatRelativeTime(event.created_at)}`;
  bodyWrap.appendChild(byline);

  card.appendChild(bodyWrap);
  container.appendChild(card);
}

/** Dispatch a block reference (note / article) to the right renderer. */
function renderBlock(container: HTMLElement, ref: string): void {
  clear(container);
  const parsed = parseNostrEntity(ref);
  if (!parsed) {
    renderBroken(container, ref.replace(/^nostr:/, ''), 'Invalid Nostr reference');
    return;
  }
  const { bech32, pointer } = parsed;
  if (pointer.kind === 'note') {
    renderNoteCard(container, bech32, pointer).catch(() => renderBroken(container, bech32, 'Note not found'));
  } else if (pointer.kind === 'article') {
    renderArticleCard(container, bech32, pointer).catch(() =>
      renderBroken(container, bech32, 'Article not found')
    );
  } else {
    renderBroken(container, bech32, 'Unsupported reference');
  }
}

async function renderMention(container: HTMLElement, bech32: string, pubkey: string, relays: string[]): Promise<void> {
  container.textContent = `@${truncateBech32(bech32, 10, 4)}`;
  if (!pubkey) return;
  const profile = await cachedProfile(pubkey, relays);
  if (profile) {
    container.textContent = `@${profileName(profile, pubkey)}`;
  }
}

// ============================================================================
// Schemas
// ============================================================================

/** Block card node for notes (note/nevent) and articles (naddr). */
export const nostrEmbedSchema = $nodeSchema('nostr_embed', () => ({
  inline: false,
  group: 'block',
  selectable: true,
  draggable: true,
  atom: true,
  marks: '',
  attrs: {
    uri: { default: '' },
    bech32: { default: '' },
    kind: { default: 'note' },
  },
  parseDOM: [
    {
      tag: 'div[data-type="nostr-embed"]',
      getAttrs: (dom: HTMLElement) => ({
        uri: dom.getAttribute('data-uri') || '',
        bech32: dom.getAttribute('data-bech32') || '',
        kind: dom.getAttribute('data-kind') || 'note',
      }),
    },
  ],
  toDOM: (node) => [
    'div',
    {
      'data-type': 'nostr-embed',
      'data-uri': node.attrs.uri,
      'data-bech32': node.attrs.bech32,
      'data-kind': node.attrs.kind,
      class: 'nostr-embed',
    },
  ],
  parseMarkdown: {
    match: ({ type }) => type === 'nostr_embed',
    runner: (state, node, type) => {
      state.addNode(type, {
        uri: node.uri as string,
        bech32: node.bech32 as string,
        kind: node.kind as string,
      });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'nostr_embed',
    runner: (state, node) => {
      // Re-emit the raw URI via an 'html' node so remark-stringify does not
      // escape it (same approach the file-embed plugin uses for ![[...]]).
      state.addNode('html', undefined, node.attrs.uri);
    },
  },
}));

/** Inline mention chip for profiles (npub/nprofile). */
export const nostrMentionSchema = $nodeSchema('nostr_mention', () => ({
  inline: true,
  group: 'inline',
  atom: true,
  selectable: true,
  marks: '',
  attrs: {
    uri: { default: '' },
    bech32: { default: '' },
    pubkey: { default: '' },
  },
  parseDOM: [
    {
      tag: 'span[data-type="nostr-mention"]',
      getAttrs: (dom: HTMLElement) => ({
        uri: dom.getAttribute('data-uri') || '',
        bech32: dom.getAttribute('data-bech32') || '',
        pubkey: dom.getAttribute('data-pubkey') || '',
      }),
    },
  ],
  toDOM: (node) => [
    'span',
    {
      'data-type': 'nostr-mention',
      'data-uri': node.attrs.uri,
      'data-bech32': node.attrs.bech32,
      'data-pubkey': node.attrs.pubkey,
      class: 'nostr-mention',
    },
  ],
  parseMarkdown: {
    match: ({ type }) => type === 'nostr_mention',
    runner: (state, node, type) => {
      state.addNode(type, {
        uri: node.uri as string,
        bech32: node.bech32 as string,
        pubkey: node.pubkey as string,
      });
    },
  },
  toMarkdown: {
    match: (node) => node.type.name === 'nostr_mention',
    runner: (state, node) => {
      // Inline text node carrying the raw URI; nostr: URIs contain no chars
      // remark-stringify escapes, so they round-trip verbatim.
      state.addNode('text', undefined, node.attrs.uri as string);
    },
  },
}));

// ============================================================================
// Node views
// ============================================================================

export const nostrEmbedView = $view(nostrEmbedSchema.node, (): NodeViewConstructor => {
  return (node) => {
    const dom = document.createElement('div');
    dom.className = 'nostr-embed';
    dom.contentEditable = 'false';

    let bech32 = node.attrs.bech32 as string;
    let uri = node.attrs.uri as string;
    renderBlock(dom, bech32 || uri);

    return {
      dom,
      update: (updated) => {
        if (updated.type.name !== 'nostr_embed') return false;
        if (updated.attrs.bech32 !== bech32 || updated.attrs.uri !== uri) {
          bech32 = updated.attrs.bech32;
          uri = updated.attrs.uri;
          renderBlock(dom, bech32 || uri);
        }
        return true;
      },
      selectNode: () => dom.classList.add('selected'),
      deselectNode: () => dom.classList.remove('selected'),
      stopEvent: () => false,
      ignoreMutation: () => true,
    };
  };
});

export const nostrMentionView = $view(nostrMentionSchema.node, (): NodeViewConstructor => {
  return (node) => {
    const dom = document.createElement('span');
    dom.className = 'nostr-mention';
    dom.contentEditable = 'false';

    let bech32 = node.attrs.bech32 as string;
    let pubkey = node.attrs.pubkey as string;

    dom.addEventListener('click', (e) => {
      e.preventDefault();
      openInClient(bech32);
    });

    renderMention(dom, bech32, pubkey, []);

    return {
      dom,
      update: (updated) => {
        if (updated.type.name !== 'nostr_mention') return false;
        if (updated.attrs.bech32 !== bech32 || updated.attrs.pubkey !== pubkey) {
          bech32 = updated.attrs.bech32;
          pubkey = updated.attrs.pubkey;
          renderMention(dom, bech32, pubkey, []);
        }
        return true;
      },
      stopEvent: () => false,
      ignoreMutation: () => true,
    };
  };
});

// ============================================================================
// Text -> node conversion
// ============================================================================

/**
 * Find every `nostr:` URI in the document and convert it to a node.
 * - Profiles (npub/nprofile) become inline mention chips wherever they appear.
 * - Notes/articles become block cards ONLY when the URI is the sole content of
 *   its paragraph (a block node cannot be inserted mid-paragraph); otherwise
 *   they are left as plain text.
 */
function convertNostrInDoc(state: EditorState): Transaction | null {
  const embedType = state.schema.nodes.nostr_embed;
  const mentionType = state.schema.nodes.nostr_mention;
  if (!embedType || !mentionType) return null;

  type Repl = { from: number; to: number; node: ProseNode; sortPos: number };
  const repls: Repl[] = [];

  state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const text = node.text;
    NOSTR_DETECT_REGEX.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = NOSTR_DETECT_REGEX.exec(text)) !== null) {
      const full = m[0]; // includes the nostr: prefix
      const bech32 = m[1];
      const parsed = parseNostrEntity(bech32);
      if (!parsed) continue;
      const uri = `nostr:${bech32}`;
      const matchStart = pos + m.index;
      const matchEnd = matchStart + full.length;

      if (parsed.pointer.kind === 'mention') {
        const mentionNode = mentionType.create({ uri, bech32, pubkey: parsed.pointer.pubkey });
        repls.push({ from: matchStart, to: matchEnd, node: mentionNode, sortPos: matchStart });
      } else {
        // note / article -> block card, only if it's the sole content of its block
        const $pos = state.doc.resolve(matchStart);
        const parent = $pos.parent;
        if (parent.isTextblock && parent.textContent.trim() === full) {
          const kind = parsed.pointer.kind === 'article' ? 'article' : 'note';
          const embedNode = embedType.create({ uri, bech32, kind });
          repls.push({ from: $pos.before(), to: $pos.after(), node: embedNode, sortPos: $pos.before() });
        }
        // otherwise: leave as plain text
      }
    }
  });

  if (!repls.length) return null;

  // Apply highest-position-first so earlier positions stay valid.
  repls.sort((a, b) => b.sortPos - a.sortPos);
  const tr = state.tr;
  for (const r of repls) {
    tr.replaceWith(r.from, r.to, r.node);
  }
  return tr;
}

/**
 * Prose plugin: convert existing `nostr:` text on load and on document changes.
 */
export const nostrProsePlugin = $prose(() => {
  return new Plugin({
    key: nostrPluginKey,

    view(editorView) {
      // Convert after the editor is ready (matches embed plugin timing).
      setTimeout(() => {
        const tr = convertNostrInDoc(editorView.state);
        if (tr) {
          tr.setMeta(nostrPluginKey, true);
          editorView.dispatch(tr);
        }
      }, 0);
      return {};
    },

    appendTransaction(transactions, _oldState, newState) {
      if (!transactions.some((tr) => tr.docChanged && !tr.getMeta(nostrPluginKey))) return null;
      const tr = convertNostrInDoc(newState);
      if (tr) {
        tr.setMeta(nostrPluginKey, true); // prevent recursion
        return tr;
      }
      return null;
    },
  });
});
