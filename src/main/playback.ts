import { spawn, type ChildProcess } from 'child_process'
import http from 'http'
import path from 'path'
import type { PlaybackPlan, PlaybackSource, ProbeResult } from '../shared/types'
import { getSettings } from './settings'
import { ensureServer, localFileUrl, streamUrlFor } from './torrent'

/**
 * Chromium's bundled ffmpeg is a reduced build. These are the codecs it will
 * actually decode; anything else has to go through our own ffmpeg first.
 */
const PLAYABLE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1', 'theora'])
const PLAYABLE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac'])

/** electron-builder unpacks binaries next to the asar; fix the path at runtime. */
function unpacked(p: string): string {
  return p.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`)
}

function ffmpegPath(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('ffmpeg-static')
  return unpacked((mod.default ?? mod) as string)
}

function ffprobePath(): string {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const mod = require('@ffprobe-installer/ffprobe')
  return unpacked(mod.path as string)
}

// -------------------------------------------------------------------- probe

function runProbe(input: string, timeoutMs = 40000): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffprobePath(), [
      '-v',
      'quiet',
      '-print_format',
      'json',
      '-show_format',
      '-show_streams',
      '-analyzeduration',
      '10000000',
      '-probesize',
      '10000000',
      input
    ])
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error('Timed out inspecting this file. It may still be buffering.'))
    }, timeoutMs)

    child.stdout.on('data', (d) => (out += d))
    child.stderr.on('data', (d) => (err += d))
    child.on('error', (e) => {
      clearTimeout(timer)
      reject(e)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code !== 0) return reject(new Error(err.trim() || `ffprobe exited ${code}`))
      try {
        resolve(JSON.parse(out))
      } catch {
        reject(new Error('Could not read this file’s format.'))
      }
    })
  })
}

export async function probe(input: string): Promise<ProbeResult> {
  const data = await runProbe(input)
  const streams: any[] = data.streams ?? []
  const video = streams.find((s) => s.codec_type === 'video')
  const audio = streams.find((s) => s.codec_type === 'audio')
  return {
    duration: Number(data.format?.duration) || 0,
    videoCodec: video?.codec_name ?? '',
    audioCodec: audio?.codec_name ?? '',
    audioChannels: audio?.channels ?? 0,
    width: video?.width ?? 0,
    height: video?.height ?? 0,
    container: data.format?.format_name ?? ''
  }
}

// --------------------------------------------------------- hardware encoders

let encoderCache: string | null = null

/**
 * `ffmpeg -encoders` lists what was compiled in, not what this machine can run —
 * it advertises h264_nvenc on a box with no NVIDIA card. So actually encode one
 * frame with each candidate and keep the first that survives.
 */
function encoderArgs(name: string): string[] {
  switch (name) {
    case 'h264_nvenc':
      return ['-preset', 'fast', '-b:v', '6M']
    case 'h264_qsv':
      return ['-preset', 'veryfast', '-b:v', '6M']
    case 'h264_amf':
      return ['-quality', 'speed', '-b:v', '6M']
    default:
      return ['-preset', 'veryfast', '-crf', '23']
  }
}

function encoderWorks(name: string): Promise<boolean> {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath(), [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'lavfi',
      '-i',
      'testsrc=size=320x240:rate=1',
      '-frames:v',
      '1',
      '-c:v',
      name,
      // Test with the real flags, or an encoder that rejects them passes here
      // and then fails when it actually matters.
      ...encoderArgs(name),
      '-f',
      'null',
      '-'
    ])
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      resolve(false)
    }, 15000)
    child.on('error', () => {
      clearTimeout(timer)
      resolve(false)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve(code === 0)
    })
  })
}

async function pickVideoEncoder(): Promise<string> {
  if (encoderCache) return encoderCache
  // Hardware encoders keep a 4K HEVC transcode real-time; x264 is the fallback.
  for (const candidate of ['h264_nvenc', 'h264_qsv', 'h264_amf']) {
    if (await encoderWorks(candidate)) {
      encoderCache = candidate
      break
    }
  }
  if (!encoderCache) encoderCache = 'libx264'
  console.log('[playback] video encoder:', encoderCache)
  return encoderCache
}

// --------------------------------------------------------------------- plan

/** What ffmpeg/ffprobe should read. A local file is faster read straight off disk. */
function probeInput(source: PlaybackSource): string {
  if (source.kind === 'local') return source.filePath
  if (source.kind === 'url') return source.url
  return streamUrlFor(source.infoHash, source.fileIdx)
}

/** What the <video> element can actually load — never a bare filesystem path. */
async function playableUrl(source: PlaybackSource): Promise<string> {
  if (source.kind === 'local') return localFileUrl(source.filePath)
  return probeInput(source)
}

export async function plan(source: PlaybackSource): Promise<PlaybackPlan> {
  await ensureServer()
  const input = probeInput(source)
  const directUrl = await playableUrl(source)

  let info: ProbeResult | null = null
  try {
    info = await probe(input)
  } catch (err) {
    // If we cannot inspect it, just hand it to the player and hope for the best.
    console.warn('[playback] probe failed:', (err as Error).message)
    return {
      mode: 'direct',
      url: directUrl,
      duration: 0,
      reason: 'Could not inspect this file, playing it directly.',
      videoCodec: '',
      audioCodec: ''
    }
  }

  const videoOk = !info.videoCodec || PLAYABLE_VIDEO.has(info.videoCodec)
  const audioOk = !info.audioCodec || PLAYABLE_AUDIO.has(info.audioCodec)

  if (videoOk && audioOk && !/matroska|avi/.test(info.container)) {
    return {
      mode: 'direct',
      url: directUrl,
      duration: info.duration,
      reason: 'Playing the original file.',
      videoCodec: info.videoCodec,
      audioCodec: info.audioCodec
    }
  }

  const mode = videoOk ? 'remux' : 'transcode'
  const params = new URLSearchParams({
    src: input,
    v: videoOk ? 'copy' : 'encode',
    a: audioOk ? 'copy' : 'encode',
    t: '0'
  })
  const port = await ensureServer()
  return {
    mode,
    url: `http://127.0.0.1:${port}/transcode?${params.toString()}`,
    duration: info.duration,
    reason: videoOk
      ? `Repackaging on the fly (${info.audioCodec || 'audio'} → AAC).`
      : `Converting ${info.videoCodec} video in real time.`,
    videoCodec: info.videoCodec,
    audioCodec: info.audioCodec
  }
}

