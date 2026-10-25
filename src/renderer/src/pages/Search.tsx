import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { MetaPreview } from '../../../shared/types'
import { Empty, ErrorBox, MetaCard, Segmented, SkeletonCards } from '../components/ui'
import { Icon } from '../components/Icon'

type Filter = 'all' | 'movie' | 'series'

export default function Search(): JSX.Element {
  const [params, setParams] = useSearchParams()
  const query = params.get('q') ?? ''
  const [draft, setDraft] = useState(query)
  const [results, setResults] = useState<MetaPreview[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<unknown>(null)
  const [filter, setFilter] = useState<Filter>('all')

  useEffect(() => setDraft(query), [query])

  useEffect(() => {
    if (!query.trim()) {
      setResults(null)
      return
    }
    let alive = true
    setLoading(true)
    setError(null)
    window.api.addons
      .search(query.trim())
      .then((list) => alive && setResults(list))
      .catch((err) => alive && setError(err))
      .finally(() => alive && setLoading(false))
    return () => {
      alive = false
    }
  }, [query])

  const shown = (results ?? []).filter((m) => filter === 'all' || m.type === filter)
  const count = (t: Filter): number =>
    (results ?? []).filter((m) => t === 'all' || m.type === t).length

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <div className="kicker">Search</div>
          <h1 className="page-title">{query ? `“${query}”` : 'Find something'}</h1>
        </div>
        {results && (
          <Segmented
            options={[
              { id: 'all', label: 'All', count: count('all') },
              { id: 'movie', label: 'Films', count: count('movie') },
              { id: 'series', label: 'Series', count: count('series') }
            ]}
            value={filter}
            onChange={setFilter}
          />
        )}
      </header>

      <form
        className="search-field"
        onSubmit={(e) => {
          e.preventDefault()
          setParams(draft.trim() ? { q: draft.trim() } : {})
        }}
      >
        <Icon name="search" size={20} />
        <input
          autoFocus
          placeholder="Search every catalog you have installed…"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
        />
      </form>

      <ErrorBox error={error} />
      {loading && (
        <div className="grid">
          <SkeletonCards count={12} />
        </div>
      )}
      {!loading && results && shown.length === 0 && (
        <Empty icon="search" title={`Nothing found for “${query}”`}>
          Try a different spelling, or install another catalog addon.
        </Empty>
      )}
      {!loading && !results && (
        <Empty icon="search" title="Search all your catalogs">
          Tip: press <kbd>Ctrl</kbd> <kbd>K</kbd> anywhere for instant search.
        </Empty>
      )}
      {!loading && shown.length > 0 && (
        <div className="grid">
          {shown.map((m) => (
            <MetaCard key={`${m.type}:${m.id}`} meta={m} />
          ))}
        </div>
      )}
    </div>
  )
}
