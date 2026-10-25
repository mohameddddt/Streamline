import { app } from 'electron'
import { randomBytes } from 'crypto'
import fs from 'fs'
import path from 'path'
import type {
  LibraryBackup,
  LibraryItem,
  ProgressEntry,
  RatingEntry,
  Settings,
  Stream
} from '../shared/types'
import { applyDebridConfig, portableDefaults } from '../shared/config'
import * as lib from '../shared/library'

function defaults(): Settings {
  return {
    ...portableDefaults(),
    downloadPath: path.join(app.getPath('temp'), 'streamline'),
    downloadsPath: path.join(app.getPath('downloads'), 'Streamline')
  }
}

function filePath(name: string): string {
  return path.join(app.getPath('userData'), name)
}

function readJson<T>(name: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath(name), 'utf8')
    return { ...fallback, ...JSON.parse(raw) }
  } catch {
    return fallback
  }
}

function writeJson(name: string, data: unknown): void {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    fs.writeFileSync(filePath(name), JSON.stringify(data, null, 2), 'utf8')
  } catch (err) {
    console.error('[settings] write failed', err)
  }
}

let cache: Settings | null = null

export function getSettings(): Settings {
  if (!cache) {
    cache = readJson<Settings>('settings.json', defaults())
    // The companion token is a secret; mint one the first time it is needed.
    if (!cache.companionToken) {
      cache.companionToken = randomBytes(18).toString('base64url')
      writeJson('settings.json', cache)
    }
  }
  return cache
}

export function saveSettings(patch: Partial<Settings>): Settings {
  cache = { ...getSettings(), ...patch }
  // Keep the debrid key in sync with any Torrentio-style addon URL.
  cache.addons = cache.addons.map((url) =>
    applyDebridConfig(url, cache!.debridProvider, cache!.debridApiKey)
  )
  writeJson('settings.json', cache)
  return cache
}

export function regenerateCompanionToken(): Settings {
  return saveSettings({ companionToken: randomBytes(18).toString('base64url') })
}

// ---------------------------------------------------------------- library

let libCache: lib.LibraryFile | null = null

function library(): lib.LibraryFile {
  if (!libCache) libCache = readJson<lib.LibraryFile>('library.json', lib.emptyLibrary())
  return libCache
}

/** Runs a change against the library and writes it out. */
function change<R>(fn: (l: lib.LibraryFile) => R): R {
  const result = fn(library())
  writeJson('library.json', library())
  return result
}

export function getLibrary(): {
  items: LibraryItem[]
  progress: ProgressEntry[]
  ratings: RatingEntry[]
} {
  return lib.listLibrary(library())
}

export const getLastStream = (key: string): Stream | null => lib.getLastStream(library(), key)
export const setLastStream = (key: string, stream: Stream): void =>
  change((l) => lib.setLastStream(l, key, stream))
export const applyImport = (batch: Parameters<typeof lib.mergeImport>[1]): void =>
  change((l) => lib.mergeImport(l, batch))
export const toggleFavorite = (item: LibraryItem): boolean =>
  change((l) => lib.toggleFavorite(l, item))
export const setProgress = (entry: ProgressEntry): void => change((l) => lib.setProgress(l, entry))
export const markWatched = (
  key: string,
  watched: boolean,
  seed?: Parameters<typeof lib.markWatched>[3]
): void => change((l) => lib.markWatched(l, key, watched, seed))
export const clearProgress = (key: string): void => change((l) => lib.clearProgress(l, key))
export const setRating = (
  entry: Parameters<typeof lib.setRating>[1],
  rating: number | null
): void => change((l) => lib.setRating(l, entry, rating))
export const makeBackup = (): LibraryBackup => lib.makeBackup(library())
export const restoreBackup = (backup: LibraryBackup): number =>
  change((l) => lib.mergeBackup(l, backup))
