/**
 * Crewlog connector: logs finished games to the user's Crewlog account.
 *
 * Pure (no Electron): fetch, the clock, timers and the outbox's storage are
 * injected, so the whole flow is unit tested with node:test. main.mjs owns the
 * secret (safeStorage) and hands the code in through getConfig() only when a
 * request is about to go to the configured base URL.
 *
 *   GET  {base}/api/recorder/me      -> { handle, features? }
 *   GET  {base}/api/recorder/events  -> { events: [{ id, name, kind, category, played_on, my_leader, rounds, wins, losses }] }
 *   POST {base}/api/recorder/games   -> { event_id, event_name, kind, round, handle, duplicate, url, round_result? }
 *   errors                           -> { error, code }
 *
 * With features: ["event_picker"] the player picks one of their open Crewlog
 * events and each game is sent with its event_id (plus optional set fields).
 * A game whose event went away waits in the outbox (entry.waiting) until the
 * player picks another event or discards it.
 */

export const DEFAULT_BASE = 'https://www.getcrewlog.com'
/** The old default. It now only redirects to www, so a saved copy of it means DEFAULT_BASE. */
export const LEGACY_BASE = 'https://getcrewlog.com'
export const CODE_RE = /^crw_[0-9a-f]{40}$/i
/** Retry delays after a 5xx / network failure; the last one repeats. */
export const BACKOFF_MS = [5_000, 30_000, 120_000, 600_000, 1_800_000]
export const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
export const MAX_BODY = 2000
const TIMEOUT_MS = 15_000
const LEADER_ID_RE = /(?<![A-Z0-9])([A-Z]{1,5}\d{2}-\d{3})(?!\d)/

/**
 * A usable base URL: https anywhere, plain http only for this machine (local
 * testing), no path/query/credentials. Returns the origin, or null.
 */
export function normalizeBase(input) {
  const s = String(input ?? '').trim() || DEFAULT_BASE
  let u
  try {
    u = new URL(s)
  } catch {
    return null
  }
  if (u.username || u.password || u.search || u.hash || (u.pathname && u.pathname !== '/')) return null
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(u.hostname)
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) return null
  return u.origin
}

