import type { Settings } from './types'

export const APP_VERSION = '0.5.0'

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

/** Hosts known to read Torrentio's `key=value|key=value` config segment. */
const TORRENTIO_HOSTS = ['torrentio.strem.fun', 'torrentsdb.com', 'knightcrawler.elfhosted.com']

/** Default addons that never take a debrid key. */
const NOT_TORRENTIO = ['v3-cinemeta.strem.io', 'opensubtitles-v3.strem.io', 'opensubtitles.strem.io', 'watchhub.strem.io']

/** Option names Torrentio-style configs use, debrid keys aside. */
const TORRENTIO_KEYS = ['providers', 'sort', 'qualityfilter', 'priotitize', 'limit', 'sizefilter', 'language', 'debridoptions']

/**
 * Torrentio (and the addons that clone its config format) take options as a
 * `key=value|key=value` path segment before `/manifest.json`. We rewrite only the
 * debrid pair so a user's hand-tuned provider/sort options survive.
 *
 * Only those addons are touched. This used to rewrite every manifest URL, which
 * broke Cinemeta, OpenSubtitles and the built-in sources the moment a debrid
 * key was set — and sent that key to every addon installed.
 */
export function applyDebridConfig(url: string, provider: string, apiKey: string): string {
  // Repairs what older builds wrote: a built-in's URL never carries a config.
  const builtin = /^streamline:\/\/([^/]+)\/.+\/manifest\.json$/.exec(url)
  if (builtin) return `streamline://${builtin[1]}/manifest.json`
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return url
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return url
  if (NOT_TORRENTIO.includes(parsed.hostname)) {
    // Older builds pushed the debrid key into these too; take it back out.
    const segs = parsed.pathname.split('/')
    const kept = segs.filter(
      (seg, i) => i === segs.length - 1 || !DEBRID_KEYS.includes(decodeURIComponent(seg).split('=')[0].toLowerCase())
    )
    if (kept.length === segs.length) return url
    parsed.pathname = kept.join('/')
    return parsed.toString()
  }
  if (!/^\/.*manifest\.json$/.test(parsed.pathname)) return url

  const segments = parsed.pathname.replace(/^\//, '').split('/')
  const manifest = segments.pop() as string
  // Torrentio's config is the one segment right before manifest.json.
  const config = segments.length ? decodeURIComponent(segments[segments.length - 1]) : ''
  const prefix = segments.slice(0, -1)
  const pairs = config ? config.split('|').filter(Boolean) : []
  const keyOf = (p: string): string => p.split('=')[0].toLowerCase()
  const isPairConfig = pairs.length > 0 && pairs.every((p) => p.includes('=') && !p.endsWith('='))
  const torrentioStyle =
    TORRENTIO_HOSTS.includes(parsed.hostname) ||
    (isPairConfig && pairs.some((p) => TORRENTIO_KEYS.includes(keyOf(p)) || DEBRID_KEYS.includes(keyOf(p))))
  if (!torrentioStyle) return url
  // Some other kind of config (an encoded blob) sits there: leave it alone.
  if (config && !isPairConfig) return url

  const kept = pairs.filter((p) => !DEBRID_KEYS.includes(keyOf(p)))
  if (provider !== 'none' && apiKey) kept.push(`${provider}=${apiKey}`)
  const base = config ? prefix : segments
  parsed.pathname = '/' + [...base, ...(kept.length ? [kept.join('|')] : []), manifest].join('/')
  return parsed.toString()
}
