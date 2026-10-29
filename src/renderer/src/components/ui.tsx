import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import type { MetaPreview } from '../../../shared/types'
import { createPortal } from 'react-dom'
import { detailPath, errorText, onDialog, onToast, type DialogRequest, type ToastMessage } from '../lib/app'
import { Icon, type IconName } from './Icon'

export function Spinner({ label }: { label?: string }): JSX.Element {
  return (
    <div className="center-pad">
      <div className="spinner" />
      {label && <div className="spinner-label">{label}</div>}
    </div>
  )
}

export function ErrorBox({ error }: { error: unknown }): JSX.Element | null {
  if (!error) return null
  return <div className="error">{errorText(error)}</div>
}

export function Empty({
  icon = 'sparkle',
  title,
  children
}: {
  icon?: IconName
  title: string
  children?: React.ReactNode
}): JSX.Element {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Icon name={icon} size={22} />
      </div>
      <div className="empty-title">{title}</div>
      {children && <div className="empty-body">{children}</div>}
    </div>
  )
}

// ------------------------------------------------------------------ cards

interface CardProps {
  meta: MetaPreview
  subtitle?: string
  progress?: number
  /** The user's own rating, 0-10. */
  rating?: number
  onClick?: () => void
}

/** Portrait poster card. Details slide up over the art on hover. */
export function MetaCard({ meta, subtitle, progress, rating, onClick }: CardProps): JSX.Element {
  const navigate = useNavigate()
  const go = (): void => (onClick ? onClick() : navigate(detailPath(meta.type, meta.id)))
  const sub = subtitle ?? [meta.releaseInfo, meta.type === 'series' ? 'Series' : ''].filter(Boolean).join(' · ')
  // Offline, or an artwork host that lost the image: show the name, not a broken icon.
  const [broken, setBroken] = useState(false)
  useEffect(() => setBroken(false), [meta.poster])
  return (
    <button className="card" onClick={go} title={meta.name}>
      <div className="card-art">
        {meta.poster && !broken ? (
          <img src={meta.poster} loading="lazy" alt="" onError={() => setBroken(true)} />
        ) : (
          <div className="fallback">{meta.name}</div>
        )}
        {rating !== undefined && (
          <span className="badge mine">
            <Icon name="starFilled" size={11} /> {rating}
          </span>
        )}
        {rating === undefined && meta.imdbRating && (
          <span className="badge">
            <Icon name="starFilled" size={11} /> {meta.imdbRating}
          </span>
        )}
        {progress !== undefined && progress > 0 && (
          <div className="progress-bar">
            <div style={{ width: `${Math.min(100, progress * 100)}%` }} />
          </div>
        )}
        <div className="card-hover">
          <span className="card-play">
            <Icon name="play" size={16} />
          </span>
        </div>
      </div>
      <div className="card-title">{meta.name}</div>
      <div className="card-sub">{sub}</div>
    </button>
  )
}

/** Landscape card for things in progress: backdrop, progress, what is left. */
export function WideCard({
  title,
  kicker,
  image,
  fallbackImage,
  progress,
  meta,
  onClick,
  onRemove
}: {
  title: string
  kicker: string
  image?: string
  /** Used when `image` fails to load (artwork services miss some titles). */
  fallbackImage?: string
  progress: number
  meta?: string
  onClick: () => void
  onRemove?: () => void
}): JSX.Element {
  const [src, setSrc] = useState(image)
  useEffect(() => setSrc(image), [image])
  return (
    <div className="wide-card">
      <button className="wide-art" onClick={onClick}>
        {src ? (
          <img
            src={src}
            alt=""
            loading="lazy"
            onError={() => setSrc(src !== fallbackImage ? fallbackImage : undefined)}
          />
        ) : (
          <div className="fallback">{title}</div>
        )}
        <span className="wide-play">
          <Icon name="play" size={18} />
        </span>
        <div className="progress-bar">
          <div style={{ width: `${Math.min(100, progress * 100)}%` }} />
        </div>
      </button>
      <div className="wide-body">
        <div className="wide-kicker">{kicker}</div>
        <div className="wide-title">{title}</div>
        {meta && <div className="wide-meta">{meta}</div>}
      </div>
      {onRemove && (
        <button className="wide-remove" title="Remove from this list" onClick={onRemove}>
          <Icon name="close" size={14} />
        </button>
      )}
    </div>
  )
}

