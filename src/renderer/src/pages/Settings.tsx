import { useCallback, useEffect, useState } from 'react'
import { useLocation } from 'react-router-dom'
import type {
  AddonManifest,
  CompanionInfo,
  DebridProvider,
  DeviceAuth,
  QualityPref,
  Settings,
  TrackerName,
  TrackerStatus,
  UpdateState
} from '../../../shared/types'
import { ACCENTS, APP_VERSION } from '../../../shared/config'
import { ErrorBox, Segmented, Spinner, Toggle } from '../components/ui'
import { Icon, type IconName } from '../components/Icon'
import { ImportSection } from '../components/ImportSection'
import { applyAccent, isWeb, toast } from '../lib/app'

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
  { name: 'Cinemeta', role: 'catalogs & metadata', url: 'https://v3-cinemeta.strem.io/manifest.json' },
  { name: 'Torrentio', role: 'sources', url: 'https://torrentio.strem.fun/manifest.json' },
  { name: 'TorrentsDB', role: 'sources', url: 'https://torrentsdb.com/manifest.json' },
  { name: 'OpenSubtitles v3', role: 'subtitles', url: 'https://opensubtitles-v3.strem.io/manifest.json' }
]

const QUALITY: { id: QualityPref; label: string }[] = [
  { id: '2160p', label: '4K' },
  { id: '1080p', label: '1080p' },
  { id: '720p', label: '720p' },
  { id: 'any', label: 'Highest' }
]

function Section({
  id,
  icon,
  title,
  children
}: {
  id: string
  icon: IconName
  title: string
  children: React.ReactNode
}): JSX.Element {
  return (
    <section className="settings-section" id={id}>
      <h2>
        <span className="section-icon">
          <Icon name={icon} size={17} />
        </span>
        {title}
      </h2>
      {children}
    </section>
  )
}

// ---------------------------------------------------------------- companion

function CompanionSection(): JSX.Element {
  const web = isWeb()
  const [info, setInfo] = useState<CompanionInfo | null>(null)
  const [url, setUrl] = useState('')
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<unknown>(null)

  useEffect(() => {
    window.api.companion
      .info()
      .then((i) => {
        setInfo(i)
        setUrl(i.url)
        setToken(i.token)
      })
      .catch(setError)
  }, [])

  const configure = async (patch: Parameters<typeof window.api.companion.configure>[0]): Promise<void> => {
    setBusy(true)
    setError(null)
    try {
      const next = await window.api.companion.configure(patch)
      setInfo(next)
      if (web) toast(next.connected ? 'Paired with the desktop app' : 'Could not reach the desktop app', next.connected ? 'good' : 'bad')
    } catch (err) {
      setError(err)
    } finally {
      setBusy(false)
    }
  }

  if (!info) return <Spinner />

  if (web) {
    return (
      <>
        <p className="hint">
          Browsers cannot talk to torrent peers, so the web version hands torrents to the Streamline desktop app
          running on this computer. In the desktop app open <b>Settings → Web companion</b>, switch it on and copy the
          token here. Instant (debrid) sources play without it.
        </p>
        <div className={'status-line' + (info.connected ? ' good' : '')}>
          <span className="status-dot" />
          {info.connected
            ? `Paired with Streamline ${info.version ?? ''} on this computer`
            : info.enabled
              ? 'Not reachable — is the desktop app running with Web companion on?'
              : 'Not paired'}
        </div>
        <div className="field">
          <label>Companion address</label>
          <input value={url} onChange={(e) => setUrl(e.target.value)} />
        </div>
        <div className="field">
          <label>Token</label>
          <input type="password" placeholder="paste the token from the desktop app" value={token} onChange={(e) => setToken(e.target.value)} />
        </div>
        <ErrorBox error={error} />
        <div className="btn-row">
          <button className="btn primary" disabled={busy} onClick={() => configure({ url, token })}>
            <Icon name="link" size={16} /> {busy ? 'Connecting…' : 'Pair'}
          </button>
          {info.enabled && (
            <button
              className="btn ghost"
              onClick={() => {
                setToken('')
                configure({ token: '' })
              }}
            >
              Unpair
            </button>
          )}
        </div>
      </>
    )
  }

  return (
    <>
      <p className="hint">
        Lets the Streamline <b>web version</b>, opened in a browser on this computer, play torrents through this
        app&rsquo;s engine. It only listens on this machine (never your network) and every request needs the token
        below, so other websites can&rsquo;t use it.
      </p>
      <Toggle
        checked={info.enabled}
        onChange={(on) => configure({ enabled: on })}
        label="Web companion"
        hint={info.enabled ? `Listening on ${info.url}` : 'Off'}
      />
      {info.error && <div className="error">{info.error}</div>}
      <div className="field">
        <label>Token — paste this into the web version&rsquo;s Settings</label>
        <div className="inline">
          <input readOnly value={info.token} className="mono" />
          <button
            className="btn glass"
            onClick={() =>
              navigator.clipboard
                .writeText(info.token)
                .then(() => toast('Token copied', 'good'))
                .catch(() => toast('Could not copy — select it instead', 'bad'))
            }
          >
            <Icon name="copy" size={15} /> Copy
          </button>
          <button className="btn ghost" disabled={busy} onClick={() => configure({ regenerate: true })} title="Old token stops working">
            New token
          </button>
        </div>
      </div>
      <ErrorBox error={error} />
    </>
  )
}

