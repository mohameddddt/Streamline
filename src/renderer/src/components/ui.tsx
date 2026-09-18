import { useNavigate } from 'react-router-dom'
import type { MetaPreview } from '../../../shared/types'

export function Spinner(): JSX.Element {
  return (
    <div className="center-pad">
      <div className="spinner" />
    </div>
  )
}

export function ErrorBox({ error }: { error: unknown }): JSX.Element | null {
  if (!error) return null
  const message = error instanceof Error ? error.message : String(error)
  return <div className="error">{message.replace(/^Error invoking remote method '[^']+': /, '')}</div>
}

interface CardProps {
  meta: MetaPreview
  subtitle?: string
  progress?: number
  onClick?: () => void
}

export function MetaCard({ meta, subtitle, progress, onClick }: CardProps): JSX.Element {
  const navigate = useNavigate()
  const go = (): void => {
    if (onClick) onClick()
    else navigate(`/detail/${encodeURIComponent(meta.type)}/${encodeURIComponent(meta.id)}`)
  }
  return (
    <div className="card" onClick={go} title={meta.name}>
      <div className="card-art">
        {meta.poster ? (
          <img src={meta.poster} loading="lazy" alt="" />
        ) : (
          <div className="fallback">{meta.name}</div>
        )}
        {meta.imdbRating && <span className="badge">★ {meta.imdbRating}</span>}
        {progress !== undefined && progress > 0 && (
          <div className="progress-bar">
            <div style={{ width: `${Math.min(100, progress * 100)}%` }} />
          </div>
        )}
      </div>
      <div>
        <div className="card-title">{meta.name}</div>
        <div className="card-sub">{subtitle ?? meta.releaseInfo ?? ''}</div>
      </div>
    </div>
  )
}

export function Row({
  title,
  tag,
  children
}: {
  title: string
  tag?: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <section className="row">
      <div className="row-head">
        <h2>{title}</h2>
        {tag && <span className="tag">{tag}</span>}
      </div>
      <div className="row-scroll">{children}</div>
    </section>
  )
}

export function humanBytes(n: number): string {
  if (!n) return '0 B'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(n) / Math.log(1024)))
  return `${(n / 1024 ** i).toFixed(i === 0 ? 0 : 1)} ${units[i]}`
}

export function humanTime(seconds: number): string {
  if (!isFinite(seconds) || seconds < 0) return '0:00'
  const h = Math.floor(seconds / 3600)
  const m = Math.floor((seconds % 3600) / 60)
  const s = Math.floor(seconds % 60)
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
    : `${m}:${String(s).padStart(2, '0')}`
}
