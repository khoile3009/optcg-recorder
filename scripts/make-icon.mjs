// Draws build/icon.png (512×512: red record dot on a dark rounded tile) with no
// image dependencies; electron-builder converts it to .ico for Windows.
//   node scripts/make-icon.mjs
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)))
const S = 512

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})
const crc32 = (buf) => {
  let c = 0xffffffff
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}
const chunk = (type, data) => {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const td = Buffer.concat([Buffer.from(type), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(td))
  return Buffer.concat([len, td, crc])
}

// Signed-distance shapes with 1px anti-aliasing.
const clamp = (v) => Math.max(0, Math.min(1, v))
const roundRect = (x, y, half, r) => {
  const qx = Math.abs(x) - half + r
  const qy = Math.abs(y) - half + r
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r
}
const mix = (a, b, t) => a.map((v, i) => v + (b[i] - v) * t)

const raw = Buffer.alloc((S * 4 + 1) * S)
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0
  for (let x = 0; x < S; x++) {
    const px = x + 0.5 - S / 2
    const py = y + 0.5 - S / 2
    const tileA = clamp(0.5 - roundRect(px, py, S * 0.47, S * 0.2))
    const g = (py + S / 2) / S
    let col = mix([28, 36, 56], [11, 15, 23], g) // tile gradient
    const ring = clamp(0.5 - (Math.abs(Math.hypot(px, py) - S * 0.27) - S * 0.025))
    col = mix(col, [242, 181, 68], ring) // gold ring
    const dot = clamp(0.5 - (Math.hypot(px, py) - S * 0.17))
    col = mix(col, [255, 77, 79], dot) // red record dot
    const o = y * (S * 4 + 1) + 1 + x * 4
    raw[o] = col[0]
    raw[o + 1] = col[1]
    raw[o + 2] = col[2]
    raw[o + 3] = Math.round(tileA * 255)
  }
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(S, 0)
ihdr.writeUInt32BE(S, 4)
ihdr[8] = 8 // bit depth
ihdr[9] = 6 // RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0)),
])
fs.mkdirSync(path.join(root, 'build'), { recursive: true })
fs.writeFileSync(path.join(root, 'build', 'icon.png'), png)
console.log('build/icon.png written')
