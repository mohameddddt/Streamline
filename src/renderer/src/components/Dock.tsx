import { NavLink } from 'react-router-dom'
import { Icon, type IconName } from './Icon'
import { Logo } from './Logo'

const ITEMS: { to: string; label: string; icon: IconName; end?: boolean }[] = [
  { to: '/', label: 'Home', icon: 'home', end: true },
  { to: '/browse', label: 'Browse', icon: 'compass' },
  { to: '/library', label: 'Library', icon: 'library' },
  { to: '/settings', label: 'Settings', icon: 'settings' }
]

/**
 * Navigation lives in a floating dock at the bottom of the window rather than a
 * sidebar or header, so every page gets the full height for artwork. On narrow
 * screens it becomes a regular tab bar.
 */
export function Dock({ onSearch }: { onSearch: () => void }): JSX.Element {
  const isMac = /mac/i.test(navigator.platform)
  return (
    <nav className="dock" aria-label="Main">
      <NavLink to="/" end className="dock-brand" aria-label="Streamline home">
        <Logo size={30} />
      </NavLink>
      <div className="dock-items">
        {ITEMS.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            end={item.end}
            className={({ isActive }) => 'dock-item' + (isActive ? ' active' : '')}
          >
            <Icon name={item.icon} size={19} />
            <span>{item.label}</span>
          </NavLink>
        ))}
      </div>
      <button className="dock-search" onClick={onSearch}>
        <Icon name="search" size={17} />
        <span className="dock-search-label">Search</span>
        <kbd>{isMac ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
    </nav>
  )
}
