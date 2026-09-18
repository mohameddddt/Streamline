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

