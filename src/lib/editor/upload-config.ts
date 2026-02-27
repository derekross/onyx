import { $prose } from '@milkdown/utils';
import { Plugin, PluginKey } from '@milkdown/prose/state';
import type { EditorView } from '@milkdown/prose/view';
import { writeFile, readFile, mkdir, exists } from '@tauri-apps/plugin-fs';
import { readImage } from '@tauri-apps/plugin-clipboard-manager';
import { isWindows } from '../../lib/platform';

// Module-level state
let currentVaultPath: string | null = null;
let onFilesUploaded: (() => void) | null = null;

export const setUploadVaultPath = (path: string | null) => {
  currentVaultPath = path;
};

export const setOnFilesUploaded = (callback: (() => void) | null) => {
  onFilesUploaded = callback;
};

// Supported file extensions
const IMAGE_EXTENSIONS = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'avif'];
const VIDEO_EXTENSIONS = ['mp4', 'webm', 'mov', 'mkv', 'ogv'];
const AUDIO_EXTENSIONS = ['mp3', 'wav', 'ogg', 'flac', 'm4a', '3gp'];
const PDF_EXTENSIONS = ['pdf'];

const ALL_EXTENSIONS = [...IMAGE_EXTENSIONS, ...VIDEO_EXTENSIONS, ...AUDIO_EXTENSIONS, ...PDF_EXTENSIONS];

/**
 * Join path segments with forward slashes (works on all platforms with Tauri plugin-fs)
 */
function joinPath(...segments: string[]): string {
  if (segments.length === 0) return '';

  // Normalize all segments to forward slashes
  const normalized = segments.map(s => {
    let norm = s.replace(/\\/g, '/');
    // Remove trailing slashes
    norm = norm.replace(/\/+$/, '');
    return norm;
  }).filter(s => s.length > 0);

  let result = normalized.join('/');
  // Clean up any double slashes (except after protocol like file://)
  result = result.replace(/([^:])\/+/g, '$1/');

  return result;
}

/**
 * Check if a path looks like a Windows or Unix file path to a supported file
 */
