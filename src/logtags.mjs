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
 */

const ZWSP = /​/g
// btoa, not Buffer: this module also runs in the (sandboxed) library window.
const END_TURN_B64 = btoa('Log.EndTurn')

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

export function parseLog(text) {
  const seats = { 1: { name: '', leaderId: '', leaderName: '' }, 2: { name: '', leaderId: '', leaderName: '' } }
  const leaderNameByPlayer = new Map()
  let firstSeat = null
  let chooser = null
  let choice = null
  let winnerSeat = null
  let endReason = null

  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '')
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
 * plain tokens match anywhere in tags, names, leader ids or notes.
 * Underscores stand in for spaces ("leader:monkey_d").
 */
export function matchesQuery(rec, query) {
  const tokens = query.toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0) return true
  const tags = [...(rec.tags ?? []), ...(rec.userTags ?? [])].map((t) => t.toLowerCase())
  const hay = [...tags, rec.title, rec.me?.name, rec.opp?.name, rec.me?.leaderId, rec.opp?.leaderId, rec.notes]
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
 * '1st'|'2nd', starred, me/opp leader ids (any of), userTags (all of), and the
 * free-text query.
 */
export function matchesFilters(rec, f = {}) {
  if (f.result && rec.winnerSeat !== (f.result === 'win' ? 1 : 2)) return false
  if (f.order && rec.firstSeat !== (f.order === '1st' ? 1 : 2)) return false
  if (f.starred && !rec.starred) return false
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
