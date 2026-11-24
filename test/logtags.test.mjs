import test from 'node:test'
import assert from 'node:assert/strict'
import { countEndTurns, backfillResult, logEvents, quitMidGame, matchesQuery, matchupStats, parseLog, parseLogFileName, tagsFor, titleFor, turnsStarted } from '../src/logtags.mjs'

const b64 = (s) => Buffer.from(s).toString('base64')
const ZW = '​'

// Synthetic players only: never commit real logs (they contain other people's names).
function fakeLog({ chooser = 'Alice', choice = 'Second', end = 'RZ1|END|99|1|win|abc' } = {}) {
  return [
    'RZ1|META|deadbeef|0',
    'RZ1|PLY|1||',
    'RZ1|PLY|2||',
    `RZ1|PLY|1|Alice${ZW}#1111|OP15-058`,
    `RZ1|PLY|2|Bob${ZW}#2222|OP17-039`,
    `[Alice${ZW}#1111] Leader is Enel [<mark><link="OP15-058">OP15-058</link></mark>]`,
    `[Bob${ZW}#2222] Leader is Monkey.D.Luffy [<mark><link="OP17-039">OP17-039</link></mark>]`,
    `[${chooser}${ZW}#${chooser === 'Alice' ? '1111' : '2222'}] Chose to go ${choice}`,
    `RZ1|SEM|10|2|${b64('Log.EndTurn')}|x`,
    `RZ1|SEM|20|1|${b64('Log.EndTurn')}|x`,
    `RZ1|SEM|30|2|${b64('Log.EndTurn')}|x`,
    end,
  ]
    .filter(Boolean)
    .join('\r\n')
}

test('file names', () => {
  assert.deepEqual(parseLogFileName('2026-11-16T22.15.11.3743364-549c8e86.log'), {
    startedAt: '2026-11-16T22:15:11',
    gameId: '549c8e86',
    partial: false,
  })
  assert.equal(parseLogFileName('2026-11-16T22.15.11.3743364-549c8e86.partial.log').partial, true)
  assert.equal(parseLogFileName('notes.txt'), null)
})

test('parses players, leaders, turn order and result', () => {
  const g = parseLog(fakeLog())
  assert.equal(g.me.name, 'Alice#1111')
  assert.equal(g.me.leaderName, 'Enel')
  assert.equal(g.opp.leaderId, 'OP17-039')
  assert.equal(g.opp.leaderName, 'Monkey.D.Luffy')
  assert.equal(g.firstSeat, 2) // Alice chose second
  assert.equal(g.winnerSeat, 1)
  assert.equal(g.endReason, 'win')
  assert.equal(g.turns, 4)
  assert.equal(countEndTurns(fakeLog()), 3)
})

test('opponent choosing first', () => {
  assert.equal(parseLog(fakeLog({ chooser: 'Bob', choice: 'First' })).firstSeat, 2)
  assert.equal(parseLog(fakeLog({ chooser: 'Bob', choice: 'Second' })).firstSeat, 1)
})

test('tags and title', () => {
  const g = parseLog(fakeLog())
  assert.deepEqual(tagsFor(g), ['leader:Enel', 'opp:Monkey.D.Luffy', 'vs:Bob', '2nd', 'win'])
  assert.equal(titleFor(g), 'Enel vs Monkey.D.Luffy · 2nd · W')
  const unfinished = parseLog(fakeLog({ end: '' }))
  assert.ok(tagsFor(unfinished).includes('unfinished'))
  const conceded = parseLog(fakeLog({ end: 'RZ1|END|99|2|concede|x' }))
  assert.ok(tagsFor(conceded).includes('loss'))
  assert.ok(tagsFor(conceded).includes('i conceded'))
})

test('search', () => {
  const g = parseLog(fakeLog())
  const rec = { ...g, tags: tagsFor(g), title: titleFor(g), userTags: ['mulligan'], notes: 'misplayed turn 3' }
  assert.ok(matchesQuery(rec, ''))
  assert.ok(matchesQuery(rec, 'opp:luffy'))
  assert.ok(matchesQuery(rec, 'leader:enel 2nd win'))
  assert.ok(!matchesQuery(rec, 'leader:luffy'))
  assert.ok(!matchesQuery(rec, '1st'))
  assert.ok(matchesQuery(rec, 'opp:monkey.d'))
  assert.ok(matchesQuery(rec, 'OP17-039'))
  assert.ok(matchesQuery(rec, 'mulligan misplayed'))
})

