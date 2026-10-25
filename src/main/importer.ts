import fs from 'fs'
import path from 'path'
import { unzipSync } from 'fflate'
import type {
  ImportService,
  ImportStatus,
  ImportSummary,
  LibraryItem,
  MetaPreview,
  ProgressEntry,
  RatingEntry
} from '../shared/types'
import { applyImport } from './settings'
import { simklFetchAll, traktFetchAll } from './trackers'

/**
 * One normalised line of someone's history, whatever service it came from.
 * Ratings are already on a 0-10 scale by the time they land here.
 */
interface Candidate {
  title: string
  year?: number
  imdb?: string
  type?: 'movie' | 'series'
  season?: number
  episode?: number
  watched: boolean
  watchlist: boolean
  rating?: number
  date?: number
  /** True when `date` is the day it was watched rather than when it was logged. */
  dateIsWatched?: boolean
  source: string
}

// ---------------------------------------------------------------------- csv

function parseCsv(input: string): string[][] {
  const text = input.replace(/^﻿/, '')
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i++
        } else quoted = false
      } else cell += ch
    } else if (ch === '"') quoted = true
    else if (ch === ',') {
      row.push(cell)
      cell = ''
    } else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++
      row.push(cell)
      cell = ''
      if (row.some((c) => c.trim() !== '')) rows.push(row)
      row = []
    } else cell += ch
  }
  row.push(cell)
  if (row.some((c) => c.trim() !== '')) rows.push(row)
  return rows
}

const ALIASES = {
  title: [
    'name',
    'title',
    'film',
    'film title',
    'movie',
    'show',
    'show name',
    'series',
    'primary title',
    'original title'
  ],
  year: ['year', 'release year', 'released'],
  imdb: ['imdbid', 'imdb id', 'imdb_id', 'imdb', 'const', 'tconst'],
  rating: ['rating', 'your rating', 'my rating', 'user rating', 'user_rating', 'score', 'stars'],
  watchedOn: ['watched date', 'watcheddate', 'date watched', 'watched at', 'watched_at', 'last watched'],
  date: ['date', 'date rated', 'created', 'added'],
  type: ['type', 'title type', 'media type', 'kind'],
  season: ['season', 'season number'],
  episode: ['episode', 'episode number']
} as const

type Field = keyof typeof ALIASES

function columnIndex(headers: string[], field: Field): number {
  for (const alias of ALIASES[field]) {
    const i = headers.indexOf(alias)
    if (i >= 0) return i
  }
  return -1
}

function parseYear(value: string | undefined): number | undefined {
  const m = /\d{4}/.exec(value ?? '')
  return m ? Number(m[0]) : undefined
}

