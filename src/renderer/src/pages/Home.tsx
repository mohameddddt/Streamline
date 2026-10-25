import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { LibraryItem, MetaPreview, ProgressEntry } from '../../../shared/types'
import type { CatalogRef } from '../../../shared/addons'
import { Empty, ErrorBox, MetaCard, Row, SkeletonCards, Spinner, WideCard, timeLeft } from '../components/ui'
import { Icon } from '../components/Icon'
import { detailPath, toast } from '../lib/app'
import {
  backdropFor,
  browsableCatalogs,
  catalogItems,
  logoFor,
  surprisePick,
  typeLabel
} from '../lib/discover'

// ------------------------------------------------------------- spotlight

function Spotlight({ items }: { items: MetaPreview[] }): JSX.Element {
  const navigate = useNavigate()
  const [index, setIndex] = useState(0)
  const [paused, setPaused] = useState(false)
  const [logoFailed, setLogoFailed] = useState<Record<string, boolean>>({})
  const [shuffling, setShuffling] = useState(false)

  useEffect(() => {
    if (paused || items.length < 2) return
    const id = window.setTimeout(() => setIndex((i) => (i + 1) % items.length), 9000)
    return () => window.clearTimeout(id)
  }, [index, paused, items.length])

  const current = items[index]
  const logo = current && !logoFailed[current.id] ? logoFor(current) : undefined

  const surprise = async (): Promise<void> => {
    setShuffling(true)
    try {
      const pick = await surprisePick()
      if (pick) navigate(detailPath(pick.type, pick.id))
      else toast('Add a catalog addon to get picks.')
    } catch {
      toast('Could not reach your catalogs.', 'bad')
    } finally {
      setShuffling(false)
    }
  }

  return (
    <section
      className="spotlight"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => setPaused(false)}
    >
      {items.map((m, i) => (
        <div
          key={`${m.type}:${m.id}`}
          className={'spot-bg' + (i === index ? ' on' : '')}
          style={{ backgroundImage: `url(${backdropFor(m)})` }}
        />
      ))}
      <div className="spot-shade" />

      <button className="spot-surprise" onClick={surprise} disabled={shuffling}>
        <Icon name="shuffle" size={16} />
        {shuffling ? 'Picking…' : 'Surprise me'}
      </button>

      {current && (
        <div className="spot-body" key={current.id}>
          <div className="kicker">
            <span className="kicker-dot" /> Spotlight · {current.type === 'series' ? 'Series' : 'Film'}
          </div>
          {logo ? (
            <img
              className="spot-logo"
              src={logo}
              alt={current.name}
              onError={() => setLogoFailed((f) => ({ ...f, [current.id]: true }))}
            />
          ) : (
            <h1 className="spot-title">{current.name}</h1>
          )}
          <div className="meta-line">
            {current.releaseInfo && <span>{current.releaseInfo}</span>}
            {current.imdbRating && (
              <span>
                <Icon name="starFilled" size={12} /> {current.imdbRating}
              </span>
            )}
            {current.genres?.slice(0, 3).map((g) => <span key={g}>{g}</span>)}
          </div>
          {current.description && <p className="spot-desc">{current.description}</p>}
          <div className="btn-row">
            <button
              className="btn primary lg"
              onClick={() => navigate(`${detailPath(current.type, current.id)}?play=1`)}
            >
              <Icon name="play" size={18} /> Watch now
            </button>
            <button className="btn glass lg" onClick={() => navigate(detailPath(current.type, current.id))}>
              More info
            </button>
          </div>
        </div>
      )}

      {items.length > 1 && (
        <div className="spot-dots" role="tablist">
          {items.map((m, i) => (
            <button
              key={m.id}
              className={'spot-dot' + (i === index ? ' on' : '')}
              onClick={() => setIndex(i)}
              aria-label={m.name}
              title={m.name}
            >
              <span style={i === index && !paused ? { animationDuration: '9s' } : undefined} />
            </button>
          ))}
        </div>
      )}
    </section>
  )
}

// --------------------------------------------------------------- shelves

function RankCard({ meta, rank }: { meta: MetaPreview; rank: number }): JSX.Element {
  const navigate = useNavigate()
  return (
    <button className="rank-card" onClick={() => navigate(detailPath(meta.type, meta.id))} title={meta.name}>
      <span className="rank-num">{rank}</span>
      <span className="rank-art">
        {meta.poster ? <img src={meta.poster} alt="" loading="lazy" /> : <span className="fallback">{meta.name}</span>}
      </span>
    </button>
  )
}

