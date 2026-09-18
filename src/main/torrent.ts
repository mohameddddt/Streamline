import http from 'http'
import fs from 'fs'
import path from 'path'
import type { AddressInfo } from 'net'
import type { Stream, TorrentHandle, TorrentStats } from '../shared/types'
import { getSettings } from './settings'

/**
 * webtorrent v2 is ESM-only while the Electron main bundle is CommonJS.
 * A `Function`-wrapped import survives Rollup untouched, so it stays a real
 * dynamic import at runtime instead of being rewritten into `require`.
 */
const esmImport = new Function('s', 'return import(s)') as (s: string) => Promise<any>

export const TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.tracker.cl:1337/announce',
  'udp://tracker.openbittorrent.com:6969/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.demonii.com:1337/announce',
  'udp://tracker.dler.org:6969/announce',
  'udp://explodie.org:6969/announce',
  'wss://tracker.openwebtorrent.com'
]

const VIDEO_EXT = /\.(mp4|mkv|avi|webm|mov|m4v|mpg|mpeg|flv|ts|m2ts|wmv|ogv)$/i
const MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime',
  '.ogv': 'video/ogg',
  '.ts': 'video/mp2t'
}

export function mimeFor(name: string): string {
  return MIME[path.extname(name).toLowerCase()] ?? 'video/mp4'
}

export function isVideo(name: string): boolean {
  return VIDEO_EXT.test(name)
}

let client: any = null
let server: http.Server | null = null
let port = 0

/** infoHash -> why we added it. Streaming torrents are disposable; downloads are not. */
const mode = new Map<string, 'stream' | 'download'>()
/** infoHash -> index of the file being streamed. */
const selectedFile = new Map<string, number>()

export function setMode(infoHash: string, value: 'stream' | 'download'): void {
  mode.set(infoHash.toLowerCase(), value)
}

export function getMode(infoHash: string): 'stream' | 'download' | undefined {
  return mode.get(infoHash.toLowerCase())
}

export async function getClient(): Promise<any> {
  if (client) return client
  const settings = getSettings()
  const mod = await esmImport('webtorrent')
  const WebTorrent = mod.default ?? mod
  client = new WebTorrent({
    maxConns: settings.maxConns,
    downloadLimit: settings.downloadLimit || -1,
    uploadLimit: settings.uploadLimit || -1
  })
  client.on('error', (err: Error) => console.error('[torrent] client error', err.message))
  return client
}

export async function ensureServer(): Promise<number> {
  if (server && port) return port
  server = http.createServer(handleRequest)
  await new Promise<void>((resolve, reject) => {
    server!.once('error', reject)
    // Loopback only: nothing about this stream should be reachable off-machine.
    server!.listen(0, '127.0.0.1', () => resolve())
  })
  server.on('error', (err) => console.error('[torrent] server error', err.message))
  port = (server.address() as AddressInfo).port
  console.log('[torrent] streaming on http://127.0.0.1:' + port)
  return port
}

// ------------------------------------------------------------- http serving

interface RangeResult {
  start: number
  end: number
}

/** Writes status + headers for a (possibly partial) response. Returns null on 416. */
function writeRangeHead(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  total: number,
  mime: string
): RangeResult | null {
  const headers: Record<string, string> = {
    'Content-Type': mime,
    'Accept-Ranges': 'bytes',
    'Cache-Control': 'no-store'
  }
  let start = 0
  let end = total - 1
  const range = req.headers.range

  if (range) {
    const m = /bytes=(\d*)-(\d*)/.exec(range)
    if (m) {
      if (m[1]) start = parseInt(m[1], 10)
      if (m[2]) end = parseInt(m[2], 10)
    }
    if (isNaN(start) || isNaN(end) || start > end || start >= total) {
      res.writeHead(416, { 'Content-Range': `bytes */${total}` }).end()
      return null
    }
    end = Math.min(end, total - 1)
    headers['Content-Range'] = `bytes ${start}-${end}/${total}`
    headers['Content-Length'] = String(end - start + 1)
    res.writeHead(206, headers)
  } else {
    headers['Content-Length'] = String(total)
    res.writeHead(200, headers)
  }
  return { start, end }
}