function parseRating(value: string | undefined): number | undefined {
  const raw = (value ?? '').trim()
  if (!raw) return undefined
  if (/[★½]/.test(raw)) return (raw.match(/★/g)?.length ?? 0) + (raw.includes('½') ? 0.5 : 0)
  const n = parseFloat(raw.replace(',', '.'))
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function parseDate(value: string | undefined): number | undefined {
  if (!value) return undefined
  const t = Date.parse(value)
  return Number.isNaN(t) ? undefined : t
}

/** Movie, series, or 'skip' for things we have no place for (episodes, games). */
function typeFrom(
  value: string,
  hasEpisode: boolean,
  service: ImportService
): 'movie' | 'series' | 'skip' | undefined {
  const v = value.toLowerCase()
  if (hasEpisode) return 'series'
  if (/movie|film/.test(v)) return 'movie'
  if (/episode|game|short/.test(v)) return 'skip'
  if (/series|tv|show|season/.test(v)) return 'series'
  if (service === 'letterboxd') return 'movie'
  if (service === 'serializd') return 'series'
  return undefined
}

/** Which of a Letterboxd export's files means what. Anything else is ignored. */
const LETTERBOXD_FILES = new Set(['watched', 'ratings', 'diary', 'watchlist'])

function candidatesFromCsv(name: string, text: string, service: ImportService): Candidate[] {
  const rows = parseCsv(text)
  if (rows.length < 2) return []
  const headers = rows[0].map((h) => h.trim().toLowerCase())
  const col = {
    title: columnIndex(headers, 'title'),
    year: columnIndex(headers, 'year'),
    imdb: columnIndex(headers, 'imdb'),
    rating: columnIndex(headers, 'rating'),
    watchedOn: columnIndex(headers, 'watchedOn'),
    date: columnIndex(headers, 'date'),
    type: columnIndex(headers, 'type'),
    season: columnIndex(headers, 'season'),
    episode: columnIndex(headers, 'episode')
  }
  if (col.title < 0 && col.imdb < 0) return []

  const base = path.basename(name).toLowerCase().replace(/\.csv$/, '')
  const watchlist = /watchlist|plan.?to.?watch|want/.test(base)
  const cell = (r: string[], i: number): string => (i >= 0 ? (r[i] ?? '').trim() : '')

  const out: Candidate[] = []
  for (const r of rows.slice(1)) {
    const imdbRaw = cell(r, col.imdb)
    const imdb = /^tt\d+$/.test(imdbRaw) ? imdbRaw : undefined
    const title = cell(r, col.title)
    if (!title && !imdb) continue

    const season = parseInt(cell(r, col.season), 10)
    const episode = parseInt(cell(r, col.episode), 10)
    const hasEpisode = Number.isFinite(season) && Number.isFinite(episode)
    const type = typeFrom(cell(r, col.type), hasEpisode, service)
    if (type === 'skip') continue

    const watchedOn = parseDate(cell(r, col.watchedOn))
    out.push({
      title,
      year: parseYear(cell(r, col.year)),
      imdb,
      type,
      season: hasEpisode ? season : undefined,
      episode: hasEpisode ? episode : undefined,
      watched: !watchlist,
      watchlist,
      rating: parseRating(cell(r, col.rating)),
      date: watchedOn ?? parseDate(cell(r, col.date)),
      dateIsWatched: watchedOn !== undefined,
      source: service
    })
  }

  // Each file uses its own scale: Letterboxd and Serializd are half-stars out of
  // five, IMDb is out of ten. Bring them all to ten so ratings compare.
  const max = Math.max(0, ...out.map((c) => c.rating ?? 0))
  const scale =
    service === 'imdb' ? 1 : service === 'letterboxd' || service === 'serializd' || max <= 5
      ? 2
      : max <= 10
        ? 1
        : 0.1
  for (const c of out) if (c.rating !== undefined) c.rating = Math.min(10, c.rating * scale)
  return out
}

function readFiles(paths: string[]): { name: string; text: string }[] {
  const decoder = new TextDecoder('utf-8')
  const files: { name: string; text: string }[] = []
  for (const p of paths) {
    if (/\.zip$/i.test(p)) {
      const entries = Object.entries(unzipSync(new Uint8Array(fs.readFileSync(p))))
        .filter(([n]) => /\.csv$/i.test(n))
        .map(([n, data]) => ({ name: n, text: decoder.decode(data) }))
      // A Letterboxd export carries lists, reviews and comments too; only its
      // four history files are wanted. Other zips are read whole.
      const known = entries.filter(
        (e) => !/\//.test(e.name) && LETTERBOXD_FILES.has(path.basename(e.name, '.csv').toLowerCase())
      )
      files.push(...(known.length ? known : entries))
    } else {
      files.push({ name: path.basename(p), text: fs.readFileSync(p, 'utf8') })
    }
  }
  return files
}

// ---------------------------------------------------------------- accounts

async function candidatesFromTrakt(report: (phase: string) => void): Promise<Candidate[]> {
  const out: Candidate[] = []
  const lists: [string, 'ratings' | 'watched' | 'watchlist', 'movie' | 'series'][] = [
    ['/sync/ratings/movies', 'ratings', 'movie'],
    ['/sync/ratings/shows', 'ratings', 'series'],
    ['/sync/watched/movies', 'watched', 'movie'],
    ['/sync/watched/shows', 'watched', 'series'],
    ['/sync/watchlist/movies', 'watchlist', 'movie'],
    ['/sync/watchlist/shows', 'watchlist', 'series']
  ]
  for (const [route, kind, type] of lists) {
    report(`Reading Trakt ${kind} (${type === 'movie' ? 'movies' : 'shows'})…`)
    for (const it of await traktFetchAll(route)) {
      const obj = it.movie ?? it.show
      if (!obj?.title) continue
      out.push({
        title: obj.title,
        year: obj.year ?? undefined,
        imdb: obj.ids?.imdb ?? undefined,
        type,
        watched: kind !== 'watchlist',
        watchlist: kind === 'watchlist',
        rating: kind === 'ratings' ? it.rating : undefined,
        date: parseDate(it.last_watched_at ?? it.rated_at ?? it.listed_at),
        dateIsWatched: kind === 'watched',
        source: 'trakt'
      })
    }
  }
  return out
}

async function candidatesFromSimkl(report: (phase: string) => void): Promise<Candidate[]> {
  report('Reading your Simkl lists…')
  const data = await simklFetchAll()
  const out: Candidate[] = []
  const buckets: ['movies' | 'shows' | 'anime', 'movie' | 'series'][] = [
    ['movies', 'movie'],
    ['shows', 'series'],
    ['anime', 'series']
  ]
  for (const [bucket, type] of buckets) {
    for (const it of data[bucket] ?? []) {
      const obj = it.movie ?? it.show
      if (!obj?.title) continue
      const watched = it.status === 'completed'
      const watchlist = it.status === 'plantowatch'
      const rating = typeof it.user_rating === 'number' ? it.user_rating : undefined
      if (!watched && !watchlist && rating === undefined) continue
      out.push({
        title: obj.title,
        year: obj.year ?? undefined,
        imdb: obj.ids?.imdb ?? undefined,
        type,
        watched,
        watchlist,
        rating,
        date: parseDate(it.last_watched_at ?? it.added_to_watchlist_at),
        dateIsWatched: watched,
        source: 'simkl'
      })
    }
  }
  return out
}

// ------------------------------------------------------------------ matching

const CINEMETA = 'https://v3-cinemeta.strem.io'

async function getJson<T>(url: string): Promise<T | null> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 15000)
    try {
      const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } })
      if (res.status === 404) return null
      if (res.ok) return (await res.json()) as T
    } catch {
      /* retry once */
    } finally {
      clearTimeout(timer)
    }
  }
  return null
}

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function yearOf(m: MetaPreview): number | undefined {
  return parseYear(m.releaseInfo)
}

