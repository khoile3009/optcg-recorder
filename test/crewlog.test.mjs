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
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
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
  assert.equal(normalizeBase(''), 'https://getcrewlog.com')
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
  assert.equal(classify(401), 'unauthorized')
  assert.equal(classify(403), 'suspended')
  assert.equal(classify(422), 'rejected')
  for (const s of [400, 413, 404]) assert.equal(classify(s), 'bug')
  for (const s of [0, 408, 429, 500, 503]) assert.equal(classify(s), 'retry')
  assert.deepEqual([1, 2, 3, 4, 5, 6, 9].map(retryDelay), [...BACKOFF_MS, BACKOFF_MS[4], BACKOFF_MS[4]])
})

// ─── the connector ──────────────────────────────────────────────────────────

test('logs a game: Bearer to the configured base only, event with link', async () => {
  const h = harness({ responses: [ok({ new_session: true })] })
  const r = await h.c.enqueue(meta(), LEADERS)
  assert.deepEqual(r, { queued: 'abc123' })
  await h.settle()
  assert.equal(h.calls.length, 1)
  const call = h.calls[0]
  assert.equal(call.url, 'https://getcrewlog.com/api/recorder/games')
  assert.equal(call.method, 'POST')
  assert.equal(call.headers.Authorization, `Bearer ${CODE}`)
  assert.equal(call.redirect, 'error')
  assert.equal(call.body.game_id, 'abc123')
  const logged = h.events.find((e) => e.type === 'logged')
  assert.equal(logged.url, 'https://getcrewlog.com/e/1')
  assert.equal(logged.newSession, true)
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
