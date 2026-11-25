import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BACKOFF_MS,
  MAX_AGE_MS,
  buildGame,
  classify,
  createCrewlog,
  normalizeBase,
  resolveLeader,
  cleanEventRow,
  eventBody,
  retryDelay,
} from '../src/crewlog.mjs'

const CODE = 'crw_' + 'a'.repeat(40)
const LEADERS = [
  { id: 'OP01-001', name: 'Roronoa Zoro' },
  { id: 'OP01-060', name: 'Donquixote Doflamingo' },
  { id: 'ST01-001', name: 'Monkey.D.Luffy' },
  { id: 'OP05-060', name: 'Monkey.D.Luffy' },
]

const meta = (over = {}) => ({
  id: 'rec-1',
  gameId: 'abc123',
  startedAt: new Date(2026, 10, 24, 23, 30).toISOString(),
  me: { name: 'me', leaderId: 'OP01-001', leaderName: 'Roronoa Zoro' },
  opp: { name: 'them', leaderId: null, leaderName: 'Donquixote Doflamingo' },
  firstSeat: 1,
  winnerSeat: 1,
  ...over,
})

/** A connector wired to fakes. `responses` is a queue of {status, body} | Error. */
function harness({ responses = [], code = CODE, base = 'https://getcrewlog.com', stored = [] } = {}) {
  const calls = []
  const timers = []
  const events = []
  const saved = []
  const clock = { t: Date.UTC(2026, 10, 24, 12) }
  const cfg = { base, code }
  const fetch = async (url, init) => {
    calls.push({ url, ...init, body: init.body ? JSON.parse(init.body) : undefined })
    const r = responses.shift() ?? { status: 500, body: { error: 'no more fake responses' } }
    if (r instanceof Error) throw r
    const headers = new Map(Object.entries(r.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v]))
    return {
      status: r.status,
      type: r.type ?? 'basic',
      ok: r.status >= 200 && r.status < 300,
      headers: { get: (k) => headers.get(k.toLowerCase()) ?? null },
      json: async () => {
        if (r.body === undefined) throw new Error('no json')
        return r.body
      },
    }
  }
  const c = createCrewlog({
    fetch,
    getConfig: () => cfg,
    load: () => stored,
    save: async (o) => saved.push(o),
    now: () => clock.t,
    setTimer: (fn, ms) => {
      const t = { fn, ms }
      timers.push(t)
      return t
    },
    clearTimer: (t) => {
      const i = timers.indexOf(t)
      if (i >= 0) timers.splice(i, 1)
    },
    onEvent: (e) => events.push(e),
  })
  const settle = () => new Promise((r) => setImmediate(r))
  return { c, calls, timers, events, saved, clock, cfg, settle, responses }
}

const ok = (over = {}) => ({
  status: 200,
  body: { event_id: 'e1', round: 1, handle: 'khoi', duplicate: false, new_session: false, url: 'https://getcrewlog.com/e/1', ...over },
})

// ─── pure helpers ────────────────────────────────────────────────────────────

test('normalizeBase: https anywhere, http only on this machine, no paths', () => {
  assert.equal(normalizeBase(''), 'https://www.getcrewlog.com')
  assert.equal(normalizeBase('  https://getcrewlog.com/ '), 'https://getcrewlog.com')
  assert.equal(normalizeBase('http://localhost:3000'), 'http://localhost:3000')
  assert.equal(normalizeBase('http://127.0.0.1:3000'), 'http://127.0.0.1:3000')
  assert.equal(normalizeBase('http://getcrewlog.com'), null)
  assert.equal(normalizeBase('https://getcrewlog.com/api'), null)
  assert.equal(normalizeBase('https://u:p@getcrewlog.com'), null)
  assert.equal(normalizeBase('https://getcrewlog.com?x=1'), null)
  assert.equal(normalizeBase('ftp://getcrewlog.com'), null)
  assert.equal(normalizeBase('not a url'), null)
})