// ---------------------------------------------------------------- transcode

const active = new Set<ChildProcess>()

function isAllowedSource(src: string): boolean {
  if (/^https?:\/\/127\.0\.0\.1:\d+\//.test(src)) return true
  if (/^https?:\/\//.test(src)) return true // a direct link an addon gave us
  const root = path.resolve(getSettings().downloadsPath)
  const rel = path.relative(root, path.resolve(src))
  return !rel.startsWith('..') && !path.isAbsolute(rel)
}

export async function handleTranscode(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL
): Promise<void> {
  const src = url.searchParams.get('src') ?? ''
  const offset = Number(url.searchParams.get('t') ?? '0') || 0
  const copyVideo = url.searchParams.get('v') !== 'encode'
  const copyAudio = url.searchParams.get('a') !== 'encode'

  if (!src || !isAllowedSource(src)) {
    res.writeHead(403).end('forbidden')
    return
  }

  const args = ['-hide_banner', '-loglevel', 'error']
  if (offset > 0) args.push('-ss', String(offset))
  args.push('-i', src, '-map', '0:v:0?', '-map', '0:a:0?')

  if (copyVideo) {
    args.push('-c:v', 'copy')
  } else {
    const encoder = await pickVideoEncoder()
    args.push('-c:v', encoder, ...encoderArgs(encoder), '-pix_fmt', 'yuv420p')
  }

  if (copyAudio) args.push('-c:a', 'copy')
  else args.push('-c:a', 'aac', '-ac', '2', '-b:a', '192k')

  args.push(
    '-sn',
    '-max_muxing_queue_size',
    '2048',
    '-f',
    'mp4',
    '-movflags',
    'frag_keyframe+empty_moov+default_base_moof',
    'pipe:1'
  )

  // A live pipe: no Accept-Ranges, so the player will not try to seek into it.
  res.writeHead(200, {
    'Content-Type': 'video/mp4',
    'Cache-Control': 'no-store',
    Connection: 'close'
  })

  const child = spawn(ffmpegPath(), args)
  active.add(child)

  child.stdout.pipe(res)
  child.stderr.on('data', (d) => {
    const line = String(d).trim()
    if (line) console.warn('[ffmpeg]', line.slice(0, 300))
  })
  child.on('error', (err) => {
    console.error('[ffmpeg] spawn failed', err.message)
    res.destroy()
  })

  const stop = (): void => {
    if (!child.killed) child.kill('SIGKILL')
    active.delete(child)
  }
  child.on('close', () => active.delete(child))
  res.on('close', stop)
  res.on('finish', stop)
}

export function killAll(): void {
  for (const child of active) {
    if (!child.killed) child.kill('SIGKILL')
  }
  active.clear()
}