import { matchesFilters, recordStats } from '../src/logtags.mjs'
import { LEADERS } from '../src/data/leaders.mjs'

test('matchesFilters combines leader, order, result, star, user tags and text', () => {
  const rec = {
    me: { name: 'Alice#1', leaderId: 'OP01-001', leaderName: 'Roronoa Zoro' },
    opp: { name: 'Bob#2', leaderId: 'OP02-001', leaderName: 'Edward Newgate' },
    firstSeat: 2,
    winnerSeat: 1,
    starred: true,
    tags: ['leader:Roronoa Zoro', 'opp:Edward Newgate', '2nd', 'win'],
    userTags: ['Locals'],
  }
  assert.ok(matchesFilters(rec, {}))
  assert.ok(matchesFilters(rec, { me: ['OP01-001'], opp: ['OP09-001', 'OP02-001'], order: '2nd', result: 'win', starred: true }))
  assert.ok(matchesFilters(rec, { userTags: ['locals'], text: 'bob' }))
  assert.ok(!matchesFilters(rec, { me: ['OP02-001'] }))
  assert.ok(!matchesFilters(rec, { order: '1st' }))
  assert.ok(!matchesFilters(rec, { result: 'loss' }))
  assert.ok(!matchesFilters(rec, { userTags: ['misplay'] }))
  assert.ok(!matchesFilters({ ...rec, starred: false }, { starred: true }))
  assert.ok(!matchesFilters(rec, { misplays: true }))
  const marked = { ...rec, misplays: [{ t: 221, turn: 6, note: 'Attacked into 7k leader' }] }
  assert.ok(matchesFilters(marked, { misplays: true, text: '7k' }))
  assert.ok(!matchesFilters(marked, { text: 'counter' }))
})

test('recordStats splits wins by turn order and skips unfinished games', () => {
  const s = recordStats([
    { winnerSeat: 1, firstSeat: 1 },
    { winnerSeat: 2, firstSeat: 1 },
    { winnerSeat: 1, firstSeat: 2 },
    { winnerSeat: null, firstSeat: 2 },
  ])
  assert.deepEqual(s, { games: 4, wins: 2, losses: 1, first: { wins: 1, losses: 1 }, second: { wins: 1, losses: 0 } })
})

test('matchupStats groups by opposing leader, most-played first', () => {
  const g = (opp, winnerSeat, firstSeat) => ({ opp: { leaderId: opp }, winnerSeat, firstSeat })
  const m = matchupStats([g('OP01-001', 1, 1), g('OP02-001', 2, 2), g('OP02-001', 1, 1), g('OP02-001', null, 2), { opp: {} }])
  assert.deepEqual(
    m.map((x) => [x.leaderId, x.games, x.wins, x.losses]),
    [
      ['OP02-001', 3, 1, 1],
      ['OP01-001', 1, 1, 0],
    ],
  )
  assert.deepEqual(m[0].first, { wins: 1, losses: 0 })
  assert.deepEqual(m[0].second, { wins: 0, losses: 1 })
})

test('leader list: unique ids, readable names, known colors', () => {
  const ids = new Set(LEADERS.map((l) => l.id))
  assert.equal(ids.size, LEADERS.length)
  assert.ok(LEADERS.length > 100)
  const colors = new Set(['Red', 'Green', 'Blue', 'Purple', 'Black', 'Yellow'])
  for (const l of LEADERS) {
    assert.match(l.id, /^[A-Z]+\d*-\d{3}$/)
    assert.ok(l.name && !/\.\S/.test(l.name.replace(/\b[A-Z]\. /g, '')), l.name)
    assert.ok(l.colors.every((c) => colors.has(c)), `${l.id} ${l.colors}`)
  }
})

test('parseLeaders reads Leader records from Unity-serialized card data', async () => {
  const { parseLeaders } = await import('../src/leaderdb.mjs')
  const str = (s) => {
    const b = Buffer.from(s, 'utf8')
    const pad = Buffer.alloc((4 - (b.length % 4)) % 4)
    return Buffer.concat([int(b.length), b, pad])
  }
  const int = (...v) => Buffer.concat(v.map((x) => { const b = Buffer.alloc(4); b.writeInt32LE(x); return b }))
  const rec = (id, type, name, colors) =>
    Buffer.concat([str(id), str(id), int(7, type), str(name), int(1, 5, 5000, 0, 2, 11, 12, 0, colors.length, ...colors)])
  const buf = Buffer.concat([Buffer.from('junk'), rec('OP18-022', 0, 'Monkey D. Luffy', [1]), rec('OP18-023', 1, 'Not A Leader', [1]), rec('EB05-010', 0, 'Nico Robin', [1, 5])])
  assert.deepEqual(parseLeaders(buf), [
    { id: 'EB05-010', name: 'Nico Robin', colors: ['Green', 'Yellow'], set: 'EB05' },
    { id: 'OP18-022', name: 'Monkey D. Luffy', colors: ['Green'], set: 'OP18' },
  ])
})

