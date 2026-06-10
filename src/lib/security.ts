/**
 * Security utilities for sanitizing untrusted content
 */

/**
 * Sanitize a URL to prevent dangerous protocols (javascript:, data:, vbscript:, etc.)
 * Only allows http, https, and mailto protocols.
 * 
 * @param url - The URL to sanitize
 * @returns Safe URL or '#blocked-unsafe-url' if dangerous
 */
export function sanitizeUrl(url: string): string {
  if (!url || typeof url !== 'string') {
    return '#invalid-url';
  }

  const trimmed = url.trim().toLowerCase();

  // Only allow http, https, and mailto protocols
  if (trimmed.startsWith('http://') ||
      trimmed.startsWith('https://') ||
      trimmed.startsWith('mailto:')) {
    return encodeUnsafeUrlChars(url.trim());
  }

  // For relative URLs that don't start with a protocol
  if (!trimmed.includes(':')) {
    return encodeUnsafeUrlChars(url.trim());
  }

  // Block javascript:, data:, vbscript:, file:, etc.
  return '#blocked-unsafe-url';
}

/**
 * Percent-encode characters that could break out of an HTML attribute or
 * otherwise be abused if a URL is interpolated into markup: quotes,
 * backticks, angle brackets, backslashes, whitespace, and control chars.
 * Legitimate URLs remain functional (percent-encoding is transparent).
 */
