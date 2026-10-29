import type { MetaPreview, Stream } from './types'
import { BUILTIN, type BuiltinAddon } from './builtins'

/**
 * The Blender Foundation's open films, all released under Creative Commons
 * Attribution. They are listed under their IMDb ids, so Cinemeta supplies the
 * artwork and details and the title pages look like any other film's.
 *
 * Each torrent names an HTTP copy of itself (`xs`) and carries web seeds, so
 * it starts at full speed even when no one else is sharing it.
 */

interface OpenMovie {
  id: string
  name: string
  year: string
  description: string
  infoHash: string
  torrentUrl: string
  file: string
  quality: string
  size: string
}

const MOVIES: OpenMovie[] = [
  {
    id: 'tt1254207',
    name: 'Big Buck Bunny',
    year: '2008',
    description: 'A good-natured giant rabbit gets even with three bullying rodents. Blender Foundation, CC BY 3.0.',
    infoHash: 'dd8255ecdc7ca55fb0bbf81323d87062db1f6d1c',
    torrentUrl: 'https://webtorrent.io/torrents/big-buck-bunny.torrent',
    file: 'Big Buck Bunny.mp4',
    quality: 'H.264',
    size: '263 MB'
  },
  {
    id: 'tt1727587',
    name: 'Sintel',
    year: '2010',
    description: 'A young woman searches a harsh world for the baby dragon she once rescued. Blender Foundation, CC BY 3.0.',
    infoHash: '08ada5a7a6183aae1e09d831df6748d566095a10',
    torrentUrl: 'https://webtorrent.io/torrents/sintel.torrent',
    file: 'Sintel.mp4',
    quality: 'H.264',
    size: '123 MB'
  },
  {
    id: 'tt2285752',
    name: 'Tears of Steel',
    year: '2012',
    description: 'Scientists in a future Amsterdam stage a last stand against robots, and an old heartbreak. Blender Foundation, CC BY 3.0.',
    infoHash: '209c8226b299b308beaf2b9cd3fb49212dbd13ec',
    torrentUrl: 'https://webtorrent.io/torrents/tears-of-steel.torrent',
    file: 'Tears of Steel.webm',
    quality: '1080p WebM',
    size: '545 MB'
  },
  {
    id: 'tt4957236',
    name: 'Cosmos Laundromat',
    year: '2015',
    description: 'A suicidal sheep is offered a lifetime of second chances by a mysterious salesman. Blender Foundation, CC BY 4.0.',
    infoHash: 'c9e15763f722f23e98a29decdfae341b98d53056',
    torrentUrl: 'https://webtorrent.io/torrents/cosmos-laundromat.torrent',
    file: 'Cosmos Laundromat.mp4',
    quality: 'H.264',
    size: '210 MB'
  },
  {
    id: 'tt0807840',
    name: 'Elephants Dream',
    year: '2006',
    description: 'Two men explore a vast, shifting machine that one believes he controls. The first Blender open film, CC BY 2.5.',
    infoHash: 'acb47ba3958759fdf09f36eeb80fe51c45c1abc9',
    torrentUrl: 'https://archive.org/download/ElephantsDream/ElephantsDream_archive.torrent',
    file: 'ed_hd.avi',
    quality: '1080p DivX',
    size: '815 MB'
  }
]

const TRACKERS = [
  'tracker:wss://tracker.webtorrent.dev',
  'tracker:wss://tracker.openwebtorrent.com',
  'tracker:udp://tracker.opentrackr.org:1337/announce'
]

function preview(m: OpenMovie): MetaPreview {
  return {
    id: m.id,
    type: 'movie',
    name: m.name,
    poster: `https://images.metahub.space/poster/medium/${m.id}/img`,
    releaseInfo: m.year,
    description: m.description,
    genres: ['Animation', 'Short']
  }
}

function stream(m: OpenMovie): Stream {
  return {
    infoHash: m.infoHash,
    name: 'Open movies',
    title: `${m.file}\n${m.quality} · Creative Commons\n💾 ${m.size}`,
    behaviorHints: { filename: m.file },
    sources: [`xs:${m.torrentUrl}`, ...TRACKERS]
  }
}

export const openMoviesAddon: BuiltinAddon = {
  url: BUILTIN.openMovies,
  manifest: () => ({
    id: 'streamline.openmovies',
    name: 'Open movies',
    version: '1.0.0',
    description: 'The Blender Foundation’s Creative Commons films as web-seeded torrents — stream or download to keep.',
    types: ['movie'],
    catalogs: [{ type: 'movie', id: 'open', name: 'Free & open', extra: [{ name: 'search' }] }],
    resources: ['catalog', { name: 'stream', types: ['movie'], idPrefixes: ['tt'] }]
  }),

  async catalog(_type, _id, extra) {
    const query = String(extra.search ?? '').trim().toLowerCase()
    return MOVIES.filter((m) => !query || m.name.toLowerCase().includes(query)).map(preview)
  },

  async streams(type, id) {
    if (type !== 'movie') return []
    return MOVIES.filter((m) => m.id === id).map(stream)
  }
}
