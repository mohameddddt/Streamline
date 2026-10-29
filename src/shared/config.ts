import type { Settings } from './types'

export const APP_VERSION = '0.4.2'

/** The desktop companion listens here, loopback only, when it is switched on. */
export const COMPANION_PORT = 11480

export const DEFAULT_ADDONS = [
  'https://v3-cinemeta.strem.io/manifest.json',
  'https://torrentio.strem.fun/manifest.json',
  'https://torrentsdb.com/manifest.json',
  'https://opensubtitles-v3.strem.io/manifest.json'
]

/** Accent themes. `ink` is the text colour that sits on top of the accent. */
export const ACCENTS: { id: string; label: string; color: string; ink: string }[] = [
  { id: 'volt', label: 'Volt', color: '#d7ff3d', ink: '#11140a' },
  { id: 'signal', label: 'Signal', color: '#ff5a36', ink: '#1a0904' },
  { id: 'tide', label: 'Tide', color: '#38e1d0', ink: '#03201d' },
  { id: 'marigold', label: 'Marigold', color: '#ffc23d', ink: '#1d1403' },
  { id: 'bloom', label: 'Bloom', color: '#ff7eb6', ink: '#250916' },
  { id: 'glacier', label: 'Glacier', color: '#9cc4ff', ink: '#0a1426' }
]

/** Everything in Settings that does not depend on where the app is running. */
export function portableDefaults(): Omit<Settings, 'downloadPath' | 'downloadsPath'> {
  return {
    addons: [...DEFAULT_ADDONS],
    debridProvider: 'none',
    debridApiKey: '',
    tmdbApiKey: '',
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
    autoUpdate: true,
    accent: 'volt',
    preferredQuality: '1080p',
    autoplayNext: true,
    companionEnabled: false,
    companionToken: '',
    engineUrl: `http://127.0.0.1:${COMPANION_PORT}`,
    engineToken: '',
    localFolders: [],
    builtinsSeeded: []
  }
}

const DEBRID_KEYS = [
  'realdebrid',
  'alldebrid',
  'premiumize',
  'torbox',
  'debridlink',
  'offcloud',
  'easydebrid',
  'putio'
]

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
  const kept = pairs.filter((p) => !DEBRID_KEYS.includes(p.split('=')[0]))
  if (provider !== 'none' && apiKey) kept.push(`${provider}=${apiKey}`)
  parsed.pathname = '/' + [...(kept.length ? [kept.join('|')] : []), manifest].join('/')
  return parsed.toString()
}