test('resolveLeader: card id wins, names map only when unique', () => {
  assert.equal(resolveLeader({ leaderId: 'OP01-001' }, LEADERS), 'OP01-001')
  assert.equal(resolveLeader({ leaderId: 'EB01-001_p1' }, LEADERS), 'EB01-001')
  assert.equal(resolveLeader({ leaderName: 'roronoa zoro' }, LEADERS), 'OP01-001')
  assert.equal(resolveLeader({ leaderName: 'Donquixote  Doflamingo' }, LEADERS), 'OP01-060')
  assert.equal(resolveLeader({ leaderName: 'Monkey.D.Luffy' }, LEADERS), null, 'two Luffys: ambiguous')
  assert.equal(resolveLeader({ leaderName: 'Nobody' }, LEADERS), null)
  assert.equal(resolveLeader({ leaderId: 'Roronoa Zoro' }, LEADERS), 'OP01-001', 'a name in the id slot')
  assert.equal(resolveLeader(null, LEADERS), null)
})

test('buildGame: the body Crewlog expects', () => {
  const { body } = buildGame(meta(), LEADERS)
  assert.deepEqual(body, {
    game_id: 'abc123',
    played_on: '2026-11-24', // local date, even late at night
    my_leader: 'OP01-001',
    opp_leader: 'OP01-060',
    result: 'W',
    went_first: true,
  })
  const b2 = buildGame(meta({ winnerSeat: 2, firstSeat: 2, gameId: null }), LEADERS).body
  assert.equal(b2.result, 'L')
  assert.equal(b2.went_first, false)
  assert.equal(b2.game_id, 'rec-1', 'falls back to the recording id')
  assert.equal('went_first' in buildGame(meta({ firstSeat: null }), LEADERS).body, false)
  assert.equal(buildGame(meta({ gameId: 'x'.repeat(300) }), LEADERS).body.game_id.length, 100)
})

test('buildGame: refuses what it cannot log', () => {
  assert.equal(buildGame(meta({ winnerSeat: null }), LEADERS).error, 'no result')
  const opp = { leaderId: null, leaderName: 'Monkey.D.Luffy' }
  assert.equal(buildGame(meta({ opp }), LEADERS).error, "Can't log, unknown leader")
  assert.equal(buildGame(meta({ gameId: null, id: null }), LEADERS).error, 'no game id')
})

test('classify + retryDelay', () => {
  assert.equal(classify(200), 'ok')
  assert.equal(classify(308), 'moved')
  assert.equal(classify(401), 'unauthorized')
  assert.equal(classify(403), 'suspended')
  assert.equal(classify(422), 'rejected')
  for (const s of [400, 413, 404]) assert.equal(classify(s), 'bug')
  for (const s of [0, 408, 429, 500, 503]) assert.equal(classify(s), 'retry')
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map(retryDelay), [...BACKOFF_MS, BACKOFF_MS[4], BACKOFF_MS[4]])
})

// ─── the connector ──────────────────────────────────────────────────────────

test('logs a game: Bearer to the configured base only, event with link', async () => {
  const h = harness({ responses: [ok()] })
  const r = await h.c.enqueue(meta(), LEADERS)
  assert.deepEqual(r, { queued: 'abc123' })
  await h.settle()
  assert.equal(h.calls.length, 1)
  const call = h.calls[0]
  assert.equal(call.url, 'https://getcrewlog.com/api/recorder/games')
  assert.equal(call.method, 'POST')
  assert.equal(call.headers.Authorization, `Bearer ${CODE}`)
  assert.equal(call.redirect, 'manual')
  assert.equal(call.body.game_id, 'abc123')
  const logged = h.events.find((e) => e.type === 'logged')
  assert.equal(logged.url, 'https://getcrewlog.com/e/1')
  assert.equal(h.c.state().pending, 0)
  assert.equal(h.c.state().handle, 'khoi')
  assert.ok(!JSON.stringify(h.saved).includes(CODE), 'the code never lands in the outbox file')
})

