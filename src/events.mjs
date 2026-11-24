/**
 * Event mode and sets. Pure (no Electron), unit tested with node:test.
 *
 * Event mode: while it's on, every game saved is tagged with the event
 * ({ client_id, name }). Games can also be tagged or untagged afterwards.
 *
 * Sets: games in one room against one opponent are one set (one round). The
 * first game of a room has a connection line naming the room; rematches have
 * none, so they inherit the set of the game just before them when it was
 * against the same opponent and finished not long ago.
 *
 * What goes to Crewlog (docs/crewlog-events-spec.md) never carries the room
 * code or the opponent's name: set_id is a hash of both.
 */
import { createHash } from 'node:crypto'
import { cleanName, shortName } from './logtags.mjs'

/** A rematch must start within this long of the previous game's end. */
export const REMATCH_GAP_MS = 45 * 60 * 1000
export const EVENT_NAME_MAX = 80
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/

/** "ev_" + 12 hex chars. randomHex is injected for tests. */
export const newClientId = (randomHex) => `ev_${randomHex}`

export const validClientId = (id) => typeof id === 'string' && ID_RE.test(id)

/** Trimmed, spaces collapsed, at most 80 chars; '' when unusable. */
export const cleanEventName = (s) =>
  String(s ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, EVENT_NAME_MAX)
    .trim()

/** An event from untrusted input (IPC), or null. */
export function cleanEvent(ev) {
  if (!ev || !validClientId(ev.client_id)) return null
  const name = cleanEventName(ev.name)
  return name ? { client_id: ev.client_id, name } : null
}

/** "s_" + first 12 hex of sha256(room|opponent|played_on). */
export function setIdFor(room, oppName, playedOn) {
  const h = createHash('sha256').update(`${room}|${cleanName(oppName)}|${playedOn}`).digest('hex')
  return `s_${h.slice(0, 12)}`
}

const endMs = (m) => Date.parse(m?.startedAt) + (m?.durationMs ?? 0)

/**
 * The set a just-finished game belongs to: { id, room, startedOn, game } or null.
 *   game  { match, opp, startedAt } of the game being saved
 *   prev  the meta saved just before it (or null)
 *   playedOn  YYYY-MM-DD of this game
 */
export function setFor(game, prev, playedOn) {
  const match = game?.match
  const opp = cleanName(game?.opp?.name)
  if (!match || !opp) return null
  if (match.room) return { id: setIdFor(match.room, opp, playedOn), room: match.room, startedOn: playedOn, game: 1 }
  if (!match.rematch || !prev?.set?.room) return null
  if (cleanName(prev.opp?.name) !== opp) return null
  const gap = Date.parse(game.startedAt) - endMs(prev)
  if (!Number.isFinite(gap) || gap > REMATCH_GAP_MS || gap < -60_000) return null
  return { ...prev.set, game: Math.min(9, (prev.set.game ?? 1) + 1) }
}

/** The tags a game's match/event add, so search finds "queue" or "event:weekly". */
export function matchTags(meta) {
  const tags = []
  if (meta.match?.source) tags.push(meta.match.source)
  if (meta.event?.name) tags.push(`event:${meta.event.name.toLowerCase()}`)
  return tags
}

/** meta.tags with the match/event tags swapped for the current ones. */
export function retagged(meta) {
  const keep = (meta.tags ?? []).filter((t) => t !== 'queue' && t !== 'private' && !t.startsWith('event:'))
  return [...keep, ...matchTags(meta)]
}

/**
 * The Crewlog event fields for a meta (spec section 2): always kind, the rest
 * for event games. match_source rides along either way.
 */
export function eventFields(meta) {
  const f = {}
  if (meta.event && cleanEvent(meta.event)) {
    f.kind = 'event'
    f.event = cleanEvent(meta.event)
    if (meta.set?.id && ID_RE.test(meta.set.id)) f.set_id = meta.set.id
    if (Number.isInteger(meta.set?.game) && meta.set.game >= 1 && meta.set.game <= 9) f.game_in_set = meta.set.game
  } else f.kind = 'sim'
  if (meta.match?.source === 'queue' || meta.match?.source === 'private') f.match_source = meta.match.source
  return f
}

/** Where a game should be filed: 'event:<client_id>' or 'sim'. */
export const wantedFiling = (meta) => (meta.event && cleanEvent(meta.event) ? `event:${meta.event.client_id}` : 'sim')

/**
 * Logged games whose Crewlog filing differs from what the user wants now
 * (tagged after the fact, or logged before the server knew events).
 */
export function needsRetag(metas) {
  return metas.filter((m) => {
    const c = m.crewlog
    if (!c?.filed || !c.gameId) return false
    const want = wantedFiling(m)
    return c.filed !== want && c.failedFor !== want
  })
}

/** Where a logged game ended up, from the server's kind and the fields sent. */
export const filedAs = (kind, sent) => (kind === 'event' && sent?.event?.client_id ? `event:${sent.event.client_id}` : 'sim')

/** Events seen in the library, newest first: [{ client_id, name, games, lastAt }]. */
export function knownEvents(metas, current = null) {
  const by = new Map()
  for (const m of metas) {
    const ev = cleanEvent(m.event)
    if (!ev) continue
    const cur = by.get(ev.client_id) ?? { ...ev, games: 0, lastAt: '' }
    cur.games++
    if ((m.startedAt ?? '') > cur.lastAt) {
      cur.lastAt = m.startedAt ?? ''
      cur.name = ev.name
    }
    by.set(ev.client_id, cur)
  }
  const cur = cleanEvent(current)
  if (cur && !by.has(cur.client_id)) by.set(cur.client_id, { ...cur, games: 0, lastAt: '9999' })
  return [...by.values()].sort((a, b) => b.lastAt.localeCompare(a.lastAt))
}

/** "vs Scarria · G2" style label for a set; opponent from the meta, never sent anywhere. */
export const setLabel = (meta) => (meta.set ? `vs ${shortName(meta.opp?.name) || '?'} · G${meta.set.game}` : '')
