// Reads every Leader card (id, name, colors, set) out of OPTCG Sim's card database.
// Used at runtime by the app (so new sets arrive when the sim updates) and by
// scripts/ingest-leaders.mjs (to refresh the bundled fallback list).
//
// Cards live in Builds_Windows/OPTCGSim_Data/resources.assets as Unity-serialized
// records (str = i32 byteLength + utf8 bytes, padded to 4):
//   str id, str id, i32 ?, i32 cardType (0 = Leader), str name, i32 attribute,
//   i32 life, i32 power, i32 ?, i32 nTypes, i32 types[n], i32 ?, i32 nColors, i32 colors[n]
import path from 'node:path'

export const COLORS = ['Red', 'Green', 'Blue', 'Purple', 'Black', 'Yellow']
export const ASSETS = path.join('Builds_Windows', 'OPTCGSim_Data', 'resources.assets')

/** All Leader records in a resources.assets buffer. */
export function parseLeaders(buf) {
  const text = buf.toString('latin1') // one char per byte, so match offsets are byte offsets
  const re = /\x08\x00\x00\x00([A-Z]+\d*-\d{3})\x08\x00\x00\x00\1/g
  const leaders = new Map()
  let m
  while ((m = re.exec(text))) {
    const id = m[1]
    let j = m.index + m[0].length
    const i32 = () => {
      const v = buf.readInt32LE(j)
      j += 4
      return v
    }
    try {
      i32()
      if (i32() !== 0) continue // not a Leader
      const n = i32()
      if (n <= 0 || n > 80) continue
      const name = buf.toString('utf8', j, j + n).replace(/\s+/g, ' ').trim()
      j += n + ((4 - (n % 4)) % 4)
      i32(), i32() // attribute, life
      const power = i32()
      i32()
      const nTypes = i32()
      if (power < 0 || power > 20000 || nTypes < 0 || nTypes > 8) continue
      j += nTypes * 4
      i32()
      const nColors = i32()
      if (nColors < 1 || nColors > 3) continue
      const colors = Array.from({ length: nColors }, i32).map((c) => COLORS[c])
      if (!name || colors.some((c) => !c) || leaders.has(id)) continue
      leaders.set(id, { id, name, colors, set: id.split('-')[0] })
    } catch {
      // record ran past the end of the buffer
    }
  }
  return [...leaders.values()].sort((a, b) => a.id.localeCompare(b.id, 'en', { numeric: true }))
}

/** Sim leaders first, plus any known leader the sim's records don't expose (e.g. PRB reprints). */
export function mergeLeaders(fromSim, known) {
  const have = new Set(fromSim.map((l) => l.id))
  return [...fromSim, ...known.filter((l) => !have.has(l.id))].sort((x, y) => x.id.localeCompare(y.id, 'en', { numeric: true }))
}