function encodeUnsafeUrlChars(url: string): string {
  // eslint-disable-next-line no-control-regex
  return url.replace(/[\u0000-\u0020\u007f"'`<>\\]/g, (ch) =>
    '%' + ch.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0')
  );
}

/**
 * Sanitize an image URL - only allows https (not http for security)
 * 
 * @param url - The image URL to sanitize
 * @returns Safe URL or undefined if dangerous
 */
export function sanitizeImageUrl(url: string | undefined): string | undefined {
  if (!url || typeof url !== 'string') {
    return undefined;
  }
  
  const trimmed = url.trim().toLowerCase();
  
  // Only allow https for images (no http to prevent mixed content/MITM)
  if (trimmed.startsWith('https://')) {
    return url;
  }
  
  // Allow http in development only (check for localhost)
  if (trimmed.startsWith('http://localhost') || trimmed.startsWith('http://127.0.0.1')) {
    return url;
  }
  
  // Block data:, blob:, javascript:, etc.
  return undefined;
}

/**
 * Sanitize a file path to prevent directory traversal attacks
 * Removes ../, ..\, leading slashes, and ensures path stays within bounds
 * 
 * @param path - The file path to sanitize
 * @returns Safe path with traversal attempts removed
 */
export function sanitizeFilePath(path: string): string {
  if (!path || typeof path !== 'string') {
    return 'untitled';
  }
  
  let sanitized = path
    // Normalize path separators
    .replace(/\\/g, '/')
    // Remove null bytes (poison null byte attack)
    .replace(/\0/g, '')
    // Remove control characters
    .replace(/[\x00-\x1f\x7f]/g, '');
  
  // Loop to remove traversal attempts until stable (prevents ....// bypass)
  let prev = '';
  while (prev !== sanitized) {
    prev = sanitized;
    sanitized = sanitized
      .replace(/\.\.\//g, '')
      .replace(/\.\.\\/g, '');
  }
  
  sanitized = sanitized
    // Remove leading slashes (absolute path attempts)
    .replace(/^\/+/, '')
    // Remove drive letters (Windows)
    .replace(/^[a-zA-Z]:/, '')
    // Remove any remaining suspicious patterns
    .replace(/\.\.+/g, '.');
  
  // If path is empty after sanitization, use default
  if (!sanitized || sanitized === '.' || sanitized === '/') {
    return 'untitled';
  }
  
  return sanitized;
}

/**
 * Extract just the filename from a path, sanitized
 * 
 * @param path - Full file path
 * @returns Just the filename portion, sanitized
 */
export function sanitizeFilename(path: string): string {
  if (!path || typeof path !== 'string') {
    return 'untitled';
  }
  
  // Extract filename from path (handles both Windows and Unix paths)
  const parts = path.split(/[/\\]/);
  let filename = parts[parts.length - 1] || 'untitled';
  
  // Remove dangerous characters from filename
  filename = filename
    .replace(/\0/g, '')  // Null bytes
    .replace(/[\x00-\x1f\x7f]/g, '')  // Control characters
    .replace(/[<>:"|?*]/g, '_');  // Windows reserved characters
  
  // Prevent hidden files on Unix
  if (filename.startsWith('.')) {
    filename = '_' + filename.slice(1);
  }
  
  return filename || 'untitled';
}

/**
 * Escape HTML entities to prevent XSS when inserting into HTML
 * 
 * @param text - Text to escape
 * @returns HTML-escaped text
 */
export function escapeHtml(text: string): string {
  if (!text || typeof text !== 'string') {
    return '';
  }
  
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

/**
 * Escape a value for safe interpolation into a quoted HTML attribute.
 * Escapes & < > " ' so the value cannot terminate the attribute or
 * introduce new attributes/tags.
 *
 * @param value - Attribute value to escape
 * @returns Attribute-safe escaped value
 */
export function escapeHtmlAttr(value: string): string {
  return escapeHtml(value);
}

/**
 * Decode the HTML entities produced by escapeHtml back to raw characters.
 * Useful when a substring (e.g. a markdown link URL) is captured from
 * already-escaped text and must be processed in its raw form before being
 * re-escaped for output.
 *
 * @param text - HTML-escaped text
 * @returns Raw, unescaped text
 */
export function unescapeHtml(text: string): string {
  if (!text || typeof text !== 'string') {
    return '';
  }

  return text
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

// Elements that are removed entirely (including their content) by sanitizeHtml
const SANITIZE_FORBIDDEN_TAGS = new Set([
  'script', 'style', 'iframe', 'object', 'embed', 'link', 'meta', 'form', 'base',
]);

/**
 * Check whether a URL is safe to keep in an href/src attribute.
 * Allows http:, https:, mailto:, relative URLs, and (optionally)
 * data:image/* URLs for inline images.
 */
function isSafeSanitizedUrl(value: string, allowDataImage: boolean): boolean {
  // Strip whitespace/control chars that browsers ignore when parsing schemes
  const normalized = value.replace(/\s/g, '').toLowerCase();

  if (normalized.startsWith('http://') ||
      normalized.startsWith('https://') ||
      normalized.startsWith('mailto:')) {
    return true;
  }

  if (allowDataImage && normalized.startsWith('data:image/')) {
    return true;
  }

  // Relative URLs (no scheme)
  if (!normalized.includes(':')) {
    return true;
  }

  // javascript:, vbscript:, generic data:, file:, etc.
  return false;
}

/**
 * Sanitize an untrusted HTML string (e.g. converter output such as mammoth's
 * DOCX-to-HTML) so it is safe to render via innerHTML.
 *
 * - Removes script/style/iframe/object/embed/link/meta/form/base elements
 * - Removes all on* event handler attributes plus srcdoc/formaction
 * - Restricts href/src/xlink:href to http:, https:, mailto:, relative URLs,
 *   and data:image/* for img src
 *
 * @param html - Untrusted HTML
 * @returns Sanitized HTML safe for innerHTML
 */
export function sanitizeHtml(html: string): string {
  if (!html || typeof html !== 'string') {
    return '';
  }

  const doc = new DOMParser().parseFromString(html, 'text/html');

  const elements = Array.from(doc.body.querySelectorAll('*'));
  for (const el of elements) {
    if (SANITIZE_FORBIDDEN_TAGS.has(el.tagName.toLowerCase())) {
      el.remove();
      continue;
    }

    for (const attr of Array.from(el.attributes)) {
      const name = attr.name.toLowerCase();

      // Event handlers and HTML injection vectors
      if (name.startsWith('on') || name === 'srcdoc' || name === 'formaction') {
        el.removeAttribute(attr.name);
        continue;
      }

      // URL-bearing attributes
      if (name === 'href' || name === 'src' || name === 'xlink:href') {
        const allowDataImage =
          name === 'src' && el.tagName.toLowerCase() === 'img';
        if (!isSafeSanitizedUrl(attr.value, allowDataImage)) {
          el.removeAttribute(attr.name);
        }
      }
    }
  }

  return doc.body.innerHTML;
}
