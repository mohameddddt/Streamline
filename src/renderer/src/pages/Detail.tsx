import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import type { DownloadRecord, MetaDetail, ProgressEntry, Video } from '../../../shared/types'
import { ErrorBox, Spinner, Stars, timeLeft } from '../components/ui'
import { Icon } from '../components/Icon'
import { SourceSheet, type SheetTarget } from '../components/SourceSheet'
import { toast } from '../lib/app'
import { backdropFor, logoFor } from '../lib/discover'
import { episodeLabel, nextEpisode, orderedEpisodes, progressKeyFor } from '../lib/play'

interface UpNext {
  video: Video
  /** Mid-episode: how far in, 0-1. */
  progress?: number
  resume: boolean
}

/**
 * Where a series picks up: the episode in progress, else the one after the last
 * finished, else the first.
 */
function findUpNext(meta: MetaDetail, progress: ProgressEntry[]): UpNext | null {
  const list = orderedEpisodes(meta.videos).filter((v) => v.season !== 0)
  if (!list.length) return null
  const mine = progress.filter((p) => p.id === meta.id && p.videoId)
  const latest = mine.sort((a, b) => b.updatedAt - a.updatedAt)[0]
  if (latest) {
    const video = list.find((v) => v.id === latest.videoId)
    if (video && !latest.finished && latest.time > 0) {
      return { video, resume: true, progress: latest.duration ? latest.time / latest.duration : 0 }
    }
    const after = nextEpisode(meta.videos, latest.videoId)
    if (after) return { video: after, resume: false }
  }
  return { video: list[0], resume: false }
}

/**
 * A title page built from what is on this computer — its downloads and library
 * entries — for when no addon can describe it (offline, before its details were
 * ever saved). Enough to reach the downloaded film or episodes and play them.
 */
async function localMeta(type: string, id: string): Promise<MetaDetail | null> {
  const [downloads, lib] = await Promise.all([
    window.api.downloads.list().catch(() => [] as DownloadRecord[]),
    window.api.library.get().catch(() => null)
  ])
  const mine = downloads.filter((d) => d.metaId === id && d.status === 'done')
  const known = lib?.items.find((i) => i.id === id) ?? lib?.progress.find((p) => p.id === id)
  if (!mine.length && !known) return null
  // Episode downloads are titled "Show · S1E5 · Episode name".
  const parts = (d: DownloadRecord): string[] => d.title.split(' · ')
  const videos: Video[] = mine
    .filter((d) => d.videoId && d.season !== undefined)
    .map((d) => ({
      id: d.videoId as string,
      season: d.season,
      episode: d.episode,
      title: parts(d).slice(2).join(' · ') || undefined
    }))
  return {
    id,
    type,
    name: known?.name ?? parts(mine[0])[0],
    poster: mine[0]?.localPoster ?? known?.poster,
    background: mine[0]?.localPoster,
    description: 'Showing what is saved on this computer. Connect to the internet for the full details.',
    videos: type === 'series' ? videos : undefined
  }
}

