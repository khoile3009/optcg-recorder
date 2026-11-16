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
import { app, BrowserWindow, Notification, desktopCapturer, dialog, ipcMain, session, shell } from 'electron'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { parseLog, parseLogFileName, tagsFor, titleFor } from './logtags.mjs'

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
const libDir = path.join(userData, 'recordings')
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

let settings = { sourceDir: null, capture: 'auto', autoRecord: true, fps: 30, bitrateMbps: 6, ...readJson(settingsPath, {}) }
const saveSettings = () => writeJson(settingsPath, settings)

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

function sourceDir() {
  if (settings.sourceDir && fs.existsSync(settings.sourceDir)) return settings.sourceDir
  return detectSourceDir()
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
  if (rec) return
  let id = localStamp()
  while (fs.existsSync(metaPath(id))) id += '-b'
  const startMs = Date.now()
  rec = { id, startMs, partial, manual, bytes: 0, stopping: false, endSeenAt: null, lastText: '' }
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
  recorderWin.webContents.send('rec:start', { id, fps: settings.fps, bitrate: settings.bitrateMbps * 1_000_000 })
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
ipcMain.on('rec:stopped', (_e, id) => {
  if (rec?.id === id) void finalize(rec)
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
  let logFile = null
  for (let i = 0; i < 10 && !logFile; i++) {
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
      if (rec.lastText.includes('\nRZ1|END|')) {
        rec.endSeenAt ??= now
        if (now - rec.endSeenAt >= TAIL_MS) stopRecording('game over')
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
    libDir,
    autoRecord: settings.autoRecord,
    capture: settings.capture,
    recording: rec && { id: rec.id, startMs: rec.startMs, bytes: rec.bytes, manual: rec.manual, stopping: rec.stopping },
    lastError,
  }
}

function sendStatus() {
  libraryWin?.webContents.send('app:event', { type: 'status', status: status() })
}

ipcMain.handle('app:status', () => status())
ipcMain.handle('lib:list', () => listRecordings())
ipcMain.handle('lib:update', (_e, id, patch) =>
  updateMeta(id, {
    ...(patch.userTags ? { userTags: patch.userTags.map(String).filter(Boolean) } : {}),
    ...(patch.notes != null ? { notes: String(patch.notes) } : {}),
    ...(patch.starred != null ? { starred: !!patch.starred } : {}),
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
  await saveSettings()
  sendStatus()
  return status()
})
ipcMain.handle('app:chooseSourceDir', async () => {
  const r = await dialog.showOpenDialog(libraryWin, {
    title: 'Choose OPTCG Sim’s CombatLogs/AutoSaved folder (or the install folder)',
    defaultPath: sourceDir() ?? os.homedir(),
    properties: ['openDirectory'],
  })
  if (!r.canceled && r.filePaths[0]) {
    let dir = r.filePaths[0]
    if (fs.existsSync(path.join(dir, AUTOSAVED))) dir = path.join(dir, AUTOSAVED)
    settings.sourceDir = dir
    await saveSettings()
    ensureWatching()
  }
  return status()
})

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
    await fsp.mkdir(libDir, { recursive: true })
    // Recordings interrupted by a crash or a closed app: mark them, keep the video.
    for (const m of listRecordings()) if (m.status === 'recording') await updateMeta(m.id, { status: 'done', tags: [...(m.tags ?? []), 'interrupted'] })

    // getDisplayMedia in the recorder window gets the source we pick here; no picker UI.
    session.defaultSession.setDisplayMediaRequestHandler(async (_req, callback) => {
      try {
        callback({ video: await pickSource() })
      } catch {
        callback({})
      }
    })

    ensureWatching()
    setInterval(() => {
      ensureWatching()
      void safeTick()
    }, POLL_MS)
    await ensureRecorderWindow()
    await createLibraryWindow()
    void safeTick()
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
