import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * The desktop window's UI: the shared renderer plus the Tauri-backed
 * `window.api` (src/desktop/api.ts). Tauri loads it from the dev server in
 * `npm run dev` and from dist/desktop in a build.
 */
export default defineConfig({
  root: resolve(__dirname, 'src/desktop'),
  base: './',
  publicDir: false,
  clearScreen: false,
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  plugins: [react()],
  server: { port: 1420, strictPort: true, fs: { allow: [resolve(__dirname)] } },
  build: {
    outDir: resolve(__dirname, 'dist/desktop'),
    emptyOutDir: true,
    // WebView2 is evergreen Chromium; no need to transpile for older engines.
    target: 'chrome110'
  }
})
