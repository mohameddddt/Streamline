import { app, BrowserWindow, ipcMain, shell, dialog, powerSaveBlocker } from 'electron'
import { spawn } from 'child_process'
import path from 'path'
import * as addons from './addons'
import * as torrent from './torrent'
import * as downloads from './downloads'
import * as playback from './playback'
import * as trackers from './trackers'
import * as updater from './updater'
import * as importer from './importer'
import * as companion from './companion'
import fs from 'fs'
import {
  getSettings,
  saveSettings,
  getLibrary,
  toggleFavorite,
  setProgress,
  clearProgress,
  markWatched,
  getLastStream,
  setLastStream,
  setRating,
  makeBackup,
  restoreBackup,
  regenerateCompanionToken
} from './settings'
import type {
  LibraryBackup,
  DeviceAuth,
  ImportService,
  LibraryItem,
  PlaybackSource,
  ProgressEntry,
  Settings,
  Stream,
  TrackerName
} from '../shared/types'

let mainWindow: BrowserWindow | null = null
let blockerId: number | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 940,
    minHeight: 600,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0b0c0f',
    title: 'Streamline',
    icon: path.join(__dirname, '../../resources/icon.png'),
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.once('ready-to-show', () => mainWindow?.show())

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

// ------------------------------------------------------------------- ipc api

