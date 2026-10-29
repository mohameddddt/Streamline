import type { QualityPref, Stream } from './types'

/**
 * Addons describe a source in free text — Torrentio's
 * `Show.S01E02.1080p.WEB-DL.x264\n👤 120 💾 2.1 GB ⚙️ ThePirateBay`, and similar
 * from the rest. This pulls the parts people choose by out of that text, and
 * ranks sources so "Play best" can pick one without asking.
 */

export type Resolution = '4K' | '1440p' | '1080p' | '720p' | 'SD' | ''

export interface StreamTraits {
  resolution: Resolution
  hdr: string
  codec: 'HEVC' | 'H.264' | 'AV1' | ''
  source: string
  audio: string
  /** Bytes, 0 when the addon did not say. */
  size: number
  /** -1 when the addon did not say. */
  seeders: number
  /** Direct link (debrid / hosted): starts at once, no peers needed. */
  instant: boolean
  cam: boolean
}

const RES_ORDER: Resolution[] = ['4K', '1440p', '1080p', '720p', 'SD']

function textOf(stream: Stream): string {
  return [stream.name, stream.title, stream.description, stream.behaviorHints?.filename]
    .filter(Boolean)
    .join('\n')
}

export function parseStream(stream: Stream): StreamTraits {
  const text = textOf(stream)

  let resolution: Resolution = ''
  if (/\b(2160p|4k|uhd)\b/i.test(text)) resolution = '4K'
  else if (/\b1440p\b/i.test(text)) resolution = '1440p'
  else if (/\b1080[pi]\b/i.test(text)) resolution = '1080p'
  else if (/\b720p\b/i.test(text)) resolution = '720p'
  else if (/\b(480p|576p|360p|sd|dvdrip)\b/i.test(text)) resolution = 'SD'

  const hdr = /\b(dolby ?vision|dovi|dv)\b/i.test(text)
    ? 'DV'
    : /\bhdr10\+/i.test(text)
      ? 'HDR10+'
      : /\bhdr(10)?\b/i.test(text)
        ? 'HDR'
        : ''

  const codec = /\b(x\.?265|h\.?265|hevc)\b/i.test(text)
    ? 'HEVC'
    : /\bav1\b/i.test(text)
      ? 'AV1'
      : /\b(x\.?264|h\.?264|avc)\b/i.test(text)
        ? 'H.264'
        : ''

  const source = /\bremux\b/i.test(text)
    ? 'Remux'
    : /\b(blu-?ray|bdrip|brrip|bd)\b/i.test(text)
      ? 'BluRay'
      : /\bweb-?dl\b/i.test(text)
        ? 'WEB-DL'
        : /\bweb-?rip\b|\bweb\b/i.test(text)
          ? 'WEB'
          : /\bhdtv\b/i.test(text)
            ? 'HDTV'
            : ''

  const audio = /\batmos\b/i.test(text)
    ? 'Atmos'
    : /\btruehd\b/i.test(text)
      ? 'TrueHD'
      : /\bdts(-?hd|-?x)?\b/i.test(text)
        ? 'DTS'
        : /\b(ddp|dd\+|e-?ac-?3)\b/i.test(text)
          ? 'DD+'
          : /\b(ac-?3|dd5\.?1|dd)\b/i.test(text)
            ? 'AC3'
            : /\baac\b/i.test(text)
              ? 'AAC'
              : ''

  let size = 0
  const sizeMatch =
    /💾\s*([\d.,]+)\s*(tb|gb|mb|gib|mib)/i.exec(text) ??
    /\b([\d.]+)\s*(tb|gb|mb|gib|mib)\b/i.exec(text)
  if (sizeMatch) {
    const n = parseFloat(sizeMatch[1].replace(',', '.'))
    const unit = sizeMatch[2].toLowerCase()
    const mult = unit.startsWith('t') ? 1024 ** 4 : unit.startsWith('g') ? 1024 ** 3 : 1024 ** 2
    if (isFinite(n)) size = Math.round(n * mult)
  }

  const seedMatch = /👤\s*(\d+)/.exec(text) ?? /\bseed(?:er)?s?[:\s]+(\d+)/i.exec(text)
  const seeders = seedMatch ? parseInt(seedMatch[1], 10) : -1

  const instant =
    Boolean(stream.url || stream.filePath) || /\[(rd|ad|pm|tb|dl|oc|ed|pt)\+\]|\bcached\b|⚡/i.test(stream.name ?? '')

  const cam = /\b(cam|camrip|hdcam|ts|telesync|hdts|tc|telecine)\b/i.test(text)

  return { resolution, hdr, codec, source, audio, size, seeders, instant, cam }
}

/**
 * Higher is better. The built-in player decodes H.264 natively but has to
 * convert HEVC in real time, so at equal quality the H.264 copy wins.
 */
export function scoreStream(t: StreamTraits, pref: QualityPref): number {
  let score = 0
  if (t.instant) score += 40
  if (t.cam) score -= 80

  const rank = t.resolution ? RES_ORDER.indexOf(t.resolution) : -1
  if (pref === 'any') {
    score += rank < 0 ? 5 : [30, 26, 24, 14, 4][rank]
  } else if (rank >= 0) {
    const want = RES_ORDER.indexOf(pref === '2160p' ? '4K' : pref)
    const diff = rank - want // positive = lower resolution than wanted
    score += diff === 0 ? 30 : diff > 0 ? Math.max(0, 30 - diff * 14) : 12
  } else {
    score += 8
  }

  if (t.codec === 'H.264') score += 8
  else if (t.codec === 'HEVC') score -= 4

  if (!t.instant) {
    if (t.seeders === 0) score -= 40
    else if (t.seeders > 0) score += Math.min(28, Math.log2(t.seeders + 1) * 4)
  }

  // Very large files mean a lot of buffering before the first minutes play.
  const gb = t.size / 1024 ** 3
  if (!t.instant && gb > 30) score -= 10
  else if (!t.instant && gb > 15) score -= 4

  return score
}

export interface RankedStream {
  stream: Stream
  traits: StreamTraits
  score: number
}

export function rankStreams(streams: Stream[], pref: QualityPref): RankedStream[] {
  return streams
    .map((stream) => {
      const traits = parseStream(stream)
      return { stream, traits, score: scoreStream(traits, pref) }
    })
    .sort((a, b) => b.score - a.score)
}

/**
 * The best source for an episode when moving on from another one: the same
 * release group (Stremio's `bingeGroup`) if the addon offers it, else the best.
 */
export function pickNext(streams: Stream[], pref: QualityPref, bingeGroup?: string): Stream | null {
  if (bingeGroup) {
    const same = streams.find((s) => s.behaviorHints?.bingeGroup === bingeGroup)
    if (same) return same
  }
  return rankStreams(streams, pref)[0]?.stream ?? null
}

export function resolutionsIn(ranked: RankedStream[]): Resolution[] {
  const present = new Set(ranked.map((r) => r.traits.resolution).filter(Boolean))
  return RES_ORDER.filter((r) => present.has(r))
}
