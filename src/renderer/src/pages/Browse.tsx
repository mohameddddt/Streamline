import { useEffect, useMemo, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { MetaPreview } from '../../../shared/types'
import type { CatalogRef } from '../../../shared/addons'
import { Empty, ErrorBox, MetaCard, Segmented, SkeletonCards, Spinner } from '../components/ui'
import { browsableCatalogs, catalogItems, typeLabel } from '../lib/discover'

const catKey = (c: CatalogRef): string => `${c.addonUrl}|${c.id}`

/**
 * Every installed catalog, filterable by type, catalog and genre, and paged in
 * as you scroll for catalogs that support it.
 */
export default function Browse(): JSX.Element {
  const [params, setParams] = useSearchParams()
  const [catalogs, setCatalogs] = useState<CatalogRef[] | null>(null)
  const [items, setItems] = useState<MetaPreview[]>([])
  const [loading, setLoading] = useState(false)
  const [done, setDone] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const sentinel = useRef<HTMLDivElement>(null)

  useEffect(() => {
    browsableCatalogs().then(setCatalogs).catch(setError)
  }, [])

  const types = useMemo(() => {
    const seen = new Set<string>()
    for (const c of catalogs ?? []) seen.add(c.type)
    // Films and series first, anything else (channels, tv) after.
    const rank = (t: string): number => {
      const i = ['movie', 'series'].indexOf(t)
      return i < 0 ? 9 : i
    }
    return [...seen].sort((a, b) => rank(a) - rank(b))
  }, [catalogs])

  const type = params.get('type') ?? types[0] ?? 'movie'
  const ofType = (catalogs ?? []).filter((c) => c.type === type)
  const cat = ofType.find((c) => catKey(c) === params.get('cat')) ?? ofType[0]
  const genre = params.get('genre') ?? (cat?.requiresGenre ? cat.genres[0] : '') ?? ''

  const update = (patch: Record<string, string | null>): void => {
    const next = new URLSearchParams(params)
    for (const [k, v] of Object.entries(patch)) {
      if (v === null || v === '') next.delete(k)
      else next.set(k, v)
    }
    setParams(next, { replace: true })
  }

  // Reset and load the first page whenever the selection changes.
  const selection = cat ? `${catKey(cat)}|${type}|${genre}` : ''
  const pageRef = useRef({ selection: '', loading: false })

  const loadMore = async (reset = false): Promise<void> => {
    if (!cat || pageRef.current.loading) return
    const sel = selection
    pageRef.current = { selection: sel, loading: true }
    setLoading(true)
    setError(null)
    try {
      const skip = reset ? 0 : items.length
      const extra: Record<string, string> = {}
      if (genre) extra.genre = genre
      if (skip) extra.skip = String(skip)
      const page = await catalogItems(cat, Object.keys(extra).length ? extra : undefined)
      if (pageRef.current.selection !== sel) return
      setItems((prev) => {
        const base = reset ? [] : prev
        const seen = new Set(base.map((m) => `${m.type}:${m.id}`))
        const fresh = page.filter((m) => !seen.has(`${m.type}:${m.id}`))
        if (!fresh.length || !cat.pageable) setDone(true)
        return [...base, ...fresh]
      })
    } catch (err) {
      setError(err)
      setDone(true)
    } finally {
      if (pageRef.current.selection === sel) {
        pageRef.current.loading = false
        setLoading(false)
      }
    }
  }

  useEffect(() => {
    if (!selection) return
    setItems([])
    setDone(false)
    pageRef.current = { selection: '', loading: false }
    loadMore(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selection])

  useEffect(() => {
    const el = sentinel.current
    if (!el || done) return
    const obs = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting) && items.length > 0) loadMore()
      },
      { rootMargin: '600px' }
    )
    obs.observe(el)
    return () => obs.disconnect()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items.length, done, selection])

  if (!catalogs) return error ? <div className="page"><ErrorBox error={error} /></div> : <Spinner />

  if (catalogs.length === 0) {
    return (
      <div className="page">
        <Empty icon="compass" title="Nothing to browse">
          Install a catalog addon such as Cinemeta in Settings → Addons.
        </Empty>
      </div>
    )
  }

  return (
    <div className="page browse">
      <header className="page-head">
        <div>
          <div className="kicker">Browse</div>
          <h1 className="page-title">{genre ? `${genre} ${typeLabel(type).toLowerCase()}` : typeLabel(type)}</h1>
        </div>
        <Segmented
          options={types.map((t) => ({ id: t, label: typeLabel(t), icon: t === 'movie' ? 'film' : t === 'series' ? 'tv' : undefined }))}
          value={type}
          onChange={(t) => update({ type: t, cat: null, genre: null })}
        />
      </header>

      <div className="filter-bar">
        <div className="filter-label">Catalog</div>
        <div className="chip-row">
          {ofType.map((c) => (
            <button
              key={catKey(c)}
              className={'filter-chip' + (cat && catKey(c) === catKey(cat) ? ' on' : '')}
              onClick={() => update({ cat: catKey(c), genre: null })}
            >
              {c.name}
              {ofType.filter((o) => o.name === c.name).length > 1 && <span className="chip-sub">{c.addonName}</span>}
            </button>
          ))}
        </div>
      </div>

      {cat && cat.genres.length > 0 && (
        <div className="filter-bar">
          <div className="filter-label">{cat.requiresGenre ? 'Pick one' : 'Genre'}</div>
          <div className="chip-row scroll">
            {!cat.requiresGenre && (
              <button className={'filter-chip' + (!genre ? ' on' : '')} onClick={() => update({ genre: null })}>
                All
              </button>
            )}
            {cat.genres.map((g) => (
              <button key={g} className={'filter-chip' + (g === genre ? ' on' : '')} onClick={() => update({ genre: g })}>
                {g}
              </button>
            ))}
          </div>
        </div>
      )}

      {Boolean(error) && (
        <div className="error retry">
          <span>Could not load this catalog — {cat?.addonName ?? 'the addon'} did not answer.</span>
          <button className="btn glass" onClick={() => {
            setDone(false)
            loadMore(items.length === 0)
          }}>
            Try again
          </button>
        </div>
      )}

      <div className="grid">
        {items.map((m) => (
          <MetaCard key={`${m.type}:${m.id}`} meta={m} />
        ))}
        {loading && <SkeletonCards count={items.length ? 6 : 18} />}
      </div>

      {!loading && done && items.length === 0 && !error && (
        <Empty icon="compass" title="Nothing here">
          This catalog has no titles for that filter.
        </Empty>
      )}
      <div ref={sentinel} className="sentinel" />
    </div>
  )
}