function registerIpc(): void {
  const handle = <T extends unknown[], R>(
    channel: string,
    fn: (...args: T) => R | Promise<R>
  ): void => {
    ipcMain.handle(channel, async (_e, ...args) => fn(...(args as T)))
  }

  handle('settings:get', () => getSettings())
  handle('settings:set', async (patch: Partial<Settings>) => {
    const next = saveSettings(patch)
    addons.forgetManifests()
    if ('companionEnabled' in patch) await companion.sync()
    return next
  })
  handle('settings:pickFolder', async () => {
    const res = await dialog.showOpenDialog({ properties: ['openDirectory', 'createDirectory'] })
    return res.canceled ? null : res.filePaths[0]
  })
  handle('settings:pickFile', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Applications', extensions: ['exe', 'app', 'bat', 'cmd', ''] }]
    })
    return res.canceled ? null : res.filePaths[0]
  })

  handle('addons:manifests', () => addons.getManifests())
  handle('addons:catalogs', () => addons.listCatalogs())
  handle('addons:probe', (url: string) => addons.getManifest(url))
  handle(
    'addons:catalog',
    (addonUrl: string, type: string, id: string, extra?: Record<string, string>) =>
      addons.getCatalog(addonUrl, type, id, extra)
  )
  handle('addons:search', (query: string, type?: string) => addons.search(query, type))
  handle('addons:meta', (type: string, id: string) => addons.getMeta(type, id))
  handle('addons:streams', (type: string, id: string) => addons.getStreams(type, id))
  handle('addons:subtitles', (type: string, id: string, extra?: Record<string, string>) =>
    addons.getSubtitles(type, id, extra)
  )
  handle('addons:subtitleVtt', (url: string) => addons.fetchSubtitleAsVtt(url))

  handle('torrent:warm', () => torrent.warmUp())
  handle('torrent:start', (stream: Stream) => torrent.startStream(stream))
  handle('torrent:stats', (infoHash: string) => torrent.getStats(infoHash))
  handle('torrent:remove', (infoHash: string) => torrent.removeTorrent(infoHash))

  handle('library:get', () => getLibrary())
  handle('library:toggleFavorite', (item: LibraryItem) => toggleFavorite(item))
  handle('library:setProgress', (entry: ProgressEntry) => setProgress(entry))
  handle('library:clearProgress', (key: string) => clearProgress(key))
  handle(
    'library:markWatched',
    (key: string, watched: boolean, seed?: Parameters<typeof markWatched>[2]) =>
      markWatched(key, watched, seed)
  )
  handle('library:setRating', (entry: Parameters<typeof setRating>[0], rating: number | null) =>
    setRating(entry, rating)
  )
  handle('library:backup', async () => {
    const stamp = new Date().toISOString().slice(0, 10)
    const res = await dialog.showSaveDialog({
      defaultPath: `streamline-library-${stamp}.json`,
      filters: [{ name: 'Streamline backup', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePath) return null
    const backup = makeBackup()
    fs.writeFileSync(res.filePath, JSON.stringify(backup, null, 2), 'utf8')
    return { count: backup.items.length + backup.progress.length + backup.ratings.length }
  })
  handle('library:restore', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile'],
      filters: [{ name: 'Streamline backup', extensions: ['json'] }]
    })
    if (res.canceled || !res.filePaths[0]) return null
    const backup = JSON.parse(fs.readFileSync(res.filePaths[0], 'utf8')) as LibraryBackup
    return { count: restoreBackup(backup) }
  })

  handle('companion:info', () => companion.info())
  handle('companion:configure', async (patch: { enabled?: boolean; regenerate?: boolean }) => {
    if (patch.regenerate) regenerateCompanionToken()
    if (patch.enabled !== undefined) saveSettings({ companionEnabled: patch.enabled })
    return companion.sync()
  })

  handle('library:getLastStream', (key: string) => getLastStream(key))
  handle('library:setLastStream', (key: string, stream: Stream) => setLastStream(key, stream))

  handle('import:pickFiles', async () => {
    const res = await dialog.showOpenDialog({
      properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Exports', extensions: ['zip', 'csv'] }]
    })
    return res.canceled ? [] : res.filePaths
  })
  handle('import:start', (service: ImportService, paths: string[]) =>
    importer.start(service, paths)
  )
  handle('import:status', () => importer.getStatus())

  handle('downloads:list', () => downloads.list())
  handle('downloads:progress', () => downloads.progress())
  handle('downloads:start', (stream: Stream, info: downloads.DownloadInfo) =>
    downloads.start(stream, info)
  )
  handle('downloads:pause', (infoHash: string) => downloads.pause(infoHash))
  handle('downloads:resume', (infoHash: string) => downloads.resume(infoHash))
  handle('downloads:remove', (infoHash: string, deleteFiles: boolean) =>
    downloads.remove(infoHash, deleteFiles)
  )
  handle('downloads:playSource', (infoHash: string) => downloads.playSource(infoHash))
  handle('downloads:reveal', (infoHash: string) => {
    const filePath = downloads.filePathFor(infoHash)
    if (!filePath) throw new Error('That download is no longer in your library.')
    shell.showItemInFolder(filePath)
    return true
  })

  handle('playback:plan', (source: PlaybackSource) => playback.plan(source))

  handle('trackers:status', () => trackers.status())
  handle('trackers:disconnect', (name: TrackerName) => trackers.disconnect(name))
  handle('trackers:traktStart', () => trackers.traktStartAuth())
  handle('trackers:traktPoll', (auth: DeviceAuth) => trackers.traktPollAuth(auth))
  handle('trackers:simklStart', () => trackers.simklStartAuth())
  handle('trackers:simklPoll', (auth: DeviceAuth) => trackers.simklPollAuth(auth))
  handle('trackers:scrobble', (action: 'start' | 'pause' | 'stop', entry: ProgressEntry) =>
    trackers.scrobble(action, entry)
  )
  handle('trackers:exportCsv', async (kind: 'letterboxd' | 'series') => {
    const suggested = kind === 'letterboxd' ? 'letterboxd-diary.csv' : 'series-watched.csv'
    const res = await dialog.showSaveDialog({
      defaultPath: suggested,
      filters: [{ name: 'CSV', extensions: ['csv'] }]
    })
    if (res.canceled || !res.filePath) return null
    const count =
      kind === 'letterboxd'
        ? trackers.exportLetterboxdCsv(res.filePath)
        : trackers.exportSeriesCsv(res.filePath)
    return { path: res.filePath, count }
  })

  handle('update:state', () => updater.getState())
  handle('update:check', () => updater.check(false))
  handle('update:install', () => updater.installNow())

  handle('app:openExternal', (url: string) => shell.openExternal(url))
  handle('app:externalPlayer', (url: string, title?: string) => {
    const player = getSettings().externalPlayerPath
    if (!player) throw new Error('No external player configured in Settings.')
    const args = [url]
    if (/vlc/i.test(player) && title) args.push(`--meta-title=${title}`)
    const child = spawn(player, args, { detached: true, stdio: 'ignore' })
    child.unref()
    return true
  })
  handle('app:keepAwake', (on: boolean) => {
    if (on && blockerId === null) {
      blockerId = powerSaveBlocker.start('prevent-display-sleep')
    } else if (!on && blockerId !== null) {
      powerSaveBlocker.stop(blockerId)
      blockerId = null
    }
    return true
  })
}

// ----------------------------------------------------------------- lifecycle

// A throw inside a torrent-engine callback lands here rather than on any promise
// we await, so without this it disappears and the UI just waits forever.
process.on('unhandledRejection', (reason) => {
  console.error('[main] unhandled rejection', reason)
})

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(() => {
    registerIpc()
    torrent.setTranscodeHandler(playback.handleTranscode)
    createWindow()
    if (getSettings().autoUpdate) updater.checkOnStartup()
    downloads.resumeAll().catch((err) => console.warn('[downloads] resumeAll', err))
    companion.sync().catch((err) => console.warn('[companion]', err.message))
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  let cleaning = false
  app.on('before-quit', (event) => {
    if (cleaning) return
    event.preventDefault()
    cleaning = true
    playback.killAll()
    companion.stop().catch(() => undefined)
    torrent.shutdown().finally(() => app.quit())
  })
}
