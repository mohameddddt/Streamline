import { NavLink, Route, Routes } from 'react-router-dom'
import Home from './pages/Home'
import Search from './pages/Search'
import Detail from './pages/Detail'
import Player from './pages/Player'
import Library from './pages/Library'
import SettingsPage from './pages/Settings'

function Sidebar(): JSX.Element {
  const link = ({ isActive }: { isActive: boolean }): string =>
    'nav-item' + (isActive ? ' active' : '')
  return (
    <nav className="sidebar">
      <div className="brand">
        <span className="dot" />
        Streamline
      </div>
      <NavLink to="/" className={link} end>
        Discover
      </NavLink>
      <NavLink to="/search" className={link}>
        Search
      </NavLink>
      <NavLink to="/library" className={link}>
        Library
      </NavLink>
      <NavLink to="/settings" className={link}>
        Settings
      </NavLink>
      <div className="sidebar-foot">
        Streams come from the addons you configure. Only stream content you have the right to
        watch.
      </div>
    </nav>
  )
}

export default function App(): JSX.Element {
  return (
    <Routes>
      <Route path="/player" element={<Player />} />
      <Route
        path="*"
        element={
          <div className="app">
            <Sidebar />
            <main className="content">
              <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/search" element={<Search />} />
                <Route path="/detail/:type/:id" element={<Detail />} />
                <Route path="/library" element={<Library />} />
                <Route path="/settings" element={<SettingsPage />} />
              </Routes>
            </main>
          </div>
        }
      />
    </Routes>
  )
}
