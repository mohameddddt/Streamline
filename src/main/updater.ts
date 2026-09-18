import { app, BrowserWindow } from 'electron'
import type { UpdateState } from '../shared/types'

/** Left in package.json until a real repo is configured. */
const PLACEHOLDER_OWNER = 'YOUR_GITHUB_USERNAME'

let state: UpdateState = { status: 'idle', version: '', notes: '', progress: 0 }
let wired = false

function publishOwner(): string {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const pkg = require('../../package.json')
    const publish = pkg?.build?.publish
    const entry = Array.isArray(publish) ? publish[0] : publish
    return entry?.owner ?? ''
  } catch {
    return ''
  }
}

export function isConfigured(): boolean {
  const owner = publishOwner()
  return Boolean(owner) && owner !== PLACEHOLDER_OWNER
}

function broadcast(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    win.webContents.send('update:state', state)
  }
}

function set(patch: Partial<UpdateState>): void {
  state = { ...state, ...patch }
  broadcast()
}

function getAutoUpdater(): any {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { autoUpdater } = require('electron-updater')
  if (!wired) {
    wired = true
    autoUpdater.autoDownload = true
    autoUpdater.autoInstallOnAppQuit = true
    autoUpdater.on('checking-for-update', () => set({ status: 'checking' }))
    autoUpdater.on('update-available', (info: any) =>
      set({ status: 'downloading', version: info?.version ?? '', progress: 0 })
    )
    autoUpdater.on('update-not-available', () => set({ status: 'current' }))
    autoUpdater.on('download-progress', (p: any) =>
      set({ status: 'downloading', progress: (p?.percent ?? 0) / 100 })
    )
    autoUpdater.on('update-downloaded', (info: any) =>
      set({
        status: 'ready',
        version: info?.version ?? '',
        notes: typeof info?.releaseNotes === 'string' ? info.releaseNotes : '',
        progress: 1
      })
    )
    autoUpdater.on('error', (err: Error) =>
      set({ status: 'error', notes: err?.message ?? String(err) })
    )
  }
  return autoUpdater
}

export function getState(): UpdateState {
  return state
}

export async function check(silent = false): Promise<UpdateState> {
  if (!app.isPackaged) {
    set({ status: 'dev', notes: 'Updates only apply to the installed app.' })
    return state
  }
  if (!isConfigured()) {
    set({
      status: 'unconfigured',
      notes: 'No update server is set. Add a GitHub repo under "build.publish" in package.json.'
    })
    return state
  }
  try {
    await getAutoUpdater().checkForUpdates()
  } catch (err) {
    if (!silent) set({ status: 'error', notes: (err as Error).message })
  }
  return state
}

/** Restarts into the new version. Only valid once status is 'ready'. */
export function installNow(): void {
  if (state.status !== 'ready') return
  getAutoUpdater().quitAndInstall()
}

export function checkOnStartup(): void {
  if (!app.isPackaged || !isConfigured()) return
  setTimeout(() => {
    check(true).catch(() => undefined)
  }, 8000)
}
