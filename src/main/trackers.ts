import fs from 'fs'
import type { DeviceAuth, ProgressEntry, TrackerName, TrackerStatus } from '../shared/types'
import { getSettings, saveSettings, getLibrary } from './settings'

const TRAKT_API = 'https://api.trakt.tv'
const SIMKL_API = 'https://api.simkl.com'

async function jsonRequest<T>(url: string, init: RequestInit, timeoutMs = 20000): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal })
    const text = await res.text()
    if (!res.ok) {
      throw new Error(`${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 200)}` : ''}`)
    }
    return (text ? JSON.parse(text) : {}) as T
  } finally {
    clearTimeout(timer)
  }
}

// ---------------------------------------------------------------- Trakt auth

export async function traktStartAuth(): Promise<DeviceAuth> {
  const { traktClientId } = getSettings()
  if (!traktClientId) throw new Error('Add your Trakt Client ID in Settings first.')
  const res = await jsonRequest<{
    device_code: string
    user_code: string
    verification_url: string
    interval: number
    expires_in: number
  }>(`${TRAKT_API}/oauth/device/code`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ client_id: traktClientId })
  })
  return {
    deviceCode: res.device_code,
    userCode: res.user_code,
    verificationUrl: res.verification_url,
    interval: res.interval,
    expiresIn: res.expires_in
  }
}

/** Polls until the user approves in their browser, or the code expires. */
export async function traktPollAuth(auth: DeviceAuth): Promise<boolean> {
  const { traktClientId, traktClientSecret } = getSettings()
  const deadline = Date.now() + auth.expiresIn * 1000
  let wait = Math.max(auth.interval, 1) * 1000

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, wait))
    const res = await fetch(`${TRAKT_API}/oauth/device/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        code: auth.deviceCode,
        client_id: traktClientId,
        client_secret: traktClientSecret
      })
    })
    if (res.status === 200) {
      const body = (await res.json()) as { access_token: string; refresh_token: string }
      saveSettings({ traktToken: body.access_token, traktRefresh: body.refresh_token })
      return true
    }
    if (res.status === 400) continue // still waiting on the user
    if (res.status === 429) {
      wait += 1000
      continue
    }
    if (res.status === 404) throw new Error('That Trakt code is no longer valid. Try again.')
    if (res.status === 409) return true // already approved
    if (res.status === 410) throw new Error('The Trakt code expired. Try again.')
    if (res.status === 418) throw new Error('Trakt authorisation was denied.')
    throw new Error(`Trakt returned ${res.status}.`)
  }
  throw new Error('Timed out waiting for Trakt approval.')
}

function traktHeaders(): Record<string, string> {
  const { traktClientId, traktToken } = getSettings()
  return {
    'Content-Type': 'application/json',
    'trakt-api-version': '2',
    'trakt-api-key': traktClientId,
    Authorization: `Bearer ${traktToken}`
  }
}

// ---------------------------------------------------------------- Simkl auth

export async function simklStartAuth(): Promise<DeviceAuth> {
  const { simklClientId } = getSettings()
  if (!simklClientId) throw new Error('Add your Simkl Client ID in Settings first.')
  const res = await jsonRequest<{
    device_code?: string
    user_code: string
    verification_url: string
    interval: number
    expires_in: number
  }>(`${SIMKL_API}/oauth/pin?client_id=${encodeURIComponent(simklClientId)}`, { method: 'GET' })
  return {
    deviceCode: res.device_code ?? res.user_code,
    userCode: res.user_code,
    verificationUrl: res.verification_url,
    interval: res.interval,
    expiresIn: res.expires_in
  }
}

export async function simklPollAuth(auth: DeviceAuth): Promise<boolean> {
  const { simklClientId } = getSettings()
  const deadline = Date.now() + auth.expiresIn * 1000
  const wait = Math.max(auth.interval, 1) * 1000

  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, wait))
    const res = await fetch(
      `${SIMKL_API}/oauth/pin/${encodeURIComponent(auth.userCode)}?client_id=${encodeURIComponent(
        simklClientId
      )}`
    )
    if (!res.ok) continue
    const body = (await res.json()) as { result: string; access_token?: string }
    if (body.result === 'OK' && body.access_token) {
      saveSettings({ simklToken: body.access_token })
      return true
    }
  }
  throw new Error('Timed out waiting for Simkl approval.')
}

