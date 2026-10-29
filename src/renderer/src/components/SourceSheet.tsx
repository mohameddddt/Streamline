import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { MetaDetail, QualityPref, Stream, Video } from '../../../shared/types'
import { rankStreams, resolutionsIn, type RankedStream, type Resolution } from '../../../shared/streams'
import { ErrorBox, Select, Spinner, humanBytes } from './ui'
import { Icon } from './Icon'
import { isWeb, toast } from '../lib/app'
import { preparePlayback, progressKeyFor } from '../lib/play'

export interface SheetTarget {
  label: string
  video?: Video
}

type Sort = 'best' | 'seeders' | 'size' | 'quality'

const idOf = (s: Stream): string => `${s.infoHash?.toLowerCase() ?? s.url ?? s.filePath}|${s.fileIdx ?? -1}`

/** Same release, even if the addon regenerated the link since we saved it. */
function sameStream(a: Stream, b: Stream): boolean {
  if (a.infoHash && b.infoHash) {
    return (
      a.infoHash.toLowerCase() === b.infoHash.toLowerCase() &&
      (a.fileIdx ?? -1) === (b.fileIdx ?? -1)
    )
  }
  if (a.url && b.url) return a.url === b.url
  if (a.filePath && b.filePath) return a.filePath === b.filePath
  return false
}

/** The release name an addon buried in its free-text title. */
function releaseName(s: Stream): string {
  const lines = (s.title ?? s.description ?? '').split('\n').map((l) => l.trim())
  const line = lines.find((l) => l && !/^[👤💾⚙️🇦-🇿]/u.test(l))
  return line || s.behaviorHints?.filename || s.name || 'Untitled source'
}

const RES_CLASS: Record<string, string> = { '4K': 'r4k', '1440p': 'r1440', '1080p': 'r1080', '720p': 'r720', SD: 'rsd' }