test('turns started: none before the first DON!! draw, then one per end-of-turn', () => {
  const don = `RZ1|SEM|5|1|${b64('Log.DrawDon')}|x`
  const end = (seq) => `RZ1|SEM|${seq}|1|${b64('Log.EndTurn')}|x`
  assert.equal(turnsStarted(['RZ1|META|x|0', 'mulligan...'].join('\n')), 0)
  assert.equal(turnsStarted([don].join('\n')), 1)
  assert.equal(turnsStarted([don, end(6), don, end(7)].join('\n')), 3)
})

test('logEvents: hits, K.O.s, triggers and the end, with turn and side', () => {
  const ref = (name, id) => b64(`${name} [<mark><link="${id}">${id}</link></mark>]`)
  const sem = (seq, seat, key, a = '') => `RZ1|SEM|${seq}|${seat}|${b64(key)}|${a}||-999|-999`
  const lines = (mirror) =>
    [
      `RZ1|PLY|1|Alice${ZW}#1111|OP15-058`,
      `RZ1|PLY|2|Bob${ZW}#2222|${mirror ? 'OP15-058' : 'OP17-039'}`,
      sem(1, 1, 'Log.DrawDon'),
      sem(2, 1, 'Log.EndTurn'),
      sem(3, 0, 'Log.LeaderHit', ref('Enel', 'OP15-058')), // turn 2 (Bob's): Alice's leader hit
      sem(4, 1, 'Log.Destroyed', ref('Gloriosa', 'OP17-046')),
      sem(5, 2, 'Log.EndTurn'),
      sem(6, 2, 'Log.UseTrigger', ref('Cross Guild', 'OP09-057')),
      sem(7, 1, 'Log.Attack'),
      'RZ1|END|8|1|opponent_concede|abc',
    ].join('\r\n')

  assert.deepEqual(logEvents(lines(false)), [
    { type: 'hit', seat: 1, turn: 2, card: 'Enel' },
    { type: 'ko', seat: 1, turn: 2, card: 'Gloriosa' },
    { type: 'trigger', seat: 2, turn: 3, card: 'Cross Guild' },
    { type: 'end', seat: 1, turn: 3, reason: 'opponent_concede' },
  ])
  // Mirror match: the leader can't tell the sides apart, so the non-turn player was hit.
  assert.equal(logEvents(lines(true))[0].seat, 1)
  assert.deepEqual(logEvents(''), [])
})

test('a mid-game quit decides the game when there is no END line', () => {
  const sem = (seq, seat, key) => `RZ1|SEM|${seq}|${seat}|${b64(key)}|||-999|-999`
  const game = (...rest) =>
    [
      `RZ1|PLY|1|Alice${ZW}#1111|OP15-058`,
      `RZ1|PLY|2|Bob${ZW}#2222|OP17-039`,
      sem(1, 1, 'Log.DrawDon'),
      sem(2, 1, 'Log.EndTurn'),
      ...rest,
    ].join('\r\n')

  const oppQuit = game(sem(3, 2, 'Log.Quit'), `[Bob${ZW}#2222] Quits!`, sem(4, 1, 'Log.Quit'))
  const g = parseLog(oppQuit)
  assert.equal(g.winnerSeat, 1)
  assert.equal(g.endReason, 'opponent_quit')
  assert.equal(g.turns, 2)
  assert.ok(tagsFor(g).includes('opp quit'))
  assert.ok(!tagsFor(g).includes('unfinished'))
  assert.ok(quitMidGame(oppQuit))
  assert.deepEqual(logEvents(oppQuit).at(-1), { type: 'end', seat: 1, turn: 2, reason: 'opponent_quit' })
  assert.equal(logEvents(oppQuit).filter((e) => e.type === 'end').length, 1)

  const iQuit = parseLog(game(sem(3, 1, 'Log.Quit')))
  assert.equal(iQuit.winnerSeat, 2)
  assert.ok(tagsFor(iQuit).includes('i quit'))

  // The END line wins over a quit.
  const both = game(sem(3, 1, 'Log.Quit'), 'RZ1|END|5|1|opponent_concede|x')
  assert.equal(parseLog(both).winnerSeat, 1)
  assert.equal(parseLog(both).endReason, 'opponent_concede')
})

