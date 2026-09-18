import fs from 'fs'
import path from 'path'
import { app } from 'electron'
import type {
  DownloadProgress,
  DownloadRecord,
  PlaybackSource,
  Stream
} from '../shared/types'
import { getSettings } from './settings'
import {
  TRACKERS,
  ensureServer,
  getClient,
  magnetFor,
  pickFile,
  removeTorrent,
  setMode,
  waitForMetadata
} from './torrent'

export interface DownloadInfo {
  title: string
  metaId: string
  metaType: string
  poster?: string
  season?: number
  episode?: number
  videoId?: string
}

const STORE = 'downloads.json'
let records: Record<string, DownloadRecord> | null = null

function storePath(): string {
  return path.join(app.getPath('userData'), STORE)
}

function all(): Record<string, DownloadRecord> {
  if (!records) {
    try {
      records = JSON.parse(fs.readFileSync(storePath(), 'utf8'))
    } catch {
      records = {}
    }
  }
  return records as Record<string, DownloadRecord>
}

function persist(): void {
  try {
    fs.mkdirSync(app.getPath('userData'), { recursive: true })
    fs.writeFileSync(storePath(), JSON.stringify(all(), null, 2), 'utf8')
  } catch (err) {
    console.error('[downloads] persist failed', err)
  }
}

function update(infoHash: string, patch: Partial<DownloadRecord>): void {
  const record = all()[infoHash]
  if (!record) return
  Object.assign(record, patch)
  persist()
}

/** Watches the one file we selected and flips the record to `done` when it lands. */
function trackCompletion(torrent: any, infoHash: string, fileIdx: number): void {
  const file = torrent.files[fileIdx]
  if (!file) return
  let settled = false
  const finish = (): void => {
    if (settled) return
    settled = true
    const filePath = path.join(torrent.path, file.path)
    update(infoHash, { status: 'done', filePath })
    console.log('[downloads] finished', file.name)
  }
  if (file.progress >= 1) finish()
  file.once('done', finish)
  torrent.once('done', finish)
  torrent.once('error', (err: Error) =>
    update(infoHash, { status: 'error', error: err.message })
  )
}

function selectOnly(torrent: any, fileIdx: number): void {
  torrent.files.forEach((f: any, i: number) => {
    if (i === fileIdx) f.select()
    else f.deselect()
  })
}

async function addTorrent(magnet: string, infoHash: string): Promise<any> {
  const engine = await getClient()
  const settings = getSettings()
  fs.mkdirSync(settings.downloadsPath, { recursive: true })

  const existing = engine.get(infoHash)
  if (existing) {
    // It was added as a throwaway stream into the cache folder — re-add it into
    // the downloads folder instead, otherwise the file vanishes on exit.
    if (existing.path !== settings.downloadsPath) {
      await removeTorrent(infoHash, true)
    } else {
      setMode(infoHash, 'download')
      return existing
    }
  }
  const torrent = engine.add(magnet, { path: settings.downloadsPath, announce: TRACKERS })
  setMode(infoHash, 'download')
  return torrent
}

export async function start(stream: Stream, info: DownloadInfo): Promise<DownloadRecord> {
  if (!stream.infoHash) throw new Error('This source has no torrent to download.')
  const infoHash = stream.infoHash.toLowerCase()
  const existing = all()[infoHash]
  if (existing && existing.status === 'done') return existing

  const magnet = magnetFor(stream)
  const torrent = await addTorrent(magnet, infoHash)
  await waitForMetadata(torrent)

  const fileIdx = pickFile(torrent, stream.fileIdx, stream.behaviorHints?.filename)
  const file = torrent.files[fileIdx]
  if (!file) throw new Error('No playable file in this torrent.')
  selectOnly(torrent, fileIdx)

  const record: DownloadRecord = {
    infoHash,
    fileIdx,
    magnet,
    title: info.title,
    metaId: info.metaId,
    metaType: info.metaType,
    poster: info.poster,
    season: info.season,
    episode: info.episode,
    videoId: info.videoId,
    fileName: file.name,
    filePath: path.join(torrent.path, file.path),
    length: file.length,
    addedAt: existing?.addedAt ?? Date.now(),
    status: 'downloading'
  }
  all()[infoHash] = record
  persist()
  trackCompletion(torrent, infoHash, fileIdx)
  return record
}