function pipeTo(res: http.ServerResponse, stream: NodeJS.ReadableStream): void {
  stream.pipe(res)
  stream.on('error', (err: Error) => {
    console.warn('[torrent] stream error', err.message)
    res.destroy()
  })
  const cleanup = (): void => {
    ;(stream as unknown as { destroy?: () => void }).destroy?.()
  }
  res.on('close', cleanup)
  res.on('finish', cleanup)
}

function serveTorrentFile(req: http.IncomingMessage, res: http.ServerResponse, url: string): void {
  const match = /^\/stream\/([0-9a-fA-F]{40})\/(\d+)/.exec(url)
  if (!match) {
    res.writeHead(404).end('not found')
    return
  }
  const [, infoHash, idxRaw] = match
  const torrent = client?.get(infoHash.toLowerCase())
  if (!torrent || !torrent.files?.length) {
    res.writeHead(404).end('torrent not ready')
    return
  }
  const file = torrent.files[Number(idxRaw)]
  if (!file) {
    res.writeHead(404).end('file not found')
    return
  }
  const range = writeRangeHead(req, res, file.length, mimeFor(file.name))
  if (!range) return
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  pipeTo(res, file.createReadStream({ start: range.start, end: range.end }))
}

/** Serves a finished download straight off disk — but only from the downloads folder. */
function serveLocalFile(req: http.IncomingMessage, res: http.ServerResponse, url: URL): void {
  const raw = url.searchParams.get('p')
  if (!raw) {
    res.writeHead(400).end('missing path')
    return
  }
  const target = path.resolve(raw)
  const root = path.resolve(getSettings().downloadsPath)
  const relative = path.relative(root, target)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    res.writeHead(403).end('forbidden')
    return
  }
  let stat: fs.Stats
  try {
    stat = fs.statSync(target)
  } catch {
    res.writeHead(404).end('not found')
    return
  }
  const range = writeRangeHead(req, res, stat.size, mimeFor(target))
  if (!range) return
  if (req.method === 'HEAD') {
    res.end()
    return
  }
  pipeTo(res, fs.createReadStream(target, { start: range.start, end: range.end }))
}

/** Set by playback.ts to avoid an import cycle (it imports this module). */
let transcodeHandler:
  | ((req: http.IncomingMessage, res: http.ServerResponse, url: URL) => void)
  | null = null

export function setTranscodeHandler(fn: typeof transcodeHandler): void {
  transcodeHandler = fn
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  if (url.pathname === '/transcode' && transcodeHandler) transcodeHandler(req, res, url)
  else if (url.pathname === '/local') serveLocalFile(req, res, url)
  else serveTorrentFile(req, res, url.pathname)
}

export async function localFileUrl(filePath: string): Promise<string> {
  const p = await ensureServer()
  return `http://127.0.0.1:${p}/local?p=${encodeURIComponent(filePath)}`
}

// ----------------------------------------------------------- torrent helpers

export function pickFile(torrent: any, fileIdx?: number, hintName?: string): number {
  if (typeof fileIdx === 'number' && torrent.files[fileIdx]) return fileIdx
  if (hintName) {
    const byName = torrent.files.findIndex((f: any) => f.name === hintName)
    if (byName >= 0) return byName
  }
  let best = -1
  let bestLen = -1
  torrent.files.forEach((f: any, i: number) => {
    if (!isVideo(f.name)) return
    if (f.length > bestLen) {
      bestLen = f.length
      best = i
    }
  })
  return best >= 0 ? best : 0
}

export function magnetFor(stream: Stream): string {
  const hash = (stream.infoHash as string).toLowerCase()
  const trackers = new Set(TRACKERS)
  for (const src of stream.sources ?? []) {
    if (src.startsWith('tracker:')) trackers.add(src.slice('tracker:'.length))
  }
  const tr = [...trackers].map((t) => `&tr=${encodeURIComponent(t)}`).join('')
  const name = stream.behaviorHints?.filename
    ? `&dn=${encodeURIComponent(stream.behaviorHints.filename)}`
    : ''
  return `magnet:?xt=urn:btih:${hash}${name}${tr}`
}

