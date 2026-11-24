// Moving the recordings library between folders. A recording is <id>.webm,
// <id>.log and <id>.json (the meta that makes it show in the library).
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

// Meta last: a recording only shows in the new folder once its video got there.
const EXTS = ['webm', 'log', 'json']

/** Recording ids in a library folder (one per .json meta file). */
export function recordingIds(dir) {
  try {
    return fs
      .readdirSync(dir)
      .filter((n) => n.endsWith('.json') && /^[\w-]+\.json$/.test(n))
      .map((n) => n.slice(0, -5))
  } catch {
    return []
  }
}

/** Why `to` can't replace `from` as the recordings folder, or null if it can. */
export function libDirProblem(from, to) {
  const rel = path.relative(path.resolve(from), path.resolve(to))
  if (!rel) return 'That is already the recordings folder.'
  if (!rel.startsWith('..') && !path.isAbsolute(rel)) return 'Pick a folder outside the current recordings folder.'
  return null
}

/** Can we create files in `dir`? Creates it if missing. Returns an error message or null. */
export async function writableProblem(dir) {
  const probe = path.join(dir, `.write-test-${process.pid}`)
  try {
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(probe, '')
    await fsp.rm(probe, { force: true })
    return null
  } catch (e) {
    return `Can't save recordings there (${e.code ?? e.message}).`
  }
}

async function moveFile(src, dst) {
  try {
    await fsp.rename(src, dst)
  } catch (e) {
    if (e.code !== 'EXDEV') throw e
    // Different drive: copy, then delete the original.
    try {
      await fsp.copyFile(src, dst, fs.constants.COPYFILE_EXCL)
    } catch (err) {
      await fsp.rm(dst, { force: true })
      throw err
    }
    await fsp.rm(src)
  }
}

/**
 * Move every recording from `from` to `to`. A recording whose id already exists in
 * `to` is left where it is (skipped); one that fails mid-way counts as failed.
 */
export async function moveRecordings(from, to, { skip = new Set() } = {}) {
  await fsp.mkdir(to, { recursive: true })
  const result = { moved: 0, skipped: 0, failed: 0 }
  for (const id of recordingIds(from)) {
    if (skip.has(id) || EXTS.some((ext) => fs.existsSync(path.join(to, `${id}.${ext}`)))) {
      result.skipped++
      continue
    }
    try {
      for (const ext of EXTS) {
        const src = path.join(from, `${id}.${ext}`)
        if (fs.existsSync(src)) await moveFile(src, path.join(to, `${id}.${ext}`))
      }
      result.moved++
    } catch {
      result.failed++
    }
  }
  return result
}