test('duplicate=true counts as success', async () => {
  const h = harness({ responses: [ok({ duplicate: true })] })
  await h.c.enqueue(meta(), LEADERS)
  await h.settle()
  assert.equal(h.events.find((e) => e.type === 'logged').duplicate, true)
  assert.equal(h.c.state().pending, 0)
})

test('dedupe: the same game queued twice is one outbox entry', async () => {
  const h = harness({ code: null })
  await h.c.enqueue(meta(), LEADERS)
  await h.c.enqueue(meta({ id: 'rec-2' }), LEADERS)
  assert.equal(h.c._outbox().length, 1)
  assert.equal(h.calls.length, 0, 'no code: nothing sent')
})

test('unknown leader: not queued, UI told', async () => {
  const h = harness()
  const r = await h.c.enqueue(meta({ opp: { leaderName: 'Monkey.D.Luffy' } }), LEADERS)
  assert.equal(r.error, "Can't log, unknown leader")
  assert.equal(h.c._outbox().length, 0)
  assert.ok(h.events.some((e) => e.type === 'unknownLeader' && e.recId === 'rec-1'))
})

test('5xx / network: backs off 5s, 30s, 2m, 10m, then every 30m; same game_id each retry', async () => {
  const h = harness({ responses: [new TypeError('fetch failed'), { status: 502 }, { status: 503 }, { status: 500 }, { status: 500 }, { status: 500 }] })
  await h.c.enqueue(meta(), LEADERS)
  await h.settle()
  const delays = []
  for (let i = 0; i < 6; i++) {
    assert.equal(h.timers.length, 1, `one timer armed after attempt ${i + 1}`)
    const t = h.timers.pop()
    delays.push(t.ms)
    h.clock.t += t.ms
    if (i < 5) {
      t.fn()
      await h.settle()
      await h.settle()
    }
  }
  assert.deepEqual(delays, [5_000, 30_000, 120_000, 600_000, 1_800_000, 1_800_000])
  assert.equal(new Set(h.calls.map((c) => c.body.game_id)).size, 1)
  assert.equal(h.c.state().pending, 1)
  assert.match(h.c.state().retryError, /Crewlog answered 500|network error/)
})

test('a retry that lands logs and empties the outbox', async () => {
  const h = harness({ responses: [{ status: 503, body: { error: 'down', code: 'x' } }, ok()] })
  await h.c.enqueue(meta(), LEADERS)
  await h.settle()
  assert.equal(h.c.state().retryError, 'down')
  const t = h.timers.pop()
  h.clock.t += t.ms
  t.fn()
  await h.settle()
  await h.settle()
  assert.equal(h.c.state().pending, 0)
  assert.equal(h.timers.length, 0)
})

for (const [status, bug] of [
  [422, false],
  [400, true],
  [413, true],
]) {
  test(`${status}: drops the game and says why${bug ? ' (logged as a bug)' : ''}`, async () => {
    const h = harness({ responses: [{ status, body: { error: `nope ${status}`, code: 'bad' } }] })
    await h.c.enqueue(meta(), LEADERS)
    await h.settle()
    const d = h.events.find((e) => e.type === 'dropped')
    assert.equal(d.error, `nope ${status}`, 'server error shown verbatim')
    assert.equal(d.bug, bug)
    assert.equal(h.c.state().pending, 0)
    assert.equal(h.timers.length, 0, 'no retry')
  })
}

