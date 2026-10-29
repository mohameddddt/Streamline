import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type {
  LocalLibraryStatus,
  MetaDetail,
  MetaPreview,
  Stream,
  SubtitleTrack
} from '../shared/types'
import { BUILTIN, fetchJson, sizeLabel, type BuiltinAddon } from '../shared/builtins'
import { getSettings } from './settings'
import { isVideo, localFileUrl } from './torrent'
import { finished as finishedDownloads } from './downloads'

/**
 * The local library: films and episodes already on this computer, from the
 * folders picked in Settings. Files are matched to Cinemeta by name, so they
 * show up with artwork and sit on the same title pages as everything else —
 * the file is simply one more source there, and the one that starts instantly.
 */

const CINEMETA = 'https://v3-cinemeta.strem.io'
const INDEX_FILE = 'local-library.json'
/** Below this a "video" is a sample, a trailer or an extra. */
const MIN_SIZE = 20 * 1024 ** 2
const MAX_DEPTH = 8
const MAX_FILES = 5000

interface Parsed {
  title: string
  year?: number
  season?: number
  episode?: number
}

interface Match {
  id: string
  type: 'movie' | 'series'
  name: string
  poster?: string
  year?: string
}

interface Entry {
  path: string
  size: number
  mtimeMs: number
  parsed: Parsed
  /** null when Cinemeta had nothing that fit; the file still plays under its own name. */
  match: Match | null
}

interface IndexFile {
  scannedAt: number
  entries: Entry[]
}

// ---------------------------------------------------------------- naming

const JUNK =
  /\b(2160p|1080p|720p|576p|480p|4k|uhd|hdr10?|dv|blu-?ray|bdrip|brrip|web-?dl|web-?rip|web|hdtv|dvdrip|dvd|x26[45]|h ?26[45]|hevc|avc|aac\d?|ac3|e?ac3|ddp?\d?|dts|truehd|atmos|remux|proper|repack|extended|unrated|imax|10bit|multi|subbed|dubbed)\b/i

function tidy(s: string): string {
  return s
    .replace(/[([{][^)\]}]*$/, '')
    .replace(/[-–(\s]+$/, '')
    .replace(/^[-–\s]+/, '')
    .replace(/\s+/g, ' ')
    .trim()
}

/** "Show Name/Season 2/Show.Name.S02E05.mkv": the show is named by a folder, not "Season 2". */
function showFromFolders(file: string): string {
  let dir = path.dirname(file)
  for (let i = 0; i < 2; i++) {
    const name = path.basename(dir)
    if (!/^(season|series|staffel|saison|s)\s*\d+$/i.test(name) && !/^specials?$/i.test(name)) {
      return tidy(name.replace(/[._]+/g, ' ').replace(/\b(19|20)\d\d\b.*$/, ''))
    }
    dir = path.dirname(dir)
  }
  return ''
}

/** Pulls a title, year and episode numbers out of a release-style file name. */
export function parseName(file: string): Parsed {
  const base = path
    .basename(file, path.extname(file))
    // Bracketed tags go — "[YTS]", "[1080p]" — but a bracketed year is kept.
    .replace(/\[(?!(?:19|20)\d\d\])[^\]]*\]/g, ' ')
    .replace(/[._]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

  const ep = /\bS(\d{1,2}) ?E(\d{1,3})\b/i.exec(base) ?? /\b(\d{1,2})x(\d{2,3})\b/.exec(base)
  if (ep) {
    // "04 - The Office 1x04": a leading track number is not part of the show's name.
    const before = base.slice(0, ep.index).replace(/^\d{1,3}\s*[-–.]\s+/, '')
    const yearMatch = /\b((?:19|20)\d\d)\b/.exec(before)
    const title = tidy(before.replace(/\(?\b(19|20)\d\d\b\)?/, '')) || showFromFolders(file)
    return {
      title,
      year: yearMatch ? Number(yearMatch[1]) : undefined,
      season: Number(ep[1]),
      episode: Number(ep[2])
    }
  }

  // The last year that is not the very start of the name: "2001 A Space Odyssey 1968".
  let year: RegExpExecArray | null = null
  const years = /\b((?:19|20)\d\d)\b/g
  for (let m = years.exec(base); m; m = years.exec(base)) if (m.index > 0) year = m
  if (year) return { title: tidy(base.slice(0, year.index)), year: Number(year[1]) }

  const junk = JUNK.exec(base)
  const title = tidy(junk ? base.slice(0, junk.index) : base)
  return { title: title || tidy(path.basename(path.dirname(file)).replace(/[._]+/g, ' ')) }
}

