import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { MetaPreview, ProgressEntry } from '../../../shared/types'
import { ErrorBox, MetaCard, Row, Spinner } from '../components/ui'

interface CatalogRef {
  addonUrl: string
  addonName: string
  type: string
  id: string
  name: string
  requiresSearch: boolean
}

function CatalogRow({ cat }: { cat: CatalogRef }): JSX.Element | null {
  const [metas, setMetas] = useState<MetaPreview[] | null>(null)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let alive = true
    window.api.addons
      .catalog(cat.addonUrl, cat.type, cat.id)
      .then((list) => alive && setMetas(list))
      .catch(() => alive && setFailed(true))
    return () => {
      alive = false
    }
  }, [cat.addonUrl, cat.type, cat.id])

  if (failed || (metas && metas.length === 0)) return null

  const label = `${cat.name}${/movie|series/i.test(cat.name) ? '' : ` · ${cat.type}`}`
  return (
    <Row title={label} tag={cat.addonName}>
      {metas
        ? metas.slice(0, 30).map((m) => <MetaCard key={`${m.type}:${m.id}`} meta={m} />)
        : Array.from({ length: 7 }, (_, i) => (
            <div key={i} className="card">
              <div className="card-art" />
            </div>
          ))}
    </Row>
  )
}

export default function Home(): JSX.Element {
  const navigate = useNavigate()
  const [catalogs, setCatalogs] = useState<CatalogRef[] | null>(null)
  const [resume, setResume] = useState<ProgressEntry[]>([])
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    window.api.addons
      .catalogs()
      .then((list) => setCatalogs(list.filter((c) => !c.requiresSearch)))
      .catch(setError)
    window.api.library
      .get()
      .then((lib) => setResume(lib.progress.filter((p) => !p.finished).slice(0, 20)))
      .catch(() => undefined)
  }, [])

  if (error) {
    return (
      <div className="page">
        <ErrorBox error={error} />
      </div>
    )
  }
  if (!catalogs) return <Spinner />

  return (
    <div className="page">
      {resume.length > 0 && (
        <Row title="Continue watching">
          {resume.map((p) => (
            <MetaCard
              key={p.key}
              meta={{ id: p.id, type: p.type, name: p.name, poster: p.poster }}
              subtitle={
                p.season !== undefined ? `S${p.season}E${p.episode}` : `${Math.round(
                  (p.time / Math.max(1, p.duration)) * 100
                )}% watched`
              }
              progress={p.duration ? p.time / p.duration : 0}
              onClick={() =>
                navigate(`/detail/${encodeURIComponent(p.type)}/${encodeURIComponent(p.id)}`)
              }
            />
          ))}
        </Row>
      )}

      {catalogs.length === 0 && (
        <div className="empty">
          No catalogs available. Add a metadata addon (like Cinemeta) in Settings.
        </div>
      )}

      {catalogs.slice(0, 14).map((c) => (
        <CatalogRow key={`${c.addonUrl}|${c.type}|${c.id}`} cat={c} />
      ))}
    </div>
  )
}
