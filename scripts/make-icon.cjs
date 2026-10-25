/**
 * Generates resources/icon.png and icon.ico (256x256) with no image dependencies.
 * A near-black tile with a volt play triangle trailing three light streamlines.
 * Keep the geometry in step with src/renderer/src/components/Logo.tsx.
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const SIZE = 256
const RADIUS = 64
const SUB = 4 // subpixel samples per axis, for antialiasing

const TILE = [0x15, 0x17, 0x1c]
const LIGHT = [0xee, 0xf0, 0xf4]
const VOLT = [0xd7, 0xff, 0x3d]

// [x, y, width, height, opacity] — pill-shaped streamlines
const BARS = [
  [34, 88, 46, 14, 0.5],
  [22, 121, 70, 14, 1],
  [34, 154, 46, 14, 0.5]
]
const TRI = [
  [104, 64],
  [104, 192],
  [212, 128]
]
const TRI_ROUND = 5 // grows the triangle by this radius and rounds its corners

function insideRoundedRect(x, y, rx, ry, w, h, r) {
  if (x < rx || y < ry || x > rx + w || y > ry + h) return false
  const cx = Math.min(Math.max(x, rx + r), rx + w - r)
  const cy = Math.min(Math.max(y, ry + r), ry + h - r)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= r * r
}

function distToSegment(px, py, [ax, ay], [bx, by]) {
  const abx = bx - ax
  const aby = by - ay
  const t = Math.max(0, Math.min(1, ((px - ax) * abx + (py - ay) * aby) / (abx * abx + aby * aby)))
  return Math.hypot(px - (ax + t * abx), py - (ay + t * aby))
}

function insideTriangle(x, y) {
  const [[ax, ay], [bx, by], [cx, cy]] = TRI
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
  const a = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d
  const b = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d
  if (a >= 0 && b >= 0 && 1 - a - b >= 0) return true
  // Just outside: within the rounding radius of any edge.
  return (
    distToSegment(x, y, TRI[0], TRI[1]) <= TRI_ROUND ||
    distToSegment(x, y, TRI[1], TRI[2]) <= TRI_ROUND ||
    distToSegment(x, y, TRI[2], TRI[0]) <= TRI_ROUND
  )
}

function coverage(px, py, test) {
  let hits = 0
  for (let sy = 0; sy < SUB; sy++) {
    for (let sx = 0; sx < SUB; sx++) {
      if (test(px + (sx + 0.5) / SUB, py + (sy + 0.5) / SUB)) hits++
    }
  }
  return hits / (SUB * SUB)
}

function over(base, top, alpha) {
  return base.map((c, i) => Math.round(c + (top[i] - c) * alpha))
}

function buildPixels() {
  // Raw scanlines, each prefixed with a 0 filter byte.
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
  let o = 0
  for (let y = 0; y < SIZE; y++) {
    raw[o++] = 0
    for (let x = 0; x < SIZE; x++) {
      const tileA = coverage(x, y, (px, py) => insideRoundedRect(px, py, 0, 0, SIZE, SIZE, RADIUS))
      let rgb = TILE
      for (const [bx, by, bw, bh, op] of BARS) {
        const a = coverage(x, y, (px, py) => insideRoundedRect(px, py, bx, by, bw, bh, bh / 2))
        if (a > 0) rgb = over(rgb, LIGHT, a * op)
      }
      const triA = coverage(x, y, insideTriangle)
      if (triA > 0) rgb = over(rgb, VOLT, triA)
      raw[o++] = rgb[0]
      raw[o++] = rgb[1]
      raw[o++] = rgb[2]
      raw[o++] = Math.round(tileA * 255)
    }
  }
  return raw
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body) >>> 0)
  return Buffer.concat([len, body, crc])
}

let crcTable = null
function crc32(buf) {
  if (!crcTable) {
    crcTable = []
    for (let n = 0; n < 256; n++) {
      let c = n
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
      crcTable[n] = c
    }
  }
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return c ^ 0xffffffff
}

function buildPng() {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(SIZE, 0)
  ihdr.writeUInt32BE(SIZE, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(buildPixels(), { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

function buildIco(png) {
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // type: icon
  header.writeUInt16LE(1, 4) // one image
  const entry = Buffer.alloc(16)
  entry[0] = 0 // 0 means 256
  entry[1] = 0
  entry[2] = 0
  entry[3] = 0
  entry.writeUInt16LE(1, 4) // planes
  entry.writeUInt16LE(32, 6) // bpp
  entry.writeUInt32LE(png.length, 8)
  entry.writeUInt32LE(6 + 16, 12)
  return Buffer.concat([header, entry, png])
}

const png = buildPng()
const outDir = path.join(__dirname, '..', 'resources')
fs.mkdirSync(outDir, { recursive: true })
fs.writeFileSync(path.join(outDir, 'icon.png'), png)
fs.writeFileSync(path.join(outDir, 'icon.ico'), buildIco(png))
console.log('wrote resources/icon.ico and icon.png (%d bytes png)', png.length)
