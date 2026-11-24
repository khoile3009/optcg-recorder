/**
 * OPTCG Recorder: main process.
 *
 *  - Watches OPTCG Sim's CombatLogs/AutoSaved folder. A fresh, growing
 *    `*.partial.log` means a game started; an END line, the partial going
 *    away, or the partial going stale means it ended.
 *  - Records the sim's window (or the screen) from a hidden recorder window
 *    (recorder.html) for the length of the game; chunks stream here over IPC.
 *  - When the game ends, copies the combat log next to the video and tags the
 *    recording (leaders, 1st/2nd, opponent, result) from it.
 *  - The library window lists, searches and plays recordings.
 *
 * Library layout (userData/recordings):  <id>.webm  <id>.json  <id>.log
 */
import { app, BrowserWindow, Notification, desktopCapturer, dialog, ipcMain, net, protocol, safeStorage, session, shell } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { backfillResult, logEvents, parseLog, parseLogFileName, quitMidGame, tagsFor, titleFor, turnsStarted } from './logtags.mjs'
import { ASSETS, mergeLeaders, parseLeaders } from './leaderdb.mjs'
import { LEADERS as BUNDLED_LEADERS } from './data/leaders.mjs'
import { installUpdate, startUpdateChecks } from './updater.mjs'
import { libDirProblem, moveRecordings, recordingIds, writableProblem } from './libmove.mjs'
import { CODE_RE, DEFAULT_BASE, createCrewlog, normalizeBase } from './crewlog.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const POLL_MS = 2000
/** A partial log must have been written this recently to count as a live game. */
const FRESH_MS = 30 * 1000
/** A live partial untouched this long is an abandoned game. */
const STALE_MS = 10 * 60 * 1000
/** Keep filming a moment after the END line so the result screen is on video. */
const TAIL_MS = 4000
const AUTOSAVED = path.join('Builds_Windows', 'CombatLogs', 'AutoSaved')

const userData = app.getPath('userData')
const defaultLibDir = path.join(userData, 'recordings')
/** The recordings folder: settings.libDir when the user picked one. Set after settings load. */
let libDir = defaultLibDir
/** True while the library is switching folders (recording is held off). */
let libMoving = false
const settingsPath = path.join(userData, 'settings.json')

let libraryWin = null
let recorderWin = null

// ─── Persistence ──────────────────────────────────────────────────────────

function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return fallback
  }
}

async function writeJson(p, v) {
  const tmp = `${p}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(v, null, 2))
  await fsp.rename(tmp, p)
}

/**
 * Recording quality. Card-game footage is mostly static, so VP9 holds up well
 * at low bitrates; height caps the captured resolution (aspect is kept).
 */
export const QUALITY = {
  high: { label: 'High · 1080p 30fps', height: 1080, fps: 30, mbps: 5 },
  balanced: { label: 'Balanced · 720p 30fps', height: 720, fps: 30, mbps: 2.5 },
  small: { label: 'Small · 720p 15fps', height: 720, fps: 15, mbps: 1.2 },
  tiny: { label: 'Tiny · 540p 10fps', height: 540, fps: 10, mbps: 0.6 },
}
const quality = () => QUALITY[settings.quality] ?? QUALITY.balanced

let settings = {
  sourceDir: null,
  capture: 'auto',
  autoRecord: true,
  quality: 'balanced',
  systemAudio: false,
  mic: false,
  micDevice: 'default',
  micGain: 1,
  ...readJson(settingsPath, {}),
}
const saveSettings = () => writeJson(settingsPath, settings)
if (typeof settings.libDir === 'string' && settings.libDir) libDir = settings.libDir

// ─── Sim folder ───────────────────────────────────────────────────────────

/** OPTCG Sim unpacks to folders like `1.31a_Windows`; the newest one wins. */
function detectSourceDir() {
  const roots = [os.homedir(), path.join(os.homedir(), 'Downloads'), path.join(os.homedir(), 'Desktop')]
  const found = []
  for (const root of roots) {
    let names = []
    try {
      names = fs.readdirSync(root)
    } catch {
      continue
    }
    for (const n of names) {
      if (!/^\d+\.\d+\w*_Windows$/i.test(n)) continue
      const dir = path.join(root, n, AUTOSAVED)
      if (fs.existsSync(dir)) found.push({ dir, mtime: fs.statSync(dir).mtimeMs })
    }
  }
  found.sort((a, b) => b.mtime - a.mtime)
  return found[0]?.dir ?? null
}

/** Only a folder the user confirmed: nothing is watched until they pick one. */
function sourceDir() {
  return settings.sourceDir && fs.existsSync(settings.sourceDir) ? settings.sourceDir : null
}

/** The install folder (…/1.31a_Windows) for an AutoSaved path, if it has that shape. */
function simRoot(dir = sourceDir()) {
  return dir && path.normalize(dir).toLowerCase().endsWith(AUTOSAVED.toLowerCase())
    ? path.normalize(dir).slice(0, -AUTOSAVED.length - 1)
    : null
}

/**
 * Accepts the install folder, Builds_Windows, CombatLogs or AutoSaved itself and
 * returns the AutoSaved path to watch (created if the sim hasn't saved a log yet).
 */
function resolveSourceDir(picked) {
  const p = path.resolve(String(picked))
  const tries = [
    [p, AUTOSAVED],
    [p, 'CombatLogs', 'AutoSaved'],
    [p, 'AutoSaved'],
  ]
  if (path.basename(p).toLowerCase() === 'autosaved' && fs.existsSync(p)) return p
  for (const t of tries) if (fs.existsSync(path.join(...t))) return path.join(...t)
  for (const base of [path.join(p, 'Builds_Windows'), p])
    if (fs.existsSync(path.join(base, 'OPTCGSim_Data'))) {
      const dir = path.join(base, 'CombatLogs', 'AutoSaved')
      fs.mkdirSync(dir, { recursive: true })
      return dir
    }
  return null
}

async function setSourceDir(picked) {
  const dir = resolveSourceDir(picked)
  if (!dir) return { ...status(), pickError: `"${picked}" doesn't look like an OPTCG Sim folder (no Builds_Windows/CombatLogs inside).` }
  settings.sourceDir = dir
  await saveSettings()
  ensureWatching()
  void refreshLeaders()
  return status()
}