/**
 * Best candidate, not first. Cinemeta sometimes titles a film differently from
 * the service ("Dune" is "Dune: Part One"), and an unrelated title with the same
 * name a year off must not beat the real one — so an exact year outranks a near
 * one, and ties fall back to Cinemeta's own popularity order.
 */
function pickMatch(metas: MetaPreview[], title: string, year?: number): MetaPreview | null {
  const want = norm(title)
  if (!want) return null
  let best: MetaPreview | null = null
  let bestScore = 0
  for (const m of metas) {
    const name = norm(m.name)
    const y = yearOf(m)
    const yearExact = Boolean(year && y && y === year)
    const yearNear = Boolean(year && y && Math.abs(y - year) === 1)
    const yearUnknown = !year || !y

    let nameScore = 0
    if (name === want) nameScore = 4
    else if ((' ' + name + ' ').includes(' ' + want + ' ') || (' ' + want + ' ').includes(' ' + name + ' ')) {
      // A subtitle or alternate title: only trusted on an exact year.
      nameScore = yearExact ? 3 : 0
    }
    if (nameScore === 0) continue
    const yearScore = yearExact ? 3 : yearNear || yearUnknown ? 1 : 0
    if (yearScore === 0) continue

    if (nameScore + yearScore > bestScore) {
      best = m
      bestScore = nameScore + yearScore
    }
  }
  return best
}

const searchCache = new Map<string, MetaPreview[]>()

async function search(type: 'movie' | 'series', title: string): Promise<MetaPreview[]> {
  const key = `${type}:${norm(title)}`
  const hit = searchCache.get(key)
  if (hit) return hit
  const res = await getJson<{ metas?: MetaPreview[] }>(
    `${CINEMETA}/catalog/${type}/top/search=${encodeURIComponent(title)}.json`
  )
  const metas = res?.metas ?? []
  searchCache.set(key, metas)
  return metas
}

interface Resolved {
  id: string
  type: 'movie' | 'series'
  name: string
  poster?: string
  year?: string
}

const posterFor = (imdb: string): string => `https://images.metahub.space/poster/small/${imdb}/img`

async function resolve(c: Candidate): Promise<Resolved | null> {
  if (c.imdb) {
    let type = c.type
    let name = c.title
    let year = c.year ? String(c.year) : undefined
    if (!type) {
      // An id with no type: whichever catalogue knows it decides.
      for (const t of ['movie', 'series'] as const) {
        const res = await getJson<{ meta?: MetaPreview }>(`${CINEMETA}/meta/${t}/${c.imdb}.json`)
        if (res?.meta) {
          type = t
          name = name || res.meta.name
          year = year ?? res.meta.releaseInfo
          break
        }
      }
    }
    return { id: c.imdb, type: type ?? 'movie', name: name || c.imdb, poster: posterFor(c.imdb), year }
  }

  const order: ('movie' | 'series')[] = c.type ? [c.type] : ['movie', 'series']
  for (const type of order) {
    const match = pickMatch(await search(type, c.title), c.title, c.year)
    if (match) {
      return {
        id: match.id,
        type,
        name: match.name,
        poster: match.poster ?? (match.id.startsWith('tt') ? posterFor(match.id) : undefined),
        year: match.releaseInfo ?? (c.year ? String(c.year) : undefined)
      }
    }
  }
  return null
}