function CatalogShelf({ cat, ranked }: { cat: CatalogRef; ranked?: boolean }): JSX.Element | null {
  const navigate = useNavigate()
  const [metas, setMetas] = useState<MetaPreview[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    catalogItems(cat)
      .then((list) => alive && setMetas(list))
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [cat])

  if (failed || (metas && metas.length === 0)) return null

  const browse = (
    <button
      className="link-btn"
      onClick={() =>
        navigate(`/browse?type=${encodeURIComponent(cat.type)}&cat=${encodeURIComponent(`${cat.addonUrl}|${cat.id}`)}`)
      }
    >
      See all
    </button>
  )

  if (ranked) {
    return (
      <Row title={`Top 10 ${typeLabel(cat.type).toLowerCase()} right now`} tag={cat.addonName} action={browse} variant="ranked">
        {metas ? metas.slice(0, 10).map((m, i) => <RankCard key={m.id} meta={m} rank={i + 1} />) : <SkeletonCards count={6} />}
      </Row>
    )
  }

  return (
    <Row title={`${cat.name} ${typeLabel(cat.type).toLowerCase()}`} tag={cat.addonName} action={browse}>
      {metas ? metas.slice(0, 30).map((m) => <MetaCard key={`${m.type}:${m.id}`} meta={m} />) : <SkeletonCards />}
    </Row>
  )
}

// ------------------------------------------------------------------ page

export default function Home(): JSX.Element {
  const navigate = useNavigate()
  const [catalogs, setCatalogs] = useState<CatalogRef[] | null>(null)
  const [spot, setSpot] = useState<MetaPreview[]>([])
  const [resume, setResume] = useState<ProgressEntry[]>([])
  const [saved, setSaved] = useState<LibraryItem[]>([])
  const [error, setError] = useState<unknown>(null)

  const loadLibrary = (): void => {
    window.api.library
      .get()
      .then((lib) => {
        setResume(lib.progress.filter((p) => !p.finished && p.time > 0).slice(0, 20))
        setSaved(lib.items)
      })
      .catch(() => undefined)
  }

  useEffect(() => {
    browsableCatalogs(true)
      .then((list) => setCatalogs(list.filter((c) => !c.requiresGenre)))
      .catch(setError)
    loadLibrary()
  }, [])

  // The spotlight mixes the first film and first series catalogs.
  useEffect(() => {
    if (!catalogs) return
    const picks = ['movie', 'series']
      .map((t) => catalogs.find((c) => c.type === t))
      .filter((c): c is CatalogRef => Boolean(c))
    // Fill in as each list lands, so one slow addon cannot hold the page back.
    let alive = true
    const lists: MetaPreview[][] = picks.map(() => [])
    picks.forEach((c, n) => {
      catalogItems(c)
        .then((list) => {
          if (!alive) return
          lists[n] = list
          const mixed: MetaPreview[] = []
          for (let i = 0; i < 6; i++) for (const l of lists) if (l[i]) mixed.push(l[i])
          setSpot(mixed.slice(0, 6))
        })
        .catch(() => undefined)
    })
    return () => {
      alive = false
    }
  }, [catalogs])

  const genres = useMemo(() => catalogs?.find((c) => c.type === 'movie' && c.genres.length)?.genres ?? [], [catalogs])

  if (error) {
    return (
      <div className="page">
        <ErrorBox error={error} />
      </div>
    )
  }
  if (!catalogs) return <Spinner label="Loading your catalogs…" />

  const [first, ...rest] = catalogs
  const forget = async (p: ProgressEntry): Promise<void> => {
    await window.api.library.clearProgress(p.key)
    toast(`Removed “${p.name}” from Continue watching`)
    loadLibrary()
  }

  return (
    <div className="home">
      {spot.length > 0 ? <Spotlight items={spot} /> : <div className="spotlight placeholder" />}

      <div className="page home-shelves">
        {catalogs.length === 0 && (
          <Empty icon="grid" title="No catalogs yet">
            Add a metadata addon such as Cinemeta in{' '}
            <button className="link-btn" onClick={() => navigate('/settings#addons')}>
              Settings → Addons
            </button>
            .
          </Empty>
        )}

        {resume.length > 0 && (
          <Row title="Pick up where you left off" variant="wide">
            {resume.map((p) => (
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
          </Row>
        )}

        {first && <CatalogShelf cat={first} ranked />}

        {saved.length > 0 && (
          <Row title="Your watchlist" action={<button className="link-btn" onClick={() => navigate('/library?tab=saved')}>Open</button>}>
            {saved.slice(0, 30).map((it) => (
              <MetaCard key={it.key} meta={{ id: it.id, type: it.type, name: it.name, poster: it.poster }} />
            ))}
          </Row>
        )}

        {genres.length > 0 && (
          <section className="row">
            <div className="row-head">
              <h2>Jump into a genre</h2>
            </div>
            <div className="genre-cloud">
              {genres.slice(0, 18).map((g) => (
                <button key={g} className="genre-chip" onClick={() => navigate(`/browse?type=movie&genre=${encodeURIComponent(g)}`)}>
                  {g}
                </button>
              ))}
            </div>
          </section>
        )}

        {rest.slice(0, 13).map((c) => (
          <CatalogShelf key={`${c.addonUrl}|${c.type}|${c.id}`} cat={c} />
        ))}
      </div>
    </div>
  )
}
