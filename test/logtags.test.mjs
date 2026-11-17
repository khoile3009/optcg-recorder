import test from 'node:test'
import assert from 'node:assert/strict'
import { countEndTurns, matchesQuery, matchupStats, parseLog, parseLogFileName, tagsFor, titleFor, turnsStarted } from '../src/logtags.mjs'

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