for (const [status, kind] of [
  [401, 'unauthorized'],
  [403, 'suspended'],
]) {
  test(`${status}: stops sending, keeps the outbox`, async () => {
    const h = harness({ responses: [{ status, body: { error: 'Code revoked', code: 'x' } }] })
    await h.c.enqueue(meta(), LEADERS)
    await h.c.enqueue(meta({ gameId: 'g2' }), LEADERS)
    await h.settle()
    await h.settle()
    assert.equal(h.calls.length, 1, 'second game not attempted once blocked')
    const s = h.c.state()
    assert.equal(s.blocked, kind)
    assert.equal(s.error, 'Code revoked')
    assert.equal(s.pending, 2)
    assert.equal(h.timers.length, 0)
    await h.c.flush()
    assert.equal(h.calls.length, 1, 'flush is a no-op while blocked')
  })
}

test('new code (reset) after 401 sends the kept outbox', async () => {
  const h = harness({ responses: [{ status: 401, body: { error: 'bad code' } }, ok(), ok()] })
  await h.c.enqueue(meta(), LEADERS)
  await h.c.enqueue(meta({ gameId: 'g2' }), LEADERS)
  await h.settle()
  h.cfg.code = 'crw_' + 'b'.repeat(40)
  h.c.reset()
  await h.settle()
  await h.settle()
  assert.equal(h.c.state().pending, 0)
  assert.equal(h.calls.at(-1).headers.Authorization, `Bearer ${h.cfg.code}`)
})

test('flush on start sends stored entries and drops ones older than 30 days', async () => {
  const now = Date.UTC(2026, 10, 24, 12)
  const body = (id) => ({ game_id: id, played_on: '2026-10-01', my_leader: 'OP01-001', opp_leader: 'OP01-060', result: 'W' })
  const stored = [
    { body: body('old'), createdAt: now - MAX_AGE_MS - 1, attempts: 3, nextAt: 0 },
    { body: body('fresh'), createdAt: now - 1000, attempts: 1, nextAt: 0 },
    { junk: true },
  ]
  const h = harness({ stored, responses: [ok()] })
  await h.c.flush()
  assert.deepEqual(h.calls.map((c) => c.body.game_id), ['fresh'])
  assert.equal(h.c.state().pending, 0)
  assert.deepEqual(h.saved.at(-1), [])
})

test('check(): 200 connects, 401 blocks, never sends to a bad base', async () => {
  const h = harness({ responses: [{ status: 200, body: { handle: 'khoi' } }, { status: 401, body: { error: 'Unknown code', code: 'x' } }] })
  assert.deepEqual(await h.c.check(), { ok: true, handle: 'khoi' })
  assert.equal(h.calls[0].url, 'https://getcrewlog.com/api/recorder/me')
  assert.equal(h.calls[0].method, 'GET')
  assert.equal(h.c.state().connected, true)
  const r = await h.c.check()
  assert.equal(r.ok, false)
  assert.equal(r.error, 'Unknown code')
  assert.equal(h.c.state().blocked, 'unauthorized')
  assert.equal(h.c.state().connected, false)

  h.cfg.base = 'http://evil.example'
  const bad = await h.c.check()
  assert.equal(bad.error, 'Bad Crewlog URL')
  assert.equal(h.calls.length, 2, 'nothing sent to a non-local http host')
})

test('check() after a 401 with a new code unblocks and flushes', async () => {
  const h = harness({ responses: [{ status: 401, body: { error: 'x' } }, { status: 200, body: { handle: 'khoi' } }, ok()] })
  await h.c.enqueue(meta(), LEADERS)
  await h.settle()
  assert.equal(h.c.state().blocked, 'unauthorized')
  await h.c.check()
  await h.settle()
  await h.settle()
  assert.equal(h.c.state().pending, 0)
})