export default function Detail(): JSX.Element {
  const { type = '', id = '' } = useParams()
  const navigate = useNavigate()
  const [params, setParams] = useSearchParams()
  const [meta, setMeta] = useState<MetaDetail | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [season, setSeason] = useState<number | null>(null)
  const [sheet, setSheet] = useState<{ target: SheetTarget; autoPlay: boolean } | null>(null)
  const [favorite, setFavorite] = useState(false)
  const [myRating, setMyRating] = useState<number | null>(null)
  const [progress, setProgress] = useState<ProgressEntry[]>([])
  const [logoFailed, setLogoFailed] = useState(false)

  const loadLibrary = useCallback(() => {
    return window.api.library.get().then((lib) => {
      setFavorite(lib.items.some((it) => it.id === id))
      setMyRating(lib.ratings.find((r) => r.id === id)?.rating ?? null)
      setProgress(lib.progress)
    })
  }, [id])

  useEffect(() => {
    let alive = true
    setMeta(null)
    setError(null)
    setSeason(null)
    setLogoFailed(false)
    window.api.addons
      .meta(type, id)
      .catch(() => null)
      .then((m) => m ?? localMeta(type, id))
      .then((m) => {
        if (!alive) return
        if (!m) throw new Error('No metadata addon could describe this title.')
        setMeta(m)
      })
      .catch((err) => alive && setError(err))
    loadLibrary().catch(() => undefined)
    return () => {
      alive = false
    }
  }, [type, id, loadLibrary])

  const isSeries = (meta?.videos?.length ?? 0) > 0
  const upNext = useMemo(() => (meta && isSeries ? findUpNext(meta, progress) : null), [meta, isSeries, progress])

  const seasons = useMemo(() => {
    const nums = new Set<number>()
    for (const v of meta?.videos ?? []) if (typeof v.season === 'number') nums.add(v.season)
    return [...nums].sort((a, b) => (a === 0 ? 1 : b === 0 ? -1 : a - b))
  }, [meta])

  useEffect(() => {
    if (season === null && seasons.length) setSeason(upNext?.video.season ?? seasons[0])
  }, [seasons, season, upNext])

  const movieTarget: SheetTarget = { label: 'Film' }
  const primaryTarget = (): SheetTarget =>
    upNext ? { label: episodeLabel(upNext.video), video: upNext.video } : movieTarget

  // ?play=1 (from "Watch now" elsewhere) goes straight to the best source.
  useEffect(() => {
    if (!meta || params.get('play') !== '1') return
    if (isSeries && !upNext) return
    setSheet({ target: primaryTarget(), autoPlay: true })
    setParams({}, { replace: true })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [meta, upNext, params])

  const toggleFav = async (): Promise<void> => {
    if (!meta) return
    const on = await window.api.library.toggleFavorite({
      key: `${meta.type}:${meta.id}`,
      id: meta.id,
      type: meta.type,
      name: meta.name,
      poster: meta.poster
    })
    setFavorite(on)
    toast(on ? 'Added to your watchlist' : 'Removed from your watchlist', on ? 'good' : 'info')
  }

  const rate = async (value: number | null): Promise<void> => {
    if (!meta) return
    setMyRating(value)
    await window.api.library.setRating(
      { key: `${meta.type}:${meta.id}`, id: meta.id, type: meta.type, name: meta.name, poster: meta.poster, year: meta.releaseInfo },
      value
    )
  }

  const progressOf = (key: string): ProgressEntry | undefined => progress.find((p) => p.key === key)

  const setWatched = async (video: Video | undefined, watched: boolean): Promise<void> => {
    if (!meta) return
    const key = progressKeyFor(meta.type, meta.id, video)
    await window.api.library.markWatched(key, watched, {
      key,
      id: meta.id,
      type: meta.type,
      name: meta.name,
      poster: meta.poster,
      season: video?.season,
      episode: video?.episode,
      videoId: video?.id,
      year: meta.releaseInfo
    })
    await loadLibrary()
  }

  /** One write for a whole season or show, not one per episode. */
  const setManyWatched = async (videos: Video[], watched: boolean, what: string): Promise<void> => {
    if (!meta || !videos.length) return
    await window.api.library.markManyWatched(
      videos.map((v) => {
        const key = progressKeyFor(meta.type, meta.id, v)
        return {
          key,
          watched,
          seed: {
            key,
            id: meta.id,
            type: meta.type,
            name: meta.name,
            poster: meta.poster,
            season: v.season,
            episode: v.episode,
            videoId: v.id,
            year: meta.releaseInfo
          }
        }
      })
    )
    await loadLibrary()
    toast(watched ? `Marked ${what} as watched` : `Marked ${what} as not watched`, watched ? 'good' : 'info')
  }

  if (error) {
    return (
      <div className="page">
        <button className="btn ghost" onClick={() => navigate(-1)}>
          <Icon name="back" size={16} /> Back
        </button>
        <ErrorBox error={error} />
      </div>
    )
  }
  if (!meta) return <Spinner />

  const episodes = orderedEpisodes(meta.videos).filter((v) => v.season === season)
  const isWatched = (v: Video): boolean => Boolean(progressOf(progressKeyFor(meta.type, meta.id, v))?.finished)
  const hasAired = (v: Video): boolean => !v.released || new Date(v.released).getTime() <= Date.now()
  // Unaired episodes cannot have been watched, and specials are extras, not the show.
  const showEpisodes = orderedEpisodes(meta.videos).filter((v) => v.season !== 0 && hasAired(v))
  const seasonEpisodes = episodes.filter(hasAired)
  const showWatched = showEpisodes.length > 0 && showEpisodes.every(isWatched)
  const seasonWatched = seasonEpisodes.length > 0 && seasonEpisodes.every(isWatched)
  const seasonName = season === 0 ? 'the specials' : `season ${season}`
  const movieProgress = !isSeries ? progressOf(progressKeyFor(meta.type, meta.id)) : undefined
  const movieWatched = Boolean(movieProgress?.finished)
  const logo = !logoFailed ? logoFor(meta) : undefined
  const trailer = meta.trailers?.find((t) => t.source)

  let primaryLabel = 'Watch now'
  if (isSeries && upNext) {
    const code = `S${upNext.video.season} E${upNext.video.episode}`
    primaryLabel = upNext.resume ? `Continue ${code}` : progress.some((p) => p.id === meta.id) ? `Play ${code}` : `Start ${code}`
  } else if (movieProgress && !movieProgress.finished && movieProgress.time > 0) {
    primaryLabel = `Resume · ${timeLeft(movieProgress.duration - movieProgress.time)}`
  }

  return (
    <div className="detail">
      <div className="detail-hero">
        <div className="detail-bg" style={{ backgroundImage: `url(${backdropFor(meta)})` }} />
        <div className="detail-shade" />
        <button className="round-btn detail-back" onClick={() => navigate(-1)} aria-label="Back">
          <Icon name="back" size={18} />
        </button>

        <div className="detail-main">
          <div className="kicker">
            <span className="kicker-dot" /> {isSeries ? 'Series' : 'Film'}
            {meta.genres?.length ? ` · ${meta.genres.slice(0, 3).join(' · ')}` : ''}
          </div>
          {logo ? (
            <img className="detail-logo" src={logo} alt={meta.name} onError={() => setLogoFailed(true)} />
          ) : (
            <h1 className="detail-title">{meta.name}</h1>
          )}
          <div className="meta-line">
            {meta.releaseInfo && <span>{meta.releaseInfo}</span>}
            {meta.runtime && <span>{meta.runtime}</span>}
            {meta.imdbRating && (
              <span>
                <Icon name="starFilled" size={12} /> {meta.imdbRating} IMDb
              </span>
            )}
            {isSeries && <span>{seasons.filter((s) => s > 0).length} seasons</span>}
            {movieWatched && <span className="good">Watched</span>}
          </div>
          {meta.description && <p className="detail-desc">{meta.description}</p>}

          <div className="btn-row">
            <button className="btn primary lg" onClick={() => setSheet({ target: primaryTarget(), autoPlay: true })}>
              <Icon name="play" size={18} /> {primaryLabel}
            </button>
            <button className="btn glass lg" onClick={() => setSheet({ target: primaryTarget(), autoPlay: false })}>
              <Icon name="grid" size={17} /> Sources
            </button>
            <button className={'round-btn lg' + (favorite ? ' on' : '')} onClick={toggleFav} title={favorite ? 'In your watchlist' : 'Add to watchlist'}>
              <Icon name={favorite ? 'bookmarkFilled' : 'bookmark'} size={19} />
            </button>
            {!isSeries && (
              <button
                className={'round-btn lg' + (movieWatched ? ' on' : '')}
                onClick={() => setWatched(undefined, !movieWatched)}
                title={movieWatched ? 'Mark as not watched' : 'Mark as watched'}
              >
                <Icon name="check" size={19} />
              </button>
            )}
            {isSeries && showEpisodes.length > 0 && (
              <button
                className={'round-btn lg' + (showWatched ? ' on' : '')}
                onClick={() => setManyWatched(showEpisodes, !showWatched, 'the whole show')}
                title={showWatched ? 'Mark the whole show as not watched' : 'Mark every aired episode as watched'}
              >
                <Icon name="check" size={19} />
              </button>
            )}
            {trailer && (
              <button
                className="round-btn lg"
                title="Watch the trailer on YouTube"
                onClick={() => window.api.app.openExternal(`https://www.youtube.com/watch?v=${trailer.source}`)}
              >
                <Icon name="film" size={18} />
              </button>
            )}
            {meta.id.startsWith('tt') && (
              <button className="round-btn lg" title="Open on IMDb" onClick={() => window.api.app.openExternal(`https://www.imdb.com/title/${meta.id}`)}>
                <Icon name="external" size={18} />
              </button>
            )}
          </div>

          <div className="rate-row">
            <span className="rate-label">Your rating</span>
            <Stars value={myRating} onChange={rate} />
          </div>
        </div>

        {(meta.director?.length || meta.cast?.length || meta.country) && (
          <dl className="detail-facts">
            {meta.director?.length ? (
              <>
                <dt>Director</dt>
                <dd>{meta.director.slice(0, 3).join(', ')}</dd>
              </>
            ) : null}
            {meta.cast?.length ? (
              <>
                <dt>Starring</dt>
                <dd>{meta.cast.slice(0, 5).join(', ')}</dd>
              </>
            ) : null}
            {meta.writer?.length ? (
              <>
                <dt>Writing</dt>
                <dd>{meta.writer.slice(0, 3).join(', ')}</dd>
              </>
            ) : null}
            {meta.country && (
              <>
                <dt>Country</dt>
                <dd>{meta.country}</dd>
              </>
            )}
          </dl>
        )}
      </div>

      {isSeries && (
        <div className="page episodes-page">
          <div className="episodes-head">
            <h2>Episodes</h2>
            <div className="chip-row scroll">
              {seasons.map((s) => (
                <button key={s} className={'filter-chip' + (s === season ? ' on' : '')} onClick={() => setSeason(s)}>
                  {s === 0 ? 'Specials' : `Season ${s}`}
                </button>
              ))}
            </div>
            {seasonEpisodes.length > 0 && (
              <button
                className={'btn glass season-check' + (seasonWatched ? ' on' : '')}
                onClick={() => setManyWatched(seasonEpisodes, !seasonWatched, seasonName)}
                title={seasonWatched ? `Mark ${seasonName} as not watched` : `Mark every aired episode of ${seasonName} as watched`}
              >
                <Icon name="check" size={15} /> {seasonWatched ? 'Season watched' : 'Mark season watched'}
              </button>
            )}
          </div>

          <div className="episode-list">
            {episodes.map((v) => {
              const p = progressOf(progressKeyFor(meta.type, meta.id, v))
              const watched = isWatched(v)
              const pct = watched ? 1 : p?.duration ? p.time / p.duration : 0
              const isNext = upNext?.video.id === v.id
              const future = v.released && new Date(v.released).getTime() > Date.now()
              return (
                <div key={v.id} className={'episode' + (isNext ? ' next' : '') + (watched ? ' watched' : '')}>
                  <button
                    className="ep-main"
                    onClick={() => setSheet({ target: { label: episodeLabel(v), video: v }, autoPlay: false })}
                  >
                    <span className="ep-thumb">
                      <img src={v.thumbnail ?? backdropFor(meta)} alt="" loading="lazy" />
                      <span className="ep-play">
                        <Icon name="play" size={16} />
                      </span>
                      {pct > 0 && (
                        <span className="progress-bar">
                          <span style={{ width: `${Math.min(100, pct * 100)}%` }} />
                        </span>
                      )}
                    </span>
                    <span className="ep-body">
                      <span className="ep-code">
                        E{String(v.episode).padStart(2, '0')}
                        {isNext && <span className="tag-pill accent">Up next</span>}
                        {future && <span className="tag-pill">Coming {new Date(v.released as string).toLocaleDateString()}</span>}
                      </span>
                      <span className="ep-title">{v.title ?? v.name ?? `Episode ${v.episode}`}</span>
                      {v.overview && <span className="ep-overview">{v.overview}</span>}
                      {!v.overview && v.released && !future && (
                        <span className="ep-overview">Aired {new Date(v.released).toLocaleDateString()}</span>
                      )}
                    </span>
                  </button>
                  <button
                    className={'ep-check' + (watched ? ' on' : '')}
                    title={watched ? 'Mark as not watched' : 'Mark as watched'}
                    onClick={() => setWatched(v, !watched)}
                  >
                    <Icon name="check" size={16} />
                  </button>
                </div>
              )
            })}
            {episodes.length === 0 && <div className="sheet-empty">No episodes listed for this season.</div>}
          </div>
        </div>
      )}

      {sheet && (
        <SourceSheet
          key={`${sheet.target.video?.id ?? meta.id}|${sheet.autoPlay}`}
          meta={meta}
          target={sheet.target}
          autoPlay={sheet.autoPlay}
          onClose={() => setSheet(null)}
        />
      )}
    </div>
  )
}
