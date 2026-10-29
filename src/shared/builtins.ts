import type {
  AddonManifest,
  MetaDetail,
  MetaPreview,
  Settings,
  Stream,
  SubtitleTrack
} from './types'

/**
 * Addons that ship with the app and answer in-process instead of over HTTP.
 * They sit in `settings.addons` under a `streamline://` URL like any other
 * addon, so they can be reordered and removed from the same list.
 */
export const BUILTIN = {
  archive: 'streamline://archive/manifest.json',
  openMovies: 'streamline://open-movies/manifest.json',
  local: 'streamline://local/manifest.json'
} as const

export type Extra = Record<string, string | number | undefined>

export interface BuiltinContext {
  /** Metadata from the installed addons, so a source can match by title. */
  meta: (type: string, id: string) => Promise<MetaDetail | null>
  /** True with no connection: a built-in that needs the internet should not try. */
  offline: () => boolean
}

export interface BuiltinAddon {
  url: string
  /** Built fresh on every call: a built-in's catalogs can depend on settings. */
  manifest: () => Omit<AddonManifest, 'transportUrl'>
  catalog?: (type: string, id: string, extra: Extra, ctx: BuiltinContext) => Promise<MetaPreview[]>
  meta?: (type: string, id: string, ctx: BuiltinContext) => Promise<MetaDetail | null>
  streams?: (type: string, id: string, ctx: BuiltinContext) => Promise<Stream[]>
  subtitles?: (type: string, id: string, ctx: BuiltinContext) => Promise<SubtitleTrack[]>
}

export const isBuiltin = (url: string): boolean => url.startsWith('streamline://')

/**
 * Installs each built-in the first time this copy of the app sees it — new
 * installs and upgrades alike — and remembers having done so, so one the user
 * removed stays removed. Returns whether anything changed.
 */
export function seedBuiltins(settings: Settings, available: string[]): boolean {
  const seeded = new Set(settings.builtinsSeeded ?? [])
  const fresh = available.filter((url) => !seeded.has(url))
  if (!fresh.length) return false
  settings.addons = [...settings.addons, ...fresh.filter((url) => !settings.addons.includes(url))]
  settings.builtinsSeeded = [...seeded, ...fresh]
  return true
}

/** Fetches JSON with a deadline; the built-ins talk to public APIs directly. */
export async function fetchJson<T>(url: string, timeoutMs = 20000): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { signal: ctrl.signal, headers: { accept: 'application/json' } })
    if (!res.ok) throw new Error(`${res.status} ${res.statusText} for ${url}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

/** `1.2 GB` / `640 MB`, in the form the source parser reads sizes from. */
export function sizeLabel(bytes: number): string {
  return bytes >= 1024 ** 3
    ? `${(bytes / 1024 ** 3).toFixed(2)} GB`
    : `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`
}

/** Matches the resolution tags the source parser understands. */
export function heightLabel(height: number): string {
  if (height >= 2000) return '2160p'
  if (height >= 1000) return '1080p'
  if (height >= 700) return '720p'
  return height > 0 ? '480p' : ''
}
