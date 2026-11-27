import type {
  AddonManifest,
  CompanionInfo,
  DeviceAuth,
  DownloadProgress,
  DownloadRecord,
  ImportService,
  ImportStatus,
  LibraryItem,
  LocalLibraryStatus,
  MetaDetail,
  MetaPreview,
  Platform,
  PlaybackPlan,
  PlaybackSource,
  ProgressEntry,
  RatingEntry,
  Settings,
  Stream,
  SubtitleTrack,
  TorrentHandle,
  TorrentStats,
  TrackerName,
  TrackerStatus,
  UpdateState
} from './types'
import type { CatalogRef } from './addons'
import type { WatchChange } from './library'

export type { CatalogRef, WatchChange }

export interface DownloadInfo {
  title: string
  metaId: string
  metaType: string
  poster?: string
  season?: number
  episode?: number
  videoId?: string
}

/** Describes an episode or film that has no progress entry yet. */
export type WatchSeed = Omit<ProgressEntry, 'time' | 'duration' | 'updatedAt'>
export type RatingTarget = Omit<RatingEntry, 'rating' | 'ratedAt' | 'source'>

/**
 * Everything the renderer can ask of the app. The desktop build implements it
 * over Tauri commands (src/desktop/api.ts), the browser build in the tab
 * itself (src/web/api.ts); both are checked against this one type.
 */
export interface StreamlineApi {
  platform: Platform
  settings: {
    get: () => Promise<Settings>
    set: (patch: Partial<Settings>) => Promise<Settings>
    pickFolder: () => Promise<string | null>
    pickFile: () => Promise<string | null>
  }
  addons: {
    manifests: () => Promise<AddonManifest[]>
    /** Installed addons being skipped for now because they did not answer. */
    unreachable: () => Promise<string[]>
    /** Back online: ask the addons that were not answering again. */
    wakeUp: () => Promise<void>
    catalogs: () => Promise<CatalogRef[]>
    probe: (url: string) => Promise<AddonManifest>
    catalog: (addonUrl: string, type: string, id: string, extra?: Record<string, string>) => Promise<MetaPreview[]>
    search: (query: string, type?: string) => Promise<MetaPreview[]>
    meta: (type: string, id: string) => Promise<MetaDetail | null>
    /**
     * Every addon's sources. `onPartial`, when given, also receives the list so
     * far each time another addon answers, so the fast ones show at once.
     */
    streams: (type: string, id: string, onPartial?: (streams: Stream[]) => void) => Promise<Stream[]>
    subtitles: (type: string, id: string, extra?: Record<string, string>) => Promise<SubtitleTrack[]>
    subtitleVtt: (url: string) => Promise<string>
  }
  local: {
    status: () => Promise<LocalLibraryStatus | null>
    rescan: () => Promise<LocalLibraryStatus | null>
  }
  torrent: {
    warm: () => Promise<void>
    start: (stream: Stream) => Promise<TorrentHandle>
    stats: (infoHash: string) => Promise<TorrentStats | null>
    remove: (infoHash: string) => Promise<void>
  }
  library: {
    get: () => Promise<{ items: LibraryItem[]; progress: ProgressEntry[]; ratings: RatingEntry[] }>
    getLastStream: (key: string) => Promise<Stream | null>
    setLastStream: (key: string, stream: Stream) => Promise<void>
    toggleFavorite: (item: LibraryItem) => Promise<boolean>
    setProgress: (entry: ProgressEntry) => Promise<void>
    clearProgress: (key: string) => Promise<void>
    markWatched: (key: string, watched: boolean, seed?: WatchSeed) => Promise<void>
    /** Marks many episodes at once — a season or a whole show. */
    markManyWatched: (changes: WatchChange[]) => Promise<void>
    setRating: (entry: RatingTarget, rating: number | null) => Promise<void>
    /** Saves the whole library to a JSON file the user picks. Null if cancelled. */
    backup: () => Promise<{ count: number } | null>
    /** Merges a backup file back in. Null if cancelled. */
    restore: () => Promise<{ count: number } | null>
  }
  companion: {
    info: () => Promise<CompanionInfo>
    configure: (patch: { enabled?: boolean; regenerate?: boolean; url?: string; token?: string }) => Promise<CompanionInfo>
  }
  importer: {
    pickFiles: () => Promise<string[]>
    start: (service: ImportService, paths: string[]) => Promise<void>
    status: () => Promise<ImportStatus>
  }
  downloads: {
    list: () => Promise<DownloadRecord[]>
    progress: () => Promise<DownloadProgress[]>
    start: (stream: Stream, info: DownloadInfo) => Promise<DownloadRecord>
    /** Each takes a download's `id` (one file of a torrent), not its info hash. */
    pause: (id: string) => Promise<void>
    resume: (id: string) => Promise<void>
    remove: (id: string, deleteFiles: boolean) => Promise<void>
    playSource: (id: string) => Promise<PlaybackSource>
    reveal: (id: string) => Promise<boolean>
    /** Opens the downloads folder in File Explorer. */
    openFolder: () => Promise<boolean>
  }
  playback: {
    plan: (source: PlaybackSource) => Promise<PlaybackPlan>
  }
  trackers: {
    status: () => Promise<TrackerStatus>
    disconnect: (name: TrackerName) => Promise<void>
    traktStart: () => Promise<DeviceAuth>
    traktPoll: (auth: DeviceAuth) => Promise<boolean>
    simklStart: () => Promise<DeviceAuth>
    simklPoll: (auth: DeviceAuth) => Promise<boolean>
    scrobble: (action: 'start' | 'pause' | 'stop', entry: ProgressEntry) => Promise<void>
    exportCsv: (kind: 'letterboxd' | 'series') => Promise<{ path: string; count: number } | null>
  }
  update: {
    state: () => Promise<UpdateState>
    check: () => Promise<UpdateState>
    install: () => Promise<void>
    onState: (cb: (state: UpdateState) => void) => () => void
  }
  app: {
    openExternal: (url: string) => Promise<void>
    externalPlayer: (url: string, title?: string) => Promise<boolean>
    keepAwake: (on: boolean) => Promise<boolean>
  }
}

/**
 * Codecs this window can decode beyond the baseline every Chromium has. The
 * engine plays those directly instead of converting them.
 */
export interface DecodeCaps {
  hevc: boolean
  ac3: boolean
  eac3: boolean
}

export function decodeCaps(): DecodeCaps {
  const can = (type: string): boolean => {
    try {
      return typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported(type)
    } catch {
      return false
    }
  }
  return {
    hevc: can('video/mp4; codecs="hvc1.1.6.L120.90"'),
    ac3: can('audio/mp4; codecs="ac-3"'),
    eac3: can('audio/mp4; codecs="ec-3"')
  }
}
