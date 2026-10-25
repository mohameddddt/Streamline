import { resolve } from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

/**
 * The web build: the desktop renderer plus a browser implementation of
 * `window.api` (src/web/api.ts). Relative `base` so it can be hosted from any
 * sub-path — GitHub Pages, a folder on a server, or opened from disk.
 */
export default defineConfig({
  root: resolve(__dirname, 'src/web'),
  base: './',
  publicDir: false,
  resolve: { alias: { '@shared': resolve(__dirname, 'src/shared') } },
  plugins: [react()],
  server: { port: 5180, fs: { allow: [resolve(__dirname)] } },
  build: { outDir: resolve(__dirname, 'dist/web'), emptyOutDir: true }
})
