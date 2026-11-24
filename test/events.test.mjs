import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  REMATCH_GAP_MS,
  cleanEvent,
  eventFields,
  filedAs,
  knownEvents,
  needsRetag,
  newClientId,
  retagged,
  setFor,
  setIdFor,
  setLabel,
  validClientId,
} from '../src/events.mjs'

const EV = { client_id: 'ev_0123456789ab', name: 'Weekly Bash #12' }
const at = (min) => new Date(Date.UTC(2026, 10, 24, 18, min)).toISOString()

test('client ids and event cleaning', () => {
  assert.equal(newClientId('abcdef012345'), 'ev_abcdef012345')
  assert.ok(validClientId('ev_abc-DEF_1'))
  assert.ok(!validClientId('ev abc'))
  assert.ok(!validClientId(''))
  assert.ok(!validClientId('x'.repeat(65)))
  assert.deepEqual(cleanEvent({ client_id: 'ev_1', name: '  Weekly   Bash  ' }), { client_id: 'ev_1', name: 'Weekly Bash' })
  assert.equal(cleanEvent({ client_id: 'ev_1', name: '   ' }), null)
  assert.equal(cleanEvent({ client_id: 'bad id', name: 'x' }), null)
  assert.equal(cleanEvent(null), null)
  assert.equal(cleanEvent({ client_id: 'ev_1', name: 'y'.repeat(200) }).name.length, 80)
})

test('setIdFor: s_ + 12 hex, deterministic, differs by room/opponent/day', () => {
  const a = setIdFor('ROOM1', 'Bob#2222', '2026-11-24')
  assert.match(a, /^s_[0-9a-f]{12}$/)
  assert.equal(a, setIdFor('ROOM1', 'Bob#2222', '2026-11-24'))
  assert.notEqual(a, setIdFor('ROOM2', 'Bob#2222', '2026-11-24'))
  assert.notEqual(a, setIdFor('ROOM1', 'Carol#3333', '2026-11-24'))
  assert.notEqual(a, setIdFor('ROOM1', 'Bob#2222', '2026-11-25'))
  assert.ok(!a.includes('ROOM1'))
})

test('setFor: a room starts a set; rematches against the same opponent continue it', () => {
  const g1 = { match: { room: 'ROOM1' }, opp: { name: 'Bob#2222' }, startedAt: at(0) }
  const s1 = setFor(g1, null, '2026-11-24')
  assert.deepEqual(s1, { id: setIdFor('ROOM1', 'Bob#2222', '2026-11-24'), room: 'ROOM1', startedOn: '2026-11-24', game: 1 })
  const prev = { ...g1, set: s1, durationMs: 20 * 60_000 }
  const g2 = { match: { rematch: true }, opp: { name: 'Bob#2222' }, startedAt: at(22) }
  const s2 = setFor(g2, prev, '2026-11-24')
  assert.deepEqual(s2, { ...s1, game: 2 })
  const g3 = { ...g2, startedAt: at(45) }
  assert.equal(setFor(g3, { ...g2, set: s2, durationMs: 20 * 60_000 }, '2026-11-24').game, 3)
})

test('setFor: no set without a match, for another opponent, or after a long gap', () => {
  const prev = { opp: { name: 'Bob#2222' }, startedAt: at(0), durationMs: 10 * 60_000, set: { id: 's_x', room: 'R', game: 1 } }
  const rematch = (over) => ({ match: { rematch: true }, opp: { name: 'Bob#2222' }, startedAt: at(12), ...over })
  assert.equal(setFor({ opp: { name: 'Bob' } }, prev, 'd'), null)
  assert.equal(setFor({ match: { room: 'R' }, opp: {} }, prev, 'd'), null)
  assert.equal(setFor(rematch({ opp: { name: 'Carol#3333' } }), prev, 'd'), null)
  const late = new Date(Date.parse(at(10)) + REMATCH_GAP_MS + 60_000).toISOString()
  assert.equal(setFor(rematch({ startedAt: late }), prev, 'd'), null)
  assert.equal(setFor(rematch({ match: {} }), prev, 'd'), null, 'not a rematch')
  assert.equal(setFor(rematch(), { ...prev, set: null }, 'd'), null, 'previous game had no set')
  assert.equal(setFor(rematch(), { ...prev, set: { ...prev.set, game: 9 } }, 'd').game, 9, 'capped at 9')
})

