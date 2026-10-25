import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { ProgressEntry, SubtitleTrack, TorrentStats, Video } from '../../../shared/types'
import { pickNext } from '../../../shared/streams'
import { ErrorBox, humanBytes, humanTime } from '../components/ui'
import { Icon } from '../components/Icon'
import { errorText, isWeb } from '../lib/app'
import { nextEpisode, preparePlayback, type PlayerState } from '../lib/play'

/** Rebuilds a transcode URL so ffmpeg restarts at a new timestamp. */
function urlAtOffset(base: string, seconds: number): string {
  const url = new URL(base)
  url.searchParams.set('t', String(Math.max(0, Math.floor(seconds))))
  return url.toString()
}

const SPEEDS = [0.5, 0.75, 1, 1.25, 1.5, 2]
const SUB_SIZES = [
  { id: 's', label: 'S', px: 22 },
  { id: 'm', label: 'M', px: 30 },
  { id: 'l', label: 'L', px: 40 }
]
/** How long before the end the "Up next" card appears. */
const UP_NEXT_LEAD = 25
const COUNTDOWN = 10

const SHORTCUTS: [string, string][] = [
  ['Space / K', 'Play or pause'],
  ['← / →  or  J / L', 'Back / forward 10 seconds'],
  ['↑ / ↓', 'Volume'],
  ['M', 'Mute'],
  ['F  or double-click', 'Fullscreen'],
  ['C', 'Subtitles on / off'],
  ['P', 'Picture in picture'],
  ['< / >', 'Slower / faster'],
  ['N', 'Next episode'],
  ['?', 'This list'],
  ['Esc', 'Back']
]

type Panel = null | 'subs' | 'speed' | 'help'

