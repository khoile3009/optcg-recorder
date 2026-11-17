/**
 * Reads an OPTCG Sim combat log (CombatLogs/AutoSaved/*.log) and derives the
 * facts we tag recordings with. Pure functions, no Electron, so they are unit
 * tested with node:test.
 *
 * Relevant lines:
 *   RZ1|PLY|<seat>|<name>|<leaderId>          seat 1 is always the local player
 *   [<name>] Leader is <Leader Name> [<...>]   readable leader name
 *   [<name>] Chose to go First|Second
 *   RZ1|SEM|<seq>|<seat>|<b64 key>|...         key "Log.EndTurn" ends a turn
 *   RZ1|END|<seq>|<winnerSeat>|<reason>|<hash>
 *   RZ1|SEM|<seq>|<seat>|<b64 "Log.Quit">|...  a player left; no END line follows
 *
 * A quit before the first DON!! draw is a lobby that never became a game (the
 * sim also logs one at the top of some normal games), so it is ignored.
 */

const ZWSP = /​/g
// btoa, not Buffer: this module also runs in the (sandboxed) library window.
const END_TURN_B64 = btoa('Log.EndTurn')
const QUIT_B64 = btoa('Log.Quit')

/** "Scarria​#1361" → "Scarria#1361" */
export const cleanName = (n) => (n ?? '').replace(ZWSP, '').trim()
/** "Scarria#1361" → "Scarria" */
export const shortName = (n) => cleanName(n).replace(/#\d+$/, '')

/** `2026-11-16T22.15.11.3743364-<id>.partial.log` → { startedAt, gameId, partial } */
export function parseLogFileName(fileName) {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})\.(\d{2})\.(\d{2})[.\d]*-([0-9a-f]+)(\.partial)?\.log$/i.exec(fileName)
  if (!m) return null
  return { startedAt: `${m[1]}T${m[2]}:${m[3]}:${m[4]}`, gameId: m[5], partial: !!m[6] }
}

/** Count of turns ended so far (works on partial logs). */
export function countEndTurns(text) {
  let n = 0
  let i = 0
  const needle = `|${END_TURN_B64}|`
  while ((i = text.indexOf(needle, i)) !== -1) {
    n++
    i += needle.length
  }
  return n
}

const FIRST_DON_B64 = btoa('Log.DrawDon')

/**
 * Turns begun so far: turn 1 starts with the first DON!! draw (after mulligans),
 * and every end-of-turn starts the next one. Works on partial logs.
 */
export function turnsStarted(text) {
  if (!text.includes(`|${FIRST_DON_B64}|`)) return 0
  return 1 + countEndTurns(text)
}

/** The first seat to quit loses. */
const quitResult = (seat) =>
  seat === '1' ? { winnerSeat: 2, endReason: 'quit' } : { winnerSeat: 1, endReason: 'opponent_quit' }

/** Has someone quit mid-game (the sim writes no END line then)? Works on partial logs. */
export function quitMidGame(text) {
  const don = text.indexOf(`|${FIRST_DON_B64}|`)
  return don !== -1 && text.indexOf(`|${QUIT_B64}|`, don) !== -1
}

export function parseLog(text) {
  const seats = { 1: { name: '', leaderId: '', leaderName: '' }, 2: { name: '', leaderId: '', leaderName: '' } }
  const leaderNameByPlayer = new Map()
  let firstSeat = null
  let chooser = null
  let choice = null
  let winnerSeat = null
  let endReason = null
  let quit = null
  let started = false

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('RZ1|SEM|')) {
      const f = line.split('|')
      if (f[4] === FIRST_DON_B64) started = true
      else if (f[4] === QUIT_B64 && started && !quit && (f[3] === '1' || f[3] === '2')) quit = quitResult(f[3])
      continue
    }
    if (line.startsWith('RZ1|PLY|')) {
      const [, , seat, name, leaderId] = line.split('|')
      if ((seat === '1' || seat === '2') && name) seats[seat] = { ...seats[seat], name: cleanName(name), leaderId: leaderId ?? '' }
      continue
    }
    if (line.startsWith('RZ1|END|')) {
      const f = line.split('|')
      winnerSeat = f[3] === '1' || f[3] === '2' ? Number(f[3]) : null
      endReason = f[4] || null
      continue
    }
    if (line.startsWith('RZ1|')) continue
    let m = /^\[([^\]]+)\] Leader is (.+?) \[/.exec(line)
    if (m) {
      leaderNameByPlayer.set(cleanName(m[1]), m[2].trim())
      continue
    }
    m = /^\[([^\]]+)\] Chose to go (First|Second)/.exec(line)
    if (m) {
      chooser = cleanName(m[1])
      choice = m[2]
    }
  }

  // The END line is authoritative; a mid-game quit stands in when there is none.
  if (!winnerSeat && quit) ({ winnerSeat, endReason } = quit)
  for (const s of [1, 2]) seats[s].leaderName = leaderNameByPlayer.get(seats[s].name) ?? seats[s].leaderId
  if (chooser) {
    const chooserSeat = seats[1].name === chooser ? 1 : seats[2].name === chooser ? 2 : null
    if (chooserSeat) firstSeat = choice === 'First' ? chooserSeat : chooserSeat === 1 ? 2 : 1
  }

  return { me: seats[1], opp: seats[2], firstSeat, winnerSeat, endReason, turns: countEndTurns(text) + (winnerSeat ? 1 : 0) }
}

