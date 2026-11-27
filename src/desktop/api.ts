import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import type { StreamlineApi } from '../shared/api'
import { decodeCaps } from '../shared/api'
import type { MetaDetail, MetaPreview, Settings, Stream, SubtitleTrack, UpdateState } from '../shared/types'
import { applyDebridConfig } from '../shared/config'
import { createAddonClient, createMetaStore, type MetaStore } from '../shared/addons'
import { BUILTIN, type BuiltinAddon } from '../shared/builtins'
import { archiveAddon } from '../shared/archive'
import { openMoviesAddon } from '../shared/openMovies'

/**
 * `window.api` for the desktop app. Each call is a command in the Rust
 * backend (src-tauri/src/lib.rs). The addon protocol client is the same one
 * the web build runs, so catalogs, search and sources behave identically in
 * both; the torrent engine, ffmpeg, files and accounts live in Rust.
 */

/** Rust errors arrive as plain strings; the pages expect `Error`s. */
async function call<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  try {
    return await invoke<T>(cmd, args)
  } catch (err) {
    throw err instanceof Error ? err : new Error(typeof err === 'string' ? err : JSON.stringify(err))
  }
}

// ---------------------------------------------------------------- settings

/** The latest settings, for the built-in manifests that must answer synchronously. */
let settingsCache: Settings | null = null

async function getSettings(): Promise<Settings> {
  settingsCache = await call<Settings>('settings_get')
  return settingsCache
}

// ------------------------------------------------------------------ online

const reportOnline = (): void => {
  call('app_set_online', { online: navigator.onLine }).catch(() => undefined)
}
window.addEventListener('online', reportOnline)
window.addEventListener('offline', reportOnline)
reportOnline()

// ------------------------------------------------------------------ addons

/** Files on this computer; the scanning and matching happen in Rust. */
const localAddon: BuiltinAddon = {
  url: BUILTIN.local,
  manifest: () => {
    const enabled = (settingsCache?.localFolders ?? []).length > 0
    return {
      id: 'streamline.local',
      name: 'Local library',
      version: '1.0.0',
      description: 'Films and episodes already on this computer, from the folders you pick in Settings.',
      types: ['movie', 'series'],
      catalogs: enabled
        ? [
            { type: 'movie', id: 'local-movies', name: 'On this computer', extra: [{ name: 'search' }] },
            { type: 'series', id: 'local-series', name: 'On this computer', extra: [{ name: 'search' }] }
          ]
        : [],
      resources: [
        'catalog',
        { name: 'meta', types: ['movie'], idPrefixes: ['local:'] },
        { name: 'stream', types: ['movie', 'series'], idPrefixes: ['tt', 'local:', 'ia:'] },
        { name: 'subtitles', types: ['movie', 'series'], idPrefixes: ['tt', 'local:'] }
      ]
    }
  },
  catalog: (type, _id, extra) => call<MetaPreview[]>('local_catalog', { kind: type, extra }),
  meta: (_type, id) => call<MetaDetail | null>('local_meta', { id }),
  streams: (type, id) => call<Stream[]>('local_streams', { kind: type, id }),
  subtitles: (type, id) => call<SubtitleTrack[]>('local_subtitles', { kind: type, id })
}

/**
 * Title details are kept on disk so a title page — and a download's — still
 * opens with no connection. The saved copy loads in the background; anything
 * remembered before it arrives is kept.
 */
function diskMetaStore(): MetaStore {
  const save = (all: Record<string, MetaDetail>): void => {
    call('meta_cache_save', { all }).catch(() => undefined)
  }
  const early = new Map<string, MetaDetail>()
  let store: MetaStore | null = null
  call<Record<string, MetaDetail>>('meta_cache_load')
    .catch(() => ({}))
    .then((initial) => {
      store = createMetaStore({ ...initial, ...Object.fromEntries(early) }, save)
    })
  return {
    get: (key) => store?.get(key) ?? early.get(key),
    set: (key, meta) => (store ? store.set(key, meta) : early.set(key, meta))
  }
}

const addons = createAddonClient({
  addonUrls: () => settingsCache?.addons ?? [],
  offline: () => !navigator.onLine,
  metaStore: diskMetaStore(),
  builtins: [archiveAddon, openMoviesAddon, localAddon]
})

/** Addon calls need the installed list, which the first settings read brings. */
async function ready(): Promise<void> {
  if (!settingsCache) await getSettings()
}

// ------------------------------------------------------------------ window

/**
 * Element fullscreen only fills the webview; the window has to follow it,
 * or the player goes "fullscreen" inside a normal window.
 */
document.addEventListener('fullscreenchange', () => {
  call('app_set_fullscreen', { on: Boolean(document.fullscreenElement) }).catch(() => undefined)
})

/** Links that would open a new window open in the default browser instead. */
document.addEventListener(
  'click',
  (e) => {
    const a = (e.target as HTMLElement | null)?.closest?.('a[href]') as HTMLAnchorElement | null
    if (!a) return
    const href = a.href
    if (/^(https?:|mailto:)/.test(href) && (a.target === '_blank' || new URL(href).origin !== location.origin)) {
      e.preventDefault()
      call('app_open_external', { url: href }).catch(() => undefined)
    }
  },
  true
)
window.open = ((url?: string | URL) => {
  if (url) call('app_open_external', { url: String(url) }).catch(() => undefined)
  return null
}) as typeof window.open

