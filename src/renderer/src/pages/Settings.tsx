import { useCallback, useEffect, useState } from 'react'
import type {
  AddonManifest,
  DebridProvider,
  DeviceAuth,
  Settings,
  TrackerName,
  TrackerStatus,
  UpdateState
} from '../../../shared/types'
import { ErrorBox, Spinner } from '../components/ui'

const DEBRID_OPTIONS: { value: DebridProvider; label: string }[] = [
  { value: 'none', label: 'None (plain torrents)' },
  { value: 'realdebrid', label: 'Real-Debrid' },
  { value: 'alldebrid', label: 'AllDebrid' },
  { value: 'premiumize', label: 'Premiumize' },
  { value: 'torbox', label: 'TorBox' },
  { value: 'debridlink', label: 'Debrid-Link' },
  { value: 'offcloud', label: 'Offcloud' },
  { value: 'easydebrid', label: 'EasyDebrid' },
  { value: 'putio', label: 'put.io' }
]

const SUGGESTED = [
  { name: 'Cinemeta (metadata)', url: 'https://v3-cinemeta.strem.io/manifest.json' },
  { name: 'Torrentio (sources)', url: 'https://torrentio.strem.fun/manifest.json' },
  { name: 'TorrentsDB (sources)', url: 'https://torrentsdb.com/manifest.json' },
  { name: 'OpenSubtitles v3', url: 'https://opensubtitles-v3.strem.io/manifest.json' }
]