// ─── Leader list ──────────────────────────────────────────────────────────
// The sim updates itself with new sets, so the leader list is re-read from its
// card database on launch and whenever the sim folder changes. The last good
// read is cached (keyed on the file's size + mtime) so an unchanged sim isn't
// re-parsed and the list survives the folder going missing.

const leadersCachePath = path.join(userData, 'leaders.json')
let leaders = BUNDLED_LEADERS
try {
  const cached = JSON.parse(fs.readFileSync(leadersCachePath, 'utf8'))
  if (Array.isArray(cached.leaders) && cached.leaders.length) leaders = mergeLeaders(cached.leaders, BUNDLED_LEADERS)
} catch {
  // no cache yet
}

let leadersBusy = false
async function refreshLeaders() {
  const root = simRoot()
  if (!root || leadersBusy) return
  leadersBusy = true
  try {
    const file = path.join(root, ASSETS)
    const st = await fsp.stat(file)
    let cached = null
    try {
      cached = JSON.parse(await fsp.readFile(leadersCachePath, 'utf8'))
    } catch {
      // first read
    }
    if (cached?.file === file && cached.size === st.size && cached.mtimeMs === st.mtimeMs) return
    const fromSim = parseLeaders(await fsp.readFile(file))
    if (fromSim.length < 20) return // layout changed or a partial file: keep what we have
    await fsp.writeFile(leadersCachePath, JSON.stringify({ file, size: st.size, mtimeMs: st.mtimeMs, leaders: fromSim }))
    const next = mergeLeaders(fromSim, BUNDLED_LEADERS)
    const changed = next.length !== leaders.length || next.some((l, i) => l.id !== leaders[i].id || l.name !== leaders[i].name)
    leaders = next
    if (changed) libraryWin?.webContents.send('app:event', { type: 'leaders' })
  } catch (e) {
    console.warn('leader refresh failed:', e.message)
  } finally {
    leadersBusy = false
  }
}

// ─── Library ──────────────────────────────────────────────────────────────

const idOk = (id) => typeof id === 'string' && /^[\w-]+$/.test(id)
const metaPath = (id) => path.join(libDir, `${id}.json`)

function withUrls(m) {
  const video = path.join(libDir, `${m.id}.webm`)
  return { ...m, videoUrl: fs.existsSync(video) ? pathToFileURL(video).href : null }
}

function listRecordings() {
  const out = []
  for (const n of fs.readdirSync(libDir)) {
    if (!n.endsWith('.json')) continue
    const m = readJson(path.join(libDir, n), null)
    if (m?.id) out.push(withUrls(m))
  }
  return out.sort((a, b) => (b.startedAt ?? '').localeCompare(a.startedAt ?? ''))
}

async function updateMeta(id, patch) {
  if (!idOk(id)) throw new Error('Bad id')
  const cur = readJson(metaPath(id), null)
  if (!cur) throw new Error('No such recording')
  const next = { ...cur, ...patch }
  await writeJson(metaPath(id), next)
  sendLibrary()
  return withUrls(next)
}

