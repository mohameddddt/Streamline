import { ACCENTS } from '../../../shared/config'

export const isWeb = (): boolean => window.api.platform === 'web'

export function applyAccent(id: string): void {
  const accent = ACCENTS.find((a) => a.id === id) ?? ACCENTS[0]
  const root = document.documentElement.style
  root.setProperty('--accent', accent.color)
  root.setProperty('--accent-ink', accent.ink)
}

// ---------------------------------------------------------------- toasts

export interface ToastMessage {
  id: number
  text: string
  tone: 'info' | 'good' | 'bad'
}

const listeners = new Set<(t: ToastMessage) => void>()
let nextId = 1

/** Shows a short message at the top of the window. */
export function toast(text: string, tone: ToastMessage['tone'] = 'info'): void {
  const msg = { id: nextId++, text, tone }
  listeners.forEach((fn) => fn(msg))
}

export function onToast(fn: (t: ToastMessage) => void): () => void {
  listeners.add(fn)
  return () => listeners.delete(fn)
}

export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** Detail page route for a title. */
export const detailPath = (type: string, id: string): string =>
  `/detail/${encodeURIComponent(type)}/${encodeURIComponent(id)}`