export function waitForMetadata(torrent: any, ms = 60000): Promise<void> {
  if (torrent.ready) return Promise.resolve()
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error('Timed out finding peers for this torrent. Try another source.')),
      ms
    )
    torrent.once('ready', () => {
      clearTimeout(timer)
      resolve()
    })
    torrent.once('error', (err: Error) => {
      clearTimeout(timer)
      reject(err)
    })
  })
}

/** Adds (or reuses) the torrent, waits for metadata, returns a local stream URL. */
export async function startStream(stream: Stream): Promise<TorrentHandle> {
  if (!stream.infoHash) throw new Error('stream has no infoHash')
  const infoHash = stream.infoHash.toLowerCase()
  const engine = await getClient()
  const streamPort = await ensureServer()
  const settings = getSettings()
  fs.mkdirSync(settings.downloadPath, { recursive: true })

  let torrent = engine.get(infoHash)
  if (!torrent) {
    torrent = engine.add(magnetFor(stream), {
      path: settings.downloadPath,
      announce: TRACKERS
    })
    setMode(infoHash, 'stream')
  }

  await waitForMetadata(torrent)

  const idx = pickFile(torrent, stream.fileIdx, stream.behaviorHints?.filename)
  const file = torrent.files[idx]
  if (!file) throw new Error('no playable file in torrent')

  // A download keeps every selected file; a stream spends all bandwidth on one.
  if (getMode(infoHash) !== 'download') {
    torrent.files.forEach((f: any, i: number) => {
      if (i === idx) f.select()
      else f.deselect()
    })
  }
  selectedFile.set(infoHash, idx)

  return {
    url: `http://127.0.0.1:${streamPort}/stream/${infoHash}/${idx}`,
    infoHash,
    fileIdx: idx,
    fileName: file.name,
    fileLength: file.length,
    mime: mimeFor(file.name)
  }
}

export function streamUrlFor(infoHash: string, fileIdx: number): string {
  return `http://127.0.0.1:${port}/stream/${infoHash.toLowerCase()}/${fileIdx}`
}

export function getStats(infoHash: string): TorrentStats | null {
  const torrent = client?.get(infoHash.toLowerCase())
  if (!torrent) return null
  const idx = selectedFile.get(infoHash.toLowerCase())
  const selected = idx === undefined ? undefined : torrent.files[idx]
  return {
    infoHash,
    progress: torrent.progress ?? 0,
    downloaded: torrent.downloaded ?? 0,
    downloadSpeed: torrent.downloadSpeed ?? 0,
    uploadSpeed: torrent.uploadSpeed ?? 0,
    peers: torrent.numPeers ?? 0,
    ready: Boolean(torrent.ready),
    fileProgress: selected?.progress ?? torrent.progress ?? 0
  }
}

export async function removeTorrent(infoHash: string, destroyStore = false): Promise<void> {
  if (!client) return
  const torrent = client.get(infoHash.toLowerCase())
  if (!torrent) return
  await new Promise<void>((resolve) => {
    client.remove(torrent, { destroyStore }, () => resolve())
  })
  mode.delete(infoHash.toLowerCase())
  selectedFile.delete(infoHash.toLowerCase())
}

export async function shutdown(): Promise<void> {
  const settings = getSettings()
  if (client) {
    // Drop streaming torrents (and their cache) individually, so that destroying
    // the client can never touch a download's files.
    if (settings.deleteOnExit) {
      const streams = (client.torrents ?? []).filter(
        (t: any) => getMode(t.infoHash) !== 'download'
      )
      for (const t of streams) {
        await new Promise<void>((resolve) => {
          client.remove(t, { destroyStore: true }, () => resolve())
        }).catch(() => undefined)
      }
    }
    await new Promise<void>((resolve) => {
      client.destroy(() => resolve())
    }).catch(() => undefined)
    client = null
  }
  if (server) {
    server.close()
    server = null
    port = 0
  }
  if (settings.deleteOnExit) {
    try {
      fs.rmSync(settings.downloadPath, { recursive: true, force: true })
    } catch {
      /* best effort */
    }
  }
}
