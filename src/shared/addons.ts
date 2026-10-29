import type {
  AddonManifest,
  AddonResourceDef,
  MetaDetail,
  MetaPreview,
  Stream,
  SubtitleTrack
} from './types'
import type { BuiltinAddon, BuiltinContext } from './builtins'

/**
 * The Stremio addon protocol client, shared by the desktop main process and the
 * web build. It only needs `fetch`, and addons are required to send CORS
 * headers, so the same code runs in Node and in a browser tab.
 */

export interface CatalogRef {
  addonUrl: string
  addonName: string
  type: string
  id: string
  name: string
  genres: string[]
  searchable: boolean
  requiresSearch: boolean
  /** Supports `skip`, so it can be paged through. */
  pageable: boolean
  /** Returns nothing unless a genre (or year, which addons send as a genre) is picked. */
  requiresGenre: boolean
  /**
   * Needs an extra only the app itself could supply (Cinemeta's "last videos"
   * wants a list of ids), so it cannot be browsed.
   */
  requiresOther: boolean
}

export interface AddonClientOptions {
  /** The installed manifest URLs, read fresh on every call. */
  addonUrls: () => string[]
  /**
   * Extra request headers. The browser build leaves this empty: anything beyond
   * `accept` turns each request into a CORS preflight some addons get wrong.
   */
  headers?: Record<string, string>
  /** Addons that answer in-process for their `streamline://` URL. */
  builtins?: BuiltinAddon[]
  /**
   * Remembers title details once fetched, so a title page — and a download's
   * — still opens with no connection.
   */
  metaStore?: MetaStore
  /**
   * True when the computer has no connection. Remote addons are then skipped
   * outright instead of each being waited on until it times out.
   */
  offline?: () => boolean
}

export interface MetaStore {
  get: (key: string) => MetaDetail | undefined
  set: (key: string, meta: MetaDetail) => void
}

/** A capped store kept in order of use; `save` persists it however the platform can. */
export function createMetaStore(
  initial: Record<string, MetaDetail>,
  save: (all: Record<string, MetaDetail>) => void,
  limit = 400
): MetaStore {
  const map = new Map(Object.entries(initial))
  let timer: ReturnType<typeof setTimeout> | null = null
  return {
    get: (key) => map.get(key),
    set: (key, meta) => {
      map.delete(key)
      map.set(key, meta)
      while (map.size > limit) map.delete(map.keys().next().value as string)
      if (timer) clearTimeout(timer)
      timer = setTimeout(() => save(Object.fromEntries(map)), 1500)
    }
  }
}

const MANIFEST_TTL = 1000 * 60 * 30
/** How long a manifest fetch may take before the addon counts as not responding. */
const MANIFEST_TIMEOUT = 8000
/** How long a page waits on a manifest it has never loaded before carrying on without it. */
const MANIFEST_WAIT = 2500
/** How long an addon that did not answer is skipped. */
const DOWN_TTL = 1000 * 60 * 5
/** Search shows what has arrived by then rather than waiting on the slowest catalog. */
const SEARCH_DEADLINE = 8000

function withDeadline<T>(job: Promise<T>, ms: number, fallback: T): Promise<T> {
  return Promise.race([job, new Promise<T>((r) => setTimeout(() => r(fallback), ms))])
}

function baseOf(manifestUrl: string): string {
  return manifestUrl.replace(/\/manifest\.json.*$/, '')
}

function supports(manifest: AddonManifest, resource: string, type: string, id?: string): boolean {
  for (const def of manifest.resources ?? []) {
    const d: AddonResourceDef = typeof def === 'string' ? { name: def } : def
    if (d.name !== resource) continue
    const types = d.types ?? manifest.types ?? []
    if (types.length && !types.includes(type)) continue
    const prefixes = d.idPrefixes ?? manifest.idPrefixes
    if (id && prefixes && prefixes.length && !prefixes.some((p) => id.startsWith(p))) continue
    return true
  }
  return false
}

function encodeExtra(extra?: Record<string, string | number | undefined>): string {
  if (!extra) return ''
  const parts = Object.entries(extra)
    .filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
  return parts.length ? '/' + parts.join('&') : ''
}

function extraNames(catalog: { extra?: { name: string }[]; extraSupported?: string[] }): string[] {
  return catalog.extraSupported ?? (catalog.extra ?? []).map((e) => e.name)
}

