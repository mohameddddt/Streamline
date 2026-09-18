import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import type { MetaPreview } from '../../../shared/types'
import { ErrorBox, MetaCard, Spinner } from '../components/ui'

export default function Search(): JSX.Element {
  const [params, setParams] = useSearchParams()
  const query = params.get('q') ?? ''
  const [draft, setDraft] = useState(query)
  const [results, setResults] = useState<MetaPreview[] | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<unknown>(null)

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

  return (
    <>
      <div className="topbar">
        <form
          className="search-box"
          style={{ flex: 1 }}
          onSubmit={(e) => {
            e.preventDefault()
            setParams(draft.trim() ? { q: draft.trim() } : {})
          }}
        >
          <input
            autoFocus
            placeholder="Search movies and series…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
          />
        </form>
      </div>
      <div className="page" style={{ paddingTop: 6 }}>
        <ErrorBox error={error} />
        {loading && <Spinner />}
        {!loading && results && results.length === 0 && (
          <div className="empty">Nothing found for “{query}”.</div>
        )}
        {!loading && !results && (
          <div className="empty">Type a title to search every catalog you have installed.</div>
        )}
        {!loading && results && results.length > 0 && (
          <div className="grid">
            {results.map((m) => (
              <MetaCard key={`${m.type}:${m.id}`} meta={m} subtitle={m.type} />
            ))}
          </div>
        )}
      </div>
    </>
  )
}