export default function Player(): JSX.Element {
  const navigate = useNavigate()
  const state = useLocation().state as PlayerState | null
  const videoRef = useRef<HTMLVideoElement>(null)
  const shellRef = useRef<HTMLDivElement>(null)
  const trackRef = useRef<HTMLTrackElement>(null)

  const [stats, setStats] = useState<TorrentStats | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [overlay, setOverlay] = useState(true)
  const [waiting, setWaiting] = useState(true)
  const [subs, setSubs] = useState<SubtitleTrack[]>([])
  const [subUrl, setSubUrl] = useState<string | null>(null)
  const [subId, setSubId] = useState<string | null>(null)
  const [lastSub, setLastSub] = useState<SubtitleTrack | null>(null)
  const [subSize, setSubSize] = useState('m')
  const [subDelay, setSubDelay] = useState(0)
  const [panel, setPanel] = useState<Panel>(null)

  const [offset, setOffset] = useState<number | null>(null)
  const [localTime, setLocalTime] = useState(0)
  const [buffered, setBuffered] = useState(0)
  const [paused, setPaused] = useState(false)
  const [volume, setVolume] = useState(1)
  const [muted, setMuted] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [fullscreen, setFullscreen] = useState(false)
  const [hover, setHover] = useState<{ x: number; t: number } | null>(null)

  const [next, setNext] = useState<Video | null>(null)
  const [autoNext, setAutoNext] = useState(true)
  const [countdown, setCountdown] = useState<number | null>(null)
  const [nextDismissed, setNextDismissed] = useState(false)
  const [nextPhase, setNextPhase] = useState('')
  const [preferred, setPreferred] = useState<{ lang: string; quality: 'any' | '2160p' | '1080p' | '720p' }>({
    lang: 'eng',
    quality: '1080p'
  })

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
  const remaining = duration ? duration - displayTime : Infinity

  useEffect(() => {
    if (!state) navigate('/', { replace: true })
  }, [state, navigate])

  useEffect(() => {
    window.api.settings
      .get()
      .then((s) => {
        setAutoNext(s.autoplayNext)
        setPreferred({ lang: s.preferredLang, quality: s.preferredQuality })
      })
      .catch(() => undefined)
  }, [])

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

  // ------------------------------------------------------- the next episode
  useEffect(() => {
    if (!state?.videoId || state.meta.type !== 'series') return
    let alive = true
    window.api.addons
      .meta(state.meta.type, state.meta.id)
      .then((m) => alive && setNext(nextEpisode(m?.videos, state.videoId)))
      .catch(() => undefined)
    return () => {
      alive = false
    }
  }, [state])

  const goNext = useCallback(async () => {
    if (!state || !next) return
    setCountdown(null)
    setNextPhase('finding a source…')
    try {
      const streams = await window.api.addons.streams(state.meta.type, next.id)
      // Without a paired desktop engine, the browser can only play direct links.
      const engine = !isWeb() || (await window.api.companion.info().catch(() => null))?.connected
      const playable = engine ? streams : streams.filter((s) => s.url)
      const pick = pickNext(playable, preferred.quality, state.stream?.behaviorHints?.bingeGroup)
      if (!pick) throw new Error('No sources found for the next episode.')
      const nextState = await preparePlayback(
        pick,
        { meta: { ...state.meta, releaseInfo: state.year }, video: next },
        setNextPhase
      )
      navigate('/player', { replace: true, state: nextState })
    } catch (err) {
      setNextPhase('')
      setError(new Error(`Next episode: ${errorText(err)}`))
    }
  }, [state, next, preferred.quality, navigate])

  const showUpNext = Boolean(next) && !nextDismissed && remaining <= UP_NEXT_LEAD && duration > 60

  useEffect(() => {
    if (showUpNext && autoNext && countdown === null && !nextPhase) setCountdown(COUNTDOWN)
  }, [showUpNext, autoNext, countdown, nextPhase])

  // Seeking back out of the last stretch calls the countdown off.
  useEffect(() => {
    if (!showUpNext && countdown !== null && !nextPhase) setCountdown(null)
  }, [showUpNext, countdown, nextPhase])

  useEffect(() => {
    if (countdown === null) return
    if (countdown <= 0) {
      goNext()
      return
    }
    const id = window.setTimeout(() => setCountdown((c) => (c === null ? null : c - 1)), 1000)
    return () => window.clearTimeout(id)
  }, [countdown, goNext])

  // -------------------------------------------------------------- subtitles
  useEffect(() => {
    if (!state) return
    window.api.addons
      .subtitles(state.meta.type, state.streamId)
      .then((list) => {
        // Preferred language first, then the rest in the order addons sent them.
        const lang = preferred.lang.toLowerCase()
        setSubs([...list].sort((a, b) => Number(b.lang.toLowerCase() === lang) - Number(a.lang.toLowerCase() === lang)))
      })
      .catch(() => undefined)
  }, [state, preferred.lang])

  const chooseSubtitle = async (track: SubtitleTrack | null): Promise<void> => {
    if (subUrl) URL.revokeObjectURL(subUrl)
    setSubId(track?.id ?? null)
    if (!track) {
      setSubUrl(null)
      return
    }
    setLastSub(track)
    try {
      const vtt = await window.api.addons.subtitleVtt(track.url)
      setSubUrl(URL.createObjectURL(new Blob([vtt], { type: 'text/vtt' })))
    } catch (err) {
      setSubId(null)
      setError(err)
    }
  }

  // Cue times are rewritten in place, keeping the originals so delay changes
  // stay exact. A live stream restarts its clock at the seek offset, so cues
  // are shifted back by that offset too — otherwise they drift by it.
  const originals = useRef(new WeakMap<TextTrackCue, [number, number]>())
  const shift = subDelay - (isLive ? offset ?? 0 : 0)
  const applyShift = useCallback(() => {
    const video = videoRef.current
    if (!video) return
    for (const t of Array.from(video.textTracks)) {
      t.mode = subUrl ? 'showing' : 'disabled'
      for (const cue of Array.from(t.cues ?? [])) {
        let orig = originals.current.get(cue)
        if (!orig) {
          orig = [cue.startTime, cue.endTime]
          originals.current.set(cue, orig)
        }
        cue.startTime = Math.max(0, orig[0] + shift)
        cue.endTime = Math.max(0, orig[1] + shift)
      }
    }
  }, [shift, subUrl])

  useEffect(() => {
    const timer = window.setTimeout(applyShift, 120)
    return () => window.clearTimeout(timer)
  }, [applyShift])

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

  const togglePip = useCallback(async () => {
    const video = videoRef.current
    if (!video || !document.pictureInPictureEnabled) return
    if (document.pictureInPictureElement) await document.exitPictureInPicture().catch(() => undefined)
    else await video.requestPictureInPicture().catch(() => undefined)
  }, [])

  const stepSpeed = useCallback((dir: 1 | -1) => {
    setSpeed((s) => SPEEDS[Math.max(0, Math.min(SPEEDS.length - 1, SPEEDS.indexOf(s) + dir))] ?? 1)
  }, [])

  const toggleSubs = useRef<() => void>(() => undefined)
  toggleSubs.current = () => {
    if (subId) chooseSubtitle(null)
    else if (lastSub) chooseSubtitle(lastSub)
    else if (subs[0]) chooseSubtitle(subs[0])
  }

  useEffect(() => {
    const onChange = (): void => setFullscreen(Boolean(document.fullscreenElement))
    document.addEventListener('fullscreenchange', onChange)
    return () => document.removeEventListener('fullscreenchange', onChange)
  }, [])

  const goNextRef = useRef(goNext)
  goNextRef.current = goNext

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
          else if (panel) setPanel(null)
          else navigate(-1)
          break
        case ' ':
        case 'k':
          e.preventDefault()
          togglePlay()
          break
        case 'ArrowRight':
        case 'l':
          seekTo(latest.current + 10)
          break
        case 'ArrowLeft':
        case 'j':
          seekTo(latest.current - 10)
          break
        case 'ArrowUp':
          e.preventDefault()
          setMuted(false)
          setVolume((v) => Math.min(1, v + 0.1))
          break
        case 'ArrowDown':
          e.preventDefault()
          setVolume((v) => Math.max(0, v - 0.1))
          break
        case 'f':
          toggleFullscreen()
          break
        case 'm':
          setMuted((m) => !m)
          break
        case 'c':
          toggleSubs.current()
          break
        case 'p':
          togglePip()
          break
        case '<':
        case ',':
          stepSpeed(-1)
          break
        case '>':
        case '.':
          stepSpeed(1)
          break
        case 'n':
          goNextRef.current()
          break
        case '?':
          setPanel((p) => (p === 'help' ? null : 'help'))
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
  }, [navigate, seekTo, togglePlay, toggleFullscreen, togglePip, stepSpeed, panel])

  useEffect(() => {
    const video = videoRef.current
    if (!video) return
    video.volume = volume
    video.muted = muted
    video.playbackRate = speed
  }, [volume, muted, speed, src])

  if (!state || !plan) return <div />

  const ratioAt = (e: React.PointerEvent<HTMLDivElement>): number => {
    const rect = e.currentTarget.getBoundingClientRect()
    return Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width))
  }

  const onScrubMove = (e: React.PointerEvent<HTMLDivElement>): void => {
    const rect = e.currentTarget.getBoundingClientRect()
    const ratio = ratioAt(e)
    setHover({ x: ratio * rect.width, t: ratio * duration })
  }

  const buffering = waiting && !paused
  const pct = duration ? Math.min(100, (displayTime / duration) * 100) : 0
  const bufPct = duration && !isLive ? Math.min(100, (buffered / duration) * 100) : 0
  const pipOk = typeof document !== 'undefined' && document.pictureInPictureEnabled
  const subPx = SUB_SIZES.find((s) => s.id === subSize)?.px ?? 30
  const controlsOn = overlay || paused || panel !== null

  return (
    <div
      className={'player' + (controlsOn ? '' : ' idle')}
      ref={shellRef}
      style={{ '--sub-size': `${subPx}px` } as React.CSSProperties}
    >
      {src && (
        <video
          ref={videoRef}
          src={src}
          autoPlay
          onClick={() => (panel ? setPanel(null) : togglePlay())}
          onDoubleClick={toggleFullscreen}
          onLoadedMetadata={() => {
            const video = videoRef.current
            if (!video) return
            if (!isLive && offset && offset > 10) video.currentTime = offset
            video.playbackRate = speed
            video.play().catch(() => undefined)
          }}
          onTimeUpdate={() => setLocalTime(videoRef.current?.currentTime ?? 0)}
          onProgress={() => {
            const video = videoRef.current
            if (!video || !video.buffered.length) return
            setBuffered(video.buffered.end(video.buffered.length - 1))
          }}
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
            if (next && !nextDismissed) goNext()
            else navigate(-1)
          }}
          onError={() =>
            setError(
              new Error(
                isWeb()
                  ? 'Your browser could not play this file. Try another source, or pair the desktop app so it can convert it.'
                  : 'This file failed to play. Try another source, or open it in an external player.'
              )
            )
          }
        >
          {subUrl && (
            <track ref={trackRef} key={subUrl} kind="subtitles" src={subUrl} label="Subtitles" default onLoad={applyShift} />
          )}
        </video>
      )}

      <div className="player-top">
        <button className="round-btn glass" onClick={() => navigate(-1)} aria-label="Back">
          <Icon name="back" size={18} />
        </button>
        <div className="player-heading">
          <div className="player-title">{state.meta.name}</div>
          {state.season !== undefined && (
            <div className="player-sub">{state.title.slice(state.meta.name.length + 3)}</div>
          )}
        </div>
        <span className="tag-pill glass" title={plan.reason}>
          {plan.mode === 'direct' ? 'Direct play' : plan.mode === 'remux' ? 'Repackaging' : 'Converting'}
        </span>
      </div>

      <div className="controls">
        <div
          className="scrub"
          onPointerDown={(e) => seekTo(ratioAt(e) * duration)}
          onPointerMove={onScrubMove}
          onPointerLeave={() => setHover(null)}
        >
          <div className="scrub-track">
            <div className="scrub-buffer" style={{ width: `${bufPct}%` }} />
            <div className="scrub-fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="scrub-knob" style={{ left: `${pct}%` }} />
          {hover && duration > 0 && (
            <span className="scrub-hover" style={{ left: hover.x }}>
              {humanTime(hover.t)}
            </span>
          )}
        </div>

        <div className="controls-row">
          <button className="ctrl big" onClick={togglePlay} title="Play / pause (space)">
            <Icon name={paused ? 'play' : 'pause'} size={24} />
          </button>
          <button className="ctrl" onClick={() => seekTo(displayTime - 10)} title="Back 10s (←)">
            <Icon name="rewind" size={21} />
          </button>
          <button className="ctrl" onClick={() => seekTo(displayTime + 10)} title="Forward 10s (→)">
            <Icon name="forward" size={21} />
          </button>
          {next && (
            <button className="ctrl" onClick={goNext} title="Next episode (N)">
              <Icon name="next" size={20} />
            </button>
          )}
          <div className="volume-group">
            <button className="ctrl" onClick={() => setMuted(!muted)} title="Mute (M)">
              <Icon name={muted || volume === 0 ? 'mute' : 'volume'} size={21} />
            </button>
            <input
              className="volume"
              type="range"
              min={0}
              max={1}
              step={0.05}
              value={muted ? 0 : volume}
              style={{ '--fill': `${(muted ? 0 : volume) * 100}%` } as React.CSSProperties}
              onChange={(e) => {
                setVolume(Number(e.target.value))
                setMuted(false)
              }}
            />
          </div>
          <span className="time">
            {humanTime(displayTime)} <span className="time-sep">/</span> {humanTime(duration)}
          </span>

          <div className="spacer" />

          {stats && (
            <span className="stat-line">
              <span>{stats.peers} peers</span>
              <span>{humanBytes(stats.downloadSpeed)}/s</span>
            </span>
          )}

          <div className="ctrl-pop">
            <button
              className={'ctrl' + (speed !== 1 ? ' on' : '')}
              onClick={() => setPanel(panel === 'speed' ? null : 'speed')}
              title="Playback speed"
            >
              {speed === 1 ? <Icon name="gauge" size={21} /> : <span className="ctrl-text">{speed}×</span>}
            </button>
            {panel === 'speed' && (
              <div className="pop">
                <div className="pop-title">Speed</div>
                {SPEEDS.map((s) => (
                  <button key={s} className={'pop-item' + (s === speed ? ' on' : '')} onClick={() => setSpeed(s)}>
                    {s === 1 ? 'Normal' : `${s}×`}
                    {s === speed && <Icon name="check" size={15} />}
                  </button>
                ))}
              </div>
            )}
          </div>

          <div className="ctrl-pop">
            <button
              className={'ctrl' + (subId ? ' on' : '')}
              onClick={() => setPanel(panel === 'subs' ? null : 'subs')}
              title="Subtitles (C)"
            >
              <Icon name="subtitles" size={21} />
            </button>
            {panel === 'subs' && (
              <div className="pop wide">
                <div className="pop-title">Subtitles</div>
                <div className="pop-scroll">
                  <button className={'pop-item' + (!subId ? ' on' : '')} onClick={() => chooseSubtitle(null)}>
                    Off {!subId && <Icon name="check" size={15} />}
                  </button>
                  {subs.length === 0 && <div className="pop-note">No subtitles from your addons for this one.</div>}
                  {subs.slice(0, 80).map((s) => (
                    <button key={s.id} className={'pop-item' + (s.id === subId ? ' on' : '')} onClick={() => chooseSubtitle(s)}>
                      <span>
                        <b className="lang">{s.lang}</b> <span className="pop-dim">{s.addonName}</span>
                      </span>
                      {s.id === subId && <Icon name="check" size={15} />}
                    </button>
                  ))}
                </div>
                <div className="pop-row">
                  <span>Size</span>
                  <div className="mini-seg">
                    {SUB_SIZES.map((s) => (
                      <button key={s.id} className={s.id === subSize ? 'on' : ''} onClick={() => setSubSize(s.id)}>
                        {s.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="pop-row">
                  <span>Delay</span>
                  <div className="mini-seg">
                    <button onClick={() => setSubDelay((d) => +(d - 0.25).toFixed(2))}>−</button>
                    <span className="mini-val">{subDelay > 0 ? '+' : ''}{subDelay.toFixed(2)}s</span>
                    <button onClick={() => setSubDelay((d) => +(d + 0.25).toFixed(2))}>+</button>
                  </div>
                </div>
              </div>
            )}
          </div>

          {pipOk && (
            <button className="ctrl" onClick={togglePip} title="Picture in picture (P)">
              <Icon name="pip" size={21} />
            </button>
          )}
          {!isWeb() && (
            <button
              className="ctrl"
              title="Open in your external player"
              onClick={() => window.api.app.externalPlayer(plan.url, state.title).catch((err) => setError(err))}
            >
              <Icon name="external" size={20} />
            </button>
          )}
          <button className="ctrl" onClick={() => setPanel(panel === 'help' ? null : 'help')} title="Keyboard shortcuts (?)">
            <Icon name="keyboard" size={21} />
          </button>
          <button className="ctrl" onClick={toggleFullscreen} title="Fullscreen (F)">
            <Icon name={fullscreen ? 'exitFullscreen' : 'fullscreen'} size={20} />
          </button>
        </div>
      </div>

      {panel === 'help' && (
        <div className="shortcuts" onClick={() => setPanel(null)}>
          <div className="shortcuts-card" onClick={(e) => e.stopPropagation()}>
            <h3>Keyboard shortcuts</h3>
            <dl>
              {SHORTCUTS.map(([k, v]) => (
                <div key={k}>
                  <dt>{k}</dt>
                  <dd>{v}</dd>
                </div>
              ))}
            </dl>
          </div>
        </div>
      )}

      {(showUpNext || nextPhase) && next && (
        <div className="up-next">
          <div className="up-next-art">
            {next.thumbnail ? <img src={next.thumbnail} alt="" /> : <Icon name="tv" size={28} />}
            {countdown !== null && (
              <svg className="up-next-ring" viewBox="0 0 36 36">
                <circle cx="18" cy="18" r="16" style={{ strokeDashoffset: `${(countdown / COUNTDOWN) * 100.5}` }} />
              </svg>
            )}
          </div>
          <div className="up-next-body">
            <div className="kicker">Up next{countdown !== null ? ` in ${countdown}s` : ''}</div>
            <div className="up-next-title">
              S{next.season} E{next.episode} · {next.title ?? next.name ?? 'Next episode'}
            </div>
            {nextPhase ? (
              <div className="up-next-phase">
                <span className="spinner small" /> {nextPhase}
              </div>
            ) : (
              <div className="btn-row">
                <button className="btn primary" onClick={goNext}>
                  <Icon name="play" size={15} /> Play now
                </button>
                <button
                  className="btn glass"
                  onClick={() => {
                    setCountdown(null)
                    setNextDismissed(true)
                  }}
                >
                  Not now
                </button>
              </div>
            )}
          </div>
        </div>
      )}

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
              {!isWeb() && (
                <button
                  className="btn"
                  onClick={() => window.api.app.externalPlayer(plan.url, state.title).catch((e) => setError(e))}
                >
                  Open in external player
                </button>
              )}
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
