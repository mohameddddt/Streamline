export type MediaType = 'movie' | 'series' | string

export interface AddonCatalogDef {
  type: MediaType
  id: string
  name?: string
  extra?: { name: string; isRequired?: boolean; options?: string[] }[]
  extraSupported?: string[]
  extraRequired?: string[]
}

export interface AddonResourceDef {
  name: string
  types?: string[]
  idPrefixes?: string[]
}

export interface AddonManifest {
  id: string
  name: string
  version?: string
  description?: string
  logo?: string
  types?: string[]
  catalogs?: AddonCatalogDef[]
  resources?: (string | AddonResourceDef)[]
  idPrefixes?: string[]
  /** Injected by us: the manifest URL this came from. */
  transportUrl: string
}

export interface MetaPreview {
  id: string
  type: MediaType
  name: string
  poster?: string
  posterShape?: string
  background?: string
  logo?: string
  description?: string
  releaseInfo?: string
  imdbRating?: string
  genres?: string[]
}

export interface Video {
  id: string
  title?: string
  name?: string
  season?: number
  episode?: number
  released?: string
  thumbnail?: string
  overview?: string
}

export interface MetaDetail extends MetaPreview {
  videos?: Video[]
  runtime?: string
  cast?: string[]
  director?: string[]
  writer?: string[]
  country?: string
  trailers?: { source: string; type: string }[]
}

export interface Stream {
  /** Direct http(s) url (debrid / hosted). Mutually exclusive with infoHash. */
  url?: string
  infoHash?: string
  fileIdx?: number
  name?: string
  title?: string
  description?: string
  behaviorHints?: { bingeGroup?: string; filename?: string; notWebReady?: boolean }
  sources?: string[]
  /** Injected by us */
  addonName?: string
  addonId?: string
}

export interface SubtitleTrack {
  id: string
  url: string
  lang: string
  addonName?: string
}

export type DebridProvider =
  | 'none'
  | 'realdebrid'
  | 'alldebrid'
  | 'premiumize'
  | 'torbox'
  | 'debridlink'
  | 'offcloud'
  | 'easydebrid'
  | 'putio'

export interface Settings {
  addons: string[]
  debridProvider: DebridProvider
  debridApiKey: string
  tmdbApiKey: string
  downloadPath: string
  downloadsPath: string
  externalPlayerPath: string
  maxConns: number
  downloadLimit: number
  uploadLimit: number
  deleteOnExit: boolean
  preferredLang: string
  traktClientId: string
  traktClientSecret: string
  traktToken: string
  traktRefresh: string
  simklClientId: string
  simklToken: string
  autoUpdate: boolean
}

export interface LibraryItem {
  key: string
  id: string
  type: MediaType
  name: string
  poster?: string
  favorite?: boolean
  addedAt?: number
}

export interface ProgressEntry {
  key: string
  id: string
  type: MediaType
  name: string
  poster?: string
  season?: number
  episode?: number
  videoId?: string
  year?: string
  time: number
  duration: number
  updatedAt: number
  finished?: boolean
}

export type DownloadStatus = 'downloading' | 'done' | 'paused' | 'error'

export interface DownloadRecord {
  infoHash: string
  fileIdx: number
  magnet: string
  title: string
  metaId: string
  metaType: MediaType
  poster?: string
  season?: number
  episode?: number
  videoId?: string
  fileName: string
  filePath: string
  length: number
  addedAt: number
  status: DownloadStatus
  error?: string
}

export interface DownloadProgress {
  infoHash: string
  progress: number
  downloaded: number
  downloadSpeed: number
  peers: number
  timeRemaining: number
}

export interface TorrentHandle {
  url: string
  infoHash: string
  fileIdx: number
  fileName: string
  fileLength: number
  mime: string
}

export interface TorrentStats {
  infoHash: string
  progress: number
  downloaded: number
  downloadSpeed: number
  uploadSpeed: number
  peers: number
  ready: boolean
  fileProgress: number
}

// ------------------------------------------------------------------ playback

export type PlaybackMode = 'direct' | 'remux' | 'transcode'

export type PlaybackSource =
  | { kind: 'torrent'; infoHash: string; fileIdx: number }
  | { kind: 'local'; filePath: string }
  | { kind: 'url'; url: string }

export interface ProbeResult {
  duration: number
  videoCodec: string
  audioCodec: string
  audioChannels: number
  width: number
  height: number
  container: string
}

export interface PlaybackPlan {
  mode: PlaybackMode
  url: string
  duration: number
  reason: string
  videoCodec: string
  audioCodec: string
}

// ------------------------------------------------------------ trackers

export type TrackerName = 'trakt' | 'simkl'

export interface TrackerStatus {
  trakt: boolean
  simkl: boolean
}

export interface DeviceAuth {
  deviceCode: string
  userCode: string
  verificationUrl: string
  interval: number
  expiresIn: number
}

// ------------------------------------------------------------- updates

export interface UpdateState {
  status: 'idle' | 'checking' | 'current' | 'downloading' | 'ready' | 'error' | 'dev' | 'unconfigured'
  version: string
  notes: string
  progress: number
}
