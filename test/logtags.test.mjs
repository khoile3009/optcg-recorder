import test from 'node:test'
import assert from 'node:assert/strict'
import { countEndTurns, matchesQuery, parseLog, parseLogFileName, tagsFor, titleFor } from '../src/logtags.mjs'

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
