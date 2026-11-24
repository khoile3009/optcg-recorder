/**
 * Crewlog connector: logs finished games to the user's Crewlog account.
 *
 * Pure (no Electron): fetch, the clock, timers and the outbox's storage are
 * injected, so the whole flow is unit tested with node:test. main.mjs owns the
 * secret (safeStorage) and hands the code in through getConfig() only when a
 * request is about to go to the configured base URL.
 *
 *   GET  {base}/api/recorder/me     -> { handle }
 *   POST {base}/api/recorder/games  -> { event_id, round, handle, duplicate, new_session, url }
 *   errors                          -> { error, code }
 */

export const DEFAULT_BASE = 'https://getcrewlog.com'
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

/** What to do with a response: ok | retry | unauthorized | suspended | rejected | bug. */
export function classify(status) {
  if (status >= 200 && status < 300) return 'ok'
  if (status === 401) return 'unauthorized'
  if (status === 403) return 'suspended'
  if (status === 422) return 'rejected'
  if (status === 408 || status === 429 || status >= 500 || !status) return 'retry'
  return 'bug' // 400, 413 and anything else we sent wrong
}

export const retryDelay = (attempts) => BACKOFF_MS[Math.min(Math.max(attempts, 1), BACKOFF_MS.length) - 1]

/**
 * The connector. Events (onEvent) for the UI:
 *   { type: 'logged', gameId, url, newSession, duplicate, handle }
 *   { type: 'dropped', gameId, error, bug }
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
  let checkError = null
  let timer = null
  let flushing = null
  let again = false

  const persist = () => save(outbox.map((e) => ({ ...e })))
  const emit = (ev) => {
    try {
      onEvent(ev)
    } catch {}
  }
  const changed = () => emit({ type: 'state' })

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
        redirect: 'error', // never carry the code to another host
        signal: typeof AbortSignal?.timeout === 'function' ? AbortSignal.timeout(TIMEOUT_MS) : undefined,
      })
    } catch (e) {
      return { status: 0, data: null, error: `Can't reach Crewlog (${e?.name === 'TimeoutError' ? 'timed out' : 'network error'})` }
    }
    let data = null
    try {
      data = await res.json()
    } catch {}
    const error = typeof data?.error === 'string' && data.error ? data.error : `Crewlog answered ${res.status}`
    return { status: res.status, data, error: res.ok ? null : error }
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
    if (blocked || !outbox.length) return
    const next = Math.min(...outbox.map((e) => e.nextAt ?? 0))
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

  async function sendOne(entry) {
    const r = await request('POST', '/api/recorder/games', entry.body)
    const kind = r.status ? classify(r.status) : 'retry'
    if (kind === 'ok') {
      outbox = outbox.filter((e) => e.body.game_id !== entry.body.game_id)
      handle = r.data?.handle ?? handle
      emit({
        type: 'logged',
        gameId: entry.body.game_id,
        recId: entry.recId ?? null,
        url: typeof r.data?.url === 'string' ? r.data.url : null,
        newSession: !!r.data?.new_session,
        duplicate: !!r.data?.duplicate,
        handle: r.data?.handle ?? null,
      })
      return true
    }
    if (kind === 'retry') {
      entry.attempts = (entry.attempts ?? 0) + 1
      entry.nextAt = now() + retryDelay(entry.attempts)
      entry.lastError = r.error
      return false
    }
    if (kind === 'unauthorized' || kind === 'suspended') {
      block(kind, r.error) // keep the outbox for the next code
      return false
    }
    // 422: the server says no; 400/413/other: we built it wrong. Neither will ever succeed.
    outbox = outbox.filter((e) => e.body.game_id !== entry.body.game_id)
    if (kind === 'bug') log(`crewlog: dropped game ${entry.body.game_id}: HTTP ${r.status} ${r.error}`)
    emit({ type: 'dropped', gameId: entry.body.game_id, recId: entry.recId ?? null, error: r.error, bug: kind === 'bug' })
    return true
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
        const due = outbox.filter((e) => (e.nextAt ?? 0) <= now()).sort((a, b) => a.createdAt - b.createdAt)
        for (const entry of due) {
          if (blocked) break
          await sendOne(entry)
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

  return {
    /** Queue a finished recording (its meta). Returns { queued } or { error }. */
    async enqueue(meta, leaders) {
      const built = buildGame(meta, leaders)
      if (built.error) {
        if (built.error.includes('unknown leader')) emit({ type: 'unknownLeader', recId: meta?.id ?? null })
        return { error: built.error }
      }
      const id = built.body.game_id
      if (!outbox.some((e) => e.body.game_id === id))
        outbox.push({ recId: meta.id ?? null, body: built.body, createdAt: now(), attempts: 0, nextAt: 0 })
      await persist()
      void flush()
      return { queued: id }
    },
    flush,
    /** GET /me. Returns { ok, handle } or { ok: false, error, status }. */
    async check() {
      const r = await request('GET', '/api/recorder/me')
      if (r.status === 200 && typeof r.data?.handle === 'string') {
        handle = r.data.handle
        checkError = null
        if (blocked) {
          blocked = null
          blockedError = null
        }
        changed()
        void flush()
        return { ok: true, handle }
      }
      const kind = r.status ? classify(r.status) : 'retry'
      checkError = r.error
      if (kind === 'unauthorized' || kind === 'suspended') block(kind, r.error)
      else changed()
      return { ok: false, status: r.status, error: r.error }
    },
    /** The code or base URL changed: forget what we knew and try again. */
    reset() {
      blocked = null
      blockedError = null
      handle = null
      checkError = null
      changed()
      void flush()
    },
    state() {
      return {
        handle,
        connected: !!handle && !blocked,
        blocked,
        error: blocked ? blockedError : checkError,
        pending: outbox.length,
        retryError: outbox.find((e) => e.lastError)?.lastError ?? null,
      }
    },
    _outbox: () => outbox,
    stop() {
      if (timer) clearTimer(timer)
      timer = null
    },
  }
}