export default function SettingsPage(): JSX.Element {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [manifests, setManifests] = useState<AddonManifest[]>([])
  const [newAddon, setNewAddon] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [saved, setSaved] = useState(false)
  const [linked, setLinked] = useState<TrackerStatus>({ trakt: false, simkl: false })
  const [auth, setAuth] = useState<{ name: TrackerName; data: DeviceAuth } | null>(null)
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [exported, setExported] = useState('')

  useEffect(() => {
    window.api.trackers.status().then(setLinked).catch(() => undefined)
    window.api.update.state().then(setUpdate).catch(() => undefined)
    return window.api.update.onState(setUpdate)
  }, [])

  const connect = async (name: TrackerName): Promise<void> => {
    setError(null)
    try {
      const data =
        name === 'trakt'
          ? await window.api.trackers.traktStart()
          : await window.api.trackers.simklStart()
      setAuth({ name, data })
      window.api.app.openExternal(data.verificationUrl).catch(() => undefined)
      // Resolves once the code is approved in the browser.
      if (name === 'trakt') await window.api.trackers.traktPoll(data)
      else await window.api.trackers.simklPoll(data)
      setLinked(await window.api.trackers.status())
    } catch (err) {
      setError(err)
    } finally {
      setAuth(null)
    }
  }

  const disconnect = async (name: TrackerName): Promise<void> => {
    await window.api.trackers.disconnect(name)
    setLinked(await window.api.trackers.status())
  }

  const doExport = async (kind: 'letterboxd' | 'series'): Promise<void> => {
    setError(null)
    try {
      const res = await window.api.trackers.exportCsv(kind)
      if (res) setExported(`Wrote ${res.count} row(s) to ${res.path}`)
    } catch (err) {
      setError(err)
    }
  }

  const refresh = useCallback(async () => {
    setSettings(await window.api.settings.get())
    setManifests(await window.api.addons.manifests())
  }, [])

  useEffect(() => {
    refresh().catch(setError)
  }, [refresh])

  const patch = async (change: Partial<Settings>): Promise<void> => {
    try {
      const next = await window.api.settings.set(change)
      setSettings(next)
      setSaved(true)
      window.setTimeout(() => setSaved(false), 1600)
      setManifests(await window.api.addons.manifests())
    } catch (err) {
      setError(err)
    }
  }

  const addAddon = async (url: string): Promise<void> => {
    const trimmed = url.trim()
    if (!trimmed || !settings) return
    setError(null)
    try {
      await window.api.addons.probe(trimmed) // fail fast on a bad URL
      if (settings.addons.includes(trimmed)) return
      await patch({ addons: [...settings.addons, trimmed] })
      setNewAddon('')
    } catch (err) {
      setError(new Error(`Could not load that addon manifest. ${(err as Error).message}`))
    }
  }

  if (!settings) return <Spinner />

  const nameFor = (url: string): string =>
    manifests.find((m) => m.transportUrl === url)?.name ?? 'Not reachable'

  return (
    <div className="page">
      <h1 style={{ fontSize: 22, marginTop: 0 }}>
        Settings {saved && <span className="chip cached">saved</span>}
      </h1>
      <ErrorBox error={error} />

      <section className="settings-section">
        <h2>Addons</h2>
        <p className="hint">
          Streamline speaks the Stremio addon protocol, so any addon manifest URL works here —
          Torrentio, TorrentsDB, MediaFusion, Comet, Cinemeta, OpenSubtitles. Paste the{' '}
          <code>…/manifest.json</code> URL. If an addon has a configure page, configure it there
          first and paste the personalised URL it gives you.
        </p>
        {settings.addons.map((url) => (
          <div className="addon-item" key={url}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className="a-name">{nameFor(url)}</div>
              <div className="a-url">{url}</div>
            </div>
            <button
              className="icon-btn"
              onClick={() => patch({ addons: settings.addons.filter((a) => a !== url) })}
            >
              Remove
            </button>
          </div>
        ))}
        <div className="inline" style={{ marginTop: 14 }}>
          <input
            placeholder="https://…/manifest.json"
            value={newAddon}
            onChange={(e) => setNewAddon(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && addAddon(newAddon)}
          />
          <button className="btn primary" onClick={() => addAddon(newAddon)}>
            Add
          </button>
        </div>
        <div className="btn-row" style={{ marginTop: 12 }}>
          {SUGGESTED.filter((s) => !settings.addons.includes(s.url)).map((s) => (
            <button key={s.url} className="btn ghost" onClick={() => addAddon(s.url)}>
              + {s.name}
            </button>
          ))}
        </div>
      </section>

      <section className="settings-section">
        <h2>Watch tracking</h2>
        <p className="hint">
          Trakt and Simkl both have free APIs, so Streamline can mark things watched as you play
          them. You need to register a free app on each site to get an ID — it takes a minute, and
          the links below go straight to the right page.
        </p>

        <div className="tracker-row">
          <span className="t-name">Trakt</span>
          <span className={linked.trakt ? 'chip cached' : 'chip'}>
            {linked.trakt ? 'connected' : 'not connected'}
          </span>
          {linked.trakt ? (
            <button className="icon-btn" onClick={() => disconnect('trakt')}>
              Disconnect
            </button>
          ) : (
            <button
              className="btn"
              disabled={!settings.traktClientId || Boolean(auth)}
              onClick={() => connect('trakt')}
            >
              Connect
            </button>
          )}
        </div>
        <div className="field">
          <label>
            Trakt Client ID + Secret — create an app at trakt.tv, with redirect URI
            urn:ietf:wg:oauth:2.0:oob
          </label>
          <div className="inline">
            <input
              placeholder="Client ID"
              defaultValue={settings.traktClientId}
              onBlur={(e) => patch({ traktClientId: e.target.value.trim() })}
            />
            <input
              type="password"
              placeholder="Client Secret"
              defaultValue={settings.traktClientSecret}
              onBlur={(e) => patch({ traktClientSecret: e.target.value.trim() })}
            />
          </div>
          <button
            className="btn ghost"
            style={{ marginTop: 8 }}
            onClick={() => window.api.app.openExternal('https://trakt.tv/oauth/applications/new')}
          >
            Open Trakt app page
          </button>
        </div>

        <div className="tracker-row" style={{ marginTop: 18 }}>
          <span className="t-name">Simkl</span>
          <span className={linked.simkl ? 'chip cached' : 'chip'}>
            {linked.simkl ? 'connected' : 'not connected'}
          </span>
          {linked.simkl ? (
            <button className="icon-btn" onClick={() => disconnect('simkl')}>
              Disconnect
            </button>
          ) : (
            <button
              className="btn"
              disabled={!settings.simklClientId || Boolean(auth)}
              onClick={() => connect('simkl')}
            >
              Connect
            </button>
          )}
        </div>
        <div className="field">
          <label>Simkl Client ID</label>
          <input
            placeholder="Client ID"
            defaultValue={settings.simklClientId}
            onBlur={(e) => patch({ simklClientId: e.target.value.trim() })}
          />
          <button
            className="btn ghost"
            style={{ marginTop: 8 }}
            onClick={() => window.api.app.openExternal('https://simkl.com/settings/developer/')}
          >
            Open Simkl developer page
          </button>
        </div>

        {auth && (
          <div style={{ marginTop: 16 }}>
            <p className="hint" style={{ marginBottom: 0 }}>
              Your browser should have opened {auth.data.verificationUrl}. Enter this code there —
              this page updates by itself once you approve it.
            </p>
            <div className="device-code">{auth.data.userCode}</div>
          </div>
        )}
      </section>

      <section className="settings-section">
        <h2>Letterboxd &amp; Serializd export</h2>
        <p className="hint">
          Letterboxd only grants API access on request, and Serializd has no public API at all, so
          live sync to them is not possible. Instead, export your history as CSV and upload it —
          Letterboxd matches on the IMDb ID column, so films land exactly right.
        </p>
        <div className="btn-row">
          <button className="btn" onClick={() => doExport('letterboxd')}>
            Export films for Letterboxd
          </button>
          <button className="btn" onClick={() => doExport('series')}>
            Export episodes (Serializd)
          </button>
          <button
            className="btn ghost"
            onClick={() => window.api.app.openExternal('https://letterboxd.com/import/')}
          >
            Open Letterboxd importer
          </button>
        </div>
        {exported && (
          <p className="hint" style={{ marginTop: 12, marginBottom: 0, color: 'var(--good)' }}>
            {exported}
          </p>
        )}
      </section>

      <section className="settings-section">
        <h2>Updates</h2>
        <p className="hint">
          Streamline can update itself from GitHub Releases. Until a repo is set under
          <code> build.publish </code> in package.json this stays off, and you update by running a
          newer installer.
        </p>
        <label className="inline" style={{ gap: 10, marginBottom: 14 }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={settings.autoUpdate}
            onChange={(e) => patch({ autoUpdate: e.target.checked })}
          />
          <span>Check for updates on startup</span>
        </label>
        <div className="btn-row">
          <button className="btn" onClick={() => window.api.update.check().then(setUpdate)}>
            Check now
          </button>
          {update?.status === 'ready' && (
            <button className="btn primary" onClick={() => window.api.update.install()}>
              Restart &amp; install {update.version}
            </button>
          )}
        </div>
        {update && (
          <p className="hint" style={{ marginTop: 12, marginBottom: 0 }}>
            {update.status === 'downloading'
              ? `Downloading ${update.version}… ${Math.round(update.progress * 100)}%`
              : update.status === 'current'
                ? 'You are on the latest version.'
                : update.notes || `Status: ${update.status}`}
          </p>
        )}
      </section>

      <section className="settings-section">
        <h2>Debrid — optional, paid</h2>
        <p className="hint">
          Leave this on <strong>None</strong> and everything works over free peer-to-peer
          torrents. It only exists if you ever decide to pay for a debrid service, which swaps
          torrents for direct HTTPS links.
        </p>
        <div className="field">
          <label>Provider</label>
          <select
            value={settings.debridProvider}
            onChange={(e) => patch({ debridProvider: e.target.value as DebridProvider })}
          >
            {DEBRID_OPTIONS.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
        </div>
        {settings.debridProvider !== 'none' && (
          <div className="field">
            <label>API key / token</label>
            <input
              type="password"
              placeholder="paste your API key"
              defaultValue={settings.debridApiKey}
              onBlur={(e) => patch({ debridApiKey: e.target.value.trim() })}
            />
          </div>
        )}
      </section>

      <section className="settings-section">
        <h2>Playback</h2>
        <p className="hint">
          The built-in player handles H.264/AAC in MP4 and MKV. Point Streamline at VLC or mpv to
          cover HEVC, AC3 and DTS releases.
        </p>
        <div className="field">
          <label>External player</label>
          <div className="inline">
            <input
              placeholder="C:\Program Files\VideoLAN\VLC\vlc.exe"
              value={settings.externalPlayerPath}
              onChange={(e) => setSettings({ ...settings, externalPlayerPath: e.target.value })}
              onBlur={(e) => patch({ externalPlayerPath: e.target.value.trim() })}
            />
            <button
              className="btn"
              onClick={async () => {
                const file = await window.api.settings.pickFile()
                if (file) patch({ externalPlayerPath: file })
              }}
            >
              Browse
            </button>
          </div>
        </div>
        <div className="field">
          <label>Preferred subtitle language (3-letter code)</label>
          <input
            defaultValue={settings.preferredLang}
            onBlur={(e) => patch({ preferredLang: e.target.value.trim() })}
          />
        </div>
      </section>

      <section className="settings-section">
        <h2>Downloads &amp; storage</h2>
        <div className="field">
          <label>Downloads folder — saved files live here and are never auto-deleted</label>
          <div className="inline">
            <input value={settings.downloadsPath} readOnly />
            <button
              className="btn"
              onClick={async () => {
                const dir = await window.api.settings.pickFolder()
                if (dir) patch({ downloadsPath: dir })
              }}
            >
              Browse
            </button>
          </div>
        </div>
        <div className="field">
          <label>Streaming cache folder — temporary, for watch-now playback</label>
          <div className="inline">
            <input value={settings.downloadPath} readOnly />
            <button
              className="btn"
              onClick={async () => {
                const dir = await window.api.settings.pickFolder()
                if (dir) patch({ downloadPath: dir })
              }}
            >
              Browse
            </button>
          </div>
        </div>
        <div className="field">
          <label>Max connections per torrent</label>
          <input
            type="number"
            defaultValue={settings.maxConns}
            onBlur={(e) => patch({ maxConns: Number(e.target.value) || 80 })}
          />
        </div>
        <div className="field">
          <label>Upload limit in bytes/s (0 = unlimited)</label>
          <input
            type="number"
            defaultValue={settings.uploadLimit}
            onBlur={(e) => patch({ uploadLimit: Number(e.target.value) || 0 })}
          />
        </div>
        <label className="inline" style={{ gap: 10 }}>
          <input
            type="checkbox"
            style={{ width: 'auto' }}
            checked={settings.deleteOnExit}
            onChange={(e) => patch({ deleteOnExit: e.target.checked })}
          />
          <span>Delete the streaming cache when the app closes (downloads are kept)</span>
        </label>
        <p className="hint" style={{ marginTop: 14, marginBottom: 0 }}>
          Engine changes apply to torrents started after a restart.
        </p>
      </section>
    </div>
  )
}
