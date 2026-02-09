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
    return url;
  }
  
  // For relative URLs that don't start with a protocol
  if (!trimmed.includes(':')) {
    return url;
  }
  
  // Block javascript:, data:, vbscript:, file:, etc.
  return '#blocked-unsafe-url';
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
