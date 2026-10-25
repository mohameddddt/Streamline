import { useCallback, useEffect, useMemo, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type {
  DownloadProgress,
  DownloadRecord,
  LibraryItem,
  ProgressEntry,
  RatingEntry
} from '../../../shared/types'
import { Empty, ErrorBox, MetaCard, Segmented, Spinner, WideCard, humanBytes, humanTime, timeLeft } from '../components/ui'
import { Icon } from '../components/Icon'
import { detailPath, isWeb, toast } from '../lib/app'
import { backdropFor } from '../lib/discover'
import type { PlayerState } from '../lib/play'

type Tab = 'continue' | 'saved' | 'watched' | 'rated' | 'downloads' | 'insights'

// ------------------------------------------------------------- downloads

function DownloadRow({
  record,
  live,
  onChanged,
  onError
}: {
  record: DownloadRecord
  live?: DownloadProgress
  onChanged: () => void
  onError: (err: unknown) => void
}): JSX.Element {
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const done = record.status === 'done'
  const pct = done ? 1 : live?.progress ?? 0

  const run = async (fn: () => Promise<unknown>): Promise<void> => {
    setBusy(true)
    try {
      await fn()
      onChanged()
    } catch (err) {
      onError(err)
    } finally {
      setBusy(false)
    }
  }

  const play = async (): Promise<void> => {
    try {
      const source = await window.api.downloads.playSource(record.infoHash)
      const plan = await window.api.playback.plan(source)
      const state: PlayerState = {
        plan,
        source,
        infoHash: done ? undefined : record.infoHash,
        streamId: record.videoId ?? record.metaId,
        title: record.title,
        meta: { id: record.metaId, type: record.metaType, name: record.title, poster: record.poster },
        season: record.season,
        episode: record.episode,
        videoId: record.videoId
      }
      navigate('/player', { state })
    } catch (err) {
      onError(err)
    }
  }

  const remove = async (): Promise<void> => {
    const deleteFiles = window.confirm(
      `Remove “${record.title}” from downloads.\n\nOK = also delete the file from disk.\nCancel = keep the file, just remove it from the list.`
    )
    await run(() => window.api.downloads.remove(record.infoHash, deleteFiles))
  }

  return (
    <div className="dl-row">
      <div className="dl-art">{record.poster ? <img src={record.poster} alt="" /> : <div className="fallback" />}</div>
      <div className="dl-body">
        <div className="dl-title">{record.title}</div>
        <div className="dl-file">{record.fileName}</div>
        <div className="dl-progress">
          <div style={{ width: `${Math.min(100, pct * 100)}%` }} />
        </div>
        <div className="stat-line">
          <span className={'tag-pill' + (done ? ' good' : record.status === 'error' ? ' bad' : '')}>
            {done ? 'Ready to watch' : record.status}
          </span>
          <span>
            {humanBytes(pct * record.length)} / {humanBytes(record.length)}
          </span>
          {!done && live && (
            <>
              <span>{humanBytes(live.downloadSpeed)}/s</span>
              <span>{live.peers} peers</span>
              {live.timeRemaining > 0 && isFinite(live.timeRemaining) && (
                <span>{humanTime(live.timeRemaining / 1000)} left</span>
              )}
            </>
          )}
          {record.error && <span className="bad-text">{record.error}</span>}
        </div>
      </div>
      <div className="dl-actions">
        <button className="btn primary" onClick={play} disabled={busy}>
          <Icon name="play" size={15} /> Play
        </button>
        {!done &&
          (record.status === 'downloading' ? (
            <button className="btn glass" disabled={busy} onClick={() => run(() => window.api.downloads.pause(record.infoHash))}>
              <Icon name="pause" size={14} /> Pause
            </button>
          ) : (
            <button className="btn glass" disabled={busy} onClick={() => run(() => window.api.downloads.resume(record.infoHash))}>
              Resume
            </button>
          ))}
        <button className="round-btn" title="Show file" disabled={busy} onClick={() => window.api.downloads.reveal(record.infoHash).catch(onError)}>
          <Icon name="folder" size={17} />
        </button>
        <button className="round-btn" title="Remove" disabled={busy} onClick={remove}>
          <Icon name="trash" size={17} />
        </button>
      </div>
    </div>
  )
}

// -------------------------------------------------------------- insights

interface Bar {
  label: string
  value: number
  tip: string
  /** Show the axis label under this bar. */
  tick?: boolean
}

/** Single-series column chart: thin bars, recessive axis, a tooltip per bar. */
function Columns({ bars, title, summary }: { bars: Bar[]; title: string; summary: string }): JSX.Element {
  const max = Math.max(1, ...bars.map((b) => b.value))
  return (
    <figure className="chart">
      <figcaption>
        <span className="chart-title">{title}</span>
        <span className="chart-sub">{summary}</span>
      </figcaption>
      <div className="columns" role="img" aria-label={`${title}. ${summary}`}>
        {bars.map((b, i) => (
          <div key={i} className="col" tabIndex={0}>
            <div className="col-bar" style={{ height: `${(b.value / max) * 100}%` }} data-empty={b.value === 0 || undefined} />
            <div className="col-tip">{b.tip}</div>
            <div className="col-label">{b.tick ? b.label : ''}</div>
          </div>
        ))}
      </div>
      <table className="sr-only">
        <caption>{title}</caption>
        <tbody>
          {bars.map((b, i) => (
            <tr key={i}>
              <th>{b.label}</th>
              <td>{b.value}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  )
}

const WEEK = 7 * 24 * 3600 * 1000

function Insights({
  progress,
  ratings,
  items
}: {
  progress: ProgressEntry[]
  ratings: RatingEntry[]
  items: LibraryItem[]
}): JSX.Element {
  const navigate = useNavigate()
  const stats = useMemo(() => {
    const seconds = progress.reduce((n, p) => n + Math.min(p.time, p.duration || p.time), 0)
    const films = progress.filter((p) => p.finished && p.type === 'movie').length
    const episodes = progress.filter((p) => p.finished && p.season !== undefined).length
    const shows = new Set(progress.filter((p) => p.season !== undefined).map((p) => p.id)).size
    const avg = ratings.length ? ratings.reduce((n, r) => n + r.rating, 0) / ratings.length : 0

    // Twelve weeks of activity, oldest first, each week ending today-ish.
    const now = Date.now()
    const weeks: Bar[] = Array.from({ length: 12 }, (_, i) => {
      const end = now - (11 - i) * WEEK
      const start = end - WEEK
      const count = progress.filter((p) => p.updatedAt > start && p.updatedAt <= end).length
      const label = new Date(start + 1).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
      return { label, value: count, tip: `Week of ${label}: ${count} title${count === 1 ? '' : 's'}`, tick: i % 3 === 0 || i === 11 }
    })

    const dist: Bar[] = Array.from({ length: 10 }, (_, i) => {
      const n = ratings.filter((r) => r.rating === i + 1).length
      return { label: String(i + 1), value: n, tip: `${n} rated ${i + 1}/10`, tick: true }
    })

    const top = [...ratings].sort((a, b) => b.rating - a.rating || b.ratedAt - a.ratedAt).slice(0, 6)
    return { seconds, films, episodes, shows, avg, weeks, dist, top }
  }, [progress, ratings])

  if (!progress.length && !ratings.length) {
    return (
      <Empty icon="chart" title="Your stats show up here">
        Watch something, rate a few titles, or import your Letterboxd or Trakt history to see your numbers.
      </Empty>
    )
  }

  const hours = stats.seconds / 3600
  const weekTotal = stats.weeks.reduce((n, w) => n + w.value, 0)

  return (
    <div className="insights">
      <div className="tiles">
        <div className="tile">
          <div className="tile-value">{hours >= 10 ? Math.round(hours) : hours.toFixed(1)}</div>
          <div className="tile-label">hours watched</div>
        </div>
        <div className="tile">
          <div className="tile-value">{stats.films}</div>
          <div className="tile-label">films finished</div>
        </div>
        <div className="tile">
          <div className="tile-value">{stats.episodes}</div>
          <div className="tile-label">episodes across {stats.shows} show{stats.shows === 1 ? '' : 's'}</div>
        </div>
        <div className="tile">
          <div className="tile-value">{stats.avg ? stats.avg.toFixed(1) : '—'}</div>
          <div className="tile-label">average rating · {ratings.length} rated</div>
        </div>
        <div className="tile">
          <div className="tile-value">{items.length}</div>
          <div className="tile-label">on your watchlist</div>
        </div>
      </div>

      <div className="chart-grid">
        <Columns bars={stats.weeks} title="Activity" summary={`${weekTotal} titles touched in the last 12 weeks`} />
        <Columns
          bars={stats.dist}
          title="How you rate"
          summary={ratings.length ? `${ratings.length} ratings, out of 10` : 'Rate titles on their page to fill this in'}
        />
      </div>

      {stats.top.length > 0 && (
        <section className="row">
          <div className="row-head">
            <h2>Your highest rated</h2>
          </div>
          <div className="grid">
            {stats.top.map((r) => (
              <MetaCard
                key={r.key}
                meta={{ id: r.id, type: r.type, name: r.name, poster: r.poster }}
                subtitle={r.year}
                rating={r.rating}
                onClick={() => navigate(detailPath(r.type, r.id))}
              />
            ))}
          </div>
        </section>
      )}
    </div>
  )
}

// ------------------------------------------------------------------ page

export default function Library(): JSX.Element {
  const navigate = useNavigate()
  const web = isWeb()
  const [params, setParams] = useSearchParams()
  const tab = (params.get('tab') as Tab) || 'continue'
  const setTab = (t: Tab): void => setParams({ tab: t }, { replace: true })
  const [items, setItems] = useState<LibraryItem[] | null>(null)
  const [progress, setProgress] = useState<ProgressEntry[]>([])
  const [ratings, setRatings] = useState<RatingEntry[]>([])
  const [downloads, setDownloads] = useState<DownloadRecord[]>([])
  const [live, setLive] = useState<Record<string, DownloadProgress>>({})
  const [error, setError] = useState<unknown>(null)

  const load = useCallback(() => {
    window.api.library
      .get()
      .then((lib) => {
        setItems(lib.items)
        setProgress(lib.progress)
        setRatings(lib.ratings)
      })
      .catch(setError)
    window.api.downloads.list().then(setDownloads).catch(setError)
  }, [])

  useEffect(load, [load])

  // Poll live download stats only while that tab is open.
  useEffect(() => {
    if (tab !== 'downloads') return
    const tick = (): void => {
      window.api.downloads
        .progress()
        .then((list) => setLive(Object.fromEntries(list.map((p) => [p.infoHash, p]))))
        .catch(() => undefined)
    }
    tick()
    const id = window.setInterval(tick, 1000)
    return () => window.clearInterval(id)
  }, [tab])

  // A finishing download should flip to "ready" without a manual refresh.
  useEffect(() => {
    if (tab !== 'downloads') return
    const id = window.setInterval(() => {
      window.api.downloads.list().then(setDownloads).catch(() => undefined)
    }, 4000)
    return () => window.clearInterval(id)
  }, [tab])

  if (!items) return <Spinner />

  const open = (type: string, id: string): void => navigate(detailPath(type, id))
  const unfinished = progress.filter((p) => !p.finished && p.time > 0)
  const watched = progress.filter((p) => p.finished)
  const ratingOf = (type: string, id: string): number | undefined =>
    ratings.find((r) => r.type === type && r.id === id)?.rating

  const tabs: { id: Tab; label: string; count?: number; icon?: 'chart' }[] = [
    { id: 'continue', label: 'Continue', count: unfinished.length },
    { id: 'saved', label: 'Watchlist', count: items.length },
    { id: 'watched', label: 'Watched', count: watched.length },
    { id: 'rated', label: 'Rated', count: ratings.length },
    ...(web ? [] : [{ id: 'downloads' as Tab, label: 'Downloads', count: downloads.length }]),
    { id: 'insights', label: 'Insights', icon: 'chart' }
  ]

  const forget = async (p: ProgressEntry): Promise<void> => {
    await window.api.library.clearProgress(p.key)
    toast(`Removed “${p.name}” from Continue watching`)
    load()
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="kicker">Library</div>
          <h1 className="page-title">Your shelf</h1>
        </div>
        {!web && (
          <button className="btn glass" onClick={() => navigate('/settings#import')}>
            <Icon name="download" size={16} /> Import from Letterboxd, Trakt…
          </button>
        )}
      </header>
      <ErrorBox error={error} />

      <div className="tab-bar">
        <Segmented options={tabs} value={tab} onChange={setTab} />
      </div>

      {tab === 'continue' &&
        (unfinished.length === 0 ? (
          <Empty icon="clock" title="Nothing in progress">
            Start something from Home and it will wait for you here.
          </Empty>
        ) : (
          <div className="wide-grid">
            {unfinished.map((p) => (
              <WideCard
                key={p.key}
                title={p.name}
                kicker={p.season !== undefined ? `S${p.season} · E${p.episode}` : 'Film'}
                image={backdropFor(p)}
                fallbackImage={p.poster}
                progress={p.duration ? p.time / p.duration : 0}
                meta={timeLeft(p.duration - p.time)}
                onClick={() => navigate(`${detailPath(p.type, p.id)}?play=1`)}
                onRemove={() => forget(p)}
              />
            ))}
          </div>
        ))}

      {tab === 'watched' &&
        (watched.length === 0 ? (
          <Empty icon="check" title="No history yet">
            Titles you finish land here{web ? '.' : ' — or bring your history in from Letterboxd, Trakt and more.'}
          </Empty>
        ) : (
          <div className="grid">
            {watched.map((p) => (
              <MetaCard
                key={p.key}
                meta={{ id: p.id, type: p.type, name: p.name, poster: p.poster }}
                subtitle={p.season !== undefined ? `S${p.season}E${p.episode}` : 'Watched'}
                progress={1}
                rating={ratingOf(p.type, p.id)}
                onClick={() => open(p.type, p.id)}
              />
            ))}
          </div>
        ))}

      {tab === 'rated' &&
        (ratings.length === 0 ? (
          <Empty icon="star" title="No ratings yet">
            Rate anything from its page{web ? '.' : ', or import ratings from Letterboxd, IMDb, Trakt or Simkl.'}
          </Empty>
        ) : (
          <div className="grid">
            {[...ratings]
              .sort((a, b) => b.rating - a.rating || b.ratedAt - a.ratedAt)
              .map((r) => (
                <MetaCard
                  key={r.key}
                  meta={{ id: r.id, type: r.type, name: r.name, poster: r.poster }}
                  subtitle={r.year}
                  rating={r.rating}
                  onClick={() => open(r.type, r.id)}
                />
              ))}
          </div>
        ))}

      {tab === 'saved' &&
        (items.length === 0 ? (
          <Empty icon="bookmark" title="Your watchlist is empty">
            Tap the bookmark on any title to save it for later.
          </Empty>
        ) : (
          <div className="grid">
            {items.map((it) => (
              <MetaCard
                key={it.key}
                meta={{ id: it.id, type: it.type, name: it.name, poster: it.poster }}
                subtitle={it.type === 'series' ? 'Series' : 'Film'}
                rating={ratingOf(it.type, it.id)}
                onClick={() => open(it.type, it.id)}
              />
            ))}
          </div>
        ))}

      {tab === 'downloads' &&
        (downloads.length === 0 ? (
          <Empty icon="download" title="No downloads yet">
            Open any title, choose Sources, then the download button on a torrent source.
          </Empty>
        ) : (
          <div className="dl-list">
            {downloads.map((d) => (
              <DownloadRow key={d.infoHash} record={d} live={live[d.infoHash]} onChanged={load} onError={setError} />
            ))}
          </div>
        ))}

      {tab === 'insights' && <Insights progress={progress} ratings={ratings} items={items} />}
    </div>
  )
}
