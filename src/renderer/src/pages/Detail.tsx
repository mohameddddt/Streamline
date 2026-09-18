import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useParams } from 'react-router-dom'
import type {
  LibraryItem,
  MetaDetail,
  PlaybackSource,
  Stream,
  Video
} from '../../../shared/types'
import { ErrorBox, Spinner } from '../components/ui'

interface PlayTarget {
  streamId: string
  label: string
  video?: Video
}

function StreamDrawer({
  meta,
  target,
  onClose
}: {
  meta: MetaDetail
  target: PlayTarget
  onClose: () => void
}): JSX.Element {
  const navigate = useNavigate()
  const [streams, setStreams] = useState<Stream[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [starting, setStarting] = useState<number | null>(null)
  const [downloading, setDownloading] = useState<number | null>(null)
  const [queued, setQueued] = useState<Set<number>>(new Set())

  const downloadInfo = {
    title: `${meta.name}${target.video ? ` · ${target.label}` : ''}`,
    metaId: meta.id,
    metaType: meta.type,
    poster: meta.poster,
    season: target.video?.season,
    episode: target.video?.episode,
    videoId: target.video?.id
  }

  const download = async (stream: Stream, index: number): Promise<void> => {
    setDownloading(index)
    setError(null)
    try {
      await window.api.downloads.start(stream, downloadInfo)
      setQueued((prev) => new Set(prev).add(index))
    } catch (err) {
      setError(err)
    } finally {
      setDownloading(null)
    }
  }

  useEffect(() => {
    let alive = true
    window.api.addons
      .streams(meta.type, target.streamId)
      .then((list) => alive && setStreams(list))
      .catch((err) => alive && setError(err))
    return () => {
      alive = false
    }
  }, [meta.type, target.streamId])

  const play = async (stream: Stream, index: number): Promise<void> => {
    setStarting(index)
    setError(null)
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
      // Inspect the file first: it decides direct play, remux, or full convert.
      const plan = await window.api.playback.plan(source)
      navigate('/player', {
        state: {
          plan,
          source,
          infoHash,
          streamId: target.streamId,
          title: `${meta.name}${target.video ? ` · ${target.label}` : ''}`,
          meta: {
            id: meta.id,
            type: meta.type,
            name: meta.name,
            poster: meta.poster
          },
          season: target.video?.season,
          episode: target.video?.episode,
          videoId: target.video?.id,
          year: meta.releaseInfo
        }
      })
    } catch (err) {
      setError(err)
    } finally {
      setStarting(null)
    }
  }

  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" onClick={(e) => e.stopPropagation()}>
        <h3>{meta.name}</h3>
        <div className="sub">
          {target.label} · sources from your stream addons
          <button className="icon-btn" style={{ float: 'right' }} onClick={onClose}>
            Close
          </button>
        </div>
        <ErrorBox error={error} />
        {!streams && <Spinner />}
        {streams && streams.length === 0 && (
          <div className="empty">
            No sources found. Add a stream addon (Torrentio, TorrentsDB…) in Settings, or try
            another episode.
          </div>
        )}
        {streams?.map((s, i) => {
          const direct = Boolean(s.url)
          return (
            <div key={`${s.infoHash ?? s.url}-${i}`} className="stream-item">
              <button
                className="stream-main"
                disabled={starting !== null}
                onClick={() => play(s, i)}
                title="Stream this now"
              >
                <div className="s-name">{s.name ?? s.addonName}</div>
                {s.title && <div className="s-title">{s.title}</div>}
              </button>
              <div className="stream-actions">
                <span className={direct ? 'chip cached' : 'chip'}>
                  {starting === i ? 'starting…' : direct ? 'instant' : 'torrent'}
                </span>
                <button
                  className="icon-btn download"
                  disabled={!s.infoHash || downloading !== null || queued.has(i)}
                  title={
                    s.infoHash
                      ? 'Download to your computer'
                      : 'This source is a direct link, not a torrent — stream it instead'
                  }
                  onClick={() => download(s, i)}
                >
                  {queued.has(i) ? '✓ queued' : downloading === i ? '…' : '↓ save'}
                </button>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}

export default function Detail(): JSX.Element {
  const { type = '', id = '' } = useParams()
  const [meta, setMeta] = useState<MetaDetail | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [season, setSeason] = useState<number | null>(null)
  const [target, setTarget] = useState<PlayTarget | null>(null)
  const [favorite, setFavorite] = useState(false)

  useEffect(() => {
    let alive = true
    setMeta(null)
    window.api.addons
      .meta(type, id)
      .then((m) => {
        if (!alive) return
        if (!m) throw new Error('No metadata addon could describe this title.')
        setMeta(m)
      })
      .catch((err) => alive && setError(err))
    window.api.library
      .get()
      .then((lib) => alive && setFavorite(lib.items.some((it) => it.id === id)))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [type, id])

  const seasons = useMemo(() => {
    const nums = new Set<number>()
    for (const v of meta?.videos ?? []) if (typeof v.season === 'number') nums.add(v.season)
    return [...nums].sort((a, b) => a - b)
  }, [meta])

  useEffect(() => {
    if (season === null && seasons.length) {
      setSeason(seasons.find((s) => s > 0) ?? seasons[0])
    }
  }, [seasons, season])

  const toggleFav = useCallback(async () => {
    if (!meta) return
    const item: LibraryItem = {
      key: `${meta.type}:${meta.id}`,
      id: meta.id,
      type: meta.type,
      name: meta.name,
      poster: meta.poster
    }
    setFavorite(await window.api.library.toggleFavorite(item))
  }, [meta])

  if (error) {
    return (
      <div className="page">
        <ErrorBox error={error} />
      </div>
    )
  }
  if (!meta) return <Spinner />

  const isSeries = (meta.videos?.length ?? 0) > 0
  const episodes = (meta.videos ?? []).filter((v) => v.season === season)

  return (
    <>
      <div className="hero">
        {meta.background && (
          <div className="hero-bg" style={{ backgroundImage: `url(${meta.background})` }} />
        )}
        {meta.poster && <img className="hero-poster" src={meta.poster} alt="" />}
        <div className="hero-info">
          <h1>{meta.name}</h1>
          <div className="meta-line">
            {meta.releaseInfo && <span>{meta.releaseInfo}</span>}
            {meta.runtime && <span>{meta.runtime}</span>}
            {meta.imdbRating && <span>★ {meta.imdbRating}</span>}
            {meta.genres?.length ? <span>{meta.genres.slice(0, 4).join(', ')}</span> : null}
          </div>
          {meta.description && <p className="desc">{meta.description}</p>}
          <div className="btn-row">
            {!isSeries && (
              <button
                className="btn primary"
                onClick={() => setTarget({ streamId: meta.id, label: 'Movie' })}
              >
                ▶ Find sources
              </button>
            )}
            <button className="btn" onClick={toggleFav}>
              {favorite ? '★ In library' : '☆ Add to library'}
            </button>
            {meta.id.startsWith('tt') && (
              <button
                className="btn ghost"
                onClick={() => window.api.app.openExternal(`https://www.imdb.com/title/${meta.id}`)}
              >
                IMDb
              </button>
            )}
          </div>
        </div>
      </div>

      {isSeries && (
        <div className="page" style={{ paddingTop: 8 }}>
          <div className="season-tabs">
            {seasons.map((s) => (
              <button
                key={s}
                className={'season-tab' + (s === season ? ' active' : '')}
                onClick={() => setSeason(s)}
              >
                {s === 0 ? 'Specials' : `Season ${s}`}
              </button>
            ))}
          </div>
          {episodes.map((v) => (
            <div
              key={v.id}
              className="episode"
              onClick={() =>
                setTarget({
                  streamId: v.id,
                  label: `S${v.season}E${v.episode} · ${v.title ?? v.name ?? ''}`,
                  video: v
                })
              }
            >
              <img src={v.thumbnail ?? meta.background ?? meta.poster} alt="" />
              <div style={{ minWidth: 0 }}>
                <div className="ep-title">
                  {v.episode}. {v.title ?? v.name ?? 'Episode'}
                </div>
                <div className="ep-overview">
                  {v.overview ?? (v.released ? new Date(v.released).toLocaleDateString() : '')}
                </div>
              </div>
            </div>
          ))}
          {episodes.length === 0 && <div className="empty">No episodes listed for this season.</div>}
        </div>
      )}

      {target && <StreamDrawer meta={meta} target={target} onClose={() => setTarget(null)} />}
    </>
  )
}
