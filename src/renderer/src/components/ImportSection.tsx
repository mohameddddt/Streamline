import { useEffect, useRef, useState } from 'react'
import { useLocation } from 'react-router-dom'
import type { ImportService, ImportStatus, TrackerStatus } from '../../../shared/types'
import { ErrorBox } from './ui'
import { Icon } from './Icon'

const SERVICES: {
  id: ImportService
  label: string
  help: string
  account?: 'trakt' | 'simkl'
}[] = [
  {
    id: 'letterboxd',
    label: 'Letterboxd',
    help: 'On letterboxd.com go to Settings → Import & Export → Export your data, then choose the ZIP you get by email. Watched films, ratings, diary dates and your watchlist all come across.'
  },
  {
    id: 'serializd',
    label: 'Serializd',
    help: 'Serializd has no export of its own. Use a CSV of your shows and ratings from a browser export extension, or a TV Time export — any CSV with a title column and optionally a rating works.'
  },
  {
    id: 'imdb',
    label: 'IMDb',
    help: 'On imdb.com open Your Ratings (or a list) → ⋯ → Export, and choose the CSV. IMDb ids in the file mean every title matches exactly.'
  },
  {
    id: 'trakt',
    label: 'Trakt account',
    account: 'trakt',
    help: 'Pulls your watched history, ratings and watchlist straight from Trakt. Connect it under Watch tracking first.'
  },
  {
    id: 'simkl',
    label: 'Simkl account',
    account: 'simkl',
    help: 'Pulls your completed titles, ratings and plan-to-watch list from Simkl. Connect it under Watch tracking first.'
  },
  {
    id: 'csv',
    label: 'Any other CSV',
    help: 'Anything with a Title or Name column. Year, Rating, Date and IMDb id columns are picked up when they are there. Ratings out of 5 or 10 are both understood.'
  }
]

export function ImportSection({ linked }: { linked: TrackerStatus }): JSX.Element {
  const [service, setService] = useState<ImportService>('letterboxd')
  const [status, setStatus] = useState<ImportStatus | null>(null)
  const [error, setError] = useState<unknown>(null)
  const [showMissed, setShowMissed] = useState(false)
  const ref = useRef<HTMLElement>(null)
  const { hash } = useLocation()

  const chosen = SERVICES.find((s) => s.id === service) ?? SERVICES[0]
  const running = status?.state === 'running'
  const needsLink = chosen.account !== undefined && !linked[chosen.account]

  useEffect(() => {
    if (hash === '#import') ref.current?.scrollIntoView({ block: 'start' })
  }, [hash])

  useEffect(() => {
    window.api.importer.status().then(setStatus).catch(() => undefined)
  }, [])

  useEffect(() => {
    if (!running) return
    const id = window.setInterval(() => {
      window.api.importer.status().then(setStatus).catch(() => undefined)
    }, 700)
    return () => window.clearInterval(id)
  }, [running])

  const begin = async (): Promise<void> => {
    setError(null)
    setShowMissed(false)
    try {
      let paths: string[] = []
      if (!chosen.account) {
        paths = await window.api.importer.pickFiles()
        if (paths.length === 0) return
      }
      await window.api.importer.start(service, paths)
      setStatus(await window.api.importer.status())
    } catch (err) {
      setError(err)
    }
  }

  const pct = status && status.total > 0 ? Math.round((status.done / status.total) * 100) : 0
  const summary = status?.summary

  return (
    <section className="settings-section" id="import" ref={ref}>
      <h2>
        <span className="section-icon">
          <Icon name="download" size={17} />
        </span>
        Import your history
      </h2>
      <p className="hint">
        Bring films and shows you have already watched, rated or saved into your Streamline
        library. Titles are matched to IMDb, then show up under Library → Watched, Rated and
        Saved, with your own ratings on the posters. Nothing you already have is overwritten.
      </p>
      <ErrorBox error={error} />

      <div className="field">
        <label>Where from</label>
        <select
          value={service}
          disabled={running}
          onChange={(e) => setService(e.target.value as ImportService)}
        >
          {SERVICES.map((s) => (
            <option key={s.id} value={s.id}>
              {s.label}
            </option>
          ))}
        </select>
      </div>
      <p className="hint">{chosen.help}</p>

      <div className="btn-row">
        <button className="btn primary" disabled={running || needsLink} onClick={begin}>
          {chosen.account ? `Import from ${chosen.label.split(' ')[0]}` : 'Choose file(s)…'}
        </button>
        {needsLink && <span className="hint" style={{ margin: 0 }}>Not connected yet.</span>}
      </div>

      {running && status && (
        <div style={{ marginTop: 18 }}>
          <div className="dl-progress">
            <div style={{ width: `${pct}%` }} />
          </div>
          <div className="stat-line">
            <span>{status.phase}</span>
            {status.total > 0 && (
              <span>
                {status.done} / {status.total}
              </span>
            )}
          </div>
        </div>
      )}

      {status?.state === 'error' && <ErrorBox error={new Error(status.error)} />}

      {status?.state === 'done' && summary && (
        <div style={{ marginTop: 18 }}>
          <div className="stat-line" style={{ fontSize: 14, color: 'var(--text)' }}>
            <span>{summary.watched} watched</span>
            <span>{summary.rated} rated</span>
            <span>{summary.watchlist} saved</span>
            <span style={{ color: summary.unmatched.length ? 'var(--warn)' : undefined }}>
              {summary.unmatched.length} not matched
            </span>
          </div>
          {summary.unmatched.length > 0 && (
            <>
              <button
                className="link-btn"
                style={{ marginTop: 10 }}
                onClick={() => setShowMissed(!showMissed)}
              >
                {showMissed ? 'Hide' : 'Show'} titles that were not matched
              </button>
              {showMissed && (
                <ul className="missed">
                  {summary.unmatched.map((t, i) => (
                    <li key={`${t}-${i}`}>{t}</li>
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      )}
    </section>
  )
}
