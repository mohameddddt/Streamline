import { useCallback, useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type {
  DownloadProgress,
  DownloadRecord,
  LibraryItem,
  ProgressEntry
} from '../../../shared/types'
import { ErrorBox, MetaCard, Spinner, humanBytes, humanTime } from '../components/ui'

type Tab = 'continue' | 'watched' | 'downloads' | 'saved'

const TABS: { id: Tab; label: string }[] = [
  { id: 'continue', label: 'Continue watching' },
  { id: 'watched', label: 'Watched' },
  { id: 'downloads', label: 'Downloads' },
  { id: 'saved', label: 'Saved' }
]

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
      navigate('/player', {
        state: {
          plan,
          source,
          infoHash: done ? undefined : record.infoHash,
          streamId: record.videoId ?? record.metaId,
          title: record.title,
          meta: {
            id: record.metaId,
            type: record.metaType,
            name: record.title,
            poster: record.poster
          },
          season: record.season,
          episode: record.episode,
          videoId: record.videoId
        }
      })
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
      <div className="dl-art">
        {record.poster ? <img src={record.poster} alt="" /> : <div className="fallback" />}
      </div>
      <div className="dl-body">
        <div className="dl-title">{record.title}</div>
        <div className="dl-file">{record.fileName}</div>
        <div className="dl-progress">
          <div style={{ width: `${Math.min(100, pct * 100)}%` }} />
        </div>
        <div className="stat-line">
          <span className={done ? 'chip cached' : 'chip'}>
            {done ? 'ready to watch' : record.status}
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
          {record.error && <span style={{ color: 'var(--bad)' }}>{record.error}</span>}
        </div>
      </div>
      <div className="dl-actions">
        <button className="btn primary" onClick={play} disabled={busy}>
          ▶ Play
        </button>
        {!done &&
          (record.status === 'downloading' ? (
            <button
              className="btn"
              disabled={busy}
              onClick={() => run(() => window.api.downloads.pause(record.infoHash))}
            >
              Pause
            </button>
          ) : (
            <button
              className="btn"
              disabled={busy}
              onClick={() => run(() => window.api.downloads.resume(record.infoHash))}
            >
              Resume
            </button>
          ))}
        <button
          className="btn ghost"
          disabled={busy}
          onClick={() => window.api.downloads.reveal(record.infoHash).catch(onError)}
        >
          Show file
        </button>
        <button className="icon-btn" disabled={busy} onClick={remove}>
          Remove
        </button>
      </div>
    </div>
  )
}

export default function Library(): JSX.Element {
  const navigate = useNavigate()
  const [tab, setTab] = useState<Tab>('continue')
  const [items, setItems] = useState<LibraryItem[] | null>(null)
  const [progress, setProgress] = useState<ProgressEntry[]>([])
  const [downloads, setDownloads] = useState<DownloadRecord[]>([])
  const [live, setLive] = useState<Record<string, DownloadProgress>>({})
  const [error, setError] = useState<unknown>(null)

  const load = useCallback(() => {
    window.api.library
      .get()
      .then((lib) => {
        setItems(lib.items)
        setProgress(lib.progress)
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

  const open = (type: string, id: string): void =>
    navigate(`/detail/${encodeURIComponent(type)}/${encodeURIComponent(id)}`)

  const unfinished = progress.filter((p) => !p.finished)
  const watched = progress.filter((p) => p.finished)

  const counts: Record<Tab, number> = {
    continue: unfinished.length,
    watched: watched.length,
    downloads: downloads.length,
    saved: items.length
  }

  const grid = (entries: ProgressEntry[], emptyText: string): JSX.Element =>
    entries.length === 0 ? (
      <div className="empty">{emptyText}</div>
    ) : (
      <div className="grid">
        {entries.map((p) => (
          <MetaCard
            key={p.key}
            meta={{ id: p.id, type: p.type, name: p.name, poster: p.poster }}
            subtitle={
              p.season !== undefined
                ? `S${p.season}E${p.episode}`
                : p.finished
                  ? 'Watched'
                  : `${Math.round((p.time / Math.max(1, p.duration)) * 100)}%`
            }
            progress={p.finished ? 1 : p.duration ? p.time / p.duration : 0}
            onClick={() => open(p.type, p.id)}
          />
        ))}
      </div>
    )

  return (
    <div className="page">
      <h1 style={{ fontSize: 22, marginTop: 0 }}>Library</h1>
      <ErrorBox error={error} />

      <div className="season-tabs" style={{ marginBottom: 22 }}>
        {TABS.map((t) => (
          <button
            key={t.id}
            className={'season-tab' + (t.id === tab ? ' active' : '')}
            onClick={() => setTab(t.id)}
          >
            {t.label} {counts[t.id] > 0 && <span className="count">{counts[t.id]}</span>}
          </button>
        ))}
      </div>

      {tab === 'continue' && grid(unfinished, 'Nothing in progress. Start something from Discover.')}
      {tab === 'watched' && grid(watched, 'Titles you finish will be listed here.')}
      {tab === 'saved' &&
        (items.length === 0 ? (
          <div className="empty">Add titles with “Add to library” on any detail page.</div>
        ) : (
          <div className="grid">
            {items.map((it) => (
              <MetaCard
                key={it.key}
                meta={{ id: it.id, type: it.type, name: it.name, poster: it.poster }}
                subtitle={it.type}
                onClick={() => open(it.type, it.id)}
              />
            ))}
          </div>
        ))}
      {tab === 'downloads' &&
        (downloads.length === 0 ? (
          <div className="empty">
            No downloads yet. Open any title, hit “Find sources”, then “↓ save” on a source.
          </div>
        ) : (
          downloads.map((d) => (
            <DownloadRow
              key={d.infoHash}
              record={d}
              live={live[d.infoHash]}
              onChanged={load}
              onError={setError}
            />
          ))
        ))}
    </div>
  )
}