// --------------------------------------------------------------------- page

export default function SettingsPage(): JSX.Element {
  const web = isWeb()
  const { hash } = useLocation()
  const [settings, setSettings] = useState<Settings | null>(null)
  const [manifests, setManifests] = useState<AddonManifest[]>([])
  const [newAddon, setNewAddon] = useState('')
  const [error, setError] = useState<unknown>(null)
  const [linked, setLinked] = useState<TrackerStatus>({ trakt: false, simkl: false })
  const [auth, setAuth] = useState<{ name: TrackerName; data: DeviceAuth } | null>(null)
  const [update, setUpdate] = useState<UpdateState | null>(null)
  const [exported, setExported] = useState('')
  const [active, setActive] = useState('appearance')

  useEffect(() => {
    window.api.trackers.status().then(setLinked).catch(() => undefined)
    window.api.update.state().then(setUpdate).catch(() => undefined)
    return window.api.update.onState(setUpdate)
  }, [])

  const refresh = useCallback(async () => {
    setSettings(await window.api.settings.get())
    setManifests(await window.api.addons.manifests())
  }, [])

  useEffect(() => {
    refresh().catch(setError)
  }, [refresh])

  // Deep links like #addons land on their section once the page has rendered.
  useEffect(() => {
    if (!settings || !hash || hash === '#import') return
    document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' })
  }, [settings, hash])

  const connect = async (name: TrackerName): Promise<void> => {
    setError(null)
    try {
      const data = name === 'trakt' ? await window.api.trackers.traktStart() : await window.api.trackers.simklStart()
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

  const patch = async (change: Partial<Settings>, quiet = false): Promise<void> => {
    try {
      const next = await window.api.settings.set(change)
      setSettings(next)
      if (!quiet) toast('Saved', 'good')
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
      const manifest = await window.api.addons.probe(trimmed) // fail fast on a bad URL
      if (settings.addons.includes(trimmed)) return
      await patch({ addons: [...settings.addons, trimmed] }, true)
      toast(`Installed ${manifest.name}`, 'good')
      setNewAddon('')
    } catch (err) {
      setError(new Error(`Could not load that addon manifest. ${(err as Error).message}`))
    }
  }

  const moveAddon = (url: string, dir: -1 | 1): void => {
    if (!settings) return
    const list = [...settings.addons]
    const i = list.indexOf(url)
    const j = i + dir
    if (i < 0 || j < 0 || j >= list.length) return
    ;[list[i], list[j]] = [list[j], list[i]]
    patch({ addons: list }, true)
  }

  const backup = async (): Promise<void> => {
    try {
      const res = await window.api.library.backup()
      if (res) toast(`Saved a backup of ${res.count} entries`, 'good')
    } catch (err) {
      setError(err)
    }
  }

  const restore = async (): Promise<void> => {
    try {
      const res = await window.api.library.restore()
      if (res) toast(res.count ? `Restored ${res.count} entries` : 'Already up to date — nothing new in that backup', 'good')
    } catch (err) {
      setError(err)
    }
  }

  if (!settings) return <Spinner />

  const manifestFor = (url: string): AddonManifest | undefined => manifests.find((m) => m.transportUrl === url)

  const nav: { id: string; label: string; icon: IconName; show: boolean }[] = [
    { id: 'appearance', label: 'Look & feel', icon: 'sparkle', show: true },
    { id: 'addons', label: 'Addons', icon: 'grid', show: true },
    { id: 'companion', label: web ? 'Desktop engine' : 'Web companion', icon: 'link', show: true },
    { id: 'library-data', label: 'Library data', icon: 'library', show: true },
    { id: 'import', label: 'Import', icon: 'download', show: !web },
    { id: 'tracking', label: 'Watch tracking', icon: 'check', show: !web },
    { id: 'playback', label: 'Playback', icon: 'play', show: !web },
    { id: 'storage', label: 'Storage', icon: 'folder', show: !web },
    { id: 'debrid', label: 'Debrid', icon: 'bolt', show: true },
    { id: 'about', label: web ? 'About' : 'Updates', icon: 'globe', show: true }
  ]

  return (
    <div className="page settings-page">
      <header className="page-head">
        <div>
          <div className="kicker">Settings</div>
          <h1 className="page-title">Make it yours</h1>
        </div>
      </header>

      <div className="settings-layout">
        <nav className="settings-nav" aria-label="Settings sections">
          {nav
            .filter((n) => n.show)
            .map((n) => (
              <a
                key={n.id}
                href={`#${n.id}`}
                className={'settings-link' + (active === n.id ? ' active' : '')}
                onClick={(e) => {
                  e.preventDefault()
                  setActive(n.id)
                  document.getElementById(n.id)?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                }}
              >
                <Icon name={n.icon} size={16} />
                {n.label}
              </a>
            ))}
        </nav>

        <div className="settings-body">
          <ErrorBox error={error} />

          <Section id="appearance" icon="sparkle" title="Look & feel">
            <div className="field">
              <label>Accent</label>
              <div className="swatches">
                {ACCENTS.map((a) => (
                  <button
                    key={a.id}
                    className={'swatch' + (settings.accent === a.id ? ' on' : '')}
                    style={{ '--swatch': a.color } as React.CSSProperties}
                    onClick={() => {
                      applyAccent(a.id)
                      patch({ accent: a.id }, true)
                    }}
                    aria-label={a.label}
                    title={a.label}
                  >
                    <span />
                    {a.label}
                  </button>
                ))}
              </div>
            </div>
            <div className="field">
              <label>“Play best” aims for</label>
              <Segmented options={QUALITY} value={settings.preferredQuality} onChange={(q) => patch({ preferredQuality: q })} />
              <p className="hint tight">
                Picks the healthiest source at this resolution, favouring ones the built-in player can play without
                converting.
              </p>
            </div>
            <Toggle
              checked={settings.autoplayNext}
              onChange={(v) => patch({ autoplayNext: v })}
              label="Play the next episode automatically"
              hint="Counts down for 10 seconds at the end of an episode, keeping the same release when it can."
            />
            <div className="field">
              <label>Preferred subtitle language (3-letter code, listed first)</label>
              <input defaultValue={settings.preferredLang} onBlur={(e) => patch({ preferredLang: e.target.value.trim() })} />
            </div>
          </Section>

          <Section id="addons" icon="grid" title="Addons">
            <p className="hint">
              Streamline speaks the Stremio addon protocol, so any addon manifest URL works — Torrentio, TorrentsDB,
              MediaFusion, Comet, Cinemeta, OpenSubtitles. If an addon has a configure page, configure it there first and
              paste the personalised URL it gives you. Order matters: earlier addons win for metadata.
            </p>
            <div className="addon-list">
              {settings.addons.map((url, i) => {
                const m = manifestFor(url)
                return (
                  <div className="addon-item" key={url}>
                    <div className="addon-logo">
                      {m?.logo ? <img src={m.logo} alt="" /> : <Icon name="grid" size={18} />}
                    </div>
                    <div className="addon-text">
                      <div className="a-name">
                        {m?.name ?? 'Not reachable'}
                        {m?.version && <span className="a-ver">v{m.version}</span>}
                      </div>
                      <div className="a-desc">{m?.description ?? url}</div>
                    </div>
                    <div className="addon-tools">
                      <button className="icon-btn" disabled={i === 0} onClick={() => moveAddon(url, -1)} aria-label="Move up">
                        <Icon name="chevronLeft" size={15} className="rot90" />
                      </button>
                      <button className="icon-btn" disabled={i === settings.addons.length - 1} onClick={() => moveAddon(url, 1)} aria-label="Move down">
                        <Icon name="chevronRight" size={15} className="rot90" />
                      </button>
                      <button
                        className="icon-btn"
                        onClick={() => patch({ addons: settings.addons.filter((a) => a !== url) }, true)}
                        aria-label="Remove"
                      >
                        <Icon name="trash" size={15} />
                      </button>
                    </div>
                  </div>
                )
              })}
            </div>
            <div className="inline" style={{ marginTop: 14 }}>
              <input
                placeholder="https://…/manifest.json"
                value={newAddon}
                onChange={(e) => setNewAddon(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && addAddon(newAddon)}
              />
              <button className="btn primary" onClick={() => addAddon(newAddon)}>
                <Icon name="plus" size={16} /> Install
              </button>
            </div>
            {SUGGESTED.some((s) => !settings.addons.includes(s.url)) && (
              <div className="chip-row" style={{ marginTop: 12 }}>
                {SUGGESTED.filter((s) => !settings.addons.includes(s.url)).map((s) => (
                  <button key={s.url} className="filter-chip" onClick={() => addAddon(s.url)}>
                    <Icon name="plus" size={13} /> {s.name} <span className="chip-sub">{s.role}</span>
                  </button>
                ))}
              </div>
            )}
          </Section>

          <Section id="companion" icon="link" title={web ? 'Desktop engine' : 'Web companion'}>
            <CompanionSection />
          </Section>

          <Section id="library-data" icon="library" title="Library data">
            <p className="hint">
              Your watchlist, progress and ratings{' '}
              {web ? 'live in this browser.' : 'live on this computer.'} Back them up to a file, or use one to move
              everything between the desktop app and the web version — restoring merges, keeping whichever copy of
              each entry is newer.
            </p>
            <div className="btn-row">
              <button className="btn glass" onClick={backup}>
                <Icon name="download" size={16} /> Save a backup
              </button>
              <button className="btn glass" onClick={restore}>
                <Icon name="folder" size={16} /> Restore from file…
              </button>
            </div>
          </Section>

          {!web && <ImportSection linked={linked} />}

          {!web && (
            <Section id="tracking" icon="check" title="Watch tracking">
              <p className="hint">
                Trakt and Simkl both have free APIs, so Streamline can mark things watched as you play them. Register a
                free app on each site to get an ID — the links below go straight to the right page.
              </p>

              <div className="tracker-row">
                <span className="t-name">Trakt</span>
                <span className={'tag-pill' + (linked.trakt ? ' good' : '')}>{linked.trakt ? 'connected' : 'not connected'}</span>
                {linked.trakt ? (
                  <button className="btn ghost" onClick={() => disconnect('trakt')}>
                    Disconnect
                  </button>
                ) : (
                  <button className="btn glass" disabled={!settings.traktClientId || Boolean(auth)} onClick={() => connect('trakt')}>
                    Connect
                  </button>
                )}
              </div>
              <div className="field">
                <label>Trakt Client ID + Secret — create an app at trakt.tv, with redirect URI urn:ietf:wg:oauth:2.0:oob</label>
                <div className="inline">
                  <input placeholder="Client ID" defaultValue={settings.traktClientId} onBlur={(e) => patch({ traktClientId: e.target.value.trim() }, true)} />
                  <input
                    type="password"
                    placeholder="Client Secret"
                    defaultValue={settings.traktClientSecret}
                    onBlur={(e) => patch({ traktClientSecret: e.target.value.trim() }, true)}
                  />
                </div>
                <button className="link-btn" onClick={() => window.api.app.openExternal('https://trakt.tv/oauth/applications/new')}>
                  Open Trakt app page <Icon name="external" size={13} />
                </button>
              </div>

              <div className="tracker-row">
                <span className="t-name">Simkl</span>
                <span className={'tag-pill' + (linked.simkl ? ' good' : '')}>{linked.simkl ? 'connected' : 'not connected'}</span>
                {linked.simkl ? (
                  <button className="btn ghost" onClick={() => disconnect('simkl')}>
                    Disconnect
                  </button>
                ) : (
                  <button className="btn glass" disabled={!settings.simklClientId || Boolean(auth)} onClick={() => connect('simkl')}>
                    Connect
                  </button>
                )}
              </div>
              <div className="field">
                <label>Simkl Client ID</label>
                <input placeholder="Client ID" defaultValue={settings.simklClientId} onBlur={(e) => patch({ simklClientId: e.target.value.trim() }, true)} />
                <button className="link-btn" onClick={() => window.api.app.openExternal('https://simkl.com/settings/developer/')}>
                  Open Simkl developer page <Icon name="external" size={13} />
                </button>
              </div>

              {auth && (
                <div className="device-auth">
                  <p className="hint tight">
                    Your browser should have opened {auth.data.verificationUrl}. Enter this code there — this page updates
                    by itself once you approve it.
                  </p>
                  <div className="device-code">{auth.data.userCode}</div>
                </div>
              )}

              <h3 className="sub-head">Letterboxd &amp; Serializd export</h3>
              <p className="hint">
                Letterboxd only grants API access on request, and Serializd has no public API, so live sync is not
                possible. Export your history as CSV instead — Letterboxd matches on the IMDb ID column.
              </p>
              <div className="btn-row">
                <button className="btn glass" onClick={() => doExport('letterboxd')}>
                  Export films for Letterboxd
                </button>
                <button className="btn glass" onClick={() => doExport('series')}>
                  Export episodes (Serializd)
                </button>
                <button className="link-btn" onClick={() => window.api.app.openExternal('https://letterboxd.com/import/')}>
                  Open Letterboxd importer <Icon name="external" size={13} />
                </button>
              </div>
              {exported && <p className="hint good-text">{exported}</p>}
            </Section>
          )}

          {!web && (
            <Section id="playback" icon="play" title="Playback">
              <p className="hint">
                The built-in player handles H.264/AAC in MP4 and MKV, and converts the rest on the fly. Point Streamline
                at VLC or mpv to play HEVC, AC3 and DTS releases without converting.
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
                    className="btn glass"
                    onClick={async () => {
                      const file = await window.api.settings.pickFile()
                      if (file) patch({ externalPlayerPath: file })
                    }}
                  >
                    Browse
                  </button>
                </div>
              </div>
            </Section>
          )}

          {!web && (
            <Section id="storage" icon="folder" title="Downloads & storage">
              <div className="field">
                <label>Downloads folder — saved files live here and are never auto-deleted</label>
                <div className="inline">
                  <input value={settings.downloadsPath} readOnly />
                  <button
                    className="btn glass"
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
                    className="btn glass"
                    onClick={async () => {
                      const dir = await window.api.settings.pickFolder()
                      if (dir) patch({ downloadPath: dir })
                    }}
                  >
                    Browse
                  </button>
                </div>
              </div>
              <div className="field-pair">
                <div className="field">
                  <label>Max connections per torrent</label>
                  <input type="number" defaultValue={settings.maxConns} onBlur={(e) => patch({ maxConns: Number(e.target.value) || 80 })} />
                </div>
                <div className="field">
                  <label>Upload limit in bytes/s (0 = unlimited)</label>
                  <input type="number" defaultValue={settings.uploadLimit} onBlur={(e) => patch({ uploadLimit: Number(e.target.value) || 0 })} />
                </div>
              </div>
              <Toggle
                checked={settings.deleteOnExit}
                onChange={(v) => patch({ deleteOnExit: v })}
                label="Clear the streaming cache when the app closes"
                hint="Downloads are always kept. Engine changes apply after a restart."
              />
            </Section>
          )}

          <Section id="debrid" icon="bolt" title="Debrid — optional, paid">
            <p className="hint">
              Leave this on <strong>None</strong> and everything works over free peer-to-peer torrents
              {web ? ' (through the paired desktop app)' : ''}. A debrid service swaps torrents for direct HTTPS links that
              start instantly{web ? ' and play right in the browser' : ''}.
            </p>
            <div className="field">
              <label>Provider</label>
              <select value={settings.debridProvider} onChange={(e) => patch({ debridProvider: e.target.value as DebridProvider })}>
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
                <input type="password" placeholder="paste your API key" defaultValue={settings.debridApiKey} onBlur={(e) => patch({ debridApiKey: e.target.value.trim() })} />
              </div>
            )}
          </Section>

          <Section id="about" icon="globe" title={web ? 'About' : 'Updates'}>
            {web ? (
              <p className="hint">
                Streamline web {APP_VERSION}. Everything here runs in your browser; the only servers it talks to are the
                addons you installed{' '}
                and, when paired, the desktop app on this computer. Only stream content you have the right to watch.
              </p>
            ) : (
              <>
                <p className="hint">
                  Streamline {APP_VERSION} updates itself from GitHub Releases. Only stream content you have the right to
                  watch.
                </p>
                <Toggle checked={settings.autoUpdate} onChange={(v) => patch({ autoUpdate: v })} label="Check for updates on startup" />
                <div className="btn-row">
                  <button className="btn glass" onClick={() => window.api.update.check().then(setUpdate)}>
                    Check now
                  </button>
                  {update?.status === 'ready' && (
                    <button className="btn primary" onClick={() => window.api.update.install()}>
                      Restart &amp; install {update.version}
                    </button>
                  )}
                </div>
                {update && (
                  <p className="hint tight">
                    {update.status === 'downloading'
                      ? `Downloading ${update.version}… ${Math.round(update.progress * 100)}%`
                      : update.status === 'current'
                        ? 'You are on the latest version.'
                        : update.notes || `Status: ${update.status}`}
                  </p>
                )}
              </>
            )}
          </Section>
        </div>
      </div>
    </div>
  )
}
