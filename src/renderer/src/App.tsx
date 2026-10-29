import { useEffect, useRef, useState } from 'react'
import { Route, Routes, useLocation, useNavigate } from 'react-router-dom'
import Home from './pages/Home'
import Browse from './pages/Browse'
import Search from './pages/Search'
import Detail from './pages/Detail'
import Player from './pages/Player'
import Library from './pages/Library'
import SettingsPage from './pages/Settings'
import { Dock } from './components/Dock'
import { CommandPalette } from './components/CommandPalette'
import { Dialogs, Toasts } from './components/ui'
import { applyAccent, isWeb, useOnline } from './lib/app'
import { Icon } from './components/Icon'

/** Remounts the player for every navigation, so "next episode" starts clean. */
function PlayerRoute(): JSX.Element {
  return <Player key={useLocation().key} />
}

/** Says so when the connection drops, and points at what still works. */
function OfflineBanner(): JSX.Element | null {
  const online = useOnline()
  const navigate = useNavigate()
  const was = useRef(online)
  useEffect(() => {
    // Back online: the addons benched while it was down get asked again.
    if (online && !was.current) window.api.addons.wakeUp().catch(() => undefined)
    was.current = online
  }, [online])
  if (online) return null
  return (
    <div className="offline-banner" role="status">
      <Icon name="globe" size={15} />
      <span>You’re offline — your downloads and files on this computer still play.</span>
      {!isWeb() && (
        <button className="link-btn" onClick={() => navigate('/library?tab=downloads')}>
          Open downloads
        </button>
      )}
    </div>
  )
}

function Shell(): JSX.Element {
  const [palette, setPalette] = useState(false)
  const stage = useRef<HTMLElement>(null)
  const { pathname } = useLocation()

  // Each page starts at the top, like a page load would.
  useEffect(() => {
    stage.current?.scrollTo({ top: 0 })
  }, [pathname])

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      const typing =
        e.target instanceof HTMLInputElement ||
        e.target instanceof HTMLTextAreaElement ||
        e.target instanceof HTMLSelectElement
      if ((e.key === 'k' || e.key === 'K') && (e.ctrlKey || e.metaKey)) {
        e.preventDefault()
        setPalette((p) => !p)
      } else if (e.key === '/' && !typing) {
        e.preventDefault()
        setPalette(true)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  return (
    <div className="shell">
      <OfflineBanner />
      <main className="stage" ref={stage}>
        <Routes>
          <Route path="/" element={<Home />} />
          <Route path="/browse" element={<Browse />} />
          <Route path="/search" element={<Search />} />
          <Route path="/detail/:type/:id" element={<Detail />} />
          <Route path="/library" element={<Library />} />
          <Route path="/settings" element={<SettingsPage />} />
        </Routes>
      </main>
      <Dock onSearch={() => setPalette(true)} />
      <CommandPalette open={palette} onClose={() => setPalette(false)} />
    </div>
  )
}

export default function App(): JSX.Element {
  useEffect(() => {
    document.documentElement.dataset.platform = isWeb() ? 'web' : 'desktop'
    window.api.settings
      .get()
      .then((s) => applyAccent(s.accent))
      .catch(() => applyAccent('volt'))
  }, [])

  return (
    <>
      <Routes>
        <Route path="/player" element={<PlayerRoute />} />
        <Route path="*" element={<Shell />} />
      </Routes>
      <Toasts />
      <Dialogs />
    </>
  )
}
