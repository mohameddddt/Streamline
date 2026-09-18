import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type {
  MetaPreview,
  PlaybackPlan,
  PlaybackSource,
  ProgressEntry,
  SubtitleTrack,
  TorrentStats
} from '../../../shared/types'
import { ErrorBox, humanBytes, humanTime } from '../components/ui'

interface PlayerState {
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
}

/** Rebuilds a transcode URL so ffmpeg restarts at a new timestamp. */
function urlAtOffset(base: string, seconds: number): string {
  const url = new URL(base)
  url.searchParams.set('t', String(Math.max(0, Math.floor(seconds))))
  return url.toString()
}

export default function Player(): JSX.Element {
  const navigate = useNavigate()
  const state = useLocation().state as PlayerState | null
  const videoRef = useRef<HTMLVideoElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)

  const [stats, setStats] = useState<TorrentStats | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [overlay, setOverlay] = useState(true)
  const [waiting, setWaiting] = useState(true)
  const [subs, setSubs] = useState<SubtitleTrack[]>([])
  const [subUrl, setSubUrl] = useState<string | null>(null)

  const [offset, setOffset] = useState<number | null>(null)
  const [localTime, setLocalTime] = useState(0)
  const [paused, setPaused] = useState(false)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [fullscreen, setFullscreen] = useState(false)

  const plan = state?.plan
  // A remuxed/transcoded stream is a live pipe and cannot be seeked natively,
  // so we restart ffmpeg at the target timestamp and add that offset back on.
  const isLive = plan ? plan.mode !== 'direct' : false

  const progressKey = useMemo(
    () => (state ? `${state.meta.type}:${state.videoId ?? state.meta.id}` : ''),
    [state]
  )

  const duration = plan?.duration || videoRef.current?.duration || 0
  const displayTime = isLive ? (offset ?? 0) + localTime : localTime

  useEffect(() => {
    if (!state) navigate('/', { replace: true })
  }, [state, navigate])

  // ----------------------------------------------- decide the start offset
  useEffect(() => {
    if (!state || offset !== null) return
    let alive = true
    window.api.library
      .get()
      .then((lib) => {
        if (!alive) return
        const entry = lib.progress.find((p) => p.key === progressKey)
        const resume = entry && entry.time > 10 && !entry.finished ? entry.time : 0
        setOffset(resume)
      })
      .catch(() => alive && setOffset(0))
    return () => {
      alive = false
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state, progressKey])

  const src = useMemo(() => {
    if (!plan || offset === null) return ''
    return isLive ? urlAtOffset(plan.url, offset) : plan.url
  }, [plan, offset, isLive])

  // --------------------------------------------------------- torrent stats
  useEffect(() => {
    if (!state?.infoHash) return
    const id = window.setInterval(() => {
      window.api.torrent
        .stats(state.infoHash as string)
        .then(setStats)
        .catch(() => undefined)
    }, 1000)
    return () => window.clearInterval(id)
  }, [state?.infoHash])

  useEffect(() => {
    window.api.app.keepAwake(true).catch(() => undefined)
    return () => {
      window.api.app.keepAwake(false).catch(() => undefined)
    }
  }, [])

  // -------------------------------------------------------------- subtitles
  useEffect(() => {
    if (!state) return
    window.api.addons
      .subtitles(state.meta.type, state.streamId)
      .then(setSubs)
      .catch(() => undefined)
  }, [state])

  const chooseSubtitle = async (track: SubtitleTrack | null): Promise<void> => {
    if (subUrl) URL.revokeObjectURL(subUrl)
    if (!track) {
      setSubUrl(null)
      return
    }
    try {
      const vtt = await window.api.addons.subtitleVtt(track.url)
      setSubUrl(URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' })))
    } catch (err) {
      setError(err)
    }
  }

  useEffect(() => {
    const video = videoRef.current
    if (!video || !subUrl) return
    const timer = window.setTimeout(() => {
      for (const t of Array.from(video.textTracks)) t.mode = 'showing'
    }, 120)
    return () => window.clearTimeout(timer)
  }, [subUrl])

  // ------------------------------------------------------ progress + scrobble
  const entryFor = useCallback(
    (time: number): ProgressEntry | null => {
      if (!state || !duration) return null
      return {
        key: progressKey,
        id: state.meta.id,
        type: state.meta.type,
        name: state.meta.name,
        poster: state.meta.poster,
        season: state.season,
        episode: state.episode,
        videoId: state.videoId,
        year: state.year,
        time,
        duration,
        updatedAt: Date.now()
      }
    },
    [state, duration, progressKey]
  )

  const latest = useRef(0)
  latest.current = displayTime

  const saveProgress = useCallback(() => {
    const entry = entryFor(latest.current)
    if (!entry || entry.time < 5) return
    window.api.library.setProgress(entry).catch(() => undefined)
  }, [entryFor])

  useEffect(() => {
    const id = window.setInterval(saveProgress, 5000)
    return () => {
      window.clearInterval(id)
      saveProgress()
    }
  }, [saveProgress])

  const scrobbleRef = useRef<{ action: string; at: number }>({ action: '', at: 0 })
  const scrobble = useCallback(
    (action: 'start' | 'pause' | 'stop', time: number) => {
      const entry = entryFor(time)
      if (!entry || entry.time < 5) return
      const now = Date.now()
      if (scrobbleRef.current.action === action && now - scrobbleRef.current.at < 5000) return
      scrobbleRef.current = { action, at: now }
      window.api.trackers.scrobble(action, entry).catch(() => undefined)
    },
    [entryFor]
  )

  // `stop` on unmount is what actually marks a title watched on Trakt/Simkl.
  const scrobbleOnExit = useRef(scrobble)
  scrobbleOnExit.current = scrobble
  useEffect(() => {
    return () => scrobbleOnExit.current('stop', latest.current)
  }, [])

  // --------------------------------------------------------------- controls
  const seekTo = useCallback(
    (target: number) => {
      const video = videoRef.current
      if (!video || !duration) return
      const clamped = Math.max(0, Math.min(duration - 1, target))
      if (isLive) {
        setOffset(clamped)
        setLocalTime(0)
        setWaiting(true)
      } else {
        video.currentTime = clamped
      }
    },
    [duration, isLive]
  )

  const togglePlay = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    if (video.paused) video.play().catch(() => undefined)
    else video.pause()
  }, [])

  const toggleFullscreen = useCallback(async () => {
    if (!document.fullscreenElement) await shellRef.current?.requestFullscreen().catch(() => undefined)
    else await document.exitFullscreen().catch(() => undefined)
  }, [])

  useEffect(() => {
    const onChange = (): void => setFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  useEffect(() => {
    let timer = 0
    const show = (): void => {
      setOverlay(true)
      window.clearTimeout(timer)
      timer = window.setTimeout(() => setOverlay(false), 3000)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) return
      switch (e.key) {
        case 'Escape':
          if (document.fullscreenElement) document.exitFullscreen().catch(() => undefined)
          else navigate(-1)
          break
        case ' ':
        case 'k':
          e.preventDefault()
          togglePlay()
          break
        case 'ArrowRight':
          seekTo(latest.current + 10)
          break
        case 'ArrowLeft':
          seekTo(latest.current - 10)
          break
        case 'f':
          toggleFullscreen()
          break
        case 'm':
          setMuted((m) => !m)
          break
        default:
          break
      }
      show()
    }
    window.addEventListener('mousemove', show)
    window.addEventListener('keydown', onKey)
    show()
    return () => {
      window.clearTimeout(timer)
      window.removeEventListener('mousemove', show)
      window.removeEventListener('keydown', onKey)
    }
  }, [navigate, seekTo, togglePlay, toggleFullscreen])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.volume = volume
    video.muted = muted
  }, [volume, muted, src])

  if (!state || !plan) return <div />

  const onScrub = (e: React.PointerEvent<HTMLDivElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
    seekTo(ratio * duration)
  }

  const buffering = waiting && !paused
  const pct = duration ? Math.min(100, (displayTime / duration) * 100) : 0

  return (
    <div className="player" ref={shellRef}>
      {src && (
        <video
          ref={videoRef}
          src={src}
          autoPlay
          onClick={togglePlay}
          onLoadedMetadata={() => {
            const video = videoRef.current
            if (!video) return
            if (!isLive && offset && offset > 10) video.currentTime = offset
            video.play().catch(() => undefined)
          }}
          onTimeUpdate={() => setLocalTime(videoRef.current?.currentTime ?? 0)}
          onPlay={() => {
            setPaused(false)
            scrobble('start', latest.current)
          }}
          onPause={() => {
            setPaused(true)
            scrobble('pause', latest.current)
          }}
          onWaiting={() => setWaiting(true)}
          onPlaying={() => setWaiting(false)}
          onCanPlay={() => setWaiting(false)}
          onEnded={() => {
            saveProgress()
            navigate(-1)
          }}
          onError={() =>
            setError(
              new Error(
                'This file failed to play. Try another source, or open it in an external player.'
              )
            )
          }
        >
          {subUrl && <track key={subUrl} kind="subtitles" src={subUrl} label="Subtitles" default />}
        </video>
      )}

      <div className={'player-overlay' + (overlay ? '' : ' hidden')}>
        <button className="btn ghost" onClick={() => navigate(-1)}>
          ← Back
        </button>
        <div className="player-title">{state.title}</div>
        <span className="chip" title={plan.reason}>
          {plan.mode === 'direct' ? 'direct' : plan.mode === 'remux' ? 'remuxing' : 'converting'}
        </span>
      </div>

      <div className={'controls' + (overlay ? '' : ' hidden')}>
        <div className="scrub" onPointerDown={onScrub}>
          <div className="scrub-fill" style={{ width: `${pct}%` }}>
            <span className="scrub-knob" />
          </div>
        </div>
        <div className="controls-row">
          <button className="ctrl" onClick={togglePlay} title="Play / pause (space)">
            {paused ? '▶' : '❚❚'}
          </button>
          <button className="ctrl" onClick={() => seekTo(displayTime - 10)} title="Back 10s (←)">
            −10
          </button>
          <button className="ctrl" onClick={() => seekTo(displayTime + 10)} title="Forward 10s (→)">
            +10
          </button>
          <span className="time">
            {humanTime(displayTime)} / {humanTime(duration)}
          </span>

          <button className="ctrl" onClick={() => setMuted(!muted)} title="Mute (m)">
            {muted || volume === 0 ? 'Mute' : 'Vol'}
          </button>
          <input
            className="volume"
            type="range"
            min={0}
            max={1}
            step={0.05}
            value={muted ? 0 : volume}
            onChange={(e) => {
              setVolume(Number(e.target.value))
              setMuted(false)
            }}
          />

          <div className="spacer" />

          {stats && (
            <span className="stat-line">
              <span>{stats.peers} peers</span>
              <span>{humanBytes(stats.downloadSpeed)}/s</span>
            </span>
          )}

          {subs.length > 0 && (
            <select
              className="sub-select"
              onChange={(e) => chooseSubtitle(subs.find((s) => s.id === e.target.value) ?? null)}
              defaultValue=""
            >
              <option value="">Subtitles: off</option>
              {subs.slice(0, 60).map((s) => (
                <option key={s.id} value={s.id}>
                  {s.lang} · {s.addonName}
                </option>
              ))}
            </select>
          )}

          <button
            className="ctrl"
            title="Open in external player"
            onClick={() =>
              window.api.app.externalPlayer(plan.url, state.title).catch((err) => setError(err))
            }
          >
            Open in VLC
          </button>
          <button className="ctrl" onClick={toggleFullscreen} title="Fullscreen (f)">
            {fullscreen ? 'Exit full' : 'Fullscreen'}
          </button>
        </div>
      </div>

      {(buffering || Boolean(error)) && (
        <div className="player-status">
          <ErrorBox error={error} />
          {!error && <div className="spinner" />}
          {!error && (
            <div>
              {state.infoHash && !stats?.peers ? 'Connecting to peers…' : 'Buffering…'}
              <div className="stat-line" style={{ marginTop: 10 }}>
                {state.infoHash && (
                  <>
                    <span>{stats?.peers ?? 0} peers</span>
                    <span>{humanBytes(stats?.downloadSpeed ?? 0)}/s</span>
                  </>
                )}
                <span>{plan.reason}</span>
              </div>
            </div>
          )}
          {Boolean(error) && (
            <div className="btn-row">
              <button
                className="btn"
                onClick={() =>
                  window.api.app.externalPlayer(plan.url, state.title).catch((e) => setError(e))
                }
              >
                Open in external player
              </button>
              <button className="btn ghost" onClick={() => navigate(-1)}>
                Back to sources
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