/**
 * Searchable tags for a game, from seat 1's (my) perspective. Keyed tags are
 * "key:value"; bare tags are flags.
 */
export function tagsFor(game, { finished = true } = {}) {
  const tags = []
  if (game.me.leaderName) tags.push(`leader:${game.me.leaderName}`)
  if (game.opp.leaderName) tags.push(`opp:${game.opp.leaderName}`)
  if (game.opp.name) tags.push(`vs:${shortName(game.opp.name)}`)
  if (game.firstSeat) tags.push(game.firstSeat === 1 ? '1st' : '2nd')
  if (game.winnerSeat) tags.push(game.winnerSeat === 1 ? 'win' : 'loss')
  if (game.endReason === 'concede') tags.push('i conceded')
  else if (game.endReason === 'opponent_concede') tags.push('opp conceded')
  else if (game.endReason === 'quit') tags.push('i quit')
  else if (game.endReason === 'opponent_quit') tags.push('opp quit')
  if (!finished || !game.winnerSeat) tags.push('unfinished')
  return tags
}

/** "Luffy vs Xebec · 2nd · W" */
export function titleFor(game) {
  const parts = [`${game.me.leaderName || '?'} vs ${game.opp.leaderName || '?'}`]
  if (game.firstSeat) parts.push(game.firstSeat === 1 ? '1st' : '2nd')
  if (game.winnerSeat) parts.push(game.winnerSeat === 1 ? 'W' : 'L')
  return parts.join(' · ')
}

/**
 * Search: every whitespace-separated token must match. "key:value" tokens
 * match a tag with that key whose value contains the text ("opp:xebec");
 * plain tokens match anywhere in tags, names, leader ids, notes or misplay notes.
 * Underscores stand in for spaces ("leader:monkey_d").
 */
export function matchesQuery(rec, query) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return true
  const tags = [...(rec.tags ?? []), ...(rec.userTags ?? [])].map((t) => t.toLowerCase())
  const hay = [
    ...tags,
    rec.title,
    rec.me?.name,
    rec.opp?.name,
    rec.me?.leaderId,
    rec.opp?.leaderId,
    rec.notes,
    ...(rec.misplays ?? []).map((m) => m.note),
  ]
    .filter(Boolean)
    .join('\n')
    .toLowerCase()
  return tokens.every((tok) => {
    const t = tok.replace(/_/g, ' ')
    const kv = /^([a-z]+):(.+)$/.exec(t)
    if (kv) return tags.some((tag) => tag.startsWith(`${kv[1]}:`) && tag.slice(kv[1].length + 1).includes(kv[2]))
    return hay.includes(t)
  })
}

/**
 * Structured library filters (all optional): result 'win'|'loss', order
 * '1st'|'2nd', starred, misplays (has at least one), me/opp leader ids (any of),
 * userTags (all of), and the free-text query.
 */
export function matchesFilters(rec, f = {}) {
  if (f.result && rec.winnerSeat !== (f.result === 'win' ? 1 : 2)) return false
  if (f.order && rec.firstSeat !== (f.order === '1st' ? 1 : 2)) return false
  if (f.starred && !rec.starred) return false
  if (f.misplays && !rec.misplays?.length) return false
  if (f.me?.length && !f.me.includes(rec.me?.leaderId)) return false
  if (f.opp?.length && !f.opp.includes(rec.opp?.leaderId)) return false
  const mine = (rec.userTags ?? []).map((t) => t.toLowerCase())
  if (f.userTags?.length && !f.userTags.every((t) => mine.includes(t.toLowerCase()))) return false
  return matchesQuery(rec, f.text ?? '')
}

/** Win/loss record overall and by turn order, for finished games. */
export function recordStats(recs) {
  const s = { games: recs.length, wins: 0, losses: 0, first: { wins: 0, losses: 0 }, second: { wins: 0, losses: 0 } }
  for (const r of recs) {
    if (!r.winnerSeat) continue
    const k = r.winnerSeat === 1 ? 'wins' : 'losses'
    s[k]++
    if (r.firstSeat) s[r.firstSeat === 1 ? 'first' : 'second'][k]++
  }
  return s
}

