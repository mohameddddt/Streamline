import type {
  AddonManifest,
  AddonResourceDef,
  MetaDetail,
  MetaPreview,
  Stream,
  SubtitleTrack
} from '../shared/types'
import { getSettings } from './settings'

const MANIFEST_TTL = 1000 * 60 * 30
const manifestCache = new Map<string, { at: number; manifest: AddonManifest }>()

async function fetchJson<T>(url: string, timeoutMs = 20000): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: { accept: 'application/json', 'user-agent': 'Streamline/0.1' }
    })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

function baseOf(manifestUrl: string): string {
  return manifestUrl.replace(/\/manifest\.json.*$/, '')
}

export async function getManifest(manifestUrl: string): Promise<AddonManifest> {
  const hit = manifestCache.get(manifestUrl)
  if (hit && Date.now() - hit.at < MANIFEST_TTL) return hit.manifest
  const manifest = await fetchJson<AddonManifest>(manifestUrl)
  manifest.transportUrl = manifestUrl
  manifestCache.set(manifestUrl, { at: Date.now(), manifest })
  return manifest
}

export function forgetManifests(): void {
  manifestCache.clear()
}

export async function getManifests(): Promise<AddonManifest[]> {
  const results = await Promise.allSettled(getSettings().addons.map((u) => getManifest(u)))
  results.forEach((r, i) => {
    if (r.status === 'rejected') {
      console.warn('[addons] manifest failed', getSettings().addons[i], String(r.reason))
    }
  })
  return results
    .filter((r): r is PromiseFulfilledResult<AddonManifest> => r.status === 'fulfilled')
    .map((r) => r.value)
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

// ------------------------------------------------------------------ catalogs

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

function extraNames(catalog: { extra?: { name: string }[]; extraSupported?: string[] }): string[] {
  return catalog.extraSupported ?? (catalog.extra ?? []).map((e) => e.name)
}

export async function listCatalogs(): Promise<CatalogRef[]> {
  const manifests = await getManifests()
  const out: CatalogRef[] = []
  for (const m of manifests) {
    for (const c of m.catalogs ?? []) {
      const required =
        c.extraRequired ?? (c.extra ?? []).filter((e) => e.isRequired).map((e) => e.name)
      out.push({
        addonUrl: m.transportUrl,
        addonName: m.name,
        type: c.type,
        id: c.id,
        name: c.name ?? c.id,
        genres: (c.extra ?? []).find((e) => e.name === 'genre')?.options ?? [],
        searchable: extraNames(c).includes('search'),
        requiresSearch: required.includes('search')
      })
    }
  }
  return out
}

export async function getCatalog(
  addonUrl: string,
  type: string,
  catalogId: string,
  extra?: Record<string, string | number | undefined>
): Promise<MetaPreview[]> {
  const url =
    `${baseOf(addonUrl)}/catalog/${encodeURIComponent(type)}/` +
    `${encodeURIComponent(catalogId)}${encodeExtra(extra)}.json`
  const res = await fetchJson<{ metas?: MetaPreview[] }>(url)
  return res.metas ?? []
}

export async function search(query: string, type?: string): Promise<MetaPreview[]> {
  const manifests = await getManifests()
  const jobs: Promise<MetaPreview[]>[] = []
  for (const m of manifests) {
    for (const c of m.catalogs ?? []) {
      if (type && c.type !== type) continue
      if (!extraNames(c).includes('search')) continue
      jobs.push(
        getCatalog(m.transportUrl, c.type, c.id, { search: query }).catch(() => [] as MetaPreview[])
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

// ---------------------------------------------------------------------- meta

export async function getMeta(type: string, id: string): Promise<MetaDetail | null> {
  const manifests = (await getManifests()).filter((m) => supports(m, 'meta', type, id))
  for (const m of manifests) {
    try {
      const url =
        `${baseOf(m.transportUrl)}/meta/${encodeURIComponent(type)}/` +
        `${encodeURIComponent(id)}.json`
      const res = await fetchJson<{ meta?: MetaDetail }>(url)
      if (res.meta) return res.meta
    } catch (err) {
      console.warn('[addons] meta failed', m.name, (err as Error).message)
    }
  }
  return null
}

// ------------------------------------------------------------------- streams

export async function getStreams(type: string, id: string): Promise<Stream[]> {
  const manifests = (await getManifests()).filter((m) => supports(m, 'stream', type, id))
  const jobs = manifests.map(async (m) => {
    const url =
      `${baseOf(m.transportUrl)}/stream/${encodeURIComponent(type)}/` +
      `${encodeURIComponent(id)}.json`
    try {
      const res = await fetchJson<{ streams?: Stream[] }>(url, 45000)
      return (res.streams ?? []).map((s) => ({ ...s, addonName: m.name, addonId: m.id }))
    } catch (err) {
      console.warn('[addons] stream failed', m.name, (err as Error).message)
      return [] as Stream[]
    }
  })
  const lists = await Promise.all(jobs)
  // Debrid / direct-http streams start instantly, so they lead the list.
  return lists.flat().sort((a, b) => Number(Boolean(b.url)) - Number(Boolean(a.url)))
}

// ----------------------------------------------------------------- subtitles

export async function getSubtitles(
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
      const res = await fetchJson<{ subtitles?: SubtitleTrack[] }>(url)
      return (res.subtitles ?? []).map((s) => ({ ...s, addonName: m.name }))
    } catch {
      return [] as SubtitleTrack[]
    }
  })
  return (await Promise.all(jobs)).flat()
}

/** Chromium only accepts WebVTT in a text track, and most addons serve SubRip. */
export async function fetchSubtitleAsVtt(url: string): Promise<string> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), 20000)
  let body: string
  try {
    const res = await fetch(url, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`)
    body = await res.text()
  } finally {
    clearTimeout(timer)
  }
  body = body.replace(/^﻿/, '').replace(/\r\n|\r/g, '\n')
  if (body.startsWith('WEBVTT')) return body
  const converted = body
    .replace(/^\d+\n(?=\d{2}:\d{2}:\d{2})/gm, '')
    .replace(/(\d{2}:\d{2}:\d{2}),(\d{3})/g, '$1.$2')
  return `WEBVTT\n\n${converted}`
}