test('a redirect is never followed: it blocks with the new address and keeps the game', async () => {
  const h = harness({
    responses: [
      { status: 308, headers: { Location: 'https://www.getcrewlog.com/api/recorder/games' } },
      { status: 200, body: { handle: 'khoi' } },
      ok(),
    ],
  })
  await h.c.enqueue(meta(), LEADERS)
  await h.settle()
  assert.equal(h.calls.length, 1, 'nothing sent to the redirect target')
  assert.equal(h.c.state().blocked, 'moved')
  assert.equal(h.c.state().error, 'Crewlog moved to https://www.getcrewlog.com. Update the Crewlog address in Settings.')
  assert.equal(h.c.state().pending, 1, 'the game waits for the new address')
  assert.equal(h.events.some((e) => e.type === 'dropped'), false)

  h.cfg.base = 'https://www.getcrewlog.com'
  assert.equal((await h.c.check()).ok, true)
  await h.settle()
  await h.settle()
  assert.equal(h.calls[1].url, 'https://www.getcrewlog.com/api/recorder/me')
  assert.equal(h.calls[2].url, 'https://www.getcrewlog.com/api/recorder/games')
  assert.equal(h.c.state().pending, 0)
})

test('check(): an opaque redirect (no Location) still reads as moved, not a network error', async () => {
  const h = harness({ responses: [{ status: 0, type: 'opaqueredirect' }] })
  const r = await h.c.check()
  assert.equal(r.ok, false)
  assert.equal(r.error, 'Crewlog answered with a redirect. Update the Crewlog address in Settings.')
  assert.equal(h.c.state().blocked, 'moved')
})

test('check(): a fetch that throws on a redirect reads as moved, not a network error', async () => {
  const h = harness({ responses: [new Error('Redirect was cancelled')] })
  const r = await h.c.check()
  assert.equal(r.error, 'Crewlog answered with a redirect. Update the Crewlog address in Settings.')
  assert.equal(h.c.state().blocked, 'moved')
})

// ─── event picker ───────────────────────────────────────────────────────────
const me200 = (features) => ({ status: 200, body: { handle: 'khoi', ...(features ? { features } : {}) } })
const ROWS = [
  { id: 'ev_sim1', name: 'Sim grind', kind: 'sim', played_on: '2026-11-24', rounds: 3, wins: 2, losses: 1 },
  { id: 'ev_t1', name: 'Weekly Cup', kind: 'tournament', category: 'locals', my_leader: 'OP01-001', played_on: '2026-11-25' },
]

test('picker support comes from /me features', async () => {
  const h = harness({ responses: [me200(['event_picker']), me200()] })
  assert.equal(h.c.pickerSupported(), false, 'unknown before /me')
  await h.c.check()
  assert.equal(h.c.pickerSupported(), true)
  assert.equal(h.c.state().picker, true)
  h.c.reset()
  assert.equal(h.c.pickerSupported(), false, 'reset forgets features')
  await h.c.check()
  assert.equal(h.c.pickerSupported(), false)
})

test('events(): GET /events with the Bearer, rows cleaned', async () => {
  const h = harness({ responses: [{ status: 200, body: { events: [...ROWS, { id: 'bad id!' }, null] } }] })
  const r = await h.c.events()
  assert.equal(h.calls[0].url, 'https://getcrewlog.com/api/recorder/events')
  assert.equal(h.calls[0].method, 'GET')
  assert.equal(h.calls[0].headers.Authorization, `Bearer ${CODE}`)
  assert.equal(r.ok, true)
  assert.deepEqual(
    r.events.map((e) => [e.id, e.kind]),
    [
      ['ev_sim1', 'sim'],
      ['ev_t1', 'tournament'],
    ],
  )
  assert.equal(r.events[1].my_leader, 'OP01-001')
  assert.equal(r.events[0].wins, 2)
})

test('events(): unreadable list, 401 blocks, and no request while blocked', async () => {
  const h = harness({ responses: [{ status: 200, body: { nope: 1 } }, { status: 401, body: { error: 'Unknown code' } }] })
  assert.equal((await h.c.events()).ok, false)
  const r = await h.c.events()
  assert.equal(r.error, 'Unknown code')
  assert.equal(h.c.state().blocked, 'unauthorized')
  await h.c.events()
  assert.equal(h.calls.length, 2)
})

