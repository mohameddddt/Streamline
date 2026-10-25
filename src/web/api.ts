import type { StreamlineApi } from '../preload/index'
import type {
  CompanionInfo,
  ImportStatus,
  LibraryBackup,
  PlaybackPlan,
  PlaybackSource,
  Settings,
  Stream,
  TorrentHandle,
  TorrentStats,
  UpdateState
} from '../shared/types'
import { APP_VERSION, applyDebridConfig, portableDefaults } from '../shared/config'
import { createAddonClient } from '../shared/addons'
import * as lib from '../shared/library'

/**
 * `window.api` for the browser. Same shape as the desktop preload, so every
 * page runs unchanged: addons are fetched straight from the tab, the library
 * and settings live in localStorage, and torrent playback is handed to the
 * desktop app's companion engine when one is paired. Things only a desktop
 * app can do — writing files, launching VLC — say so instead of failing
 * silently.
 */

const SETTINGS_KEY = 'streamline:settings'
const LIBRARY_KEY = 'streamline:library'

function load<T>(key: string, fallback: T): T {
  try {
    const raw = window.localStorage.getItem(key)
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback
  } catch {
    return fallback
  }
}

function store(key: string, value: unknown): void {
  try {
    window.localStorage.setItem(key, JSON.stringify(value))
  } catch (err) {
    console.warn('[web] could not save', key, err)
  }
}

let settings: Settings = load<Settings>(SETTINGS_KEY, {
  ...portableDefaults(),
  downloadPath: '',
  downloadsPath: ''
})

const library: lib.LibraryFile = load(LIBRARY_KEY, lib.emptyLibrary())

function change<R>(fn: (l: lib.LibraryFile) => R): R {
  const result = fn(library)
  store(LIBRARY_KEY, library)
  return result
}

const addons = createAddonClient({ addonUrls: () => settings.addons })

class DesktopOnly extends Error {
  constructor(what: string) {
    super(`${what} needs the Streamline desktop app.`)
  }
}

// --------------------------------------------------------------- companion

let engineConnected = false
let engineVersion: string | undefined

const NO_ENGINE =
  'Torrent sources play through the Streamline desktop app. Open it on this computer, turn on ' +
  'Settings → Web companion, and paste its token into Settings here. Sources marked “instant” ' +
  '(debrid links) play without it.'