test('eventFields: sim games send kind only; event games the event, set and game', () => {
  assert.deepEqual(eventFields({}), { kind: 'sim' })
  assert.deepEqual(eventFields({ match: { source: 'queue' } }), { kind: 'sim', match_source: 'queue' })
  assert.deepEqual(eventFields({ event: EV, set: { id: 's_abc', room: 'ROOM1', game: 2 }, match: { source: 'private', room: 'ROOM1' } }), {
    kind: 'event',
    event: EV,
    set_id: 's_abc',
    game_in_set: 2,
    match_source: 'private',
  })
  assert.deepEqual(eventFields({ event: { client_id: 'bad id', name: 'x' } }), { kind: 'sim' })
  const sent = JSON.stringify(eventFields({ event: EV, set: { id: 's_abc', room: 'ROOM1', game: 1 }, opp: { name: 'Bob#2222' } }))
  assert.ok(!sent.includes('ROOM1') && !sent.includes('Bob'), 'no room code or opponent name')
})

test('needsRetag and filedAs', () => {
  assert.equal(filedAs('event', { event: EV }), `event:${EV.client_id}`)
  assert.equal(filedAs('sim', { event: EV }), 'sim', 'server filed it as sim')
  assert.equal(filedAs('event', null), 'sim')
  const metas = [
    { id: 'a', crewlog: { gameId: 'g1', filed: 'sim' } }, // fine
    { id: 'b', event: EV, crewlog: { gameId: 'g2', filed: 'sim' } }, // tagged afterwards
    { id: 'c', crewlog: { gameId: 'g3', filed: `event:${EV.client_id}` } }, // untagged afterwards
    { id: 'd', event: EV, crewlog: { gameId: 'g4', filed: 'sim', failedFor: `event:${EV.client_id}` } }, // already failed
    { id: 'e', event: EV }, // never logged
  ]
  assert.deepEqual(
    needsRetag(metas).map((m) => m.id),
    ['b', 'c'],
  )
})

test('knownEvents: newest first, latest name wins, current event included', () => {
  const metas = [
    { event: EV, startedAt: at(0) },
    { event: { ...EV, name: 'Weekly Bash 12' }, startedAt: at(30) },
    { event: { client_id: 'ev_old', name: 'Old Cup' }, startedAt: '2026-10-01T00:00:00.000Z' },
    { startedAt: at(40) },
  ]
  assert.deepEqual(
    knownEvents(metas).map((e) => [e.client_id, e.name, e.games]),
    [
      [EV.client_id, 'Weekly Bash 12', 2],
      ['ev_old', 'Old Cup', 1],
    ],
  )
  const cur = knownEvents(metas, { client_id: 'ev_new', name: 'New Open' })
  assert.equal(cur[0].client_id, 'ev_new')
  assert.equal(cur[0].games, 0)
})

test('retagged swaps match/event tags and keeps the rest', () => {
  const m = { tags: ['win', 'queue', 'event:old'], match: { source: 'private' }, event: EV }
  assert.deepEqual(retagged(m), ['win', 'private', 'event:weekly bash #12'])
  assert.deepEqual(retagged({ tags: ['win', 'event:old'] }), ['win'])
})

test('setLabel stays local', () => {
  assert.equal(setLabel({ set: { game: 2 }, opp: { name: 'Bob#2222' } }), 'vs Bob · G2')
  assert.equal(setLabel({}), '')
})
