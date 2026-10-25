import http from 'http'
import { timingSafeEqual } from 'crypto'
import type { CompanionInfo, PlaybackSource, Stream } from '../shared/types'
import { APP_VERSION, COMPANION_PORT } from '../shared/config'
import { getSettings } from './settings'
import * as torrent from './torrent'
import * as playback from './playback'
import { fetchSubtitleAsVtt } from './addons'

/**
 * A small JSON API that lets the Streamline web app, open in a browser on this
 * same machine, use this app's torrent engine and transcoder — browsers cannot
 * talk to torrent peers themselves.
 *
 * It is off until switched on in Settings, listens on loopback only, and every
 * call needs the token shown in Settings, so other sites open in the browser
 * cannot drive it. The stream URLs it hands back point at the engine's own
 * loopback server, exactly as the desktop player uses them.
 */

let server: http.Server | null = null
let lastError = ''

function tokenOk(header: string | undefined): boolean {
  const expected = Buffer.from(`Bearer ${getSettings().companionToken}`)
  const given = Buffer.from(header ?? '')
  return given.length === expected.length && timingSafeEqual(given, expected)
}

function cors(res: http.ServerResponse): void {
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'authorization, content-type')
  // Chrome asks before a public page may reach a loopback address.
  res.setHeader('Access-Control-Allow-Private-Network', 'true')
  res.setHeader('Access-Control-Max-Age', '600')
}

function send(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(body))
}

function readBody<T>(req: http.IncomingMessage): Promise<T> {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
      if (raw.length > 1_000_000) {
        reject(new Error('request too large'))
        req.destroy()
      }
    })
    req.on('end', () => {
      try {
        resolve((raw ? JSON.parse(raw) : {}) as T)
      } catch {
        reject(new Error('invalid JSON'))
      }
    })
    req.on('error', reject)
  })
}

async function route(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  cors(res)
  if (req.method === 'OPTIONS') {
    res.writeHead(204).end()
    return
  }
  if (!tokenOk(req.headers.authorization)) {
    send(res, 401, { error: 'Wrong or missing companion token.' })
    return
  }

  switch (`${req.method} ${url.pathname}`) {
    case 'GET /api/hello':
      return send(res, 200, { app: 'streamline', version: APP_VERSION })
    case 'POST /api/torrent/warm':
      await torrent.warmUp()
      return send(res, 200, {})
    case 'POST /api/torrent/start': {
      const { stream } = await readBody<{ stream: Stream }>(req)
      return send(res, 200, await torrent.startStream(stream))
    }
    case 'GET /api/torrent/stats':
      return send(res, 200, torrent.getStats(url.searchParams.get('h') ?? ''))
    case 'POST /api/torrent/remove': {
      const { infoHash } = await readBody<{ infoHash: string }>(req)
      await torrent.removeTorrent(infoHash)
      return send(res, 200, {})
    }
    case 'POST /api/playback/plan': {
      const { source } = await readBody<{ source: PlaybackSource }>(req)
      // Downloads on disk are the desktop app's business; never serve paths here.
      if (source?.kind !== 'torrent' && source?.kind !== 'url') {
        return send(res, 400, { error: 'Only torrent and link sources can be planned remotely.' })
      }
      return send(res, 200, await playback.plan(source))
    }
    case 'GET /api/subtitles/vtt': {
      const target = url.searchParams.get('url') ?? ''
      if (!/^https?:\/\//.test(target)) return send(res, 400, { error: 'bad subtitle url' })
      res.writeHead(200, { 'Content-Type': 'text/vtt; charset=utf-8' })
      res.end(await fetchSubtitleAsVtt(target))
      return
    }
    default:
      return send(res, 404, { error: 'not found' })
  }
}

export function info(): CompanionInfo {
  const s = getSettings()
  return {
    role: 'host',
    enabled: Boolean(server),
    url: `http://127.0.0.1:${COMPANION_PORT}`,
    token: s.companionToken,
    connected: Boolean(server),
    version: APP_VERSION,
    error: lastError || undefined
  }
}

export async function start(): Promise<void> {
  if (server) return
  const next = http.createServer((req, res) => {
    route(req, res).catch((err: Error) => {
      if (!res.headersSent) send(res, 500, { error: err.message })
      else res.destroy()
    })
  })
  await new Promise<void>((resolve, reject) => {
    next.once('error', reject)
    next.listen(COMPANION_PORT, '127.0.0.1', () => resolve())
  }).catch((err: Error) => {
    lastError = `Could not listen on port ${COMPANION_PORT}: ${err.message}`
    throw new Error(lastError)
  })
  lastError = ''
  server = next
  console.log('[companion] listening on http://127.0.0.1:' + COMPANION_PORT)
}

export async function stop(): Promise<void> {
  if (!server) return
  const closing = server
  server = null
  const closed = new Promise<void>((resolve) => closing.close(() => resolve()))
  closing.closeAllConnections()
  await closed
}

/** Brings the server in line with the setting. */
export async function sync(): Promise<CompanionInfo> {
  if (getSettings().companionEnabled) await start()
  else await stop()
  return info()
}
