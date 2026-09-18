import { app, BrowserWindow, ipcMain, shell, dialog, powerSaveBlocker } from 'electron'
import { spawn } from 'child_process'
import path from 'path'
import * as addons from './addons'
import * as torrent from './torrent'
import * as downloads from './downloads'
import * as playback from './playback'
import * as trackers from './trackers'
import * as updater from './updater'
import {
  getSettings,
  saveSettings,
  getLibrary,
  toggleFavorite,
  setProgress,
  clearProgress,
  markWatched
} from './settings'
import type {
  DeviceAuth,
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
    backgroundColor: '#0b0d12',
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
  handle('settings:set', (patch: Partial<Settings>) => {
    const next = saveSettings(patch)
    addons.forgetManifests()
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

  handle('torrent:start', (stream: Stream) => torrent.startStream(stream))
  handle('torrent:stats', (infoHash: string) => torrent.getStats(infoHash))
  handle('torrent:remove', (infoHash: string) => torrent.removeTorrent(infoHash))

  handle('library:get', () => getLibrary())
  handle('library:toggleFavorite', (item: LibraryItem) => toggleFavorite(item))
  handle('library:setProgress', (entry: ProgressEntry) => setProgress(entry))
  handle('library:clearProgress', (key: string) => clearProgress(key))
  handle('library:markWatched', (key: string, watched: boolean) => markWatched(key, watched))

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
    torrent.shutdown().finally(() => app.quit())
  })
}