/** Give saved games without a result the one their log now yields (e.g. quits, which older versions missed). */
async function backfillResults() {
  for (const m of listRecordings()) {
    if (m.status !== 'done' || m.winnerSeat || !idOk(m.id)) continue
    let text = ''
    try {
      text = await fsp.readFile(path.join(libDir, `${m.id}.log`), 'utf8')
    } catch {
      continue
    }
    const patch = backfillResult(m, text)
    if (patch) await updateMeta(m.id, patch).catch(() => {})
  }
}

function sendLibrary() {
  libraryWin?.webContents.send('app:event', { type: 'library' })
}

// ─── Recording ────────────────────────────────────────────────────────────

/**
 * The active recording, or null.
 * { id, startMs, partial, stream, bytes, manual, stopping, endSeenAt }
 */
let rec = null
let lastError = null

function localStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`
}

/** Capturable windows and screens, minus this app's own windows. */
async function captureSources() {
  const own = new Set(BrowserWindow.getAllWindows().map((w) => w.getMediaSourceId()))
  const sources = await desktopCapturer.getSources({ types: ['window', 'screen'], thumbnailSize: { width: 0, height: 0 } })
  return sources.filter((s) => !own.has(s.id) && s.name !== 'OPTCG Recorder')
}

async function pickSource() {
  const sources = await captureSources()
  if (settings.capture && settings.capture !== 'auto') {
    const chosen = sources.find((s) => s.name === settings.capture) ?? sources.find((s) => s.id === settings.capture)
    if (chosen) return chosen
  }
  return (
    sources.find((s) => s.id.startsWith('window:') && /optcg/i.test(s.name)) ??
    sources.find((s) => s.id.startsWith('screen:')) ??
    sources[0]
  )
}

async function startRecording({ partial = null, manual = false } = {}) {
  if (rec || libMoving) return
  let id = localStamp()
  while (fs.existsSync(metaPath(id))) id += '-b'
  const startMs = Date.now()
  rec = { id, startMs, videoStartMs: null, turnAt: [], eventAt: [], partial, manual, bytes: 0, stopping: false, endSeenAt: null, lastText: '' }
  rec.stream = fs.createWriteStream(path.join(libDir, `${id}.webm`))
  await writeJson(metaPath(id), {
    id,
    startedAt: new Date(startMs).toISOString(),
    status: 'recording',
    title: 'Game in progress',
    tags: [],
    userTags: [],
    notes: '',
    starred: false,
  })
  await ensureRecorderWindow()
  const q = quality()
  recorderWin.webContents.send('rec:start', {
    id,
    fps: q.fps,
    height: q.height,
    bitrate: q.mbps * 1_000_000,
    systemAudio: !!settings.systemAudio,
    mic: settings.mic ? { deviceId: settings.micDevice || 'default', gain: settings.micGain ?? 1 } : null,
  })
  sendStatus()
  sendLibrary()
}

/** Ask the recorder to flush and stop; finalize when it confirms (or times out). */
function stopRecording(reason) {
  if (!rec || rec.stopping) return
  rec.stopping = true
  rec.stopReason = reason
  const cur = rec
  recorderWin?.webContents.send('rec:stop', { id: cur.id })
  cur.stopTimer = setTimeout(() => void finalize(cur), 8000)
  sendStatus()
}

ipcMain.on('rec:chunk', (_e, id, data) => {
  if (rec?.id !== id) return
  const buf = Buffer.from(data)
  rec.bytes += buf.length
  rec.stream.write(buf)
})
// The video's t=0 (MediaRecorder start), so turn stamps line up with playback.
ipcMain.on('rec:started', (_e, id, atMs) => {
  if (rec?.id === id) rec.videoStartMs = Number(atMs) || Date.now()
})
ipcMain.on('rec:stopped', (_e, id) => {
  if (rec?.id === id) void finalize(rec)
})
// Non-fatal (e.g. the mic could not be opened): keep recording, surface the message.
ipcMain.on('rec:warn', (_e, _id, message) => {
  lastError = String(message)
  sendStatus()
})
ipcMain.on('rec:error', (_e, id, message) => {
  lastError = message
  if (rec?.id === id) {
    rec.stopping = true
    rec.stopReason = 'error'
    void finalize(rec)
  }
  sendStatus()
})

async function finalize(cur) {
  if (cur.finalized) return
  cur.finalized = true
  clearTimeout(cur.stopTimer)
  await new Promise((r) => cur.stream.end(r))
  if (rec === cur) rec = null
  sendStatus()

  const durationMs = Date.now() - cur.startMs
  const videoPath = path.join(libDir, `${cur.id}.webm`)
  const size = fs.existsSync(videoPath) ? fs.statSync(videoPath).size : 0
  const base = readJson(metaPath(cur.id), { id: cur.id, userTags: [], notes: '', starred: false })

  // The finished log can lag the partial's END line by a moment; wait briefly.
  // After a quit there is no finished log: the partial is the whole game.
  let logFile = null
  if (cur.stopReason === 'quit' && cur.partial) {
    try {
      cur.lastText = await fsp.readFile(path.join(sourceDir(), cur.partial), 'utf8')
    } catch {
      /* keep the last poll's text */
    }
  }
  for (let i = 0; i < 10 && !logFile && cur.stopReason !== 'quit'; i++) {
    logFile = await findFinishedLog(cur)
    if (!logFile) await new Promise((r) => setTimeout(r, 1500))
  }
  let text = cur.lastText
  if (logFile) {
    try {
      text = await fsp.readFile(logFile, 'utf8')
      await fsp.copyFile(logFile, path.join(libDir, `${cur.id}.log`))
    } catch {
      /* keep the partial's text */
    }
  } else if (text) {
    await fsp.writeFile(path.join(libDir, `${cur.id}.log`), text)
  }

  let game = null
  if (text) game = parseLog(text)
  const finished = !!game?.winnerSeat
  const meta = {
    ...base,
    status: 'done',
    durationMs,
    size,
    stopReason: cur.stopReason ?? null,
    gameId: (logFile && parseLogFileName(path.basename(logFile))?.gameId) || (cur.partial && parseLogFileName(cur.partial)?.gameId) || null,
    ...(game
      ? {
          me: game.me,
          opp: game.opp,
          firstSeat: game.firstSeat,
          winnerSeat: game.winnerSeat,
          endReason: game.endReason,
          turns: game.turns,
          turnTimes: turnTimesFor(cur),
          events: eventsFor(cur, text),
          tags: tagsFor(game, { finished }),
          title: titleFor(game),
        }
      : { tags: ['no log'], title: cur.manual ? 'Manual recording' : 'Unknown game' }),
  }
  if (size === 0) meta.tags = [...meta.tags, 'no video']
  await writeJson(metaPath(cur.id), meta)
  sendLibrary()
  if (Notification.isSupported())
    new Notification({ title: 'Game saved', body: `${meta.title}  (${Math.round(durationMs / 60000)} min)` }).show()
  if (finished && game && crewlogHasCode()) void crewlog.enqueue(meta, leaders)
}

/**
 * Highlight events with their video time. Events the watcher never saw (the log's tail
 * after the last poll) have no time and are left out.
 */
function eventsFor(cur, text) {
  const t0 = cur.videoStartMs ?? cur.startMs
  return logEvents(text)
    .map((e, i) => (cur.eventAt[i] == null ? null : { ...e, t: Math.max(0, Math.round((cur.eventAt[i] - t0) / 100) / 10) }))
    .filter(Boolean)
}

/** Seconds into the video at which each turn began (as far as the watcher saw). */
function turnTimesFor(cur) {
  const t0 = cur.videoStartMs ?? cur.startMs
  return cur.turnAt.map((ms) => Math.max(0, Math.round((ms - t0) / 100) / 10))
}

/** The finished log for this recording: same game id, else the newest one written since it began. */
async function findFinishedLog(cur) {
  const dir = sourceDir()
  if (!dir) return null
  let names = []
  try {
    names = await fsp.readdir(dir)
  } catch {
    return null
  }
  const wantId = cur.partial ? parseLogFileName(cur.partial)?.gameId : null
  let best = null
  for (const n of names) {
    const info = parseLogFileName(n)
    if (!info || info.partial) continue
    const p = path.join(dir, n)
    if (wantId && info.gameId === wantId) return p
    try {
      const st = await fsp.stat(p)
      if (st.mtimeMs >= cur.startMs - 5000 && (!best || st.mtimeMs > best.mtime)) best = { p, mtime: st.mtimeMs }
    } catch {
      /* raced */
    }
  }
  if (best && claimedLogs.has(best.p)) return null
  if (best) claimedLogs.add(best.p)
  return best?.p ?? null
}
const claimedLogs = new Set()

// ─── Watcher ──────────────────────────────────────────────────────────────

/** Partials that were already old when first seen, or whose game we already recorded. */
const ignoredPartials = new Set()

async function tick() {
  const dir = sourceDir()
  if (!dir) return
  let names = []
  try {
    names = await fsp.readdir(dir)
  } catch {
    return
  }
  const now = Date.now()
  const partials = []
  for (const n of names) {
    if (!n.endsWith('.partial.log')) continue
    try {
      const st = await fsp.stat(path.join(dir, n))
      partials.push({ n, mtime: st.mtimeMs })
    } catch {
      /* raced with a rename */
    }
  }

  if (rec && !rec.stopping && rec.partial) {
    const cur = partials.find((p) => p.n === rec.partial)
    if (!cur) {
      stopRecording('log closed')
    } else {
      try {
        rec.lastText = await fsp.readFile(path.join(dir, rec.partial), 'utf8')
      } catch {
        /* keep last */
      }
      // No timestamps in the log: stamp each new turn when we first see it.
      for (let n = turnsStarted(rec.lastText); rec.turnAt.length < n; ) rec.turnAt.push(now)
      for (let n = logEvents(rec.lastText).length; rec.eventAt.length < n; ) rec.eventAt.push(now)
      // A quit ends the game too, but the sim writes no END line and never closes the partial.
      const quit = !rec.lastText.includes('\nRZ1|END|') && quitMidGame(rec.lastText)
      if (quit || rec.lastText.includes('\nRZ1|END|')) {
        rec.endSeenAt ??= now
        if (now - rec.endSeenAt >= TAIL_MS) stopRecording(quit ? 'quit' : 'game over')
      } else if (now - cur.mtime > STALE_MS) {
        stopRecording('abandoned')
      } else {
        await liveTag(rec)
      }
      // A newer game started without this one ending.
      if (partials.some((p) => p.n !== rec.partial && !ignoredPartials.has(p.n) && now - p.mtime < FRESH_MS && p.mtime > cur.mtime))
        stopRecording('new game')
    }
  }

  if (rec) sendStatus() // keep the size readout moving

  if (!rec && settings.autoRecord) {
    const fresh = partials
      .filter((p) => !ignoredPartials.has(p.n) && now - p.mtime < FRESH_MS)
      .sort((a, b) => b.mtime - a.mtime)[0]
    if (fresh) {
      ignoredPartials.add(fresh.n)
      await startRecording({ partial: fresh.n })
    }
  }
}

/** Tag the in-progress recording as soon as the leaders are in the log. */
async function liveTag(cur) {
  if (cur.liveTagged || !cur.lastText) return
  const g = parseLog(cur.lastText)
  if (!g.me.leaderName || !g.opp.leaderName) return
  cur.liveTagged = true
  const m = readJson(metaPath(cur.id), null)
  if (m) await writeJson(metaPath(cur.id), { ...m, me: g.me, opp: g.opp, firstSeat: g.firstSeat, title: `${titleFor(g)} (live)`, tags: tagsFor(g, { finished: false }) })
  sendLibrary()
}

let ticking = false
async function safeTick() {
  if (ticking) return
  ticking = true
  try {
    await tick()
  } catch (e) {
    lastError = String(e)
  } finally {
    ticking = false
  }
}

function seedIgnored() {
  const dir = sourceDir()
  if (!dir) return
  const now = Date.now()
  for (const n of fs.readdirSync(dir)) {
    if (!n.endsWith('.partial.log')) continue
    try {
      if (now - fs.statSync(path.join(dir, n)).mtimeMs >= FRESH_MS) ignoredPartials.add(n)
    } catch {
      /* gone */
    }
  }
}

let watcher = null
let watchedDir = null
function ensureWatching() {
  const dir = sourceDir()
  if (dir === watchedDir) return
  watcher?.close()
  watcher = null
  watchedDir = dir
  if (!dir) return
  seedIgnored()
  try {
    watcher = fs.watch(dir, () => void safeTick())
  } catch {
    watcher = null
  }
  sendStatus()
}

// ─── Status + IPC ─────────────────────────────────────────────────────────

function status() {
  return {
    sourceDir: sourceDir(),
    detectedDir: sourceDir() ? null : detectSourceDir(),
    libDir,
    autoRecord: settings.autoRecord,
    capture: settings.capture,
    quality: settings.quality,
    systemAudio: !!settings.systemAudio,
    mic: !!settings.mic,
    micDevice: settings.micDevice || 'default',
    micGain: settings.micGain ?? 1,
    qualities: Object.entries(QUALITY).map(([key, q]) => ({ key, label: q.label, mbPerMin: Math.round((q.mbps * 60) / 8) })),
    recording: rec && { id: rec.id, startMs: rec.startMs, bytes: rec.bytes, manual: rec.manual, stopping: rec.stopping },
    lastError,
    update,
    crewlog: crewlogStatus(),
  }
}

// ─── Crewlog ──────────────────────────────────────────────────────────────
// The connector code lives only in crewlog.key, encrypted with safeStorage. It is
// decrypted per request and only ever sent to the configured base URL.

const crewlogKeyPath = path.join(userData, 'crewlog.key')
const crewlogOutboxPath = path.join(userData, 'crewlog-outbox.json')
const crewlogBase = () => normalizeBase(settings.crewlogBase) ?? DEFAULT_BASE
const crewlogHasCode = () => fs.existsSync(crewlogKeyPath)
function crewlogCode() {
  try {
    if (!safeStorage.isEncryptionAvailable()) return null
    return safeStorage.decryptString(fs.readFileSync(crewlogKeyPath))
  } catch {
    return null
  }
}
/** The last thing worth telling the user: { ok, text, url?, at }. */
let crewlogLast = null
let crewlogWasBlocked = null

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return
  const n = new Notification({ title, body })
  if (onClick) n.on('click', onClick)
  n.show()
}
function openCrewlogUrl(url) {
  try {
    if (new URL(url).origin === crewlogBase()) void shell.openExternal(url)
  } catch {}
}

const crewlog = createCrewlog({
  fetch: (url, opts) => net.fetch(url, opts),
  getConfig: () => ({ base: crewlogBase(), code: crewlogCode() }),
  load: () => readJson(crewlogOutboxPath, []),
  save: (list) => writeJson(crewlogOutboxPath, list),
  log: (msg) => console.error(msg),
  onEvent: (ev) => {
    if (ev.type === 'logged') {
      const text = `Logged to Crewlog${ev.newSession ? " · Started today's sim session" : ''}`
      crewlogLast = { ok: true, text, url: ev.url, at: Date.now() }
      notify('Logged to Crewlog', ev.newSession ? "Started today's sim session" : ev.handle ? `as @${ev.handle}` : 'Game added', ev.url ? () => openCrewlogUrl(ev.url) : null)
    } else if (ev.type === 'dropped') {
      crewlogLast = { ok: false, text: `Crewlog didn't take a game: ${ev.error}`, at: Date.now() }
    } else if (ev.type === 'unknownLeader') {
      crewlogLast = { ok: false, text: "Can't log, unknown leader", at: Date.now() }
      notify('Not logged to Crewlog', "Can't log, unknown leader")
    } else if (ev.type === 'state') {
      const { blocked, error } = crewlog.state()
      if (blocked && blocked !== crewlogWasBlocked)
        notify('Crewlog stopped logging', blocked === 'unauthorized' ? `${error} Make a new code in Crewlog and paste it in Settings.` : error)
      crewlogWasBlocked = blocked
    }
    sendStatus()
  },
})