const nameKey = (s) =>
  String(s ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')

/**
 * A leader's card id for Crewlog. Uses the id the log carried when there is
 * one, else maps the name through the leader list, but only when exactly one
 * leader has that name (several Luffys share it). null = unknown.
 */
export function resolveLeader(side, leaders = []) {
  if (!side) return null
  const idMatch = String(side.leaderId ?? '').match(LEADER_ID_RE)
  if (idMatch) return idMatch[1]
  for (const v of [side.leaderName, side.leaderId]) {
    const k = nameKey(v)
    if (!k) continue
    const hits = [...new Set(leaders.filter((l) => nameKey(l.name) === k).map((l) => l.id))]
    if (hits.length === 1) return hits[0]
    if (hits.length > 1) return null
  }
  return null
}

/** YYYY-MM-DD of a moment, in local time. */
export function localDate(ms) {
  const d = new Date(ms)
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`
}

/**
 * The POST body for a finished recording's meta, or { error } when it can't be
 * logged. game_id comes from the sim's own game id (stable across retries and
 * re-installs), falling back to the recording id.
 */
export function buildGame(meta, leaders = []) {
  if (!meta?.winnerSeat) return { error: 'no result' }
  const my = resolveLeader(meta.me, leaders)
  const opp = resolveLeader(meta.opp, leaders)
  if (!my || !opp) return { error: "Can't log, unknown leader" }
  const gameId = String(meta.gameId || meta.id || '').slice(0, 100)
  if (!gameId) return { error: 'no game id' }
  const started = Date.parse(meta.startedAt)
  const body = {
    game_id: gameId,
    played_on: localDate(Number.isFinite(started) ? started : Date.now()),
    my_leader: my,
    opp_leader: opp,
    result: meta.winnerSeat === 1 ? 'W' : 'L',
  }
  if (meta.firstSeat === 1 || meta.firstSeat === 2) body.went_first = meta.firstSeat === 1
  if (JSON.stringify(body).length >= MAX_BODY) return { error: 'game too large to log' }
  return { body }
}

/** What to do with a response: ok | moved | retry | unauthorized | suspended | rejected | bug. */
export function classify(status) {
  if (status >= 200 && status < 300) return 'ok'
  if (status >= 300 && status < 400) return 'moved'
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'suspended'
  if (status === 422) return 'rejected'
  if (status === 408 || status === 429 || status >= 500 || !status) return 'retry'
  return 'bug' // 400, 413 and anything else we sent wrong
}

export const SET_ID_RE = /^[A-Za-z0-9_-]{1,64}$/
export const EVENT_ID_RE = /^[A-Za-z0-9_-]{1,100}$/

/** One row of GET /events, cleaned; null when it is unusable. */
export function cleanEventRow(r) {
  if (!r || typeof r.id !== 'string' || !EVENT_ID_RE.test(r.id)) return null
  const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null)
  const int = (v) => (Number.isInteger(v) && v >= 0 ? v : 0)
  return {
    id: r.id,
    name: str(r.name, 120) || 'Untitled event',
    kind: r.kind === 'sim' ? 'sim' : 'tournament',
    category: str(r.category, 40),
    played_on: /^\d{4}-\d{2}-\d{2}$/.test(r.played_on ?? '') ? r.played_on : null,
    my_leader: str(r.my_leader, 20),
    rounds: int(r.rounds),
    wins: int(r.wins),
    losses: int(r.losses),
  }
}

/** The extra POST fields for a game going to an event: event_id plus the valid set fields. */
export function eventBody(eventId, set = {}) {
  const out = { event_id: eventId }
  if (typeof set.set_id === 'string' && SET_ID_RE.test(set.set_id)) {
    out.set_id = set.set_id
    if (Number.isInteger(set.game_in_set) && set.game_in_set >= 1 && set.game_in_set <= 9) out.game_in_set = set.game_in_set
  }
  if (set.match_source === 'queue' || set.match_source === 'private') out.match_source = set.match_source
  return out
}

export const retryDelay = (attempts) => BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1]

/**
 * The connector. Events (onEvent) for the UI:
 *   { type: 'logged', gameId, recId, url, duplicate, handle, eventId, eventName, kind, round, roundResult }
 *     kind: 'sim' | 'tournament' | null (no event); roundResult: 'W' | 'L' | null (tied) | undefined
 *   { type: 'dropped', gameId, recId, error, bug }
 *   { type: 'eventGone', reason: 'unknown_event' | 'event_closed', eventId, error }
 *   { type: 'leaderMismatch', gameId, recId, eventId, error }
 *   { type: 'unknownLeader', recId }
 *   { type: 'state' }  (state() changed)
 */
export function createCrewlog({
  fetch,
  getConfig, // () => ({ base, code }) ; code may be null
  load = () => [],
  save = async () => {},
  now = () => Date.now(),
  setTimer = (fn, ms) => setTimeout(fn, ms),
  clearTimer = (t) => clearTimeout(t),
  onEvent = () => {},
  log = () => {},
}) {
  const loaded = load()
  let outbox = Array.isArray(loaded) ? loaded.filter((e) => e?.body?.game_id) : []
  /** null | 'unauthorized' | 'suspended': sending stopped until a new code. */
  let blocked = null
  let blockedError = null
  let handle = null
  /** null = not asked yet; else the server's feature list. */
  let features = null
  let checkError = null
  let timer = null
  let flushing = null
  let again = false

  const persist = () => save(outbox.map((e) => ({ ...e, body: { ...e.body } })))
  const emit = (ev) => {
    try {
      onEvent(ev)
    } catch {}
  }
  const changed = () => emit({ type: 'state' })
  const remove = (entry) => {
    outbox = outbox.filter((e) => e.body.game_id !== entry.body.game_id)
  }

  async function request(method, pathname, body) {
    const { base, code } = getConfig()
    const origin = normalizeBase(base)
    if (!origin) return { status: 0, data: null, error: 'Bad Crewlog URL' }
    if (!code) return { status: 0, data: null, error: 'No connector code' }
    let res
    try {
      res = await fetch(`${origin}${pathname}`, {
        method,
        headers: {
          Authorization: `Bearer ${code}`,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
        redirect: 'manual', // never carry the code to another host: a redirect stops here
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(TIMEOUT_MS) : undefined,
      })
    } catch (e) {
      if (e?.name !== 'TimeoutError' && /redirect/i.test(e?.message ?? ''))
        return { status: 307, data: null, error: 'Crewlog answered with a redirect. Update the Crewlog address in Settings.', code: 'moved' }
      return { status: 0, data: null, error: `Can't reach Crewlog (${e?.name === 'TimeoutError' ? 'timed out' : 'network error'})` }
    }
    if (res.type === 'opaqueredirect' || (res.status >= 300 && res.status < 400)) {
      let to = null
      try {
        to = new URL(res.headers?.get?.('location') ?? '', `${origin}${pathname}`).origin
      } catch {}
      const where = to && to !== 'null' && to !== origin ? `Crewlog moved to ${to}.` : 'Crewlog answered with a redirect.'
      return { status: res.status || 307, data: null, error: `${where} Update the Crewlog address in Settings.`, code: 'moved' }
    }
    let data = null
    try {
      data = await res.json()
    } catch {}
    const error = typeof data?.error === 'string' && data.error ? data.error : `Crewlog answered ${res.status}`
    const errCode = typeof data?.code === 'string' ? data.code : null
    return { status: res.status, data, error: res.ok ? null : error, code: res.ok ? null : errCode }
  }

  function block(kind, error) {
    blocked = kind
    blockedError = error
    handle = null
    changed()
  }

  function schedule() {
    if (timer) clearTimer(timer)
    timer = null
    const live = outbox.filter((e) => !e.waiting)
    if (blocked || !live.length) return
    const next = Math.min(...live.map((e) => e.nextAt ?? 0))
    timer = setTimer(() => {
      timer = null
      void flush()
    }, Math.max(0, next - now()))
  }

  function prune() {
    const cutoff = now() - MAX_AGE_MS
    const before = outbox.length
    outbox = outbox.filter((e) => (e.createdAt ?? 0) >= cutoff)
    return outbox.length !== before
  }

  const pickerSupported = () => !!features?.includes('event_picker')

  /** GET /me without flushing. Returns { ok, handle } or { ok: false, error, status }. */
  async function me() {
    const r = await request('GET', '/api/recorder/me')
    if (r.status === 200 && typeof r.data?.handle === 'string') {
      handle = r.data.handle
      features = Array.isArray(r.data.features) ? r.data.features.filter((f) => typeof f === 'string') : []
      checkError = null
      if (blocked) {
        blocked = null
        blockedError = null
      }
      changed()
      return { ok: true, handle }
    }
    const kind = r.status ? classify(r.status) : 'retry'
    checkError = r.error
    if (kind === 'unauthorized' || kind === 'suspended' || kind === 'moved') block(kind, r.error)
    else changed()
    return { ok: false, status: r.status, error: r.error }
  }

  /** Returns true when the entry should be sent again right away (bad_set_id). */
  async function sendOne(entry) {
    const r = await request('POST', '/api/recorder/games', entry.body)
    const kind = r.status ? classify(r.status) : 'retry'
    const gameId = entry.body.game_id
    const recId = entry.recId ?? null
    if (kind === 'ok') {
      remove(entry)
      const d = r.data ?? {}
      if (typeof d.handle === 'string') handle = d.handle
      emit({
        type: 'logged',
        gameId,
        recId,
        url: typeof d.url === 'string' ? d.url : null,
        duplicate: !!d.duplicate,
        handle: typeof d.handle === 'string' ? d.handle : null,
        eventId: typeof d.event_id === 'string' ? d.event_id : (entry.body.event_id ?? null),
        eventName: typeof d.event_name === 'string' ? d.event_name : null,
        kind: d.kind === 'sim' || d.kind === 'tournament' ? d.kind : null,
        round: Number.isInteger(d.round) ? d.round : null,
        roundResult: 'round_result' in d ? (d.round_result === 'W' || d.round_result === 'L' ? d.round_result : null) : undefined,
      })
      return false
    }
    if (kind === 'retry') {
      entry.attempts = (entry.attempts ?? 0) + 1
      entry.nextAt = now() + retryDelay(entry.attempts)
      entry.lastError = r.error
      return false
    }
    if (kind === 'unauthorized' || kind === 'suspended' || kind === 'moved') {
      block(kind, r.error) // keep the outbox for the next code or address
      return false
    }
    const code = r.code
    if ((r.status === 404 && code === 'unknown_event') || (r.status === 422 && code === 'event_closed')) {
      // Keep it until the player picks another event.
      entry.waiting = code
      entry.lastError = r.error
      emit({ type: 'eventGone', reason: code, eventId: entry.body.event_id ?? null, error: r.error })
      return false
    }
    if (r.status === 422 && code === 'leader_mismatch') {
      entry.waiting = code
      entry.lastError = r.error
      emit({ type: 'leaderMismatch', gameId, recId, eventId: entry.body.event_id ?? null, error: r.error })
      return false
    }
    if (r.status === 422 && code === 'bad_set_id' && 'set_id' in entry.body) {
      delete entry.body.set_id
      delete entry.body.game_in_set
      return true
    }
    // event_required is our bug; other 422s are bad game data; 400/413 a body we built wrong.
    remove(entry)
    const bug = kind === 'bug' || code === 'event_required'
    if (bug) log(`crewlog: dropped game ${gameId}: HTTP ${r.status} ${code ?? ''} ${r.error}`)
    emit({ type: 'dropped', gameId, recId, error: r.error, bug })
    return false
  }

  /** Send every due entry, oldest first. Safe to call any time; calls coalesce. */
  async function flush() {
    if (flushing) {
      again = true
      return flushing
    }
    flushing = (async () => {
      do {
        again = false
        let dirty = prune()
        const { code } = getConfig()
        if (!code || blocked) break
        const due = outbox.filter((e) => !e.waiting && (e.nextAt ?? 0) <= now()).sort((a, b) => a.createdAt - b.createdAt)
        for (const entry of due) {
          if (blocked) break
          if (await sendOne(entry)) await sendOne(entry) // once more, without set_id
          dirty = true
        }
        if (dirty) await persist()
      } while (again)
      schedule()
      changed()
    })()
    try {
      await flushing
    } finally {
      flushing = null
    }
  }

  const waiting = () => outbox.filter((e) => e.waiting)

  return {
    /**
     * Queue a finished recording (its meta). `extra` is eventBody(...) when the
     * game goes to a picked event. Returns { queued } or { error }.
     */
    async enqueue(meta, leaders, extra = null) {
      const built = buildGame(meta, leaders)
      if (built.error) {
        if (built.error.includes('unknown leader')) emit({ type: 'unknownLeader', recId: meta?.id ?? null })
        return { error: built.error }
      }
      const body = extra ? { ...built.body, ...extra } : built.body
      if (JSON.stringify(body).length >= MAX_BODY) return { error: 'game too large to log' }
      const id = body.game_id
      if (!outbox.some((e) => e.body.game_id === id))
        outbox.push({ recId: meta.id ?? null, body, createdAt: now(), attempts: 0, nextAt: 0 })
      await persist()
      void flush()
      return { queued: id }
    },
    flush,
    /** GET /me. Returns { ok, handle } or { ok: false, error, status }. */
    async check() {
      const r = await me()
      if (r.ok) void flush()
      return r
    },
    pickerSupported,
    /** GET /events. Returns { ok: true, events } or { ok: false, error }. */
    async events() {
      if (blocked) return { ok: false, error: blockedError }
      const r = await request('GET', '/api/recorder/events')
      if (r.status === 200 && Array.isArray(r.data?.events))
        return { ok: true, events: r.data.events.map(cleanEventRow).filter(Boolean).slice(0, 20) }
      if (r.status === 200) return { ok: false, error: 'Crewlog sent an unreadable event list' }
      const kind = r.status ? classify(r.status) : 'retry'
      if (kind === 'unauthorized' || kind === 'suspended' || kind === 'moved') block(kind, r.error)
      return { ok: false, error: r.error }
    },
    /** Waiting games go to this event now. A mismatched game skips the event that refused it. */
    async assignWaiting(eventId) {
      let n = 0
      for (const e of waiting()) {
        if (e.waiting === 'leader_mismatch' && e.body.event_id === eventId) continue
        e.body.event_id = eventId
        delete e.waiting
        e.lastError = null
        e.attempts = 0
        e.nextAt = 0
        n++
      }
      if (n) {
        await persist()
        void flush()
      }
      changed()
      return n
    },
    /** Drop every waiting game. */
    async discardWaiting() {
      const n = waiting().length
      outbox = outbox.filter((e) => !e.waiting)
      if (n) await persist()
      changed()
      return n
    },
    /** The code or base URL changed: forget what we knew and try again. */
    reset() {
      blocked = null
      blockedError = null
      handle = null
      features = null
      checkError = null
      changed()
      void flush()
    },
    state() {
      const w = waiting()
      const live = outbox.filter((e) => !e.waiting)
      const lastW = w[w.length - 1]
      return {
        handle,
        connected: !!handle && !blocked,
        picker: pickerSupported(),
        blocked,
        error: blocked ? blockedError : checkError,
        pending: live.length,
        retryError: live.find((e) => e.lastError)?.lastError ?? null,
        waiting: w.length,
        waitingReason: lastW?.waiting ?? null,
        waitingError: lastW?.lastError ?? null,
      }
    },
    _outbox: () => outbox,
    stop() {
      if (timer) clearTimer(timer)
      timer = null
    },
  }
}
