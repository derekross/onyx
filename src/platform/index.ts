// Platform adapter — alias entrypoint.
//
// Vite's `@platform` alias points here. The alias resolution in vite.config.ts
// rewrites `@platform` to `./tauri/index.ts` (default) or `./web/index.ts`
// (when BUILD_TARGET=web). This file exists so that direct `from './platform'`
// imports still resolve in non-Vite tooling (tsc, IDE), defaulting to the
// Tauri implementation.

export * from './types';
export { platform } from './tauri';