// --------------------------------------------------------------------- api

const caps = decodeCaps()

export const desktopApi: StreamlineApi = {
  platform: 'desktop',
  settings: {
    get: getSettings,
    set: async (patch) => {
      const current = settingsCache ?? (await getSettings())
      const next = { ...current, ...patch }
      // Keeps the debrid key in sync with any Torrentio-style addon URL.
      const urls = next.addons.map((u) => applyDebridConfig(u, next.debridProvider, next.debridApiKey))
      const changed = urls.length !== current.addons.length || urls.some((u, i) => u !== current.addons[i])
      settingsCache = await call<Settings>('settings_set', { patch: changed ? { ...patch, addons: urls } : patch })
      addons.forgetManifests()
      return settingsCache
    },
    pickFolder: () => call('settings_pick_folder'),
    pickFile: () => call('settings_pick_file')
  },
  addons: {
    manifests: async () => (await ready(), addons.getManifests()),
    unreachable: async () => (await ready(), addons.unreachable()),
    wakeUp: async () => addons.wakeUp(),
    catalogs: async () => (await ready(), addons.listCatalogs()),
    probe: (url) => addons.getManifest(url),
    catalog: async (addonUrl, type, id, extra) => (await ready(), addons.getCatalog(addonUrl, type, id, extra)),
    search: async (query, type) => (await ready(), addons.search(query, type)),
    meta: async (type, id) => (await ready(), addons.getMeta(type, id)),
    streams: async (type, id, onPartial) => (await ready(), addons.getStreams(type, id, onPartial)),
    subtitles: async (type, id, extra) => (await ready(), addons.getSubtitles(type, id, extra)),
    // Fetched in Rust: no CORS limits, and legacy encodings are detected.
    subtitleVtt: (url) => call('subtitle_vtt', { url })
  },
  local: {
    status: () => call('local_status'),
    rescan: () => call('local_rescan')
  },
  torrent: {
    warm: () => call('torrent_warm'),
    start: (stream) => call('torrent_start', { stream }),
    stats: (infoHash) => call('torrent_stats', { infoHash }),
    remove: (infoHash) => call('torrent_remove', { infoHash })
  },
  library: {
    get: () => call('library_get'),
    getLastStream: (key) => call('library_get_last_stream', { key }),
    setLastStream: (key, stream) => call('library_set_last_stream', { key, stream }),
    toggleFavorite: (item) => call('library_toggle_favorite', { item }),
    setProgress: (entry) => call('library_set_progress', { entry }),
    clearProgress: (key) => call('library_clear_progress', { key }),
    markWatched: (key, watched, seed) => call('library_mark_watched', { key, watched, seed: seed ?? null }),
    markManyWatched: (changes) => call('library_mark_many_watched', { changes }),
    setRating: (entry, rating) => call('library_set_rating', { entry, rating }),
    backup: () => call('library_backup'),
    restore: () => call('library_restore')
  },
  companion: {
    info: () => call('companion_info'),
    configure: (patch) => call('companion_configure', { patch: { enabled: patch.enabled, regenerate: patch.regenerate } })
  },
  importer: {
    pickFiles: () => call('import_pick_files'),
    start: (service, paths) => call('import_start', { service, paths }),
    status: () => call('import_status')
  },
  downloads: {
    list: () => call('downloads_list'),
    progress: () => call('downloads_progress'),
    start: (stream, info) => call('downloads_start', { stream, info }),
    pause: (id) => call('downloads_pause', { id }),
    resume: (id) => call('downloads_resume', { id }),
    remove: (id, deleteFiles) => call('downloads_remove', { id, deleteFiles }),
    playSource: (id) => call('downloads_play_source', { id }),
    reveal: (id) => call('downloads_reveal', { id }),
    openFolder: () => call('downloads_open_folder')
  },
  playback: {
    plan: (source) => call('playback_plan', { source, caps })
  },
  trackers: {
    status: () => call('trackers_status'),
    disconnect: (name) => call('trackers_disconnect', { name }),
    traktStart: () => call('trakt_start'),
    traktPoll: (auth) => call('trakt_poll', { auth }),
    simklStart: () => call('simkl_start'),
    simklPoll: (auth) => call('simkl_poll', { auth }),
    scrobble: (action, entry) => call('trackers_scrobble', { action, entry }),
    exportCsv: (kind) => call('trackers_export_csv', { kind })
  },
  update: {
    state: () => call('update_state'),
    check: () => call('update_check'),
    install: () => call('update_install'),
    onState: (cb) => {
      const off = listen<UpdateState>('update:state', (e) => cb(e.payload))
      return () => {
        off.then((fn) => fn()).catch(() => undefined)
      }
    }
  },
  app: {
    openExternal: (url) => call('app_open_external', { url }),
    externalPlayer: (url, title) => call('app_external_player', { url, title: title ?? null }),
    keepAwake: (on) => call('app_keep_awake', { on })
  }
}

/** The window starts hidden; show it once the first frame is painted. */
export function showWindowWhenPainted(): void {
  requestAnimationFrame(() => requestAnimationFrame(() => call('app_ready').catch(() => undefined)))
}
