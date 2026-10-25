import type {
  MetaPreview,
  PlaybackPlan,
  PlaybackSource,
  Stream,
  Video
} from '../../../shared/types'

/** Everything the player route needs, passed through router state. */
export interface PlayerState {
  plan: PlaybackPlan
  source: PlaybackSource
  infoHash?: string
  streamId: string
  title: string
  meta: MetaPreview
  season?: number
  episode?: number
  videoId?: string
  year?: string
  /** The source chosen, so the next episode can stay with the same release. */
  stream?: Stream
}

export interface PlayContext {
  meta: Pick<MetaPreview, 'id' | 'type' | 'name' | 'poster' | 'releaseInfo' | 'background'>
  video?: Video
}

export const episodeLabel = (v: Video): string =>
  `S${v.season}E${v.episode}${v.title || v.name ? ` · ${v.title ?? v.name}` : ''}`

/** The key progress and "last source" are saved under. */
export const progressKeyFor = (type: string, id: string, video?: Video): string =>
  `${type}:${video?.id ?? id}`

/**
 * Turns a chosen source into a ready-to-play player state: starts the torrent
 * (or takes the link as-is), remembers the choice, and asks the engine how the
 * file must be played. `onPhase` reports peers and progress while it waits.
 */
export async function preparePlayback(
  stream: Stream,
  ctx: PlayContext,
  onPhase: (phase: string) => void = () => undefined
): Promise<PlayerState> {
  const { meta, video } = ctx
  onPhase('connecting…')

  // Finding peers can take a while on a cold torrent; poll so the caller can
  // show peers and progress rather than looking hung.
  let poll: number | undefined
  if (stream.infoHash) {
    const hash = stream.infoHash
    poll = window.setInterval(() => {
      window.api.torrent
        .stats(hash)
        .then((s) => {
          if (!s) return
          if (!s.ready) onPhase(`${s.peers} peers · reading torrent…`)
          else onPhase(`${s.peers} peers · ${Math.round(s.fileProgress * 100)}%`)
        })
        .catch(() => undefined)
    }, 700)
  }

  try {
    let source: PlaybackSource
    let infoHash: string | undefined
    if (stream.url) {
      source = { kind: 'url', url: stream.url }
    } else {
      const handle = await window.api.torrent.start(stream)
      infoHash = handle.infoHash
      source = { kind: 'torrent', infoHash: handle.infoHash, fileIdx: handle.fileIdx }
    }
    const key = progressKeyFor(meta.type, meta.id, video)
    window.api.library.setLastStream(key, stream).catch(() => undefined)

    onPhase('checking the file…')
    // Inspect the file first: it decides direct play, remux, or full convert.
    const plan = await window.api.playback.plan(source)
    return {
      plan,
      source,
      infoHash,
      streamId: video?.id ?? meta.id,
      title: `${meta.name}${video ? ` · ${episodeLabel(video)}` : ''}`,
      meta: { id: meta.id, type: meta.type, name: meta.name, poster: meta.poster },
      season: video?.season,
      episode: video?.episode,
      videoId: video?.id,
      year: meta.releaseInfo,
      stream
    }
  } finally {
    if (poll !== undefined) window.clearInterval(poll)
  }
}

/** Episodes in airing order, specials (season 0) last. */
export function orderedEpisodes(videos: Video[] = []): Video[] {
  return [...videos]
    .filter((v) => typeof v.season === 'number')
    .sort((a, b) => {
      const sa = a.season === 0 ? 1e6 : (a.season as number)
      const sb = b.season === 0 ? 1e6 : (b.season as number)
      return sa - sb || (a.episode ?? 0) - (b.episode ?? 0)
    })
}

/** The episode after `videoId`, skipping specials and ones that have not aired. */
export function nextEpisode(videos: Video[] = [], videoId?: string): Video | null {
  const list = orderedEpisodes(videos).filter((v) => v.season !== 0)
  const i = list.findIndex((v) => v.id === videoId)
  const next = i >= 0 ? list[i + 1] : undefined
  if (!next) return null
  if (next.released && new Date(next.released).getTime() > Date.now()) return null
  return next
}