/** A horizontally scrolling shelf with arrow buttons that page through it. */
export function Row({
  title,
  tag,
  action,
  children,
  variant
}: {
  title: string
  tag?: string
  action?: React.ReactNode
  children: React.ReactNode
  variant?: 'wide' | 'ranked'
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [edges, setEdges] = useState({ start: true, end: false })

  const update = (): void => {
    const el = ref.current
    if (!el) return
    setEdges({
      start: el.scrollLeft < 8,
      end: el.scrollLeft + el.clientWidth > el.scrollWidth - 8
    })
  }

  useEffect(update, [children])

  const page = (dir: 1 | -1): void => {
    const el = ref.current
    if (el) el.scrollBy({ left: dir * el.clientWidth * 0.85, behavior: 'smooth' })
  }

  return (
    <section className={'row' + (variant ? ` row-${variant}` : '')}>
      <div className="row-head">
        <h2>{title}</h2>
        {tag && <span className="tag">{tag}</span>}
        <div className="row-tools">
          {action}
          <button className="round-btn" disabled={edges.start} onClick={() => page(-1)} aria-label="Scroll left">
            <Icon name="chevronLeft" size={18} />
          </button>
          <button className="round-btn" disabled={edges.end} onClick={() => page(1)} aria-label="Scroll right">
            <Icon name="chevronRight" size={18} />
          </button>
        </div>
      </div>
      <div className="row-scroll" ref={ref} onScroll={update}>
        {children}
      </div>
    </section>
  )
}

export function SkeletonCards({ count = 7 }: { count?: number }): JSX.Element {
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="card skeleton">
          <div className="card-art" />
          <div className="skeleton-line" />
        </div>
      ))}
    </>
  )
}

// ---------------------------------------------------------------- controls

/** Ten-point rating as five stars, each half a star apart. */
export function Stars({
  value,
  onChange
}: {
  value: number | null
  onChange: (v: number | null) => void
}): JSX.Element {
  const [hover, setHover] = useState<number | null>(null)
  const shown = hover ?? value ?? 0
  return (
    <div className="stars" onMouseLeave={() => setHover(null)}>
      {Array.from({ length: 5 }, (_, i) => {
        const full = shown >= (i + 1) * 2
        const half = !full && shown >= i * 2 + 1
        return (
          <span key={i} className="star-slot">
            <Icon name={full || half ? 'starFilled' : 'star'} size={22} className={half ? 'half' : ''} />
            <button
              className="star-hit left"
              aria-label={`${i * 2 + 1} out of 10`}
              onMouseEnter={() => setHover(i * 2 + 1)}
              onClick={() => onChange(value === i * 2 + 1 ? null : i * 2 + 1)}
            />
            <button
              className="star-hit right"
              aria-label={`${i * 2 + 2} out of 10`}
              onMouseEnter={() => setHover(i * 2 + 2)}
              onClick={() => onChange(value === i * 2 + 2 ? null : i * 2 + 2)}
            />
          </span>
        )
      })}
      <span className="stars-value">{shown ? `${shown}/10` : 'Rate it'}</span>
    </div>
  )
}

export function Segmented<T extends string>({
  options,
  value,
  onChange
}: {
  options: { id: T; label: string; count?: number; icon?: IconName }[]
  value: T
  onChange: (v: T) => void
}): JSX.Element {
  return (
    <div className="segmented" role="tablist">
      {options.map((o) => (
        <button
          key={o.id}
          role="tab"
          aria-selected={o.id === value}
          className={'seg' + (o.id === value ? ' active' : '')}
          onClick={() => onChange(o.id)}
        >
          {o.icon && <Icon name={o.icon} size={16} />}
          {o.label}
          {o.count !== undefined && o.count > 0 && <span className="count">{o.count}</span>}
        </button>
      ))}
    </div>
  )
}

export function Toggle({
  checked,
  onChange,
  label,
  hint
}: {
  checked: boolean
  onChange: (v: boolean) => void
  label: string
  hint?: string
}): JSX.Element {
  return (
    <label className="toggle-row">
      <span className="toggle-text">
        <span>{label}</span>
        {hint && <span className="hint">{hint}</span>}
      </span>
      <input type="checkbox" className="toggle" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  )
}

export function Toasts(): JSX.Element {
  const [items, setItems] = useState<ToastMessage[]>([])
  useEffect(
    () =>
      onToast((t) => {
        setItems((prev) => [...prev.slice(-2), t])
        window.setTimeout(() => setItems((prev) => prev.filter((p) => p.id !== t.id)), 3200)
      }),
    []
  )
  return (
    <div className="toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.id} className={`toast ${t.tone}`}>
          {t.text}
        </div>
      ))}
    </div>
  )
}