/** Chromium only accepts WebVTT in a text track, and most addons serve SubRip. */
export function srtToVtt(body: string): string {
  body = body.replace(/^﻿/, '').replace(/\r\n|\r/g, '\n')
  if (body.startsWith('WEBVTT')) return body
  const converted = body
    .replace(/^\d+\n(?=\d{2}:\d{2}:\d{2})/gm, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
  return `WEBVTT\n\n${converted}`
}

export function createAddonClient(options: AddonClientOptions) {
  const manifestCache = new Map<string, { at: number; manifest: AddonManifest }>()
  const builtinFor = (url: string): BuiltinAddon | undefined =>
    options.builtins?.find((b) => b.url === url)
  const isOffline = (): boolean => options.offline?.() ?? false
  const ctx: BuiltinContext = { meta: (type, id) => getMeta(type, id), offline: isOffline }

  async function fetchOnce<T>(url: string, timeoutMs: number): Promise<T> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), timeoutMs)
    try {
      const res = await fetch(url, {
        signal: ctrl.signal,
        headers: { accept: 'application/json', ...options.headers }
      })
      if (!res.ok) {
        const err = new Error(`${res.status} ${res.statusText} for ${url}`) as Error & { retry?: boolean }
        err.retry = res.status >= 500
        throw err
      }
      return (await res.json()) as T
    } finally {
      clearTimeout(timer)
    }
  }

  /**
   * Addon hosts sit behind CDNs that now and then answer a cold cache miss
   * with an error — which in a browser also lacks CORS headers and surfaces as
   * a bare network failure. One quick retry hides nearly all of those.
   */
  async function fetchJson<T>(url: string, timeoutMs = 20000): Promise<T> {
    const started = Date.now()
    try {
      return await fetchOnce<T>(url, timeoutMs)
    } catch (err) {
      const e = err as Error & { retry?: boolean }
      const transient = e.retry || e.name === 'TypeError'
      // A host that took seconds to fail is down, not hiccuping; retrying only doubles the wait.
      if (!transient || Date.now() - started > 3000) throw err
      await new Promise((r) => setTimeout(r, 700))
      return fetchOnce<T>(url, timeoutMs)
    }
  }

  /** Manifest URL -> until when it is skipped, after it failed to answer. */
  const down = new Map<string, number>()
  const inflight = new Map<string, Promise<AddonManifest>>()

  /** A request that never got an answer (no connection, or timed out) benches its addon. */
  function noteFailure(manifestUrl: string, err: unknown): void {
    const name = (err as Error)?.name
    if (name !== 'TypeError' && name !== 'AbortError') return
    if (!isDown(manifestUrl)) console.warn('[addons] not responding, skipping for a while:', manifestUrl)
    down.set(manifestUrl, Date.now() + DOWN_TTL)
  }

  function isDown(url: string): boolean {
    const until = down.get(url)
    if (until === undefined) return false
    if (Date.now() < until) return true
    down.delete(url)
    return false
  }

  function fetchManifest(manifestUrl: string): Promise<AddonManifest> {
    const pending = inflight.get(manifestUrl)
    if (pending) return pending
    const job = fetchOnce<AddonManifest>(manifestUrl, MANIFEST_TIMEOUT)
      .then((manifest) => {
        manifest.transportUrl = manifestUrl
        manifestCache.set(manifestUrl, { at: Date.now(), manifest })
        down.delete(manifestUrl)
        return manifest
      })
      .catch((err) => {
        down.set(manifestUrl, Date.now() + DOWN_TTL)
        console.warn('[addons] not responding, skipping for a while:', manifestUrl, String(err))
        throw err
      })
      .finally(() => inflight.delete(manifestUrl))
    inflight.set(manifestUrl, job)
    return job
  }

  /**
   * Manifests barely change, so a cached one is served even once it is old and
   * refreshed in the background. An addon that does not answer is skipped for a
   * few minutes rather than waited on by every page.
   */
  async function getManifest(manifestUrl: string): Promise<AddonManifest> {
    const builtin = builtinFor(manifestUrl)
    if (builtin) return { ...builtin.manifest(), transportUrl: manifestUrl }
    if (manifestUrl.startsWith('streamline://')) {
      throw new Error('This built-in source is only available in the desktop app.')
    }
    if (isOffline()) throw new Error('You are offline.')
    if (isDown(manifestUrl)) throw new Error('This addon is not responding; skipped for a few minutes.')
    const hit = manifestCache.get(manifestUrl)
    if (hit) {
      if (Date.now() - hit.at > MANIFEST_TTL) fetchManifest(manifestUrl).catch(() => undefined)
      return hit.manifest
    }
    return fetchManifest(manifestUrl)
  }

  /** Drops what is no longer installed. The rest stays: a settings change does not alter it. */
  function forgetManifests(): void {
    const installed = new Set(options.addonUrls())
    for (const url of manifestCache.keys()) if (!installed.has(url)) manifestCache.delete(url)
    for (const url of down.keys()) if (!installed.has(url)) down.delete(url)
  }

  /**
   * Every installed manifest that is ready within a moment. A slow one keeps
   * loading in the background and joins in on a later call, so one sluggish
   * host cannot hold up every page.
   */
  async function getManifests(): Promise<AddonManifest[]> {
    // Offline, only the built-ins can answer: no waiting on hosts that cannot be reached.
    const urls = isOffline() ? options.addonUrls().filter((u) => builtinFor(u)) : options.addonUrls()
    const results = await Promise.all(
      urls.map((u) => {
        const job = getManifest(u).catch(() => null)
        if (builtinFor(u) || manifestCache.has(u)) return job
        return Promise.race([job, new Promise<null>((r) => setTimeout(() => r(null), MANIFEST_WAIT))])
      })
    )
    return results.filter((m): m is AddonManifest => m !== null)
  }

  /** Installed addons currently being skipped because they did not answer. */
  /** Forgets which addons were not answering — the connection is back, so ask them again. */
  function wakeUp(): void {
    down.clear()
  }

  function unreachable(): string[] {
    return options.addonUrls().filter((u) => isDown(u) || (!manifestCache.has(u) && inflight.has(u)))
  }

  async function listCatalogs(): Promise<CatalogRef[]> {
    const manifests = await getManifests()
    const out: CatalogRef[] = []
    for (const m of manifests) {
      for (const c of m.catalogs ?? []) {
        const required =
          c.extraRequired ?? (c.extra ?? []).filter((e) => e.isRequired).map((e) => e.name)
        const names = extraNames(c)
        out.push({
          addonUrl: m.transportUrl,
          addonName: m.name,
          type: c.type,
          id: c.id,
          name: c.name ?? c.id,
          genres: (c.extra ?? []).find((e) => e.name === 'genre')?.options ?? [],
          searchable: names.includes('search'),
          requiresSearch: required.includes('search'),
          pageable: names.includes('skip'),
          requiresGenre: required.includes('genre'),
          requiresOther: required.some((r) => r !== 'genre' && r !== 'search')
        })
      }
    }
    return out
  }

  async function getCatalog(
    addonUrl: string,
    type: string,
    catalogId: string,
    extra?: Record<string, string | number | undefined>
  ): Promise<MetaPreview[]> {
    const builtin = builtinFor(addonUrl)
    if (builtin) return (await builtin.catalog?.(type, catalogId, extra ?? {}, ctx)) ?? []
    if (isOffline()) throw new Error('You are offline.')
    const url =
      `${baseOf(addonUrl)}/catalog/${encodeURIComponent(type)}/` +
      `${encodeURIComponent(catalogId)}${encodeExtra(extra)}.json`
    try {
      return (await fetchJson<{ metas?: MetaPreview[] }>(url)).metas ?? []
    } catch (err) {
      noteFailure(addonUrl, err)
      throw err
    }
  }

  async function search(query: string, type?: string): Promise<MetaPreview[]> {
    const manifests = await getManifests()
    const jobs: Promise<MetaPreview[]>[] = []
    for (const m of manifests) {
      for (const c of m.catalogs ?? []) {
        if (type && c.type !== type) continue
        if (!extraNames(c).includes('search')) continue
        jobs.push(
          withDeadline(
            getCatalog(m.transportUrl, c.type, c.id, { search: query }).catch(() => [] as MetaPreview[]),
            SEARCH_DEADLINE,
            [] as MetaPreview[]
          )
        )
      }
    }
    const results = await Promise.all(jobs)
    const seen = new Set<string>()
    const merged: MetaPreview[] = []
    for (const list of results) {
      for (const meta of list) {
        const key = `${meta.type}:${meta.id}`
        if (seen.has(key)) continue
        seen.add(key)
        merged.push(meta)
      }
    }
    return merged
  }

  /** Fresh details when an addon answers, else the last copy seen (offline). */
  async function getMeta(type: string, id: string): Promise<MetaDetail | null> {
    const key = `${type}:${id}`
    const fresh = await fetchMeta(type, id)
    if (fresh) {
      options.metaStore?.set(key, fresh)
      return fresh
    }
    return options.metaStore?.get(key) ?? null
  }

  async function fetchMeta(type: string, id: string): Promise<MetaDetail | null> {
    const manifests = (await getManifests()).filter((m) => supports(m, 'meta', type, id))
    for (const m of manifests) {
      try {
        const builtin = builtinFor(m.transportUrl)
        if (builtin) {
          const meta = await builtin.meta?.(type, id, ctx)
          if (meta) return meta
          continue
        }
        const url =
          `${baseOf(m.transportUrl)}/meta/${encodeURIComponent(type)}/` +
          `${encodeURIComponent(id)}.json`
        const res = await fetchJson<{ meta?: MetaDetail }>(url)
        if (res.meta) return res.meta
      } catch (err) {
        noteFailure(m.transportUrl, err)
        console.warn('[addons] meta failed', m.name, (err as Error).message)
      }
    }
    return null
  }

  async function getStreams(type: string, id: string): Promise<Stream[]> {
    const manifests = (await getManifests()).filter((m) => supports(m, 'stream', type, id))
    const jobs = manifests.map(async (m) => {
      const url =
        `${baseOf(m.transportUrl)}/stream/${encodeURIComponent(type)}/` +
        `${encodeURIComponent(id)}.json`
      try {
        const builtin = builtinFor(m.transportUrl)
        const streams = builtin
          ? ((await builtin.streams?.(type, id, ctx)) ?? [])
          : ((await fetchJson<{ streams?: Stream[] }>(url, 45000)).streams ?? [])
        // A built-in may name a source itself ("Downloaded"); remote addons never get to.
        return streams.map((s) => ({ ...s, addonName: (builtin && s.addonName) || m.name, addonId: m.id }))
      } catch (err) {
        noteFailure(m.transportUrl, err)
        console.warn('[addons] stream failed', m.name, (err as Error).message)
        return [] as Stream[]
      }
    })
    const lists = await Promise.all(jobs)
    // Debrid / direct-http / local files start instantly, so they lead the list.
    const instant = (s: Stream): number => Number(Boolean(s.url || s.filePath))
    return lists.flat().sort((a, b) => instant(b) - instant(a))
  }

  async function getSubtitles(
    type: string,
    id: string,
    extra?: Record<string, string | number | undefined>
  ): Promise<SubtitleTrack[]> {
    const manifests = (await getManifests()).filter((m) => supports(m, 'subtitles', type, id))
    const jobs = manifests.map(async (m) => {
      const url =
        `${baseOf(m.transportUrl)}/subtitles/${encodeURIComponent(type)}/` +
        `${encodeURIComponent(id)}${encodeExtra(extra)}.json`
      try {
        const builtin = builtinFor(m.transportUrl)
        const subtitles = builtin
          ? ((await builtin.subtitles?.(type, id, ctx)) ?? [])
          : ((await fetchJson<{ subtitles?: SubtitleTrack[] }>(url)).subtitles ?? [])
        return subtitles.map((s) => ({ ...s, addonName: m.name }))
      } catch (err) {
        noteFailure(m.transportUrl, err)
        return [] as SubtitleTrack[]
      }
    })
    return (await Promise.all(jobs)).flat()
  }

  async function fetchSubtitleAsVtt(url: string): Promise<string> {
    const ctrl = new AbortController()
    const timer = setTimeout(() => ctrl.abort(), 20000)
    try {
      const res = await fetch(url, { signal: ctrl.signal })
      if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
      return srtToVtt(await res.text())
    } finally {
      clearTimeout(timer)
    }
  }

  return {
    getManifest,
    getManifests,
    forgetManifests,
    unreachable,
    wakeUp,
    listCatalogs,
    getCatalog,
    search,
    getMeta,
    getStreams,
    getSubtitles,
    fetchSubtitleAsVtt
  }
}

export type AddonClient = ReturnType<typeof createAddonClient>
