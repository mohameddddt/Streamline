import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { MetaPreview } from '../../../shared/types'
import { detailPath, toast } from '../lib/app'
import { surprisePick } from '../lib/discover'
import { Icon, type IconName } from './Icon'

interface Command {
  id: string
  label: string
  hint?: string
  icon?: IconName
  poster?: string
  run: () => void
}

/**
 * Ctrl/⌘ K (or "/") from anywhere: titles from your own library match as you
 * type, addon search results follow, and app actions sit underneath.
 */
export function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const navigate = useNavigate()
  const [query, setQuery] = useState('')
  const [remote, setRemote] = useState<MetaPreview[]>([])
  const [local, setLocal] = useState<MetaPreview[]>([])
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const listRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    setQuery('')
    setRemote([])
    setActive(0)
    window.setTimeout(() => inputRef.current?.focus(), 10)
    window.api.library
      .get()
      .then((lib) => {
        const seen = new Set<string>()
        const all: MetaPreview[] = []
        for (const x of [...lib.progress, ...lib.items, ...lib.ratings]) {
          const k = `${x.type}:${x.id}`
          if (seen.has(k)) continue
          seen.add(k)
          all.push({ id: x.id, type: x.type, name: x.name, poster: x.poster })
        }
        setLocal(all)
      })
      .catch(() => undefined)
  }, [open])

  // Escape closes it even when focus has wandered off the input.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  const q = query.trim()

  useEffect(() => {
    if (!open || q.length < 2) {
      setRemote([])
      setLoading(false)
      return
    }
    let alive = true
    setLoading(true)
    const timer = window.setTimeout(() => {
      window.api.addons
        .search(q)
        .then((list) => alive && setRemote(list.slice(0, 8)))
        .catch(() => alive && setRemote([]))
        .finally(() => alive && setLoading(false))
    }, 260)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [q, open])

  const go = (path: string): void => {
    onClose()
    navigate(path)
  }

  const commands = useMemo(() => {
    const lower = q.toLowerCase()
    const titleCmd = (m: MetaPreview, hint: string): Command => ({
      id: `t:${m.type}:${m.id}`,
      label: m.name,
      hint,
      poster: m.poster,
      run: () => go(detailPath(m.type, m.id))
    })

    const mine = q
      ? local.filter((m) => m.name.toLowerCase().includes(lower)).slice(0, 4)
      : []
    const mineKeys = new Set(mine.map((m) => `${m.type}:${m.id}`))
    const found = remote.filter((m) => !mineKeys.has(`${m.type}:${m.id}`))

    const actions: Command[] = [
      { id: 'a:home', label: 'Home', icon: 'home', run: () => go('/') },
      { id: 'a:movies', label: 'Browse films', icon: 'film', run: () => go('/browse?type=movie') },
      { id: 'a:series', label: 'Browse series', icon: 'tv', run: () => go('/browse?type=series') },
      { id: 'a:library', label: 'Library', icon: 'library', run: () => go('/library') },
      { id: 'a:insights', label: 'Your stats', icon: 'chart', run: () => go('/library?tab=insights') },
      {
        id: 'a:surprise',
        label: 'Surprise me',
        hint: 'a random pick from your catalogs',
        icon: 'shuffle',
        run: () => {
          onClose()
          surprisePick()
            .then((m) => (m ? navigate(detailPath(m.type, m.id)) : toast('No catalogs to pick from yet.')))
            .catch(() => toast('Could not reach your catalogs.', 'bad'))
        }
      },
      { id: 'a:settings', label: 'Settings', icon: 'settings', run: () => go('/settings') },
      { id: 'a:addons', label: 'Manage addons', icon: 'grid', run: () => go('/settings#addons') }
    ].filter((a) => !q || a.label.toLowerCase().includes(lower))

    const groups: { title: string; items: Command[] }[] = []
    if (mine.length) groups.push({ title: 'In your library', items: mine.map((m) => titleCmd(m, 'library')) })
    if (found.length)
      groups.push({
        title: 'Titles',
        items: found.map((m) => titleCmd(m, [m.releaseInfo, m.type === 'series' ? 'Series' : 'Film'].filter(Boolean).join(' · ')))
      })
    if (q)
      groups.push({
        title: 'Search',
        items: [
          {
            id: 'a:all',
            label: `See all results for “${q}”`,
            icon: 'search',
            run: () => go(`/search?q=${encodeURIComponent(q)}`)
          }
        ]
      })
    if (actions.length) groups.push({ title: 'Go to', items: actions })
    return groups
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [q, local, remote])

  const flat = commands.flatMap((g) => g.items)
  const titleCount = commands
    .filter((g) => g.title === 'Titles' || g.title === 'In your library')
    .reduce((n, g) => n + g.items.length, 0)

  useEffect(() => setActive(0), [q])

  useEffect(() => {
    listRef.current?.querySelector('.cmd-item.active')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  if (!open) return null

  const onKey = (e: React.KeyboardEvent): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setActive((a) => Math.min(flat.length - 1, a + 1))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setActive((a) => Math.max(0, a - 1))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      flat[active]?.run()
    }
  }

  let index = -1
  return (
    <div className="cmd-backdrop" onMouseDown={onClose}>
      <div className="cmd" onMouseDown={(e) => e.stopPropagation()} onKeyDown={onKey} role="dialog" aria-label="Search">
        <div className="cmd-input">
          <Icon name="search" size={20} />
          <input
            ref={inputRef}
            placeholder="Search films, series, or jump anywhere…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          {loading ? <div className="spinner small" /> : <kbd>Esc</kbd>}
        </div>
        <div className="cmd-list" ref={listRef}>
          {commands.map((group) => (
            <div key={group.title} className="cmd-group">
              <div className="cmd-group-title">{group.title}</div>
              {group.items.map((item) => {
                index++
                const i = index
                return (
                  <button
                    key={item.id}
                    className={'cmd-item' + (i === active ? ' active' : '')}
                    onMouseMove={() => setActive(i)}
                    onClick={item.run}
                  >
                    {item.poster ? (
                      <img className="cmd-poster" src={item.poster} alt="" />
                    ) : (
                      <span className="cmd-icon">
                        <Icon name={item.icon ?? 'sparkle'} size={17} />
                      </span>
                    )}
                    <span className="cmd-label">{item.label}</span>
                    {item.hint && <span className="cmd-hint">{item.hint}</span>}
                    <Icon name="chevronRight" size={16} className="cmd-enter" />
                  </button>
                )
              })}
            </div>
          ))}
          {q.length >= 2 && !loading && titleCount === 0 && (
            <div className="cmd-none">Nothing matched “{q}” in your catalogs.</div>
          )}
        </div>
        <div className="cmd-foot">
          <span><kbd>↑</kbd><kbd>↓</kbd> move</span>
          <span><kbd>Enter</kbd> open</span>
          <span><kbd>Esc</kbd> close</span>
        </div>
      </div>
    </div>
  )
}
