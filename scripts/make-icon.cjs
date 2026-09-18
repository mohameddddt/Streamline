/**
 * Generates resources/icon.ico (256x256) with no image dependencies.
 * A rounded purple tile with a play triangle — plain shapes, drawn from scratch.
 */
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const SIZE = 256
const RADIUS = 56
const SUB = 3 // subpixel samples per axis, for antialiasing

const TRI = [
  [104, 70],
  [104, 186],
  [194, 128]
]

function insideRoundedRect(x, y) {
  if (x < 0 || y < 0 || x > SIZE || y > SIZE) return false
  const cx = Math.min(Math.max(x, RADIUS), SIZE - RADIUS)
  const cy = Math.min(Math.max(y, RADIUS), SIZE - RADIUS)
  const dx = x - cx
  const dy = y - cy
  return dx * dx + dy * dy <= RADIUS * RADIUS
}

function insideTriangle(x, y) {
  const [[ax, ay], [bx, by], [cx, cy]] = TRI
  const d = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
  const a = ((by - cy) * (x - cx) + (cx - bx) * (y - cy)) / d
  const b = ((cy - ay) * (x - cx) + (ax - cx) * (y - cy)) / d
  const c = 1 - a - b
  return a >= 0 && b >= 0 && c >= 0
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

function mix(a, b, t) {
  return Math.round(a + (b - a) * t)
}

function buildPixels() {
  // Raw scanlines, each prefixed with a 0 filter byte.
  const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
  let o = 0
  for (let y = 0; y < SIZE; y++) {
    raw[o++] = 0
    for (let x = 0; x < SIZE; x++) {
      const tileA = coverage(x, y, insideRoundedRect)
      const triA = coverage(x, y, insideTriangle)
      // Vertical gradient across the tile.
      const t = y / SIZE
      let r = mix(0x8b, 0x4b, t)
      let g = mix(0x6b, 0x31, t)
      let b = mix(0xff, 0xc9, t)
      if (triA > 0) {
        r = mix(r, 0xff, triA)
        g = mix(g, 0xff, triA)
        b = mix(b, 0xff, triA)
      }
      raw[o++] = r
      raw[o++] = g
      raw[o++] = b
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