export function list(): DownloadRecord[] {
  return Object.values(all()).sort((a, b) => b.addedAt - a.addedAt)
}

export async function progress(): Promise<DownloadProgress[]> {
  const engine = await getClient()
  const out: DownloadProgress[] = []
  for (const record of Object.values(all())) {
    if (record.status === 'done') continue
    const torrent = engine.get(record.infoHash)
    if (!torrent) continue
    const file = torrent.files?.[record.fileIdx]
    out.push({
      infoHash: record.infoHash,
      progress: file?.progress ?? torrent.progress ?? 0,
      downloaded: file ? file.progress * file.length : torrent.downloaded ?? 0,
      downloadSpeed: torrent.downloadSpeed ?? 0,
      peers: torrent.numPeers ?? 0,
      timeRemaining: torrent.timeRemaining ?? 0
    })
  }
  return out
}

export async function pause(infoHash: string): Promise<void> {
  await removeTorrent(infoHash.toLowerCase(), false)
  update(infoHash.toLowerCase(), { status: 'paused' })
}

export async function resume(infoHash: string): Promise<void> {
  const record = all()[infoHash.toLowerCase()]
  if (!record || record.status === 'done') return
  const torrent = await addTorrent(record.magnet, record.infoHash)
  update(record.infoHash, { status: 'downloading', error: undefined })
  await waitForMetadata(torrent)
  selectOnly(torrent, record.fileIdx)
  trackCompletion(torrent, record.infoHash, record.fileIdx)
}

/** Removes empty folders left behind under the downloads root. */
function pruneEmptyDirs(from: string): void {
  const root = path.resolve(getSettings().downloadsPath)
  let dir = path.dirname(path.resolve(from))
  while (dir.startsWith(root) && dir !== root) {
    try {
      if (fs.readdirSync(dir).length > 0) return
      fs.rmdirSync(dir)
    } catch {
      return
    }
    dir = path.dirname(dir)
  }
}

export async function remove(infoHash: string, deleteFiles: boolean): Promise<void> {
  const key = infoHash.toLowerCase()
  const record = all()[key]
  await removeTorrent(key, false)
  if (record && deleteFiles) {
    try {
      fs.rmSync(record.filePath, { force: true })
      pruneEmptyDirs(record.filePath)
    } catch (err) {
      console.warn('[downloads] delete failed', (err as Error).message)
    }
  }
  delete all()[key]
  persist()
}

/** Local file once finished, live torrent while still downloading. */
export async function playSource(infoHash: string): Promise<PlaybackSource> {
  const record = all()[infoHash.toLowerCase()]
  if (!record) throw new Error('That download is no longer in your library.')
  await ensureServer()
  if (record.status === 'done' && fs.existsSync(record.filePath)) {
    return { kind: 'local', filePath: record.filePath }
  }
  const engine = await getClient()
  if (!engine.get(record.infoHash)) await resume(record.infoHash)
  return { kind: 'torrent', infoHash: record.infoHash, fileIdx: record.fileIdx }
}

export function filePathFor(infoHash: string): string | null {
  const record = all()[infoHash.toLowerCase()]
  return record ? record.filePath : null
}

/** Re-attaches unfinished downloads after a restart. */
export async function resumeAll(): Promise<void> {
  const pending = Object.values(all()).filter((r) => r.status === 'downloading')
  for (const record of pending) {
    try {
      await resume(record.infoHash)
    } catch (err) {
      console.warn('[downloads] resume failed', record.title, (err as Error).message)
      update(record.infoHash, { status: 'paused' })
    }
  }
}