function crewlogStatus() {
  const s = crewlog.state()
  return { hasCode: crewlogHasCode(), base: crewlogBase(), ...s, last: crewlogLast }
}

/** { code?, base? }: a new code and/or base URL, then a connection check. */
ipcMain.handle('crewlog:set', async (_e, patch = {}) => {
  if (patch.base != null) {
    const base = normalizeBase(patch.base)
    if (!base) return { ok: false, error: 'Use an https:// address (http:// only for localhost), with no path.' }
    settings.crewlogBase = base
    await saveSettings()
  }
  const code = String(patch.code ?? '').trim()
  if (code) {
    if (!CODE_RE.test(code)) return { ok: false, error: 'A connector code is crw_ followed by 40 letters and digits.' }
    if (!safeStorage.isEncryptionAvailable()) return { ok: false, error: "This PC can't store the code securely, so it wasn't saved." }
    await fsp.writeFile(crewlogKeyPath, safeStorage.encryptString(code))
  }
  crewlog.reset()
  if (!crewlogHasCode()) return { ok: true }
  return crewlog.check()
})
ipcMain.handle('crewlog:check', () => (crewlogHasCode() ? crewlog.check() : { ok: false, error: 'Paste a connector code first.' }))
ipcMain.handle('crewlog:forget', async () => {
  await fsp.rm(crewlogKeyPath, { force: true })
  crewlog.reset()
  return { ok: true }
})
ipcMain.handle('crewlog:open', (_e, url) => openCrewlogUrl(String(url ?? '')))