async function engine<T>(path: string, body?: unknown): Promise<T> {
  if (!settings.engineToken) throw new Error(NO_ENGINE)
  let res: Response
  try {
    res = await fetch(settings.engineUrl.replace(/\/$/, '') + path, {
      method: body === undefined ? 'GET' : 'POST',
      headers: {
        authorization: `Bearer ${settings.engineToken}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' })
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    })
  } catch {
    engineConnected = false
    throw new Error(
      'Could not reach the Streamline desktop app. Make sure it is running with Web companion ' +
        'switched on, and that your browser allowed this page to reach your local network.'
    )
  }
  const data = (await res.json().catch(() => ({}))) as T & { error?: string }
  if (!res.ok) throw new Error(data.error ?? `Companion answered ${res.status}`)
  engineConnected = true
  return data
}

async function handshake(): Promise<CompanionInfo> {
  try {
    const hello = await engine<{ version: string }>('/api/hello')
    engineVersion = hello.version
  } catch {
    engineConnected = false
    engineVersion = undefined
  }
  return companionInfo()
}

function companionInfo(): CompanionInfo {
  return {
    role: 'client',
    enabled: Boolean(settings.engineToken),
    url: settings.engineUrl,
    token: settings.engineToken,
    connected: engineConnected,
    version: engineVersion
  }
}

// ----------------------------------------------------------------- files

function saveFile(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  window.setTimeout(() => URL.revokeObjectURL(url), 2000)
}

/** Resolves with the chosen file's text, or null if the picker was dismissed. */
function openFile(accept: string): Promise<string | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = accept
    input.addEventListener('change', () => {
      const file = input.files?.[0]
      if (!file) return resolve(null)
      file.text().then(resolve, () => resolve(null))
    })
    input.addEventListener('cancel', () => resolve(null))
    input.click()
  })
}

// --------------------------------------------------------------- wake lock

let wakeLock: { release: () => Promise<void> } | null = null

async function keepAwake(on: boolean): Promise<boolean> {
  const nav = navigator as Navigator & {
    wakeLock?: { request: (type: 'screen') => Promise<{ release: () => Promise<void> }> }
  }
  try {
    if (on && !wakeLock && nav.wakeLock) wakeLock = await nav.wakeLock.request('screen')
    if (!on && wakeLock) {
      await wakeLock.release()
      wakeLock = null
    }
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------- api

const idleImport: ImportStatus = { state: 'idle', phase: '', total: 0, done: 0 }
const webUpdate: UpdateState = {
  status: 'unconfigured',
  version: APP_VERSION,
  notes: 'The web version is always the latest — just reload the page.',
  progress: 0
}

export const webApi: StreamlineApi = {
  platform: 'web',
  settings: {
    get: async () => settings,
    set: async (patch) => {
      settings = { ...settings, ...patch }
      settings.addons = settings.addons.map((url) =>
        applyDebridConfig(url, settings.debridProvider, settings.debridApiKey)
      )
      store(SETTINGS_KEY, settings)
      addons.forgetManifests()
      return settings
    },
    pickFolder: async () => null,
    pickFile: async () => null
  },
  addons: {
    manifests: () => addons.getManifests(),
    catalogs: () => addons.listCatalogs(),
    probe: (url) => addons.getManifest(url),
    catalog: (addonUrl, type, id, extra) => addons.getCatalog(addonUrl, type, id, extra),
    search: (query, type) => addons.search(query, type),
    meta: (type, id) => addons.getMeta(type, id),
    streams: (type, id) => addons.getStreams(type, id),
    subtitles: (type, id, extra) => addons.getSubtitles(type, id, extra),
    // Many subtitle hosts send no CORS headers; the companion can fetch for us.
    subtitleVtt: async (url) => {
      try {
        return await addons.fetchSubtitleAsVtt(url)
      } catch (err) {
        if (!settings.engineToken) throw err
        const res = await fetch(
          `${settings.engineUrl.replace(/\/$/, '')}/api/subtitles/vtt?url=${encodeURIComponent(url)}`,
          { headers: { authorization: `Bearer ${settings.engineToken}` } }
        )
        if (!res.ok) throw err
        return res.text()
      }
    }
  },
  torrent: {
    warm: async () => {
      if (settings.engineToken) await engine('/api/torrent/warm', {}).catch(() => undefined)
    },
    start: async (stream: Stream) => {
      if (!stream.infoHash) throw new Error('This source is not a torrent.')
      return engine<TorrentHandle>('/api/torrent/start', { stream })
    },
    stats: async (infoHash) => {
      if (!settings.engineToken) return null
      return engine<TorrentStats | null>(`/api/torrent/stats?h=${encodeURIComponent(infoHash)}`)
    },
    remove: async (infoHash) => {
      await engine('/api/torrent/remove', { infoHash })
    }
  },
  library: {
    get: async () => lib.listLibrary(library),
    getLastStream: async (key) => lib.getLastStream(library, key),
    setLastStream: async (key, stream) => change((l) => lib.setLastStream(l, key, stream)),
    toggleFavorite: async (item) => change((l) => lib.toggleFavorite(l, item)),
    setProgress: async (entry) => change((l) => lib.setProgress(l, entry)),
    clearProgress: async (key) => change((l) => lib.clearProgress(l, key)),
    markWatched: async (key, watched, seed) =>
      change((l) => lib.markWatched(l, key, watched, seed)),
    setRating: async (entry, rating) => change((l) => lib.setRating(l, entry, rating)),
    backup: async () => {
      const backup = lib.makeBackup(library)
      const stamp = new Date().toISOString().slice(0, 10)
      saveFile(`streamline-library-${stamp}.json`, JSON.stringify(backup, null, 2), 'application/json')
      return { count: backup.items.length + backup.progress.length + backup.ratings.length }
    },
    restore: async () => {
      const text = await openFile('application/json,.json')
      if (text === null) return null
      const backup = JSON.parse(text) as LibraryBackup
      return { count: change((l) => lib.mergeBackup(l, backup)) }
    }
  },
  companion: {
    info: () => handshake(),
    configure: async (patch) => {
      const next: Partial<Settings> = {}
      if (patch.url !== undefined) next.engineUrl = patch.url.trim() || portableDefaults().engineUrl
      if (patch.token !== undefined) next.engineToken = patch.token.trim()
      settings = { ...settings, ...next }
      store(SETTINGS_KEY, settings)
      return handshake()
    }
  },
  importer: {
    pickFiles: async () => [],
    start: async () => {
      throw new DesktopOnly('Importing history')
    },
    status: async () => idleImport
  },
  downloads: {
    list: async () => [],
    progress: async () => [],
    start: async () => {
      throw new DesktopOnly('Downloading to disk')
    },
    pause: async () => undefined,
    resume: async () => undefined,
    remove: async () => undefined,
    playSource: async () => {
      throw new DesktopOnly('Playing downloads')
    },
    reveal: async () => false
  },
  playback: {
    plan: async (source: PlaybackSource): Promise<PlaybackPlan> => {
      // With the companion paired, let it inspect the file: it can repackage or
      // convert what the browser cannot decode.
      if (settings.engineToken && source.kind !== 'local') {
        try {
          return await engine<PlaybackPlan>('/api/playback/plan', { source })
        } catch (err) {
          if (source.kind === 'torrent') throw err
        }
      }
      if (source.kind === 'url') {
        return {
          mode: 'direct',
          url: source.url,
          duration: 0,
          reason: 'Playing the link directly in your browser.',
          videoCodec: '',
          audioCodec: ''
        }
      }
      throw new Error(NO_ENGINE)
    }
  },
  trackers: {
    status: async () => ({ trakt: false, simkl: false }),
    disconnect: async () => undefined,
    traktStart: async () => {
      throw new DesktopOnly('Trakt sync')
    },
    traktPoll: async () => false,
    simklStart: async () => {
      throw new DesktopOnly('Simkl sync')
    },
    simklPoll: async () => false,
    scrobble: async () => undefined,
    exportCsv: async () => {
      throw new DesktopOnly('CSV export')
    }
  },
  update: {
    state: async () => webUpdate,
    check: async () => webUpdate,
    install: async () => undefined,
    onState: () => () => undefined
  },
  app: {
    openExternal: async (url) => {
      window.open(url, '_blank', 'noopener,noreferrer')
    },
    externalPlayer: async () => {
      throw new DesktopOnly('Opening an external player')
    },
    keepAwake
  }
}
