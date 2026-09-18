import { app } from 'electron'
import fs from 'fs'
import path from 'path'
import type { Settings, LibraryItem, ProgressEntry } from '../shared/types'

export const DEFAULT_ADDONS = [
  'https://v3-cinemeta.strem.io/manifest.json',
  'https://torrentio.strem.fun/manifest.json',
  'https://torrentsdb.com/manifest.json',
  'https://opensubtitles-v3.strem.io/manifest.json'
]

function defaults(): Settings {
  return {
    addons: [...DEFAULT_ADDONS],
    debridProvider: 'none',
    debridApiKey: '',
    tmdbApiKey: '',
    downloadPath: path.join(app.getPath('temp'), 'streamline'),
    downloadsPath: path.join(app.getPath('downloads'), 'Streamline'),
    externalPlayerPath: '',
    maxConns: 80,
    downloadLimit: 0,
    uploadLimit: 262144,
    deleteOnExit: true,
    preferredLang: 'eng',
    traktClientId: '',
    traktClientSecret: '',
    traktToken: '',
    traktRefresh: '',
    simklClientId: '',
    simklToken: '',
    autoUpdate: true
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
  if (!cache) cache = readJson<Settings>('settings.json', defaults())
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

/**
 * Torrentio (and the addons that clone its config format) take options as a
 * `key=value|key=value` path segment before `/manifest.json`. We rewrite only the
 * debrid pair so a user's hand-tuned provider/sort options survive.
 */
export function applyDebridConfig(url: string, provider: string, apiKey: string): string {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  if (!/^\/.*manifest\.json$/.test(parsed.pathname)) return url

  const segments = parsed.pathname.replace(/^\//, '').split('/')
  const manifest = segments.pop() as string
  const config = segments.join('/')
  const pairs = config ? config.split('|').filter(Boolean) : []
  const known = [
    'realdebrid',
    'alldebrid',
    'premiumize',
    'torbox',
    'debridlink',
    'offcloud',
    'easydebrid',
    'putio'
  ]
  const kept = pairs.filter((p) => !known.includes(p.split('=')[0]))
  if (provider !== 'none' && apiKey) kept.push(`${provider}=${apiKey}`)
  parsed.pathname = '/' + [...(kept.length ? [kept.join('|')] : []), manifest].join('/')
  return parsed.toString()
}

// ---------------------------------------------------------------- library

interface LibraryFile {
  items: Record<string, LibraryItem>
  progress: Record<string, ProgressEntry>
}

let libCache: LibraryFile | null = null

function library(): LibraryFile {
  if (!libCache) libCache = readJson<LibraryFile>('library.json', { items: {}, progress: {} })
  return libCache
}

function persistLibrary(): void {
  writeJson('library.json', library())
}

export function getLibrary(): { items: LibraryItem[]; progress: ProgressEntry[] } {
  const lib = library()
  return {
    items: Object.values(lib.items).sort((a, b) => (b.addedAt ?? 0) - (a.addedAt ?? 0)),
    progress: Object.values(lib.progress).sort((a, b) => b.updatedAt - a.updatedAt)
  }
}

export function toggleFavorite(item: LibraryItem): boolean {
  const lib = library()
  const key = `${item.type}:${item.id}`
  if (lib.items[key]) {
    delete lib.items[key]
    persistLibrary()
    return false
  }
  lib.items[key] = { ...item, key, favorite: true, addedAt: Date.now() }
  persistLibrary()
  return true
}

export function setProgress(entry: ProgressEntry): void {
  const lib = library()
  // Past 95% counts as watched. The entry stays so it can show up as history.
  const finished = entry.duration > 0 && entry.time / entry.duration > 0.95
  lib.progress[entry.key] = { ...entry, finished, updatedAt: Date.now() }
  persistLibrary()
}

export function markWatched(key: string, watched: boolean): void {
  const lib = library()
  const entry = lib.progress[key]
  if (!entry) return
  entry.finished = watched
  entry.updatedAt = Date.now()
  persistLibrary()
}

export function clearProgress(key: string): void {
  const lib = library()
  delete lib.progress[key]
  persistLibrary()
}
