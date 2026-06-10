import { defineConfig } from 'vite';
import solid from 'vite-plugin-solid';
import { VitePWA } from 'vite-plugin-pwa';
import path from 'node:path';
import { readFileSync } from 'node:fs';

const pkg = JSON.parse(readFileSync(path.resolve(__dirname, 'package.json'), 'utf-8')) as {
  version: string;
};

// BUILD_TARGET selects which platform adapter is bundled:
//   - 'tauri' (default): wraps Tauri commands. Used for desktop + Android builds.
//   - 'web':            browser-only PWA via OPFS + IndexedDB + WebCrypto.
const BUILD_TARGET = (process.env.BUILD_TARGET ?? 'tauri') as 'tauri' | 'web';

const platformEntry =
  BUILD_TARGET === 'web'
    ? path.resolve(__dirname, 'src/platform/web/index.ts')
    : path.resolve(__dirname, 'src/platform/tauri/index.ts');

// The Tauri build gets its CSP from tauri.conf.json; the web build needs its own.
// Injected only into production builds so the dev server (HMR websocket, inline
// preamble) keeps working.
const WEB_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' https: data: blob:",
  "media-src 'self' https: blob:",
  "connect-src 'self' https: wss: blob:",
  "worker-src 'self' blob:",
  "font-src 'self' data:",
  "object-src 'none'",
  "frame-src 'none'",
  "base-uri 'self'",
].join('; ');

const webCspPlugin = () => ({
  name: 'onyx-web-csp',
  apply: 'build' as const,
  transformIndexHtml() {
    return [
      {
        tag: 'meta',
        attrs: { 'http-equiv': 'Content-Security-Policy', content: WEB_CSP },
        injectTo: 'head-prepend' as const,
      },
    ];
  },
});

const webPlugins =
  BUILD_TARGET === 'web'
    ? [
        webCspPlugin(),
        VitePWA({
          registerType: 'autoUpdate',
          includeAssets: ['icons/icon.png', 'icons/128x128.png', 'icons/128x128@2x.png'],
          manifest: {
            name: 'Onyx',
            short_name: 'Onyx',
            description: 'Nostr-synced markdown notes.',
            theme_color: '#1e1e1e',
            background_color: '#1e1e1e',
            display: 'standalone',
            start_url: '/',
            scope: '/',
            icons: [
              { src: '/icons/128x128.png', sizes: '128x128', type: 'image/png' },
              { src: '/icons/128x128@2x.png', sizes: '256x256', type: 'image/png' },
              { src: '/icons/icon.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
            ],
          },
          workbox: {
            // Don't intercept routes that look like deep-link callbacks or
            // future WebSocket upgrade paths.
            navigateFallbackDenylist: [/^\/api\//, /^\/ws\//],
            maximumFileSizeToCacheInBytes: 5 * 1024 * 1024,
            globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
          },
        }),
      ]
    : [];

export default defineConfig({
  plugins: [solid(), ...webPlugins],
  clearScreen: false,
  resolve: {
    alias: {
      '@platform': platformEntry,
    },
  },
  define: {
    'import.meta.env.BUILD_TARGET': JSON.stringify(BUILD_TARGET),
    'import.meta.env.VITE_APP_VERSION': JSON.stringify(pkg.version),
  },
  esbuild: {
    // Treat debug logging as side-effect free so minified builds drop it.
    pure: ['console.log', 'console.debug', 'console.trace'],
  },
  server: {
    port: 1420,
    strictPort: true,
    watch: {
      ignored: ['**/src-tauri/**'],
    },
  },
  ...(BUILD_TARGET === 'web'
    ? {
        build: { outDir: 'dist-web' },
        // optimizeDeps.exclude only matches exact package-id strings (no RegExp),
        // so every Tauri plugin must be listed explicitly.
        optimizeDeps: {
          exclude: [
            '@tauri-apps/api',
            '@tauri-apps/plugin-biometric',
            '@tauri-apps/plugin-clipboard-manager',
            '@tauri-apps/plugin-deep-link',
            '@tauri-apps/plugin-dialog',
            '@tauri-apps/plugin-fs',
            '@tauri-apps/plugin-haptics',
            '@tauri-apps/plugin-notification',
            '@tauri-apps/plugin-opener',
            '@tauri-apps/plugin-shell',
            '@tauri-apps/plugin-store',
          ],
        },
      }
    : {}),
});