const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

const yearOf = (releaseInfo?: string): number => Number(/\d{4}/.exec(releaseInfo ?? '')?.[0] ?? 0)

/** Shared words over all words: "holiday video" is not "Greatest Holiday Videos Countdown". */
function overlap(a: string, b: string): number {
  const wa = new Set(a.split(' '))
  const wb = new Set(b.split(' '))
  const shared = [...wa].filter((w) => wb.has(w)).length
  return shared / new Set([...wa, ...wb]).size
}

/**
 * Cinemeta's search is fuzzy — asked for "Sintel" it leads with Interstellar —
 * so its answer is kept only when the name, and the year if known, back it up.
 * A wrong match is worse than none: unmatched files still play under their name.
 */
function pick(metas: MetaPreview[], parsed: Parsed): MetaPreview | undefined {
  const wanted = norm(parsed.title)
  let best: { meta: MetaPreview; score: number } | undefined
  metas.slice(0, 10).forEach((meta, i) => {
    const name = norm(meta.name)
    let score = -i
    if (name === wanted) score += 20
    else if (overlap(name, wanted) >= 0.6) score += 6
    else score -= 30
    if (parsed.year) {
      const y = yearOf(meta.releaseInfo)
      if (y === parsed.year) score += 15
      else if (y && Math.abs(y - parsed.year) === 1) score += 8
      else if (y) score -= 12
    }
    if (!best || score > best.score) best = { meta, score }
  })
  return best && best.score >= 0 ? best.meta : undefined
}

async function lookup(parsed: Parsed): Promise<Match | null> {
  if (!parsed.title) return null
  const type = parsed.season !== undefined ? 'series' : 'movie'
  const url = `${CINEMETA}/catalog/${type}/top/search=${encodeURIComponent(parsed.title)}.json`
  const res = await fetchJson<{ metas?: MetaPreview[] }>(url, 15000)
  const meta = pick(res.metas ?? [], parsed)
  if (!meta || !meta.id.startsWith('tt')) return null
  return { id: meta.id, type, name: meta.name, poster: meta.poster, year: meta.releaseInfo }
}

// ----------------------------------------------------------------- index

const indexPath = (): string => path.join(app.getPath('userData'), INDEX_FILE)

let index: IndexFile | null = null
let scanning: Promise<void> | null = null
let lastError: string | undefined

function loadIndex(): IndexFile {
  if (!index) {
    try {
      index = JSON.parse(fs.readFileSync(indexPath(), 'utf8')) as IndexFile
    } catch {
      index = { scannedAt: 0, entries: [] }
    }
  }
  return index
}

function saveIndex(next: IndexFile): void {
  index = next
  try {
    fs.writeFileSync(indexPath(), JSON.stringify(next), 'utf8')
  } catch (err) {
    console.warn('[local] could not save the index', (err as Error).message)
  }
}

async function walk(dir: string, depth: number, out: { path: string; size: number; mtimeMs: number }[]): Promise<void> {
  if (depth > MAX_DEPTH || out.length >= MAX_FILES) return
  let dirents: fs.Dirent[]
  try {
    dirents = await fs.promises.readdir(dir, { withFileTypes: true })
  } catch {
    return
  }
  for (const d of dirents) {
    if (out.length >= MAX_FILES) return
    if (d.name.startsWith('.') || d.name.startsWith('$') || d.name === 'System Volume Information') continue
    const full = path.join(dir, d.name)
    if (d.isDirectory()) {
      await walk(full, depth + 1, out)
    } else if (d.isFile() && isVideo(d.name) && !/\bsample\b/i.test(d.name)) {
      try {
        const stat = await fs.promises.stat(full)
        if (stat.size >= MIN_SIZE) out.push({ path: full, size: stat.size, mtimeMs: stat.mtimeMs })
      } catch {
        /* vanished mid-scan */
      }
    }
  }
}