export function SourceSheet({
  meta,
  target,
  autoPlay,
  onClose
}: {
  meta: MetaDetail
  target: SheetTarget
  autoPlay?: boolean
  onClose: () => void
}): JSX.Element {
  const navigate = useNavigate()
  const web = isWeb()
  const [streams, setStreams] = useState<Stream[] | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [starting, setStarting] = useState<string | null>(null)
  const [phase, setPhase] = useState('')
  const [downloading, setDownloading] = useState<string | null>(null)
  const [queued, setQueued] = useState<Set<string>>(new Set())
  const [last, setLast] = useState<Stream | null>(null)
  const [lastLoaded, setLastLoaded] = useState(false)
  const [pref, setPref] = useState<QualityPref | null>(null)
  const [res, setRes] = useState<Resolution | 'all'>('all')
  const [instantOnly, setInstantOnly] = useState(false)
  const [sort, setSort] = useState<Sort>('best')
  /** Web only: whether torrents can play (a desktop companion is paired). */
  const [engine, setEngine] = useState(!web)
  const autoStarted = useRef(false)

  const key = progressKeyFor(meta.type, meta.id, target.video)
  const streamId = target.video?.id ?? meta.id

  useEffect(() => {
    let alive = true
    window.api.settings.get().then((s) => alive && setPref(s.preferredQuality)).catch(() => alive && setPref('1080p'))
    window.api.library
      .getLastStream(key)
      .then((s) => alive && setLast(s))
      .catch(() => undefined)
      .finally(() => alive && setLastLoaded(true))
    if (web) window.api.companion.info().then((i) => alive && setEngine(i.connected)).catch(() => undefined)
    // Spinning up the torrent engine takes a moment; do it while they read the
    // list rather than on the click, where it shows up as dead time.
    window.api.torrent.warm().catch(() => undefined)
    return () => {
      alive = false
    }
  }, [key, web])

  useEffect(() => {
    let alive = true
    setStreams(null)
    window.api.addons
      .streams(meta.type, streamId)
      .then((list) => alive && setStreams(list))
      .catch((err) => alive && setError(err))
    return () => {
      alive = false
    }
  }, [meta.type, streamId])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const ranked = useMemo(() => (streams && pref ? rankStreams(streams, pref) : []), [streams, pref])

  // What they watched before goes first — from the fresh list when the addon
  // still offers it, otherwise from the saved copy, so it is there at once.
  const lastRanked = useMemo((): RankedStream | null => {
    if (!last) return null
    const fresh = ranked.find((r) => sameStream(r.stream, last))
    return fresh ?? rankStreams([last], pref ?? '1080p')[0]
  }, [ranked, last, pref])

  const visible = useMemo(() => {
    // Unfiltered, the last source is pinned above the list instead.
    const pinned = res === 'all' && !instantOnly
    let list = ranked.filter((r) => !pinned || r !== lastRanked)
    if (res !== 'all') list = list.filter((r) => r.traits.resolution === res)
    if (instantOnly) list = list.filter((r) => r.traits.instant)
    const by: Record<Sort, (a: RankedStream, b: RankedStream) => number> = {
      best: (a, b) => b.score - a.score,
      seeders: (a, b) => b.traits.seeders - a.traits.seeders,
      size: (a, b) => b.traits.size - a.traits.size,
      quality: (a, b) =>
        ['4K', '1440p', '1080p', '720p', 'SD', ''].indexOf(a.traits.resolution) -
        ['4K', '1440p', '1080p', '720p', 'SD', ''].indexOf(b.traits.resolution)
    }
    list = [...list].sort(by[sort])
    // On the web without a paired desktop app, what can actually play goes first.
    if (!engine) list.sort((a, b) => Number(Boolean(b.stream.url)) - Number(Boolean(a.stream.url)))
    return list
  }, [ranked, lastRanked, res, instantOnly, sort, engine])

  const resolutions = useMemo(() => resolutionsIn(ranked), [ranked])
  const best = ranked.find((r) => engine || r.stream.url) ?? null

  const play = async (stream: Stream): Promise<void> => {
    const id = idOf(stream)
    setStarting(id)
    setError(null)
    try {
      const state = await preparePlayback(stream, { meta, video: target.video }, setPhase)
      navigate('/player', { state })
    } catch (err) {
      setError(err)
    } finally {
      setStarting(null)
      setPhase('')
    }
  }

  // "Watch now": go straight to the last source, else the best match.
  useEffect(() => {
    if (!autoPlay || autoStarted.current || !streams || !pref || !lastLoaded) return
    autoStarted.current = true
    const pick = lastRanked?.stream ?? best?.stream
    if (pick) play(pick)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoPlay, streams, pref, lastLoaded])

  const download = async (stream: Stream): Promise<void> => {
    const id = idOf(stream)
    setDownloading(id)
    setError(null)
    try {
      await window.api.downloads.start(stream, {
        title: `${meta.name}${target.video ? ` · ${target.label}` : ''}`,
        metaId: meta.id,
        metaType: meta.type,
        poster: meta.poster,
        season: target.video?.season,
        episode: target.video?.episode,
        videoId: target.video?.id
      })
      setQueued((prev) => new Set(prev).add(id))
      toast('Download started — find it in Library → Downloads', 'good')
    } catch (err) {
      setError(err)
    } finally {
      setDownloading(null)
    }
  }

  const row = (r: RankedStream, flag?: 'last' | 'best'): JSX.Element => {
    const s = r.stream
    const t = r.traits
    const id = idOf(s)
    const playable = engine || Boolean(s.url)
    const busy = starting === id
    return (
      <div key={id + (flag ?? '')} className={'source' + (flag ? ` ${flag}` : '') + (playable ? '' : ' dim')}>
        <button className="source-main" disabled={starting !== null} onClick={() => play(s)} title="Stream this now">
          <span className={'res-badge ' + (RES_CLASS[t.resolution] ?? 'rnone')}>{t.resolution || '—'}</span>
          <span className="source-body">
            <span className="source-title">{releaseName(s)}</span>
            <span className="source-tags">
              {flag === 'last' && <span className="tag-pill accent">Last played</span>}
              {flag === 'best' && <span className="tag-pill accent"><Icon name="sparkle" size={11} /> Best match</span>}
              {t.instant && <span className="tag-pill good"><Icon name="bolt" size={11} /> Instant</span>}
              {t.hdr && <span className="tag-pill">{t.hdr}</span>}
              {t.codec && <span className="tag-pill">{t.codec}</span>}
              {t.source && <span className="tag-pill">{t.source}</span>}
              {t.audio && <span className="tag-pill">{t.audio}</span>}
              {t.cam && <span className="tag-pill bad">CAM</span>}
              {!playable && <span className="tag-pill warn">Needs desktop app</span>}
            </span>
          </span>
          <span className="source-stats">
            {t.seeders >= 0 && !t.instant && <span>{t.seeders} seeds</span>}
            {t.size > 0 && <span>{humanBytes(t.size)}</span>}
            <span className="source-addon">{s.addonName ?? s.name}</span>
          </span>
        </button>
        <div className="source-actions">
          {busy ? (
            <span className="phase"><span className="spinner small" /> {phase || 'starting…'}</span>
          ) : (
            <button className="icon-btn play" disabled={starting !== null} onClick={() => play(s)} aria-label="Play">
              <Icon name="play" size={16} />
            </button>
          )}
          {!web && (
            <button
              className="icon-btn"
              disabled={!s.infoHash || downloading !== null || queued.has(id)}
              title={
                s.infoHash
                  ? 'Download to your computer'
                  : s.filePath
                    ? 'Already on this computer'
                    : 'This source is a direct link — stream it instead'
              }
              onClick={() => download(s)}
            >
              <Icon name={queued.has(id) ? 'check' : 'download'} size={16} />
            </button>
          )}
        </div>
      </div>
    )
  }

  const filtered = res !== 'all' || instantOnly
  const showBest = best && !lastRanked && !filtered && sort === 'best' && visible[0] === best

  return (
    <div className="sheet-backdrop" onMouseDown={onClose}>
      <div className="sheet" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Sources">
        <div className="sheet-grip" />
        <header className="sheet-head">
          <div>
            <div className="kicker">Sources</div>
            <h3>{meta.name}</h3>
            <div className="sheet-sub">{target.label}</div>
          </div>
          <div className="sheet-head-actions">
            {best && (
              <button className="btn primary" disabled={starting !== null} onClick={() => play(lastRanked?.stream ?? best.stream)}>
                <Icon name="play" size={16} /> {lastRanked ? 'Resume last source' : 'Play best'}
              </button>
            )}
            <button className="round-btn" onClick={onClose} aria-label="Close">
              <Icon name="close" size={18} />
            </button>
          </div>
        </header>

        {ranked.length > 0 && (
          <div className="sheet-tools">
            <div className="chip-row">
              <button className={'filter-chip' + (res === 'all' ? ' on' : '')} onClick={() => setRes('all')}>
                All <span className="chip-sub">{ranked.length}</span>
              </button>
              {resolutions.map((r) => (
                <button key={r} className={'filter-chip' + (res === r ? ' on' : '')} onClick={() => setRes(r)}>
                  {r} <span className="chip-sub">{ranked.filter((x) => x.traits.resolution === r).length}</span>
                </button>
              ))}
              {ranked.some((r) => r.traits.instant) && (
                <button className={'filter-chip' + (instantOnly ? ' on' : '')} onClick={() => setInstantOnly(!instantOnly)}>
                  <Icon name="bolt" size={13} /> Instant
                </button>
              )}
            </div>
            <div className="sort-select">
              Sort
              <Select
                size="sm"
                ariaLabel="Sort sources"
                value={sort}
                onChange={setSort}
                options={[
                  { value: 'best', label: 'Best match' },
                  { value: 'seeders', label: 'Most seeds' },
                  { value: 'quality', label: 'Highest quality' },
                  { value: 'size', label: 'Largest file' }
                ]}
              />
            </div>
          </div>
        )}

        {web && !engine && ranked.some((r) => r.stream.infoHash) && (
          <div className="notice">
            <Icon name="link" size={16} />
            <span>
              Torrent sources play through the Streamline desktop app. Turn on <b>Web companion</b> there and
              pair it in Settings — instant (debrid) sources work right away.
            </span>
          </div>
        )}

        <ErrorBox error={error} />

        <div className="sheet-list">
          {!streams && !error && <Spinner label="Asking your stream addons…" />}
          {streams && streams.length === 0 && !lastRanked && (
            <div className="sheet-empty">
              No sources found. Add a stream addon in Settings, point the local library at your own files, or try
              another episode.
            </div>
          )}
          {lastRanked && !filtered && row(lastRanked, 'last')}
          {visible.map((r, i) => row(r, showBest && i === 0 ? 'best' : undefined))}
          {streams && visible.length === 0 && filtered && <div className="sheet-empty">No sources match those filters.</div>}
        </div>
      </div>
    </div>
  )
}
