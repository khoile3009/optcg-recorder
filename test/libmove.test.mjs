import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { libDirProblem, moveRecordings, recordingIds, writableProblem } from '../src/libmove.mjs'

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'libmove-'))
const put = (dir, name, body = name) => fs.writeFileSync(path.join(dir, name), body)
const ls = (dir) => fs.readdirSync(dir).sort()

test('libDirProblem: same folder and nested folders are refused, siblings and parents are fine', () => {
  const root = tmp()
  const lib = path.join(root, 'recordings')
  assert.match(libDirProblem(lib, lib), /already/)
  assert.match(libDirProblem(lib, path.join(lib, '.')), /already/)
  assert.match(libDirProblem(lib, path.join(lib, 'sub')), /outside/)
  assert.equal(libDirProblem(lib, path.join(root, 'other')), null)
  assert.equal(libDirProblem(lib, path.join(root, 'recordings2')), null)
  assert.equal(libDirProblem(lib, root), null)
})

test('recordingIds lists one id per meta file and ignores other json', () => {
  const dir = tmp()
  put(dir, 'a.json')
  put(dir, 'a.webm')
  put(dir, 'b-1.json')
  put(dir, 'settings.json.tmp')
  put(dir, 'weird name.json')
  assert.deepEqual(recordingIds(dir).sort(), ['a', 'b-1'])
  assert.deepEqual(recordingIds(path.join(dir, 'missing')), [])
})

test('moveRecordings moves every file of each recording and skips name collisions', async () => {
  const from = tmp()
  const to = path.join(tmp(), 'new', 'lib')
  for (const ext of ['webm', 'log', 'json']) put(from, `g1.${ext}`)
  put(from, 'g2.json') // a meta whose video was never saved
  for (const ext of ['webm', 'json']) put(from, `g3.${ext}`, 'old')
  fs.mkdirSync(to, { recursive: true })
  put(to, 'g3.json', 'new')
  put(from, 'notes.txt') // not ours: stays

  const r = await moveRecordings(from, to)
  assert.deepEqual(r, { moved: 2, skipped: 1, failed: 0 })
  assert.deepEqual(ls(to), ['g1.json', 'g1.log', 'g1.webm', 'g2.json', 'g3.json'])
  assert.equal(fs.readFileSync(path.join(to, 'g3.json'), 'utf8'), 'new')
  assert.deepEqual(ls(from), ['g3.json', 'g3.webm', 'notes.txt'])
  assert.equal(fs.readFileSync(path.join(to, 'g1.webm'), 'utf8'), 'g1.webm')
})

test('moveRecordings honours an explicit skip list', async () => {
  const from = tmp()
  const to = tmp()
  put(from, 'live.json')
  put(from, 'live.webm')
  put(from, 'done.json')
  const r = await moveRecordings(from, to, { skip: new Set(['live']) })
  assert.deepEqual(r, { moved: 1, skipped: 1, failed: 0 })
  assert.deepEqual(ls(to), ['done.json'])
})

test('writableProblem creates a missing folder and leaves no probe file', async () => {
  const dir = path.join(tmp(), 'a', 'b')
  assert.equal(await writableProblem(dir), null)
  assert.deepEqual(ls(dir), [])
})