/** Hosts the dialogs `ask()` opens. One at a time; later ones queue. */
export function Dialogs(): JSX.Element | null {
  const [queue, setQueue] = useState<DialogRequest[]>([])
  const current = queue[0]
  const panel = useRef<HTMLDivElement>(null)

  useEffect(() => onDialog((d) => setQueue((q) => [...q, d])), [])

  const close = (choice: string | null): void => {
    if (!current) return
    current.resolve(choice)
    setQueue((q) => q.slice(1))
  }

  useEffect(() => {
    if (!current) return
    // The first non-destructive action gets focus, so Enter never deletes by accident.
    const buttons = panel.current?.querySelectorAll<HTMLButtonElement>('.dialog-actions button')
    const safe = [...(buttons ?? [])].find((b) => !b.classList.contains('danger'))
    safe?.focus()
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        close(null)
      }
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current])

  if (!current) return null
  return createPortal(
    <div className="dialog-backdrop" onMouseDown={() => close(null)}>
      <div
        ref={panel}
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={`dialog-${current.id}`}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <h3 id={`dialog-${current.id}`}>{current.title}</h3>
        {current.message && <p>{current.message}</p>}
        <div className="dialog-actions">
          {current.actions.map((a) => (
            <button
              key={a.id}
              className={'btn ' + (a.tone === 'primary' ? 'primary' : a.tone === 'danger' ? 'danger' : 'glass')}
              onClick={() => close(a.id)}
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
    </div>,
    document.body
  )
}

/**
 * A styled replacement for `<select>`: the native one ignores the app's theme
 * and draws a grey OS menu. The list opens in a portal, so a scrolling or
 * clipped parent (the source sheet) cannot cut it off.
 */
export function Select<T extends string>({
  value,
  options,
  onChange,
  disabled,
  size = 'md',
  ariaLabel
}: {
  value: T
  options: { value: T; label: string }[]
  onChange: (value: T) => void
  disabled?: boolean
  size?: 'sm' | 'md'
  ariaLabel?: string
}): JSX.Element {
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(0)
  const [rect, setRect] = useState<DOMRect | null>(null)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const current = options.find((o) => o.value === value) ?? options[0]

  const show = (): void => {
    if (disabled || !button.current) return
    setRect(button.current.getBoundingClientRect())
    setActive(Math.max(0, options.findIndex((o) => o.value === value)))
    setOpen(true)
  }

  const choose = (i: number): void => {
    const picked = options[i]
    setOpen(false)
    button.current?.focus()
    if (picked && picked.value !== value) onChange(picked.value)
  }

  useEffect(() => {
    if (!open) return
    const away = (e: MouseEvent): void => {
      const t = e.target as Node
      if (!menu.current?.contains(t) && !button.current?.contains(t)) setOpen(false)
    }
    const reflow = (): void => setOpen(false)
    window.addEventListener('mousedown', away)
    window.addEventListener('resize', reflow)
    window.addEventListener('scroll', reflow, true)
    return () => {
      window.removeEventListener('mousedown', away)
      window.removeEventListener('resize', reflow)
      window.removeEventListener('scroll', reflow, true)
    }
  }, [open])

  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLElement>(`[data-i="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const onKey = (e: React.KeyboardEvent): void => {
    if (!open) {
      if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(e.key)) {
        e.preventDefault()
        show()
      }
      return
    }
    // Keep Escape from also closing whatever the select sits in.
    e.stopPropagation()
    if (e.key === 'Escape' || e.key === 'Tab') setOpen(false)
    else if (e.key === 'ArrowDown') setActive((i) => Math.min(options.length - 1, i + 1))
    else if (e.key === 'ArrowUp') setActive((i) => Math.max(0, i - 1))
    else if (e.key === 'Home') setActive(0)
    else if (e.key === 'End') setActive(options.length - 1)
    else if (e.key === 'Enter' || e.key === ' ') choose(active)
    else return
    e.preventDefault()
  }

  // Opens upwards when there is no room below.
  const below = rect ? window.innerHeight - rect.bottom : 0
  const up = rect ? below < Math.min(280, options.length * 38 + 12) && rect.top > below : false
  const style: React.CSSProperties = rect
    ? {
        left: Math.min(rect.left, window.innerWidth - Math.max(rect.width, 180) - 8),
        minWidth: rect.width,
        ...(up ? { bottom: window.innerHeight - rect.top + 6 } : { top: rect.bottom + 6 })
      }
    : {}

  return (
    <>
      <button
        ref={button}
        type="button"
        className={`select-btn ${size}` + (open ? ' open' : '')}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => (open ? setOpen(false) : show())}
        onKeyDown={onKey}
      >
        <span className="select-value">{current?.label}</span>
        <Icon name="chevronDown" size={16} className="select-chevron" />
      </button>
      {open &&
        createPortal(
          <div ref={menu} className={'select-menu' + (up ? ' up' : '')} role="listbox" style={style}>
            {options.map((o, i) => (
              <button
                key={o.value}
                type="button"
                data-i={i}
                role="option"
                aria-selected={o.value === value}
                className={'select-option' + (i === active ? ' active' : '') + (o.value === value ? ' chosen' : '')}
                onMouseEnter={() => setActive(i)}
                onClick={() => choose(i)}
              >
                <span>{o.label}</span>
                {o.value === value && <Icon name="check" size={15} />}
              </button>
            ))}
          </div>,
          document.body
        )}
    </>
  )
}

// ----------------------------------------------------------------- format

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

/** "1h 12m left" style. */
export function timeLeft(seconds: number): string {
  if (!isFinite(seconds) || seconds <= 0) return ''
  const m = Math.round(seconds / 60)
  if (m < 60) return `${m}m left`
  return `${Math.floor(m / 60)}h ${m % 60}m left`
}