test('cleanEventRow defaults and limits', () => {
  assert.equal(cleanEventRow(null), null)
  assert.equal(cleanEventRow({ id: 'x y' }), null)
  const r = cleanEventRow({ id: 'e1', kind: 'weird', rounds: -2, wins: 1.5, played_on: 'tomorrow', name: 'n'.repeat(500) })
  assert.equal(r.kind, 'tournament')
  assert.equal(r.rounds, 0)
  assert.equal(r.wins, 0)
  assert.equal(r.played_on, null)
  assert.equal(r.name.length, 120)
  assert.equal(cleanEventRow({ id: 'e2' }).name, 'Untitled event')
})

test('eventBody keeps only valid set fields', () => {
  assert.deepEqual(eventBody('e1'), { event_id: 'e1' })
  assert.deepEqual(eventBody('e1', { set_id: 's_1', game_in_set: 2, match_source: 'private' }), {
    event_id: 'e1',
    set_id: 's_1',
    game_in_set: 2,
    match_source: 'private',
  })
  assert.deepEqual(eventBody('e1', { set_id: 'bad id', game_in_set: 2, match_source: 'lobby' }), { event_id: 'e1' })
  assert.deepEqual(eventBody('e1', { set_id: 's_1', game_in_set: 12 }), { event_id: 'e1', set_id: 's_1' })
})

test('picked event: event_id and set fields in the POST, logged carries the round', async () => {
  const h = harness({ responses: [ok({ event_id: 'ev_t1', event_name: 'Weekly Cup', kind: 'tournament', round: 2, round_result: 'W' })] })
  await h.c.enqueue(meta(), LEADERS, eventBody('ev_t1', { set_id: 's_1', game_in_set: 1, match_source: 'private' }))
  await h.settle()
  const body = h.calls[0].body
  assert.equal(body.event_id, 'ev_t1')
  assert.equal(body.set_id, 's_1')
  assert.equal(body.game_in_set, 1)
  assert.equal(body.match_source, 'private')
  assert.equal(body.game_id, 'abc123')
  const logged = h.events.find((e) => e.type === 'logged')
  assert.equal(logged.eventId, 'ev_t1')
  assert.equal(logged.eventName, 'Weekly Cup')
  assert.equal(logged.kind, 'tournament')
  assert.equal(logged.round, 2)
  assert.equal(logged.roundResult, 'W')
})

test('a duplicate to a picked event is a success', async () => {
  const h = harness({ responses: [ok({ duplicate: true, event_id: 'ev_t1' })] })
  await h.c.enqueue(meta(), LEADERS, eventBody('ev_t1'))
  await h.settle()
  assert.equal(h.events.find((e) => e.type === 'logged').duplicate, true)
  assert.equal(h.c.state().pending, 0)
  assert.equal(h.c.state().waiting, 0)
})

for (const [status, code] of [
  [404, 'unknown_event'],
  [422, 'event_closed'],
]) {
  test(`${code}: the game waits, eventGone fires, assignWaiting sends it on`, async () => {
    const h = harness({ responses: [{ status, body: { error: 'gone', code } }, ok({ event_id: 'ev_2' })] })
    await h.c.enqueue(meta(), LEADERS, eventBody('ev_1'))
    await h.settle()
    const gone = h.events.find((e) => e.type === 'eventGone')
    assert.deepEqual([gone.reason, gone.eventId], [code, 'ev_1'])
    const st = h.c.state()
    assert.deepEqual([st.waiting, st.pending, st.waitingReason], [1, 0, code])
    assert.equal(h.timers.length, 0, 'no retry timer for a waiting game')
    await h.c.flush()
    assert.equal(h.calls.length, 1, 'flush leaves waiting games alone')
    assert.equal(await h.c.assignWaiting('ev_2'), 1)
    await h.settle()
    assert.equal(h.calls[1].body.event_id, 'ev_2')
    assert.equal(h.c.state().waiting, 0)
    assert.ok(h.events.some((e) => e.type === 'logged' && e.eventId === 'ev_2'))
  })
}