// ------------------------------------------------------------------- the job

let status: ImportStatus = { state: 'idle', phase: '', total: 0, done: 0 }

export function getStatus(): ImportStatus {
  return status
}

function mergeCandidates(list: Candidate[]): Candidate[] {
  const merged = new Map<string, Candidate>()
  for (const c of list) {
    const key = `${c.imdb ?? `${norm(c.title)}|${c.year ?? ''}`}|${c.type ?? ''}|${c.season ?? ''}|${c.episode ?? ''}`
    const prev = merged.get(key)
    if (!prev) {
      merged.set(key, { ...c })
      continue
    }
    prev.watched ||= c.watched
    prev.watchlist ||= c.watchlist
    prev.rating = c.rating ?? prev.rating
    prev.year = prev.year ?? c.year
    if (c.date !== undefined && (prev.date === undefined || (c.dateIsWatched && !prev.dateIsWatched))) {
      prev.date = c.date
      prev.dateIsWatched = c.dateIsWatched
    }
  }
  return [...merged.values()]
}

async function run(service: ImportService, paths: string[]): Promise<ImportSummary> {
  let candidates: Candidate[]
  const report = (phase: string): void => {
    status = { ...status, phase }
  }
  if (service === 'trakt') candidates = await candidatesFromTrakt(report)
  else if (service === 'simkl') candidates = await candidatesFromSimkl(report)
  else {
    report('Reading your files…')
    candidates = readFiles(paths).flatMap((f) => candidatesFromCsv(f.name, f.text, service))
  }
  if (candidates.length === 0) {
    throw new Error(
      'Nothing to import in that. Pick the export from the service — a Letterboxd ZIP, or a CSV with a title column.'
    )
  }

  const merged = mergeCandidates(candidates)
  status = { ...status, phase: 'Matching titles…', total: merged.length, done: 0 }

  const items: LibraryItem[] = []
  const progress: ProgressEntry[] = []
  const ratings: RatingEntry[] = []
  const summary: ImportSummary = { watched: 0, rated: 0, watchlist: 0, unmatched: [] }
  const now = Date.now()

  let next = 0
  const worker = async (): Promise<void> => {
    while (next < merged.length) {
      const c = merged[next++]
      const hit = await resolve(c).catch(() => null)
      status = { ...status, done: status.done + 1 }
      if (!hit) {
        summary.unmatched.push(c.year ? `${c.title} (${c.year})` : c.title)
        continue
      }
      const when = c.date ?? now
      const isEpisode = c.season !== undefined && c.episode !== undefined
      // Rating a title means you saw it, which is how Letterboxd treats it too.
      const watched = c.watched || c.rating !== undefined

      if (watched) {
        const videoId = isEpisode ? `${hit.id}:${c.season}:${c.episode}` : undefined
        progress.push({
          key: `${hit.type}:${videoId ?? hit.id}`,
          id: hit.id,
          type: hit.type,
          name: hit.name,
          poster: hit.poster,
          season: c.season,
          episode: c.episode,
          videoId,
          year: hit.year,
          time: 0,
          duration: 0,
          updatedAt: when,
          finished: true
        })
        summary.watched++
      } else if (c.watchlist) {
        items.push({
          key: `${hit.type}:${hit.id}`,
          id: hit.id,
          type: hit.type,
          name: hit.name,
          poster: hit.poster,
          favorite: true,
          addedAt: when
        })
        summary.watchlist++
      }

      if (c.rating !== undefined && !isEpisode) {
        ratings.push({
          key: `${hit.type}:${hit.id}`,
          id: hit.id,
          type: hit.type,
          name: hit.name,
          poster: hit.poster,
          year: hit.year,
          rating: Math.round(c.rating * 10) / 10,
          ratedAt: when,
          source: c.source
        })
        summary.rated++
      }
    }
  }
  await Promise.all(Array.from({ length: 6 }, worker))

  applyImport({ items, progress, ratings })
  return summary
}

export function start(service: ImportService, paths: string[]): void {
  if (status.state === 'running') throw new Error('An import is already running.')
  status = { state: 'running', phase: 'Starting…', total: 0, done: 0 }
  run(service, paths)
    .then((summary) => {
      status = { ...status, state: 'done', phase: 'Done', summary }
    })
    .catch((err: Error) => {
      status = { ...status, state: 'error', phase: 'Failed', error: err.message }
    })
}
