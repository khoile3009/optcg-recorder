// Which recordings lose their video under the "Keep videos" setting. Only the
// .webm goes: the meta and the log stay, so stats, the dashboard and the turn
// log are unaffected. Starred games and games with misplay notes are kept,
// since those are the ones worth rewatching. Pure, so it is testable.

export const RETENTION_DAYS = [7, 14, 30, 90]
export const DEFAULT_RETENTION_DAYS = 30
const DAY_MS = 24 * 60 * 60 * 1000

/** A valid setting: one of RETENTION_DAYS, or null for keep forever. */
export function cleanRetention(v) {
  const n = Number(v)
  return RETENTION_DAYS.includes(n) ? n : null
}

/** Why a recording's video is kept regardless of age, or null if it can expire. */
export function keepReason(r) {
  if (r.starred) return 'starred'
  if (r.misplays?.length) return 'misplays'
  return null
}

/** The recordings whose video is older than `days` and may be removed. */
export function pickExpired(recs, { days, now = Date.now(), activeId = null } = {}) {
  if (!cleanRetention(days)) return []
  const cutoff = now - days * DAY_MS
  return recs.filter((r) => {
    if (!r?.id || r.id === activeId || r.status === 'recording') return false
    if (!r.videoUrl || r.videoPruned || keepReason(r)) return false
    const at = Date.parse(r.startedAt)
    return Number.isFinite(at) && at < cutoff
  })
}