function extractFilePath(text: string): string | null {
  // Clean up the text - remove quotes and trim
  let cleaned = text.trim().replace(/^["']|["']$/g, '').trim();

  // Check for Windows path (C:\... or \\...)
  const windowsMatch = cleaned.match(/^([A-Za-z]:\\|\\\\).+$/);
  // Check for Unix path (/...)
  const unixMatch = cleaned.match(/^\/[^\s]+$/);

  const path = windowsMatch?.[0] || unixMatch?.[0];
  if (!path) return null;

  // Check if it ends with a supported extension
  const ext = path.split('.').pop()?.toLowerCase();
  if (ext && ALL_EXTENSIONS.includes(ext)) {
    return path;
  }

  return null;
}

/**
 * Save file to vault's attachments folder from a File object
 * Uses @tauri-apps/plugin-fs for efficient binary data transfer
 */
async function saveFileToVault(file: File, vaultPath: string): Promise<string> {
  console.log('[Upload] saveFileToVault called with file:', file.name, 'type:', file.type, 'size:', file.size);
  console.log('[Upload] vaultPath:', vaultPath);

  let fileName = file.name;

  // For clipboard pastes with generic names, generate timestamp-based name
  if (!fileName || fileName === 'image.png' || fileName === 'blob' || fileName === 'image') {
    const ext = getExtensionFromMime(file.type) || 'png';
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    fileName = `pasted-${timestamp}.${ext}`;
  }

  fileName = sanitizeFileName(fileName);

  const attachmentsDir = joinPath(vaultPath, 'attachments');

  // Ensure attachments directory exists
  if (!(await exists(attachmentsDir))) {
    console.log('[Upload] Creating attachments directory:', attachmentsDir);
    await mkdir(attachmentsDir, { recursive: true });
  }

  fileName = await getUniqueFileName(attachmentsDir, fileName);

  const relativePath = `attachments/${fileName}`;
  const fullPath = joinPath(vaultPath, relativePath);

  console.log('[Upload] Saving to fullPath:', fullPath);
  console.log('[Upload] relativePath:', relativePath);

  try {
    const arrayBuffer = await file.arrayBuffer();
    console.log('[Upload] Read', arrayBuffer.byteLength, 'bytes from file');
    
    // Security: Validate file content matches claimed MIME type
    if (!validateFileMagicBytes(arrayBuffer, file.type)) {
      console.error('[Upload] File content does not match claimed MIME type:', file.type);
      throw new Error('File content does not match the expected type. The file may be corrupted or mislabeled.');
    }

    await writeFile(fullPath, new Uint8Array(arrayBuffer));
    console.log('[Upload] File written successfully');

    return relativePath;
  } catch (err) {
    console.error('[Upload] Failed to write file:', err);
    throw err;
  }
}

/**
 * Copy a file from a source path (Windows or Unix) to the vault's attachments folder
 * Uses @tauri-apps/plugin-fs for efficient binary data transfer
 */
async function copyFileToVault(sourcePath: string, vaultPath: string): Promise<string> {
  console.log('[Upload] copyFileToVault called with sourcePath:', sourcePath);

  // Extract filename from path
  const pathParts = sourcePath.replace(/\\/g, '/').split('/');
  let fileName = pathParts[pathParts.length - 1];

  fileName = sanitizeFileName(fileName);

  const attachmentsDir = joinPath(vaultPath, 'attachments');

  // Ensure attachments directory exists
  if (!(await exists(attachmentsDir))) {
    console.log('[Upload] Creating attachments directory:', attachmentsDir);
    await mkdir(attachmentsDir, { recursive: true });
  }

  fileName = await getUniqueFileName(attachmentsDir, fileName);

  const relativePath = `attachments/${fileName}`;
  const fullPath = joinPath(vaultPath, relativePath);

  console.log('[Upload] Copying to fullPath:', fullPath);

  try {
    // Read source file as binary using plugin-fs
    const data = await readFile(sourcePath);
    console.log('[Upload] Read', data.length, 'bytes from source');

    // Write to destination
    await writeFile(fullPath, data);
    console.log('[Upload] File copied successfully');

    return relativePath;
  } catch (err) {
    console.error('[Upload] Failed to copy file:', err);
    throw err;
  }
}

/**
 * Insert an embed node at the current position
 */
function insertEmbed(view: EditorView, relativePath: string): boolean {
  console.log('[Upload] insertEmbed called with path:', relativePath);

  const { state, dispatch } = view;
  const embedType = state.schema.nodes.embed;

  if (!embedType) {
    console.error('[Upload] Embed node type not found in schema');
    return false;
  }

  const node = embedType.create({
    target: relativePath,
    anchor: null,
    width: null,
    height: null,
  });

  const tr = state.tr.replaceSelectionWith(node);
  dispatch(tr);

  console.log('[Upload] Embed node inserted');
  return true;
}

/**
 * Handle an array of File objects (from clipboardData.items or filtered files)
 */
async function handleFileArray(files: File[], view: EditorView): Promise<boolean> {
  console.log('[Upload] handleFileArray called with', files.length, 'files');
  console.log('[Upload] currentVaultPath:', currentVaultPath);

  if (!currentVaultPath || files.length === 0) return false;

  let handled = false;

  for (const file of files) {
    console.log('[Upload] Processing file:', file.name, 'type:', file.type, 'size:', file.size);
    if (!isSupportedFileType(file.type)) continue;

    try {
      const relativePath = await saveFileToVault(file, currentVaultPath);
      insertEmbed(view, relativePath);
      handled = true;
    } catch (err) {
      console.error('[Upload] Failed to save file:', err);
    }
  }

  if (handled) {
    console.log('[Upload] Files uploaded, triggering callback');
    onFilesUploaded?.();
  }

  return handled;
}

/**
 * Handle pasted text that might be a file path
 */
async function handleFilePath(text: string, view: EditorView): Promise<boolean> {
  console.log('[Upload] handleFilePath called with:', text);

  if (!currentVaultPath) {
    console.log('[Upload] No vault path set');
    return false;
  }

  const filePath = extractFilePath(text);
  if (!filePath) {
    console.log('[Upload] No valid file path found in text');
    return false;
  }

  console.log('[Upload] Extracted file path:', filePath);

  try {
    const relativePath = await copyFileToVault(filePath, currentVaultPath);
    insertEmbed(view, relativePath);
    onFilesUploaded?.();
    return true;
  } catch (err) {
    console.error('[Upload] Failed to copy file from path:', err);
    return false;
  }
}

// Plugin key for identification
const uploadPluginKey = new PluginKey('vault-upload');

/**
 * Custom ProseMirror plugin for handling file uploads via paste
 * Note: Drag-drop is handled separately by Tauri's tauri://drag-drop event
 */
export const vaultUploadPlugin = $prose(() => {
  return new Plugin({
    key: uploadPluginKey,
    props: {
      handlePaste(view, event) {
        console.log('[Upload] handlePaste triggered');

        if (!currentVaultPath) {
          console.log('[Upload] No vault path, skipping');
          return false;
        }

        const clipboardData = event.clipboardData;
        if (!clipboardData) {
          console.log('[Upload] No clipboard data');
          return false;
        }

        // First, check for files (images from clipboard)
        // On Windows, clipboardData.files may be empty or contain 0-byte entries
        // for screenshot pastes. We also check clipboardData.items as a fallback.
        const files = clipboardData.files;
        console.log('[Upload] Clipboard files:', files?.length || 0);

        let filesToHandle: File[] = [];

        // Try clipboardData.files first
        if (files && files.length > 0) {
          for (let i = 0; i < files.length; i++) {
            const file = files.item(i);
            if (file && file.size > 0 && isSupportedFileType(file.type)) {
              filesToHandle.push(file);
            }
          }
        }

        // Fallback: check clipboardData.items (more reliable on Windows for screenshots)
        if (filesToHandle.length === 0 && clipboardData.items) {
          for (let i = 0; i < clipboardData.items.length; i++) {
            const item = clipboardData.items[i];
            console.log('[Upload] Item', i, ':', item.kind, item.type);
            if (item.kind === 'file' && isSupportedFileType(item.type)) {
              const file = item.getAsFile();
              if (file && file.size > 0) {
                filesToHandle.push(file);
              }
            }
          }
        }

        if (filesToHandle.length > 0) {
          console.log('[Upload] Found', filesToHandle.length, 'supported files, handling...');
          event.preventDefault();

          // Handle async properly - don't insert embed until file is saved
          const fileList = filesToHandle;
          (async () => {
            try {
              await handleFileArray(fileList, view);
            } catch (err) {
              console.error('[Upload] Error in handleFiles:', err);
            }
          })();

          return true;
        }

        // Check for text that might be a file path
        const text = clipboardData.getData('text/plain');
        console.log('[Upload] Clipboard text:', text?.substring(0, 100));

        if (text) {
          const filePath = extractFilePath(text);
          if (filePath) {
            console.log('[Upload] Found file path, handling...');
            event.preventDefault();

            (async () => {
              try {
                await handleFilePath(text, view);
              } catch (err) {
                console.error('[Upload] Error in handleFilePath:', err);
              }
            })();

            return true;
          }
        }

        // Final fallback (Windows only): use Tauri clipboard plugin to read image
        // data directly. On Windows WebView2, clipboardData may not expose screenshot
        // image data through the standard files/items APIs. The Tauri clipboard plugin
        // reads from the native OS clipboard, bypassing WebView2 limitations.
        if (isWindows() && !text) {
          event.preventDefault();

          (async () => {
            try {
              console.log('[Upload] Trying Tauri clipboard readImage fallback...');
              const clipImage = await readImage();
              const rgba = await clipImage.rgba();
              const { width, height } = await clipImage.size();

              if (rgba.length > 0 && width > 0 && height > 0) {
                // Convert RGBA to PNG using an offscreen canvas
                const canvas = new OffscreenCanvas(width, height);
                const ctx2d = canvas.getContext('2d');
                if (ctx2d) {
                  const imageData = new ImageData(new Uint8ClampedArray(rgba), width, height);
                  ctx2d.putImageData(imageData, 0, 0);
                  const pngBlob = await canvas.convertToBlob({ type: 'image/png' });

                  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
                  const file = new File([pngBlob], `pasted-${timestamp}.png`, { type: 'image/png' });
                  await handleFileArray([file], view);
                }
              }
            } catch (err) {
              // No image on clipboard or clipboard read failed — this is expected
              // on Linux/macOS where the standard clipboard APIs work correctly.
              console.log('[Upload] Tauri clipboard fallback: no image found');
            }
          })();

          return true;
        }

        console.log('[Upload] No supported content found');
        return false;
      },
      // Note: handleDrop is intentionally NOT implemented here.
      // OS file drops are handled via DOM drop event listeners in Editor.tsx.
    },
  });
});

// Helper functions

/**
 * Get a unique filename in the given directory
 */
async function getUniqueFileName(directory: string, fileName: string): Promise<string> {
  const ext = fileName.split('.').pop() || '';
  const nameWithoutExt = ext ? fileName.slice(0, -(ext.length + 1)) : fileName;

  let candidate = fileName;
  let counter = 1;

  while (await exists(joinPath(directory, candidate))) {
    candidate = `${nameWithoutExt}-${counter}.${ext}`;
    counter++;
  }

  return candidate;
}

function getExtensionFromMime(mimeType: string): string | null {
  const map: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/gif': 'gif',
    'image/webp': 'webp',
    'image/svg+xml': 'svg',
    'image/bmp': 'bmp',
    'image/avif': 'avif',
    'video/mp4': 'mp4',
    'video/webm': 'webm',
    'video/quicktime': 'mov',
    'audio/mpeg': 'mp3',
    'audio/wav': 'wav',
    'audio/ogg': 'ogg',
    'audio/flac': 'flac',
    'application/pdf': 'pdf',
  };
  return map[mimeType] || null;
}

function sanitizeFileName(name: string): string {
  // Replace problematic characters but keep the name readable
  return name
    .replace(/[<>:"|?*]/g, '-')
    .replace(/\\/g, '-')
    .replace(/\//g, '-')
    .replace(/\s+/g, '-');
}

function isSupportedFileType(mimeType: string): boolean {
  if (!mimeType) return false;
  return (
    mimeType.startsWith('image/') ||
    mimeType.startsWith('video/') ||
    mimeType.startsWith('audio/') ||
    mimeType === 'application/pdf'
  );
}

/**
 * Magic byte signatures for common file types
 * Used to verify file content matches claimed MIME type
 */
const MAGIC_BYTES: Record<string, number[][]> = {
  // Images
  'image/jpeg': [[0xFF, 0xD8, 0xFF]],
  'image/png': [[0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]],
  'image/gif': [[0x47, 0x49, 0x46, 0x38, 0x37, 0x61], [0x47, 0x49, 0x46, 0x38, 0x39, 0x61]], // GIF87a, GIF89a
  'image/webp': [[0x52, 0x49, 0x46, 0x46]], // RIFF (+ WEBP at offset 8)
  'image/bmp': [[0x42, 0x4D]], // BM
  'image/svg+xml': [[0x3C, 0x3F, 0x78, 0x6D, 0x6C], [0x3C, 0x73, 0x76, 0x67]], // <?xml, <svg
  // Video
  'video/mp4': [[0x00, 0x00, 0x00], [0x66, 0x74, 0x79, 0x70]], // ftyp at offset 4
  'video/webm': [[0x1A, 0x45, 0xDF, 0xA3]], // EBML
  'video/quicktime': [[0x00, 0x00, 0x00]], // Similar to mp4
  // Audio
  'audio/mpeg': [[0xFF, 0xFB], [0xFF, 0xFA], [0xFF, 0xF3], [0x49, 0x44, 0x33]], // MP3 frames, ID3
  'audio/wav': [[0x52, 0x49, 0x46, 0x46]], // RIFF
  'audio/ogg': [[0x4F, 0x67, 0x67, 0x53]], // OggS
  'audio/flac': [[0x66, 0x4C, 0x61, 0x43]], // fLaC
  // Documents
  'application/pdf': [[0x25, 0x50, 0x44, 0x46]], // %PDF
};

/**
 * Validate file content matches the claimed MIME type using magic bytes
 * Returns true if valid or if MIME type is not in our signature database
 */
export function validateFileMagicBytes(data: ArrayBuffer, mimeType: string): boolean {
  const signatures = MAGIC_BYTES[mimeType];
  if (!signatures) {
    // Unknown type - allow but log warning
    console.warn(`[Security] No magic byte signature for MIME type: ${mimeType}`);
    return true;
  }
  
  const bytes = new Uint8Array(data);
  if (bytes.length < 4) {
    return false; // File too small to validate
  }
  
  // Check if any signature matches
  return signatures.some(signature => {
    for (let i = 0; i < signature.length && i < bytes.length; i++) {
      if (bytes[i] !== signature[i]) {
        return false;
      }
    }
    return true;
  });
}

// Export utilities for use in Editor.tsx drag-drop handler
export { joinPath, sanitizeFileName, ALL_EXTENSIONS };

/**
 * Get a unique filename - exported for use in Editor.tsx
 */
export async function getUniqueFileNameInVault(
  vaultPath: string,
  folder: string,
  fileName: string
): Promise<string> {
  const directory = joinPath(vaultPath, folder);
  return getUniqueFileName(directory, fileName);
}
