import { contextBridge, ipcRenderer } from 'electron'
import type {
  AddonManifest,
  DownloadProgress,
  DownloadRecord,
  LibraryItem,
  MetaDetail,
  MetaPreview,
  ProgressEntry,
  Settings,
  Stream,
  SubtitleTrack,
  DeviceAuth,
  PlaybackPlan,
  PlaybackSource,
  TrackerName,
  TrackerStatus,
  UpdateState,
  TorrentHandle,
  TorrentStats
} from '../shared/types'

const invoke = <T>(channel: string, ...args: unknown[]): Promise<T> =>
  ipcRenderer.invoke(channel, ...args) as Promise<T>

export interface CatalogRef {
  addonUrl: string
  addonName: string
  type: string
  id: string
  name: string
  genres: string[]
  searchable: boolean
  requiresSearch: boolean
}

export interface DownloadInfo {
  title: string
  metaId: string
  metaType: string
  poster?: string
  season?: number
  episode?: number
  videoId?: string
}

const api = {
  settings: {
    get: () => invoke<Settings>('settings:get'),
    set: (patch: Partial<Settings>) => invoke<Settings>('settings:set', patch),
    pickFolder: () => invoke<string | null>('settings:pickFolder'),
    pickFile: () => invoke<string | null>('settings:pickFile')
  },
  addons: {
    manifests: () => invoke<AddonManifest[]>('addons:manifests'),
    catalogs: () => invoke<CatalogRef[]>('addons:catalogs'),
    probe: (url: string) => invoke<AddonManifest>('addons:probe', url),
    catalog: (addonUrl: string, type: string, id: string, extra?: Record<string, string>) =>
      invoke<MetaPreview[]>('addons:catalog', addonUrl, type, id, extra),
    search: (query: string, type?: string) => invoke<MetaPreview[]>('addons:search', query, type),
    meta: (type: string, id: string) => invoke<MetaDetail | null>('addons:meta', type, id),
    streams: (type: string, id: string) => invoke<Stream[]>('addons:streams', type, id),
    subtitles: (type: string, id: string, extra?: Record<string, string>) =>
      invoke<SubtitleTrack[]>('addons:subtitles', type, id, extra),
    subtitleVtt: (url: string) => invoke<string>('addons:subtitleVtt', url)
  },
  torrent: {
    start: (stream: Stream) => invoke<TorrentHandle>('torrent:start', stream),
    stats: (infoHash: string) => invoke<TorrentStats | null>('torrent:stats', infoHash),
    remove: (infoHash: string) => invoke<void>('torrent:remove', infoHash)
  },
  library: {
    get: () => invoke<{ items: LibraryItem[]; progress: ProgressEntry[] }>('library:get'),
    toggleFavorite: (item: LibraryItem) => invoke<boolean>('library:toggleFavorite', item),
    setProgress: (entry: ProgressEntry) => invoke<void>('library:setProgress', entry),
    clearProgress: (key: string) => invoke<void>('library:clearProgress', key),
    markWatched: (key: string, watched: boolean) =>
      invoke<void>('library:markWatched', key, watched)
  },
  downloads: {
    list: () => invoke<DownloadRecord[]>('downloads:list'),
    progress: () => invoke<DownloadProgress[]>('downloads:progress'),
    start: (stream: Stream, info: DownloadInfo) =>
      invoke<DownloadRecord>('downloads:start', stream, info),
    pause: (infoHash: string) => invoke<void>('downloads:pause', infoHash),
    resume: (infoHash: string) => invoke<void>('downloads:resume', infoHash),
    remove: (infoHash: string, deleteFiles: boolean) =>
      invoke<void>('downloads:remove', infoHash, deleteFiles),
    playSource: (infoHash: string) => invoke<PlaybackSource>('downloads:playSource', infoHash),
    reveal: (infoHash: string) => invoke<boolean>('downloads:reveal', infoHash)
  },
  playback: {
    plan: (source: PlaybackSource) => invoke<PlaybackPlan>('playback:plan', source)
  },
  trackers: {
    status: () => invoke<TrackerStatus>('trackers:status'),
    disconnect: (name: TrackerName) => invoke<void>('trackers:disconnect', name),
    traktStart: () => invoke<DeviceAuth>('trackers:traktStart'),
    traktPoll: (auth: DeviceAuth) => invoke<boolean>('trackers:traktPoll', auth),
    simklStart: () => invoke<DeviceAuth>('trackers:simklStart'),
    simklPoll: (auth: DeviceAuth) => invoke<boolean>('trackers:simklPoll', auth),
    scrobble: (action: 'start' | 'pause' | 'stop', entry: ProgressEntry) =>
      invoke<void>('trackers:scrobble', action, entry),
    exportCsv: (kind: 'letterboxd' | 'series') =>
      invoke<{ path: string; count: number } | null>('trackers:exportCsv', kind)
  },
  update: {
    state: () => invoke<UpdateState>('update:state'),
    check: () => invoke<UpdateState>('update:check'),
    install: () => invoke<void>('update:install'),
    onState: (cb: (state: UpdateState) => void): (() => void) => {
      const listener = (_e: unknown, state: UpdateState): void => cb(state)
      ipcRenderer.on('update:state', listener)
      return () => ipcRenderer.removeListener('update:state', listener)
    }
  },
  app: {
    openExternal: (url: string) => invoke<void>('app:openExternal', url),
    externalPlayer: (url: string, title?: string) =>
      invoke<boolean>('app:externalPlayer', url, title),
    keepAwake: (on: boolean) => invoke<boolean>('app:keepAwake', on)
  }
}

export type StreamlineApi = typeof api

contextBridge.exposeInMainWorld('api', api)
