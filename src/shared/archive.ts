import type { MetaDetail, MetaPreview, Stream } from './types'
import {
  BUILTIN,
  fetchJson,
  heightLabel,
  sizeLabel,
  type BuiltinAddon,
  type BuiltinContext,
  type Extra
} from './builtins'

/**
 * The Internet Archive's public-domain and openly licensed films. The Archive
 * sends CORS headers, so this runs unchanged in the desktop app and the web
 * version, and its MP4s play straight in a browser.
 *
 * Anyone can upload to the Archive, so this sticks to its curated film
 * collections and, within them, to items that either carry an explicit
 * Creative Commons / public-domain licence or predate 1978 (after which a US
 * film only entered the public domain by dedication, which would be marked).
 */

const API = 'https://archive.org'
const ROWS = 50

const COLLECTIONS: { genre: string; query: string }[] = [
  { genre: 'Feature films', query: 'collection:feature_films' },
  { genre: 'Silent era', query: 'collection:silent_films' },
  { genre: 'Sci-fi & horror', query: 'collection:SciFi_Horror' },
  { genre: 'Comedy', query: 'collection:Comedy_Films' },
  { genre: 'Classic cartoons', query: 'collection:classic_cartoons' },
  { genre: 'Animation', query: 'collection:animationandcartoons' }
]

const CLEARED = '(licenseurl:* OR year:[1890 TO 1977])'

function scopeFor(genre?: string): string {
  const picked = COLLECTIONS.find((c) => c.genre === genre)
  const collections = picked
    ? picked.query
    : '(' + COLLECTIONS.map((c) => `(${c.query})`).join(' OR ') + ')'
  return `mediatype:movies AND ${collections} AND ${CLEARED}`
}

/** Search words, stripped of anything the Archive's query syntax would read. */
function words(text: string): string[] {
  return text
    .normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s']/gu, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 0 && !/^(and|or|not)$/i.test(w))
}

interface SearchDoc {
  identifier: string
  title?: string | string[]
  year?: number | string
  description?: string | string[]
  subject?: string | string[]
}

async function searchItems(query: string, page: number, rows = ROWS, timeoutMs = 20000): Promise<SearchDoc[]> {
  const params = new URLSearchParams({ q: query, rows: String(rows), page: String(page), output: 'json' })
  for (const f of ['identifier', 'title', 'year', 'description', 'subject']) params.append('fl[]', f)
  params.append('sort[]', 'downloads desc')
  const res = await fetchJson<{ response?: { docs?: SearchDoc[] } }>(
    `${API}/advancedsearch.php?${params.toString()}`,
    timeoutMs
  )
  return res.response?.docs ?? []
}

const first = (v: unknown): string =>
  Array.isArray(v) ? String(v[0] ?? '') : v === undefined || v === null ? '' : String(v)

const list = (v: unknown): string[] =>
  (Array.isArray(v) ? v : v ? [v] : [])
    .flatMap((s) => String(s).split(/[;,]/))
    .map((s) => s.trim())
    .filter(Boolean)