/** Newer release found: {version, ready} (installed build) or {version, url} (portable). */
let update = null

function sendStatus() {
  libraryWin?.webContents.send('app:event', { type: 'status', status: status() })
}

ipcMain.handle('app:status', () => status())
ipcMain.handle('app:installUpdate', () => {
  if (!update?.ready) return { ok: false, error: 'No update downloaded yet.' }
  if (rec) return { ok: false, error: 'Finish the recording first.' }
  installUpdate()
  return { ok: true }
})
ipcMain.handle('app:openUpdatePage', () => {
  if (update?.url?.startsWith('https://github.com/')) void shell.openExternal(update.url)
})
ipcMain.handle('app:leaders', () => leaders)
ipcMain.handle('lib:list', () => listRecordings())
/** Misplay marks from the renderer: { t: seconds into the video, turn, note }, in time order. */
const cleanMisplays = (list) =>
  list
    .filter((m) => Number.isFinite(m?.t) && m.t >= 0)
    .map((m) => ({ t: m.t, turn: Number.isInteger(m.turn) && m.turn > 0 ? m.turn : null, note: String(m.note ?? '').slice(0, 500) }))
    .sort((a, b) => a.t - b.t)
ipcMain.handle('lib:update', (_e, id, patch) =>
  updateMeta(id, {
    ...(patch.userTags ? { userTags: patch.userTags.map(String).filter(Boolean) } : {}),
    ...(patch.notes != null ? { notes: String(patch.notes) } : {}),
    ...(patch.starred != null ? { starred: !!patch.starred } : {}),
    ...(Array.isArray(patch.misplays) ? { misplays: cleanMisplays(patch.misplays) } : {}),
  }),
)
ipcMain.handle('lib:delete', async (_e, id) => {
  if (!idOk(id) || rec?.id === id) throw new Error('Cannot delete this recording')
  for (const ext of ['webm', 'json', 'log']) await fsp.rm(path.join(libDir, `${id}.${ext}`), { force: true })
  sendLibrary()
})
ipcMain.handle('lib:reveal', (_e, id) => {
  if (idOk(id) && fs.existsSync(path.join(libDir, `${id}.webm`))) shell.showItemInFolder(path.join(libDir, `${id}.webm`))
  else void shell.openPath(libDir)
})
ipcMain.handle('rec:manualStart', () => startRecording({ manual: true }))
ipcMain.handle('rec:manualStop', () => stopRecording('manual'))
ipcMain.handle('app:listSources', async () => {
  const sources = await captureSources()
  return sources.map((s) => ({ id: s.id, name: s.name }))
})
ipcMain.handle('app:setSettings', async (_e, patch) => {
  if (patch.capture != null) settings.capture = String(patch.capture)
  if (patch.autoRecord != null) settings.autoRecord = !!patch.autoRecord
  if (patch.quality != null && QUALITY[patch.quality]) settings.quality = patch.quality
  if (patch.systemAudio != null) settings.systemAudio = !!patch.systemAudio
  if (patch.mic != null) settings.mic = !!patch.mic
  if (patch.micDevice != null) settings.micDevice = String(patch.micDevice)
  if (patch.micGain != null && Number.isFinite(+patch.micGain)) settings.micGain = Math.min(3, Math.max(0, +patch.micGain))
  await saveSettings()
  sendStatus()
  return status()
})
ipcMain.handle('app:chooseSourceDir', async () => {
  const r = await dialog.showOpenDialog(libraryWin, {
    title: 'Choose your OPTCG Sim folder (e.g. 1.31a_Windows)',
    defaultPath: simRoot() ?? (simRoot(detectSourceDir()) || os.homedir()),
    properties: ['openDirectory'],
  })
  return !r.canceled && r.filePaths[0] ? setSourceDir(r.filePaths[0]) : status()
})
ipcMain.handle('app:useSourceDir', (_e, dir) => setSourceDir(dir))
ipcMain.handle('app:chooseLibDir', async () => {
  const busy = () => (rec ? 'Finish the current recording first.' : libMoving ? 'Already changing the folder.' : null)
  if (busy()) return { ...status(), pickError: busy() }
  const r = await dialog.showOpenDialog(libraryWin, {
    title: 'Choose where recordings are saved',
    defaultPath: libDir,
    properties: ['openDirectory', 'createDirectory'],
  })
  const to = !r.canceled && r.filePaths[0]
  if (!to) return status()
  const problem = libDirProblem(libDir, to) ?? (await writableProblem(to))
  if (problem) return { ...status(), pickError: problem }

  const n = recordingIds(libDir).length
  let move = false
  if (n) {
    const games = n === 1 ? '1 game' : `${n} games`
    const { response } = await dialog.showMessageBox(libraryWin, {
      type: 'question',
      title: 'Recordings folder',
      message: `Move your ${games} to the new folder?`,
      detail: `From: ${libDir}\nTo: ${to}\n\nIf you leave them, they stay in the old folder and won't show in the library unless you switch back to it.`,
      buttons: [`Move ${games}`, 'Leave them', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
      noLink: true,
    })
    if (response === 2) return status()
    move = response === 0
  }
  if (busy()) return { ...status(), pickError: busy() } // a game started while the dialog was open

  libMoving = true
  let moved = null
  try {
    if (move) {
      sendStatus()
      moved = await moveRecordings(libDir, to)
    }
    libDir = to
    settings.libDir = to
    await saveSettings()
  } finally {
    libMoving = false
  }
  sendLibrary()
  sendStatus()
  return { ...status(), moved }
})

// ─── Card images ──────────────────────────────────────────────────────────
// card://img/OP18-022[?small] → the sim's own art when we know its folder (works
// offline and covers sets the CDN doesn't have yet), else the Limitless CDN art,
// cached on disk after first use.

const CDN = 'https://limitlesstcg.nyc3.cdn.digitaloceanspaces.com/one-piece'
const cardDir = path.join(userData, 'cards')
protocol.registerSchemesAsPrivileged([{ scheme: 'card', privileges: { standard: true, secure: true, supportFetchAPI: true } }])

async function serveCard(req) {
  const id = decodeURIComponent(new URL(req.url).pathname.slice(1)).toUpperCase()
  if (!/^[A-Z]+\d*-\d{3}$/.test(id)) return new Response('bad id', { status: 400 })
  const set = id.split('-')[0]
  const root = simRoot() ?? simRoot(detectSourceDir())
  if (root) {
    const dir = path.join(root, 'Builds_Windows', 'OPTCGSim_Data', 'StreamingAssets', 'Cards', set)
    const small = new URL(req.url).searchParams.has('small')
    for (const name of small ? [`${id}_small.jpg`, `${id}.jpg`] : [`${id}.jpg`]) {
      try {
        return new Response(await fsp.readFile(path.join(dir, name)), { headers: { 'content-type': 'image/jpeg' } })
      } catch {}
    }
  }
  const file = path.join(cardDir, `${id}.webp`)
  try {
    return new Response(await fsp.readFile(file), { headers: { 'content-type': 'image/webp' } })
  } catch {}
  const res = await net.fetch(`${CDN}/${set}/${id}_EN.webp`).catch(() => null)
  if (!res?.ok) return new Response('not found', { status: 404 })
  const buf = Buffer.from(await res.arrayBuffer())
  await fsp.mkdir(cardDir, { recursive: true })
  await fsp.writeFile(file, buf).catch(() => {})
  return new Response(buf, { headers: { 'content-type': 'image/webp' } })
}

// ─── Windows ──────────────────────────────────────────────────────────────

const webPreferences = {
  preload: path.join(__dirname, 'preload.cjs'),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: true,
}

async function ensureRecorderWindow() {
  if (recorderWin && !recorderWin.isDestroyed()) return
  recorderWin = new BrowserWindow({ show: false, width: 320, height: 200, webPreferences: { ...webPreferences, backgroundThrottling: false } })
  recorderWin.on('closed', () => (recorderWin = null))
  await recorderWin.loadFile(path.join(__dirname, 'renderer', 'recorder.html'))
}

async function createLibraryWindow() {
  libraryWin = new BrowserWindow({
    width: 1320,
    height: 860,
    backgroundColor: '#0b1220',
    title: 'OPTCG Recorder',
    autoHideMenuBar: true,
    webPreferences,
  })
  libraryWin.on('closed', () => (libraryWin = null))
  if (process.env.REC_DEBUG) libraryWin.webContents.on('console-message', (_e, level, msg) => console.log(`[ui:${level}] ${msg}`))
  await libraryWin.loadFile(path.join(__dirname, 'renderer', 'index.html'))
}

// ─── Lifecycle ────────────────────────────────────────────────────────────

if (!app.requestSingleInstanceLock()) app.quit()
else {
  app.on('second-instance', () => {
    if (!libraryWin) return void createLibraryWindow()
    if (libraryWin.isMinimized()) libraryWin.restore()
    libraryWin.focus()
  })

  app.whenReady().then(async () => {
    app.setAppUserModelId('OPTCG Recorder')
    try {
      await fsp.mkdir(libDir, { recursive: true })
    } catch (e) {
      // The chosen folder is gone (e.g. an unplugged drive): record to the default for now.
      lastError = `Recordings folder ${libDir} is unavailable (${e.code ?? e.message}); saving to ${defaultLibDir} for now.`
      libDir = defaultLibDir
      await fsp.mkdir(libDir, { recursive: true })
    }
    protocol.handle('card', serveCard)
    // Recordings interrupted by a crash or a closed app: mark them, keep the video.
    for (const m of listRecordings()) if (m.status === 'recording') await updateMeta(m.id, { status: 'done', tags: [...(m.tags ?? []), 'interrupted'] })
    await backfillResults()
    void crewlog.flush() // games that didn't make it last time

    // getDisplayMedia in the recorder window gets the source we pick here; no picker UI.
    // 'loopback' is the whole system mix (Windows can't capture one window's audio).
    session.defaultSession.setDisplayMediaRequestHandler(async (req, callback) => {
      try {
        const video = await pickSource()
        callback(req.audioRequested && settings.systemAudio ? { video, audio: 'loopback' } : { video })
      } catch {
        callback({})
      }
    })

    ensureWatching()
    void refreshLeaders()
    setInterval(() => {
      ensureWatching()
      void safeTick()
    }, POLL_MS)
    await ensureRecorderWindow()
    await createLibraryWindow()
    void safeTick()
    startUpdateChecks((u) => {
      update = u
      sendStatus()
    })
  })

  // Closing the library window quits; stop and save any recording first.
  app.on('window-all-closed', () => app.quit())
  let quitting = false
  app.on('before-quit', (e) => {
    if (!rec || quitting) return
    e.preventDefault()
    quitting = true
    const cur = rec
    stopRecording('app closed')
    const wait = setInterval(() => {
      if (cur.finalized) {
        clearInterval(wait)
        app.quit()
      }
    }, 200)
  })
}
