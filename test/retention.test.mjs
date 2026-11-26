import { test } from 'node:test'
import assert from 'node:assert/strict'
import { cleanRetention, pickExpired } from '../src/retention.mjs'

const NOW = Date.parse('2026-06-01T12:00:00Z')
const ago = (d) => new Date(NOW - d * 86400000).toISOString()
const rec = (id, days, extra = {}) => ({ id, startedAt: ago(days), status: 'done', videoUrl: `rec://${id}.webm`, ...extra })
const ids = (rs) => rs.map((r) => r.id)

test('cleanRetention accepts only the offered durations', () => {
  assert.equal(cleanRetention(30), 30)
  assert.equal(cleanRetention('14'), 14)
  assert.equal(cleanRetention(null), null)
  assert.equal(cleanRetention(0), null)
  assert.equal(cleanRetention(5), null)
  assert.equal(cleanRetention('forever'), null)
})

test('picks only videos older than the window', () => {
  const recs = [rec('new', 3), rec('edge', 29.9), rec('old', 31), rec('older', 200)]
  assert.deepEqual(ids(pickExpired(recs, { days: 30, now: NOW })), ['old', 'older'])
  assert.deepEqual(ids(pickExpired(recs, { days: 7, now: NOW })), ['edge', 'old', 'older'])
  assert.deepEqual(ids(pickExpired(recs, { days: 90, now: NOW })), ['older'])
})

test('keep forever removes nothing', () => {
  assert.deepEqual(pickExpired([rec('old', 400)], { days: null, now: NOW }), [])
})

test('starred, misplay-noted, active, unfinished and video-less games are kept', () => {
  const recs = [
    rec('star', 60, { starred: true }),
    rec('noted', 60, { misplays: [{ t: 1, turn: 2, note: 'x' }] }),
    rec('emptyNotes', 60, { misplays: [] }),
    rec('active', 60),
    rec('live', 60, { status: 'recording' }),
    rec('tracked', 60, { videoUrl: null, tracked: true }),
    rec('pruned', 60, { videoPruned: true }),
    rec('nodate', 60, { startedAt: 'garbage' }),
  ]
  assert.deepEqual(ids(pickExpired(recs, { days: 30, now: NOW, activeId: 'active' })), ['emptyNotes'])
})