/** Archive descriptions are uploader HTML. */
function plainText(html: string): string {
  return html
    .replace(/<br\s*\/?>|<\/p>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

const posterFor = (identifier: string): string => `${API}/services/img/${encodeURIComponent(identifier)}`

function preview(doc: SearchDoc): MetaPreview {
  const description = plainText(first(doc.description))
  return {
    id: `ia:${doc.identifier}`,
    type: 'movie',
    name: first(doc.title) || doc.identifier,
    poster: posterFor(doc.identifier),
    releaseInfo: first(doc.year) || undefined,
    description: description.length > 400 ? description.slice(0, 397) + '…' : description,
    genres: list(doc.subject).slice(0, 4)
  }
}

// --------------------------------------------------------------- item files

interface ItemFile {
  name: string
  format?: string
  size?: string
  length?: string
  height?: string
  btih?: string
}

interface Item {
  metadata?: Record<string, unknown>
  files?: ItemFile[]
}

const ITEM_TTL = 1000 * 60 * 30
const items = new Map<string, { at: number; item: Promise<Item> }>()

function getItem(identifier: string): Promise<Item> {
  const hit = items.get(identifier)
  if (hit && Date.now() - hit.at < ITEM_TTL) return hit.item
  const item = fetchJson<Item>(`${API}/metadata/${encodeURIComponent(identifier)}`)
  item.catch(() => items.delete(identifier))
  items.set(identifier, { at: Date.now(), item })
  return item
}

/** Seconds, from either `5731.83` or `95:17`. */
function seconds(length?: string): number {
  if (!length) return 0
  if (length.includes(':')) return length.split(':').reduce((acc, part) => acc * 60 + Number(part), 0)
  return Number(length) || 0
}

/** How well the built-in player takes each container: MP4 plays as-is, the rest gets converted. */
function rank(f: ItemFile): number {
  const name = f.name.toLowerCase()
  if (name.endsWith('.mp4') || name.endsWith('.m4v')) return /_512kb\.mp4$/.test(name) ? 1 : 4
  if (/\.(webm|mkv)$/.test(name)) return 3
  if (/\.(avi|mpe?g|mov|wmv)$/.test(name)) return 2
  if (name.endsWith('.ogv')) return 0
  return -1
}

const EXTRAS = /\b(trailers?|teasers?|documentary|making of|behind the scenes|featurettes?|interviews?|extras?|bonus|commentary)\b/i

/**
 * The films in an item, best first: full-length (or, given the film's runtime,
 * closest to it), then the copy the built-in player handles best. Items often
 * carry trailers and making-of reels next to the film; those are left out.
 */
function videoFiles(item: Item, runtime = 0): ItemFile[] {
  const files = (item.files ?? []).filter((f) => {
    if (rank(f) < 0 || f.name.includes('.thumbs/')) return false
    if (EXTRAS.test(f.name.replace(/[._-]+/g, ' '))) return false
    const len = seconds(f.length)
    if (len > 0 && len < 60) return false
    return Number(f.size ?? 0) > 2 * 1024 ** 2
  })
  const fit = (f: ItemFile): number => {
    const len = seconds(f.length)
    return runtime ? -Math.abs(len - runtime) : len
  }
  return files.sort((a, b) => {
    const fa = fit(a)
    const fb = fit(b)
    const scale = Math.max(runtime, seconds(a.length), seconds(b.length))
    if (Math.abs(fa - fb) > scale * 0.05) return fb - fa
    return rank(b) - rank(a) || Number(b.height ?? 0) - Number(a.height ?? 0)
  })
}

/** Cinemeta writes runtimes as "96 min" or "1h 36min". */
function runtimeSeconds(runtime?: string): number {
  if (!runtime) return 0
  const h = /(\d+)\s*h/i.exec(runtime)
  const m = /(\d+)\s*m/i.exec(runtime)
  return ((h ? Number(h[1]) * 60 : 0) + (m ? Number(m[1]) : 0)) * 60
}

const downloadUrl = (identifier: string, file: string): string =>
  `${API}/download/${encodeURIComponent(identifier)}/${file.split('/').map(encodeURIComponent).join('/')}`

function describe(f: ItemFile, label?: string): string {
  const quality = [heightLabel(Number(f.height ?? 0)), f.format].filter(Boolean).join(' · ')
  const size = Number(f.size ?? 0)
  return [label ? `${label} — ${f.name}` : f.name, quality, size ? `💾 ${sizeLabel(size)}` : '']
    .filter(Boolean)
    .join('\n')
}

/**
 * Direct links for each copy, plus the item's torrent. The torrent is what
 * makes a film downloadable to keep, and its metadata comes from the Archive
 * over HTTP (`xs`), so it starts without waiting for peers.
 */
function itemStreams(identifier: string, item: Item, limit: number, label?: string, runtime = 0): Stream[] {
  const files = videoFiles(item, runtime).slice(0, limit)
  if (!files.length) return []
  // Matched by title, an item whose best file is far off the film's length is a different film.
  const len = seconds(files[0].length)
  if (runtime && len && Math.abs(len - runtime) > runtime * 0.35) return []
  const out: Stream[] = files.map((f) => ({
    url: downloadUrl(identifier, f.name),
    name: 'Internet Archive',
    title: describe(f, label),
    behaviorHints: { filename: f.name.split('/').pop(), bingeGroup: `ia-${identifier}` }
  }))
  const torrent = (item.files ?? []).find((f) => f.name.endsWith('_archive.torrent') && f.btih)
  if (torrent?.btih) {
    out.push({
      infoHash: torrent.btih.toLowerCase(),
      name: 'Internet Archive',
      title: describe(files[0], label ? `${label} (torrent)` : 'Torrent') + '\n⚙️ archive.org',
      behaviorHints: { filename: files[0].name.split('/').pop() },
      sources: [
        `xs:${downloadUrl(identifier, torrent.name)}`,
        'tracker:http://bt1.archive.org:6969/announce',
        'tracker:http://bt2.archive.org:6969/announce'
      ]
    })
  }
  return out
}

// ---------------------------------------------------------- title matching

const SUFFIX = new Set(
  'restored remastered remaster hd sd 1080p 720p 480p 4k colorized colourized color colour uncut full movie film version edition original widescreen ws raw dvd bluray complete'.split(
    ' '
  )
)

const norm = (s: string): string =>
  s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/&/g, ' and ')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()

/** "Night of the Living Dead (1968) - restored" is still Night of the Living Dead. */
function sameTitle(archiveTitle: string, name: string): boolean {
  const a = norm(archiveTitle)
  const b = norm(name)
  if (a === b) return true
  if (!a.startsWith(b + ' ')) return false
  return a
    .slice(b.length)
    .trim()
    .split(' ')
    .every((w) => SUFFIX.has(w) || /^(19|20)\d\d$/.test(w))
}

/** Archive copies of a film that the other addons know by its IMDb id. */
async function streamsForImdb(id: string, ctx: BuiltinContext): Promise<Stream[]> {
  const meta = await ctx.meta('movie', id).catch(() => null)
  const year = Number(/\d{4}/.exec(meta?.releaseInfo ?? '')?.[0] ?? 0)
  if (!meta?.name || !year) return []
  const runtime = runtimeSeconds(meta.runtime)
  const terms = words(meta.name)
  if (!terms.length) return []
  const docs = await searchItems(`${scopeFor()} AND title:(${terms.join(' AND ')})`, 1, 12, 8000)
  const matches = docs
    .filter((d) => {
      const y = Number(first(d.year))
      if (y && Math.abs(y - year) > 1) return false
      return sameTitle(first(d.title), meta.name) && (y > 0 || norm(first(d.title)) === norm(meta.name))
    })
    .slice(0, 3)
  const lists = await Promise.all(
    matches.map((d) =>
      getItem(d.identifier)
        .then((item) => itemStreams(d.identifier, item, 1, first(d.title) || d.identifier, runtime))
        .catch(() => [] as Stream[])
    )
  )
  return lists.flat()
}

// -------------------------------------------------------------------- addon

export const archiveAddon: BuiltinAddon = {
  url: BUILTIN.archive,
  manifest: () => ({
    id: 'streamline.archive',
    name: 'Internet Archive',
    version: '1.0.0',
    description: 'Public-domain and openly licensed films from archive.org — free to watch and keep.',
    types: ['movie'],
    catalogs: [
      {
        type: 'movie',
        id: 'archive',
        name: 'Public domain',
        extra: [
          { name: 'genre', options: COLLECTIONS.map((c) => c.genre) },
          { name: 'search' },
          { name: 'skip' }
        ]
      }
    ],
    resources: [
      'catalog',
      { name: 'meta', types: ['movie'], idPrefixes: ['ia:'] },
      { name: 'stream', types: ['movie'], idPrefixes: ['ia:', 'tt'] }
    ]
  }),

  async catalog(_type, _id, extra: Extra, ctx) {
    if (ctx.offline()) return []
    let query = scopeFor(extra.genre ? String(extra.genre) : undefined)
    if (extra.search) {
      const terms = words(String(extra.search))
      if (!terms.length) return []
      query += ` AND title:(${terms.join(' AND ')})`
    }
    const page = Math.floor(Number(extra.skip ?? 0) / ROWS) + 1
    return (await searchItems(query, page)).map(preview)
  },

  async meta(_type, id, ctx) {
    if (ctx.offline()) return null
    const identifier = id.slice('ia:'.length)
    const item = await getItem(identifier)
    const md = item.metadata
    if (!md) return null
    const longest = videoFiles(item)[0]
    const runtime = first(md.runtime) || (longest ? `${Math.round(seconds(longest.length) / 60)} min` : '')
    const detail: MetaDetail = {
      id,
      type: 'movie',
      name: first(md.title) || identifier,
      poster: posterFor(identifier),
      background: posterFor(identifier),
      description: plainText(first(md.description)),
      releaseInfo: first(md.year) || first(md.date).slice(0, 4) || undefined,
      genres: list(md.subject).slice(0, 6),
      director: list(md.creator).slice(0, 3),
      runtime: runtime && runtime !== '0 min' ? runtime : undefined
    }
    return detail
  },

  async streams(type, id, ctx) {
    if (ctx.offline()) return []
    if (id.startsWith('ia:')) {
      const identifier = id.slice('ia:'.length)
      return itemStreams(identifier, await getItem(identifier), 6)
    }
    // A plain IMDb film, not an episode (those look like tt123:1:2).
    if (type === 'movie' && /^tt\d+$/.test(id)) return streamsForImdb(id, ctx)
    return []
  }
}