test('leader_mismatch waits; assignWaiting skips the event that refused it', async () => {
  const h = harness({ responses: [{ status: 422, body: { error: 'Wrong leader', code: 'leader_mismatch' } }, ok({ event_id: 'ev_2' })] })
  await h.c.enqueue(meta(), LEADERS, eventBody('ev_1'))
  await h.settle()
  assert.ok(h.events.some((e) => e.type === 'leaderMismatch' && e.eventId === 'ev_1'))
  assert.equal(h.c.state().waitingReason, 'leader_mismatch')
  assert.equal(await h.c.assignWaiting('ev_1'), 0)
  assert.equal(h.calls.length, 1)
  assert.equal(await h.c.assignWaiting('ev_2'), 1)
  await h.settle()
  assert.equal(h.calls[1].body.event_id, 'ev_2')
})

test('discardWaiting drops waiting games only', async () => {
  const h = harness({ responses: [{ status: 422, body: { error: 'closed', code: 'event_closed' } }, new Error('offline')] })
  await h.c.enqueue(meta(), LEADERS, eventBody('ev_1'))
  await h.settle()
  await h.c.enqueue(meta({ id: 'rec-2', gameId: 'def456' }), LEADERS, eventBody('ev_1'))
  await h.settle()
  assert.deepEqual([h.c.state().waiting, h.c.state().pending], [1, 1])
  assert.equal(await h.c.discardWaiting(), 1)
  assert.deepEqual([h.c.state().waiting, h.c.state().pending], [0, 1])
})

test('bad_set_id: resent once right away without the set fields', async () => {
  const h = harness({ responses: [{ status: 422, body: { error: 'bad set', code: 'bad_set_id' } }, ok({ event_id: 'ev_1' })] })
  await h.c.enqueue(meta(), LEADERS, eventBody('ev_1', { set_id: 's_1', game_in_set: 2, match_source: 'queue' }))
  await h.settle()
  assert.equal(h.calls.length, 2)
  assert.equal(h.calls[1].body.set_id, undefined)
  assert.equal(h.calls[1].body.game_in_set, undefined)
  assert.equal(h.calls[1].body.match_source, 'queue')
  assert.equal(h.calls[1].body.event_id, 'ev_1')
  assert.equal(h.c.state().pending, 0)
})

test('bad_set_id twice: the second refusal drops the game', async () => {
  const bad = { status: 422, body: { error: 'bad set', code: 'bad_set_id' } }
  const h = harness({ responses: [bad, bad] })
  await h.c.enqueue(meta(), LEADERS, eventBody('ev_1', { set_id: 's_1' }))
  await h.settle()
  assert.equal(h.calls.length, 2)
  assert.ok(h.events.some((e) => e.type === 'dropped'))
  assert.equal(h.c.state().pending, 0)
})

test('event_required is dropped as our bug', async () => {
  const h = harness({ responses: [{ status: 422, body: { error: 'Pick an event', code: 'event_required' } }] })
  await h.c.enqueue(meta(), LEADERS)
  await h.settle()
  const d = h.events.find((e) => e.type === 'dropped')
  assert.equal(d.bug, true)
  assert.equal(h.c.state().pending, 0)
  assert.equal(h.c.state().waiting, 0)
})

test('waiting games survive a restart', async () => {
  const h = harness({ responses: [{ status: 404, body: { error: 'gone', code: 'unknown_event' } }] })
  await h.c.enqueue(meta(), LEADERS, eventBody('ev_1'))
  await h.settle()
  const stored = h.saved[h.saved.length - 1]
  const h2 = harness({ stored, responses: [] })
  assert.equal(h2.c.state().waiting, 1)
  await h2.c.flush()
  assert.equal(h2.calls.length, 0)
})