function simklHeaders(): Record<string, string> {
  const { simklClientId, simklToken } = getSettings()
  return {
    'Content-Type': 'application/json',
    'simkl-api-key': simklClientId,
    Authorization: `Bearer ${simklToken}`
  }
}

// ------------------------------------------------------------------- status

export function status(): TrackerStatus {
  const s = getSettings()
  return {
    trakt: Boolean(s.traktToken),
    simkl: Boolean(s.simklToken)
  }
}

export function disconnect(name: TrackerName): void {
  if (name === 'trakt') saveSettings({ traktToken: '', traktRefresh: '' })
  else saveSettings({ simklToken: '' })
}

// ----------------------------------------------------------------- scrobble

/** Trakt wants the show/movie identified by IMDb id; ours come from Cinemeta. */
function traktBody(entry: ProgressEntry, progress: number): Record<string, unknown> | null {
  const imdb = entry.id
  if (!imdb.startsWith('tt')) return null
  if (entry.season !== undefined && entry.episode !== undefined) {
    return {
      show: { ids: { imdb } },
      episode: { season: entry.season, number: entry.episode },
      progress
    }
  }
  return { movie: { ids: { imdb } }, progress }
}

export async function scrobble(
  action: 'start' | 'pause' | 'stop',
  entry: ProgressEntry
): Promise<void> {
  const s = getSettings()
  const progress = entry.duration > 0 ? (entry.time / entry.duration) * 100 : 0

  if (s.traktToken) {
    const body = traktBody(entry, Math.min(100, Math.max(0, progress)))
    if (body) {
      try {
        await jsonRequest(`${TRAKT_API}/scrobble/${action}`, {
          method: 'POST',
          headers: traktHeaders(),
          body: JSON.stringify(body)
        })
      } catch (err) {
        console.warn('[trakt] scrobble failed', (err as Error).message)
      }
    }
  }

  // Simkl has no live scrobble endpoint we rely on, so it records on completion.
  if (s.simklToken && action === 'stop' && progress >= 80) {
    await markWatchedSimkl(entry).catch((err) =>
      console.warn('[simkl] history failed', (err as Error).message)
    )
  }
}

async function markWatchedSimkl(entry: ProgressEntry): Promise<void> {
  const imdb = entry.id
  if (!imdb.startsWith('tt')) return
  const body =
    entry.season !== undefined && entry.episode !== undefined
      ? {
          shows: [
            {
              ids: { imdb },
              seasons: [{ number: entry.season, episodes: [{ number: entry.episode }] }]
            }
          ]
        }
      : { movies: [{ ids: { imdb } }] }

  await jsonRequest(`${SIMKL_API}/sync/history`, {
    method: 'POST',
    headers: simklHeaders(),
    body: JSON.stringify(body)
  })
}

// --------------------------------------------------------------- CSV export

function csvCell(value: string | number | undefined): string {
  const str = String(value ?? '')
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str
}

function isoDate(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10)
}

/**
 * Letterboxd's importer takes a CSV and matches on imdbID when present, which
 * avoids the title-collision problem entirely.
 */
export function exportLetterboxdCsv(filePath: string): number {
  const rows = getLibrary()
    .progress.filter((p) => p.finished && p.season === undefined && p.id.startsWith('tt'))
    .map((p) => [csvCell(p.name), csvCell(p.year), csvCell(p.id), csvCell(isoDate(p.updatedAt))])
  const csv = ['Title,Year,imdbID,WatchedDate', ...rows.map((r) => r.join(','))].join('\n')
  fs.writeFileSync(filePath, csv, 'utf8')
  return rows.length
}

/** Serializd has no public API, so episodes go out as a generic CSV. */
export function exportSeriesCsv(filePath: string): number {
  const rows = getLibrary()
    .progress.filter((p) => p.finished && p.season !== undefined)
    .map((p) =>
      [
        csvCell(p.name),
        csvCell(p.season),
        csvCell(p.episode),
        csvCell(p.id),
        csvCell(isoDate(p.updatedAt))
      ].join(',')
    )
  const csv = ['Show,Season,Episode,imdbID,WatchedDate', ...rows].join('\n')
  fs.writeFileSync(filePath, csv, 'utf8')
  return rows.length
}
