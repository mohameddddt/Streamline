import { useEffect, useState } from 'react'
import { ACCENTS } from '../../../shared/config'

export const isWeb = (): boolean => window.api.platform === 'web'

export function applyAccent(id: string): void {
  const accent = ACCENTS.find((a) => a.id === id) ?? ACCENTS[0]
  const root = document.documentElement.style
  root.setProperty('--accent', accent.color)
  root.setProperty('--accent-ink', accent.ink)
}

/** Whether the computer has a network connection, kept current. */
export function useOnline(): boolean {
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const on = (): void => setOnline(true)
    const off = (): void => setOnline(false)
    window.addEventListener('online', on)
    window.addEventListener('offline', off)
    return () => {
      window.removeEventListener('online', on)
      window.removeEventListener('offline', off)
    }
  }, [])
  return online
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

// --------------------------------------------------------------- dialogs

export interface DialogAction {
  id: string
  label: string
  tone?: 'primary' | 'danger' | 'plain'
}

export interface DialogRequest {
  id: number
  title: string
  message?: string
  actions: DialogAction[]
  resolve: (choice: string | null) => void
}

const dialogListeners = new Set<(d: DialogRequest) => void>()

/**
 * Asks in an in-app dialog — never the operating system's — and resolves with
 * the chosen action's id, or null when it is dismissed.
 */
export function ask(options: Omit<DialogRequest, 'id' | 'resolve'>): Promise<string | null> {
  return new Promise((resolve) => {
    const request = { ...options, id: nextId++, resolve }
    if (!dialogListeners.size) return resolve(null)
    dialogListeners.forEach((fn) => fn(request))
  })
}

export function onDialog(fn: (d: DialogRequest) => void): () => void {
  dialogListeners.add(fn)
  return () => dialogListeners.delete(fn)
}

export function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '')
}

/** Detail page route for a title. */
export const detailPath = (type: string, id: string): string =>
  `/detail/${encodeURIComponent(type)}/${encodeURIComponent(id)}`