test('a quit before the first DON!! draw is not a result', () => {
  const quit = `RZ1|SEM|1|2|${b64('Log.Quit')}|||-999|-999`
  const lobby = [`RZ1|PLY|1|Alice${ZW}#1111|OP15-058`, quit].join('\r\n')
  assert.equal(parseLog(lobby).winnerSeat, null)
  assert.ok(!quitMidGame(lobby))
  assert.deepEqual(logEvents(lobby), [])
  // The sim logs a quit at the top of some normal games; the END line still decides them.
  const normal = [quit, `RZ1|SEM|2|1|${b64('Log.DrawDon')}|x`, 'RZ1|END|9|2|concede|x'].join('\r\n')
  assert.equal(parseLog(normal).winnerSeat, 2)
  assert.equal(parseLog(normal).endReason, 'concede')
})

test('backfillResult fills in a saved game the log now decides, keeping other tags', () => {
  const sem = (seq, seat, key) => `RZ1|SEM|${seq}|${seat}|${b64(key)}|||-999|-999`
  const text = [
    `RZ1|PLY|1|Alice${ZW}#1111|OP15-058`,
    `RZ1|PLY|2|Bob${ZW}#2222|OP17-039`,
    `[Alice${ZW}#1111] Leader is Enel [<mark><link="OP15-058">OP15-058</link></mark>]`,
    `[Bob${ZW}#2222] Leader is Monkey.D.Luffy [<mark><link="OP17-039">OP17-039</link></mark>]`,
    sem(1, 1, 'Log.DrawDon'),
    sem(2, 2, 'Log.Quit'),
  ].join('\r\n')
  const meta = { winnerSeat: null, tags: ['leader:Enel', 'opp:Monkey.D.Luffy', 'vs:Bob', 'unfinished', 'interrupted'] }
  const patch = backfillResult(meta, text)
  assert.equal(patch.winnerSeat, 1)
  assert.equal(patch.endReason, 'opponent_quit')
  assert.deepEqual(patch.tags, ['leader:Enel', 'opp:Monkey.D.Luffy', 'vs:Bob', 'win', 'opp quit', 'interrupted'])
  assert.equal(patch.title, 'Enel vs Monkey.D.Luffy · W')
  assert.equal(backfillResult({ ...meta, winnerSeat: 2 }, text), null)
  assert.equal(backfillResult(meta, text.replace(/\r\nRZ1\|SEM\|2\|.*$/, '')), null)
})

import { parseConnection } from '../src/logtags.mjs'

test('parseConnection: queue vs private room, hosting, rematches', () => {
  const log = (...lines) => ['RZ1|VER|1', ...lines, 'RZ1|TURN|1'].join('\r\n')
  assert.deepEqual(parseConnection(log('RZ1|META|x|4127', 'Attempting to connect to QROOM9')), {
    source: 'queue',
    room: 'QROOM9',
    hosted: false,
    rematch: false,
    matchNo: 4127,
  })
  const hosted = parseConnection(log('RZ1|META|x|0', 'Room ID: ABCD12'))
  assert.equal(hosted.source, 'private')
  assert.equal(hosted.room, 'ABCD12')
  assert.ok(hosted.hosted)
  const re = parseConnection(log('RZ1|META|x|0', 'Ready for Rematch'))
  assert.equal(re.room, null)
  assert.ok(re.rematch)
  assert.equal(parseConnection('no header here').source, null)
  const late = parseConnection(log('RZ1|META|x|0') + '\r\nAttempting to connect to LATER')
  assert.equal(late.room, null, 'lines after the header are ignored')
})

test('matchesFilters: kind, event and match source', () => {
  const sim = { tags: [], match: { source: 'queue' } }
  const ev = { tags: [], match: { source: 'private' }, event: { client_id: 'ev_a', name: 'Cup' } }
  assert.ok(matchesFilters(sim, { kind: 'sim' }))
  assert.ok(!matchesFilters(ev, { kind: 'sim' }))
  assert.ok(matchesFilters(ev, { kind: 'event' }))
  assert.ok(!matchesFilters(sim, { kind: 'event' }))
  assert.ok(matchesFilters(ev, { kind: 'event', event: 'ev_a' }))
  assert.ok(!matchesFilters(ev, { event: 'ev_b' }))
  assert.ok(matchesFilters(sim, { source: 'queue' }))
  assert.ok(!matchesFilters(ev, { source: 'queue' }))
})