/** recordStats per opposing leader, most-played first. Games without a known opponent leader are skipped. */
export function matchupStats(recs) {
  const by = new Map()
  for (const r of recs) {
    const id = r.opp?.leaderId
    if (!id) continue
    if (!by.has(id)) by.set(id, [])
    by.get(id).push(r)
  }
  return [...by]
    .map(([leaderId, games]) => ({ leaderId, ...recordStats(games) }))
    .sort((a, b) => b.games - a.games || b.wins + b.losses - (a.wins + a.losses) || a.leaderId.localeCompare(b.leaderId))
}

const EV_KEYS = { [btoa('Log.LeaderHit')]: 'hit', [btoa('Log.Destroyed')]: 'ko', [btoa('Log.UseTrigger')]: 'trigger' }
const DON_KEY = btoa('Log.DrawDon')
const b64text = (s) => {
  try {
    return new TextDecoder().decode(Uint8Array.from(atob(s), (c) => c.charCodeAt(0)))
  } catch {
    return ''
  }
}
/** `Gloriosa [<mark><link="OP17-046">OP17-046</link></mark>]` → { name, id } */
const cardRef = (s) => ({ name: s.replace(/\s*\[.*$/, '').trim(), id: /link="([^"]+)"/.exec(s)?.[1] ?? '' })

/**
 * Highlight events in log order, picked from the event-frequency study (about 16 per game):
 * leader hits (`seat` lost a life), K.O.s (`seat` owned the card), [Trigger]s
 * (`seat` activated it) and the game end (`seat` won). `turn` is the overall turn
 * number (0 = before the first turn). Append-only on partial logs, so callers can
 * stamp new entries by index as they appear.
 * @returns {{type: 'hit'|'ko'|'trigger'|'end', seat: 1|2|null, turn: number, card?: string, reason?: string}[]}
 */
export function logEvents(text) {
  const leaderOf = { 1: '', 2: '' }
  const events = []
  let turn = 0
  let turnSeat = null // whose turn it is; known once a turn has ended
  let ended = false
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
    if (line.startsWith('RZ1|PLY|')) {
      const [, , seat, , leaderId] = line.split('|')
      if (seat === '1' || seat === '2') leaderOf[seat] = leaderId ?? ''
      continue
    }
    if (line.startsWith('RZ1|END|')) {
      if (ended) continue
      ended = true
      const f = line.split('|')
      events.push({ type: 'end', seat: f[3] === '1' || f[3] === '2' ? Number(f[3]) : null, turn, reason: f[4] || '' })
      continue
    }
    if (!line.startsWith('RZ1|SEM|')) continue
    const f = line.split('|')
    const key = f[4]
    if (key === QUIT_B64) {
      if (turn > 0 && !ended && (f[3] === '1' || f[3] === '2')) {
        ended = true
        const q = quitResult(f[3])
        events.push({ type: 'end', seat: q.winnerSeat, turn, reason: q.endReason })
      }
      continue
    }
    if (key === DON_KEY && turn === 0) turn = 1
    else if (key === END_TURN_B64) {
      turn++
      turnSeat = f[3] === '1' ? 2 : f[3] === '2' ? 1 : null
    }
    const type = EV_KEYS[key]
    if (!type) continue
    const card = cardRef(b64text(f[5] ?? ''))
    let seat = f[3] === '1' || f[3] === '2' ? Number(f[3]) : null
    if (type === 'hit') {
      // Logged with seat 0; the hit leader names the side, unless both play the same leader.
      const m1 = card.id && card.id === leaderOf[1]
      const m2 = card.id && card.id === leaderOf[2]
      seat = m1 && !m2 ? 1 : m2 && !m1 ? 2 : turnSeat ? (turnSeat === 1 ? 2 : 1) : null
    }
    events.push({ type, seat, turn, card: card.name })
  }
  return events
}

/**
 * For a saved recording without a result: the result patch its log now yields
 * (e.g. a quit read by a newer parser), or null. Tags not derived from the log
 * ('interrupted', 'no video') are kept.
 */
export function backfillResult(meta, text) {
  if (meta.winnerSeat || !text) return null
  const game = parseLog(text)
  if (!game.winnerSeat) return null
  const old = tagsFor({ ...game, winnerSeat: null, endReason: null })
  const extra = (meta.tags ?? []).filter((t) => !old.includes(t))
  return {
    winnerSeat: game.winnerSeat,
    endReason: game.endReason,
    turns: game.turns,
    tags: [...tagsFor(game), ...extra],
    title: titleFor(game),
  }
}