/** Runs `fn` over `items`, a few at a time, so a big folder does not flood Cinemeta. */
async function eachLimited<T>(items: T[], limit: number, fn: (item: T) => Promise<void>): Promise<void> {
  let next = 0
  const worker = async (): Promise<void> => {
    while (next < items.length) await fn(items[next++])
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

async function scan(): Promise<void> {
  const folders = getSettings().localFolders ?? []
  const found: { path: string; size: number; mtimeMs: number }[] = []
  for (const folder of folders) await walk(folder, 0, found)

  // Unchanged files keep their match; only new or changed ones are looked up.
  const known = new Map(loadIndex().entries.map((e) => [e.path, e]))
  const entries: Entry[] = []
  const todo: Entry[] = []
  for (const f of found) {
    const old = known.get(f.path)
    if (old && old.size === f.size && old.mtimeMs === f.mtimeMs) {
      entries.push(old)
    } else {
      const entry: Entry = { ...f, parsed: parseName(f.path), match: null }
      entries.push(entry)
      todo.push(entry)
    }
  }

  // Every episode of a show asks the same question; ask it once.
  const lookups = new Map<string, Promise<Match | null>>()
  await eachLimited(todo, 4, async (entry) => {
    const p = entry.parsed
    const key = `${p.season !== undefined ? 'series' : 'movie'}|${norm(p.title)}|${p.year ?? ''}`
    if (!lookups.has(key)) lookups.set(key, lookup(p).catch(() => null))
    entry.match = await (lookups.get(key) as Promise<Match | null>)
  })

  saveIndex({ scannedAt: Date.now(), entries })
}

/** Rescans the library folders. Concurrent calls share one scan. */
export function rescan(): Promise<LocalLibraryStatus> {
  if (!scanning) {
    lastError = undefined
    scanning = scan()
      .catch((err) => {
        lastError = (err as Error).message
        console.warn('[local] scan failed', lastError)
      })
      .finally(() => {
        scanning = null
      })
  }
  return scanning.then(status)
}

/** What is in the index now, limited to folders that are still in Settings. */
function entries(): Entry[] {
  const folders = (getSettings().localFolders ?? []).map((f) => path.resolve(f))
  return loadIndex().entries.filter((e) =>
    folders.some((f) => {
      const rel = path.relative(f, e.path)
      return !rel.startsWith('..') && !path.isAbsolute(rel)
    })
  )
}

export function status(): LocalLibraryStatus {
  const list = entries()
  return {
    scanning: Boolean(scanning),
    scannedAt: loadIndex().scannedAt,
    files: list.length,
    movies: list.filter((e) => e.match?.type === 'movie').length,
    episodes: list.filter((e) => e.match?.type === 'series').length,
    unmatched: list.filter((e) => !e.match).length,
    error: lastError
  }
}

/** Before answering, make sure there is something to answer from. */
async function ready(): Promise<void> {
  if (!(getSettings().localFolders ?? []).length) return
  if (!loadIndex().scannedAt || scanning) await rescan()
}

// ----------------------------------------------------------------- addon

const localId = (file: string): string => `local:${Buffer.from(file).toString('base64url')}`
const fileOf = (id: string): string => Buffer.from(id.slice('local:'.length), 'base64url').toString()

function displayName(e: Entry): string {
  const p = e.parsed
  const ep =
    p.season !== undefined
      ? ` S${String(p.season).padStart(2, '0')}E${String(p.episode).padStart(2, '0')}`
      : ''
  return (p.title || path.basename(e.path, path.extname(e.path))) + ep
}

function matching(type: string, id: string): Entry[] {
  if (id.startsWith('local:')) {
    const file = fileOf(id)
    return entries().filter((e) => e.path === file)
  }
  if (type === 'movie') return entries().filter((e) => e.match?.type === 'movie' && e.match.id === id)
  const [show, season, episode] = id.split(':')
  return entries().filter(
    (e) =>
      e.match?.type === 'series' &&
      e.match.id === show &&
      e.parsed.season === Number(season) &&
      e.parsed.episode === Number(episode)
  )
}

function toStream(e: Entry): Stream {
  const name = path.basename(e.path)
  return {
    filePath: e.path,
    name: 'On this computer',
    title: `${name}\n📁 ${path.dirname(e.path)}\n💾 ${sizeLabel(e.size)}`,
    behaviorHints: { filename: name }
  }
}

const LANGS: Record<string, string> = {
  en: 'eng', fr: 'fre', es: 'spa', de: 'ger', it: 'ita', pt: 'por', nl: 'dut', ru: 'rus', ar: 'ara',
  ja: 'jpn', zh: 'chi', ko: 'kor', pl: 'pol', tr: 'tur', sv: 'swe', no: 'nor', da: 'dan', fi: 'fin'
}

/** `Film.mkv` takes `Film.srt`, `Film.en.srt`, `Film.English.vtt`. */
async function sidecars(e: Entry): Promise<SubtitleTrack[]> {
  const dir = path.dirname(e.path)
  const stem = path.basename(e.path, path.extname(e.path)).toLowerCase()
  let names: string[]
  try {
    names = await fs.promises.readdir(dir)
  } catch {
    return []
  }
  const out: SubtitleTrack[] = []
  for (const name of names) {
    const ext = path.extname(name).toLowerCase()
    if (ext !== '.srt' && ext !== '.vtt') continue
    const base = path.basename(name, ext)
    if (!base.toLowerCase().startsWith(stem)) continue
    const tag = base.slice(stem.length).replace(/^[._\s-]+/, '').toLowerCase()
    const lang = LANGS[tag] ?? (/^[a-z]{3}$/.test(tag) ? tag : tag ? tag.slice(0, 12) : 'und')
    const file = path.join(dir, name)
    out.push({ id: `local-sub:${file}`, url: await localFileUrl(file), lang })
  }
  return out
}

export const localAddon: BuiltinAddon = {
  url: BUILTIN.local,
  manifest: () => {
    const enabled = (getSettings().localFolders ?? []).length > 0
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

  async catalog(type, _id, extra) {
    await ready()
    const query = norm(String(extra.search ?? ''))
    const seen = new Set<string>()
    const out: MetaPreview[] = []
    const newest = [...entries()].sort((a, b) => b.mtimeMs - a.mtimeMs)
    for (const e of newest) {
      const meta: MetaPreview | null = e.match
        ? e.match.type === type
          ? { id: e.match.id, type, name: e.match.name, poster: e.match.poster, releaseInfo: e.match.year }
          : null
        : // Unmatched files are listed as films under their own name, episodes included.
          type === 'movie'
          ? { id: localId(e.path), type: 'movie', name: displayName(e) }
          : null
      if (!meta || seen.has(meta.id)) continue
      if (query && !norm(meta.name).includes(query)) continue
      seen.add(meta.id)
      out.push(meta)
    }
    return out
  },

  async meta(_type, id) {
    const [e] = matching('movie', id)
    if (!e) return null
    const detail: MetaDetail = {
      id,
      type: 'movie',
      name: displayName(e),
      releaseInfo: e.parsed.year ? String(e.parsed.year) : undefined,
      description: `${e.path}\n\nStreamline could not match this file to a title, so it is shown under its file name. Renaming it to something like “Title (Year).mkv” and rescanning usually fixes that.`
    }
    return detail
  },

  async streams(type, id) {
    if (!loadIndex().scannedAt) await ready()
    const out = matching(type, id).map(toStream)
    // Finished downloads are known by id already, no name matching needed.
    const seen = new Set(out.map((s) => s.filePath))
    for (const d of finishedDownloads()) {
      const mine = type === 'series' ? d.videoId === id : d.metaId === id && !d.videoId
      if (!mine || seen.has(d.filePath)) continue
      seen.add(d.filePath)
      out.push({
        filePath: d.filePath,
        name: 'Downloaded',
        addonName: 'Downloaded',
        title: `${d.fileName}\n📁 ${path.dirname(d.filePath)}\n💾 ${sizeLabel(d.length)}`,
        behaviorHints: { filename: d.fileName }
      })
    }
    return out
  },

  async subtitles(type, id) {
    const lists = await Promise.all(matching(type, id).map(sidecars))
    return lists.flat()
  }
}
