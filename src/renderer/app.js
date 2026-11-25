import { matchesFilters, matchupStats, recordStats, shortName } from '../logtags.mjs'
import { LEADERS as BUNDLED_LEADERS } from '../data/leaders.mjs'

const api = window.recorder
const $ = (id) => document.getElementById(id)
const el = (tag, cls, text) => {
  const e = document.createElement(tag)
  if (cls) e.className = cls
  if (text != null) e.textContent = text
  return e
}

// Bundled list until main hands over the one read from the installed sim (it
// refreshes on launch and whenever the sim folder changes).
let LEADERS = BUNDLED_LEADERS
let LEADER = new Map(LEADERS.map((l) => [l.id, l]))
async function loadLeaders() {
  try {
    const list = await api.leaders()
    if (Array.isArray(list) && list.length) LEADERS = list
  } catch {
    /* keep the bundled list */
  }
  LEADER = new Map(LEADERS.map((l) => [l.id, l]))
}
const COLOR_HEX = { Red: '#e5484d', Green: '#30a46c', Blue: '#3e8ed0', Purple: '#8e4ec6', Black: '#8b8d98', Yellow: '#f5c518' }

let recs = []
let status = null
let selId = null
const filters = { result: '', order: '', kind: '', event: '', starred: false, misplays: false, me: [], opp: [], userTags: [], text: '' }

// ─── Helpers ──────────────────────────────────────────────────────────────

const fmtDur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
const fmtSize = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round((b ?? 0) / 1e6)} MB`)
const SOURCE_LABEL = { queue: 'Queue', private: 'Private' }
/** "vs Scarria · G2" (the opponent's name stays on this machine). */
const setLabel = (r) => (r.set ? `vs ${shortName(r.opp?.name) || '?'} · G${r.set.game}` : '')
const normName = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().toLowerCase()
/** Known event with this name (so retyping a name reuses its id), or undefined. */
const eventByName = (name) => (status?.events ?? []).find((e) => normName(e.name) === normName(name))
const leaderName = (side) => LEADER.get(side?.leaderId)?.name ?? side?.leaderName ?? side?.leaderId ?? '?'

/** A leader portrait (art crop of the card), with a colour ring. */
function avatar(id, size = 'md', small = true) {
  const wrap = el('span', `avatar ${size}`)
  const colors = LEADER.get(id)?.colors ?? []
  wrap.style.setProperty(
    '--ring',
    colors.length > 1
      ? `linear-gradient(135deg, ${colors.map((c) => COLOR_HEX[c]).join(', ')})`
      : (COLOR_HEX[colors[0]] ?? '#3a4560'),
  )
  if (id) {
    const img = el('img')
    img.loading = 'lazy'
    img.alt = LEADER.get(id)?.name ?? id
    img.src = `card://img/${id}${small ? '?small' : ''}`
    img.onerror = () => img.replaceWith(el('span', 'noimg', id.split('-')[0]))
    wrap.append(img)
  } else wrap.append(el('span', 'noimg', '?'))
  return wrap
}

const colorDots = (id) => {
  const d = el('span', 'dots')
  for (const c of LEADER.get(id)?.colors ?? []) {
    const s = el('span', 'cdot')
    s.style.background = COLOR_HEX[c]
    s.title = c
    d.append(s)
  }
  return d
}

// ─── Status, settings, onboarding ─────────────────────────────────────────

$('updateBtn').onclick = async () => {
  if (!status?.update) return
  if (!status.update.ready) return void api.openUpdatePage()
  const res = await api.installUpdate()
  if (!res?.ok && res?.error) alert(res.error)
}

function renderStatus() {
  if (!status) return
  const r = status.recording
  const mode = status.onGameStart ?? (status.autoRecord ? 'record' : 'off')
  $('state').className = `pill ${r ? (r.track ? 'track' : 'rec') : status.sourceDir && mode !== 'off' ? 'armed' : 'idle'}`
  $('stateText').textContent = r
    ? r.stopping
      ? 'Saving…'
      : r.track
        ? `Tracking · T${Math.max(1, r.turn ?? 0)} · ${fmtDur(Date.now() - r.startMs)}`
        : `Recording ${fmtDur(Date.now() - r.startMs)} · ${fmtSize(r.bytes)}`
    : !status.sourceDir
      ? 'Choose the sim folder'
      : mode === 'track'
        ? 'Waiting for a game (track only)'
        : mode === 'record'
          ? 'Waiting for a game'
          : 'Auto off'
  $('recBtn').textContent = r ? (r.track ? '■ Stop tracking' : '■ Stop') : mode === 'track' ? '● Track now' : '● Record now'
  $('recBtn').classList.toggle('stop', !!r)
  $('recBtn').disabled = !!r?.stopping
  $('upgradeBtn').hidden = !(r?.track && !r.stopping)
  for (const b of $('gameStart').querySelectorAll('button')) b.classList.toggle('on', b.dataset.v === mode)
  $('gameStartHint').textContent = {
    record: 'Records video and saves the game summary.',
    track: 'Saves result, turns, events and the log. No video, no disk space.',
    off: 'Nothing happens until you press Record now.',
  }[mode]
  $('emptyText').textContent = {
    record: 'Start a game in OPTCG Sim and it records automatically. Finished games appear on the left.',
    track: 'Start a game in OPTCG Sim and it is tracked automatically (no video). Finished games appear on the left.',
    off: 'Auto is off. Press Record now to capture a game. Finished games appear on the left.',
  }[mode]
  $('sysAudio').checked = !!status.systemAudio
  $('micOn').checked = !!status.mic
  $('micOpts').hidden = !status.mic
  if (document.activeElement !== $('micGain')) $('micGain').value = status.micGain ?? 1
  $('micGainLabel').textContent = `${Math.round(($('micGain').value || 1) * 100)}%`
  $('folderHint').textContent = [
    status.sourceDir ? `Watching ${status.sourceDir}` : 'No sim folder chosen yet.',
    status.libDir ? `Recordings saved to ${status.libDir}` : '',
  ]
    .filter(Boolean)
    .join('\n')
  const crwProblem = status.crewlog?.blocked ? `Crewlog: ${status.crewlog.error}` : null
  $('error').hidden = !(status.lastError || crwProblem)
  $('error').textContent = status.lastError ?? crwProblem ?? ''
  renderCrewlog()
  renderEventMode()
  const u = status.update
  $('updateBar').hidden = !u
  if (u) {
    $('updateText').textContent = u.ready
      ? `Version ${u.version} is ready to install.`
      : `Version ${u.version} is available.`
    $('updateBtn').textContent = u.ready ? 'Restart to update' : 'Download'
    $('updateBtn').disabled = u.ready && !!r
    $('updateBtn').title = u.ready && r ? 'Available once the recording is saved' : ''
  }

  const q = $('quality')
  if (q.options.length !== status.qualities.length)
    q.replaceChildren(...status.qualities.map((x) => new Option(`${x.label} · ~${x.mbPerMin} MB/min`, x.key)))
  if (document.activeElement !== q) q.value = status.quality
  renderOnboard()
}
setInterval(renderStatus, 1000)

let obError = ''
function renderOnboard() {
  const need = !status.sourceDir
  $('onboard').hidden = !need
  if (!need) return
  const d = status.detectedDir
  $('obLabel').textContent = d ? 'Found automatically' : 'Not found automatically'
  $('obDetected').textContent = d ?? 'Click "Choose another folder…" and pick your OPTCG Sim folder.'
  $('obUse').hidden = !d
  $('obError').hidden = !obError
  $('obError').textContent = obError
}
const afterPick = (s) => {
  obError = s.pickError ?? ''
  status = s
  renderStatus()
  if (!obError) void refresh()
}
$('obUse').onclick = async () => afterPick(await api.useSourceDir(status.detectedDir))
$('obChoose').onclick = async () => afterPick(await api.chooseSourceDir())

async function loadSources() {
  const sources = await api.listSources()
  const sel = $('capture')
  sel.replaceChildren(new Option('Auto: OPTCG Sim window, else screen', 'auto'))
  for (const s of sources) sel.add(new Option(`${s.id.startsWith('screen:') ? 'Screen' : 'Window'}: ${s.name}`, s.name))
  if (status?.capture && status.capture !== 'auto' && ![...sel.options].some((o) => o.value === status.capture))
    sel.add(new Option(`(not open) ${status.capture}`, status.capture))
  sel.value = status?.capture ?? 'auto'
}

async function loadMics() {
  let mics = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
  // Device labels stay blank until mic access has been granted once.
  if (status?.mic && mics.length && !mics.some((d) => d.label)) {
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true })
      s.getTracks().forEach((t) => t.stop())
      mics = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput')
    } catch {}
  }
  const sel = $('micDevice')
  sel.replaceChildren(new Option('System default', 'default'))
  mics
    .filter((d) => d.deviceId !== 'default' && d.deviceId !== 'communications')
    .forEach((d, i) => sel.add(new Option(d.label || `Microphone ${i + 1}`, d.deviceId)))
  const want = status?.micDevice ?? 'default'
  if (![...sel.options].some((o) => o.value === want)) sel.add(new Option('(not connected) saved mic', want))
  sel.value = want
}

$('recBtn').onclick = () =>
  status?.recording ? api.stop() : api.start({ track: (status?.onGameStart ?? 'record') === 'track' })
$('upgradeBtn').onclick = async () => {
  $('upgradeBtn').disabled = true
  try {
    await api.upgrade()
  } finally {
    $('upgradeBtn').disabled = false
  }
}
$('sysAudio').onchange = (e) => api.setSettings({ systemAudio: e.target.checked })
$('micOn').onchange = async (e) => {
  status = await api.setSettings({ mic: e.target.checked })
  renderStatus()
  if (e.target.checked) void loadMics()
}
$('micDevice').onfocus = loadMics
$('micDevice').onchange = (e) => api.setSettings({ micDevice: e.target.value })
$('micGain').oninput = (e) => ($('micGainLabel').textContent = `${Math.round(e.target.value * 100)}%`)
$('micGain').onchange = (e) => api.setSettings({ micGain: Number(e.target.value) })
for (const b of $('gameStart').querySelectorAll('button'))
  b.onclick = async () => {
    status = await api.setSettings({ onGameStart: b.dataset.v })
    renderStatus()
  }
$('quality').onchange = (e) => api.setSettings({ quality: e.target.value })
$('capture').onfocus = loadSources
$('capture').onchange = (e) => api.setSettings({ capture: e.target.value })
$('folderBtn').onclick = async () => {
  const s = await api.chooseSourceDir()
  if (s.pickError) alert(s.pickError)
  status = s
  renderStatus()
}
$('libDirBtn').onclick = async () => {
  const s = await api.chooseLibDir()
  if (s.pickError) alert(s.pickError)
  else if (s.moved && (s.moved.skipped || s.moved.failed)) {
    const parts = [`Moved ${s.moved.moved} game${s.moved.moved === 1 ? '' : 's'}.`]
    if (s.moved.skipped) parts.push(`${s.moved.skipped} left in the old folder (same name already in the new one).`)
    if (s.moved.failed) parts.push(`${s.moved.failed} couldn't be moved and stayed in the old folder.`)
    alert(parts.join('\n'))
  }
  status = s
  renderStatus()
  await refresh()
}
$('libBtn').onclick = () => api.reveal(null)

// ─── Crewlog connector ────────────────────────────────────────────────────
// The code never comes back from main: the field only ever holds what you type.

let crwNote = null // { ok, text } from the last Save / Check
function renderCrewlog() {
  const c = status?.crewlog
  if (!c) return
  if (document.activeElement !== $('crwBase')) $('crwBase').value = c.base ?? ''
  $('crwCode').placeholder = c.hasCode ? 'Saved · paste a new code to replace it' : 'crw_…'
  $('crwCheck').disabled = !c.hasCode
  $('crwForget').disabled = !c.hasCode
  const el = $('crwStatus')
  let text, cls
  if (c.hasCode && c.blocked === 'unauthorized') [text, cls] = [`Not connected: ${c.error} Paste a new code.`, 'bad']
  else if (c.hasCode && c.blocked === 'suspended') [text, cls] = [`Stopped: ${c.error}`, 'bad']
  else if (crwNote && !crwNote.ok) [text, cls] = [crwNote.text, 'bad']
  else if (!c.hasCode) [text, cls] = ['Not connected.', '']
  else if (c.connected) [text, cls] = [`Connected as @${c.handle}`, 'good']
  else [text, cls] = ['Code saved. Press Check to test it.', '']
  if (c.pending) text += ` · ${c.pending} game${c.pending === 1 ? '' : 's'} waiting to send`
  if (c.pending && c.retryError) text += ` (${c.retryError})`
  el.textContent = text
  el.className = `hint crwStatus ${cls}`
  const last = c.last
  const box = $('crwLast')
  box.replaceChildren()
  if (last) {
    box.className = `hint ${last.ok ? '' : 'bad'}`
    box.append(last.text)
    if (last.url) {
      const a = document.createElement('a')
      a.href = '#'
      a.textContent = 'View'
      a.onclick = (e) => {
        e.preventDefault()
        void api.crewlogOpen(last.url)
      }
      box.append(' · ', a)
    }
  }
}
async function crewlogDo(p) {
  const res = await p
  crwNote = res?.ok ? null : { ok: false, text: res?.error ?? 'Something went wrong.' }
  status = await api.status()
  renderStatus()
}
$('crwSave').onclick = async () => {
  const code = $('crwCode').value.trim()
  await crewlogDo(api.crewlogSet({ base: $('crwBase').value.trim(), ...(code ? { code } : {}) }))
  if (!crwNote) $('crwCode').value = ''
}
$('crwCheck').onclick = () => crewlogDo(api.crewlogCheck())
$('crwForget').onclick = () => crewlogDo(api.crewlogForget())
$('settingsBtn').onclick = (e) => {
  e.stopPropagation()
  $('settings').hidden = !$('settings').hidden
  if (!$('settings').hidden) {
    void loadSources()
    void loadMics()
  }
}
document.addEventListener('click', (e) => {
  if (!$('settings').hidden && !$('settings').contains(e.target)) $('settings').hidden = true
})

// ─── Event mode ───────────────────────────────────────────────────────────

let eventKeys = ''
const pickerOn = () => !!status?.crewlog?.picker
function renderEventMode() {
  if (pickerOn()) return renderEventPicker()
  $('pickPop').hidden = true
  const ev = status.event
  $('eventBtn').classList.toggle('on', !!ev)
  $('eventText').textContent = ev ? `Event: ${ev.name}` : 'Sim session'
  $('eventBtn').title = ev
    ? 'Event mode is on: games you play now are tagged with this event. Click to switch or end it.'
    : 'Games go to your sim session. Click to start Event mode for an online tournament.'
  $('eventStop').hidden = !ev
  $('eventStart').textContent = ev ? 'Switch event' : 'Start event'
  const names = (status.events ?? []).map((e) => e.name)
  if (names.join('\n') !== eventKeys) {
    eventKeys = names.join('\n')
    $('eventSuggest').replaceChildren(...names.map((n) => new Option(n)))
  }
}
const showEventErr = (msg) => {
  $('eventErr').hidden = !msg
  $('eventErr').textContent = msg ?? ''
}
$('eventBtn').onclick = (e) => {
  e.stopPropagation()
  if (pickerOn()) {
    $('eventPop').hidden = true
    const open = $('pickPop').hidden
    $('pickPop').hidden = !open
    $('eventBtn').setAttribute('aria-expanded', String(open))
    if (open) {
      pickErr = null
      renderEventPicker()
    }
    return
  }
  const open = $('eventPop').hidden
  $('eventPop').hidden = !open
  $('eventBtn').setAttribute('aria-expanded', String(open))
  if (open) {
    showEventErr('')
    $('eventName').value = status?.event?.name ?? ''
    $('eventName').focus()
    $('eventName').select()
  }
}
$('eventPop').onsubmit = async (e) => {
  e.preventDefault()
  const name = $('eventName').value
  const known = eventByName(name)
  const client_id = known?.client_id
  const res = await api.setEvent({ name, client_id })
  if (!res?.ok) return showEventErr(res?.error ?? 'Could not start the event.')
  $('eventPop').hidden = true
}
$('eventStop').onclick = async () => {
  await api.setEvent(null)
  $('eventPop').hidden = true
}
document.addEventListener('click', (e) => {
  if ($('eventWrap').contains(e.target)) return
  $('eventPop').hidden = true
  $('pickPop').hidden = true
})
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return
  $('eventPop').hidden = true
  $('pickPop').hidden = true
})

// ─── Crewlog event picker (servers that list events) ──────────────────────

let pickErr = null // the last failed action in the picker
let pickBusy = false
const KIND_LABEL = { sim: 'Sim', tournament: 'Tournament' }
const leaderLabel = (id) => (id ? (LEADER.get(id)?.name ?? id) : 'any leader')
const fmtAgo = (at) => {
  const s = Math.round((Date.now() - at) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
}

function renderEventPicker() {
  const c = status.crewlog
  const pick = c.pick
  const btn = $('eventBtn')
  btn.classList.toggle('on', !!c.logging)
  $('eventText').textContent = c.logging ? `Adding games to ${pick.name}` : 'Not adding games'
  btn.title = c.logging
    ? `Finished games go to ${pick.name} in Crewlog. Click to switch events or stop.`
    : 'Finished games are saved here but not sent to Crewlog. Click to pick an event.'

  const ev = c.events ?? {}
  $('pickFetched').textContent = pickBusy ? 'Fetching…' : ev.fetchedAt ? `Fetched ${fmtAgo(ev.fetchedAt)}` : ''
  $('pickFetch').disabled = pickBusy || !c.hasCode

  const err = pickErr ?? ev.error ?? (!c.hasCode ? 'Paste a connector code in Settings first.' : null)
  $('pickErr').hidden = !err
  $('pickErr').textContent = err ?? ''

  $('pickNotice').hidden = !c.notice
  $('pickNotice').textContent = c.notice ?? ''

  const list = $('pickList')
  if (!ev.list) list.replaceChildren(el('div', 'hint', pick ? `Picked: ${pick.name}. Fetch events to see the rest.` : 'Fetch events to see what you can log to.'))
  else if (!ev.list.length) list.replaceChildren(el('div', 'hint', 'No open events. Start a sim session or tournament in Crewlog, then fetch again.'))
  else
    list.replaceChildren(
      ...ev.list.map((row) => {
        const b = el('button', `pickRow${pick?.id === row.id ? ' on' : ''}`)
        b.type = 'button'
        b.setAttribute('role', 'option')
        b.setAttribute('aria-selected', String(pick?.id === row.id))
        const top = el('div', 'pickTop')
        top.append(el('span', 'pickName', row.name), el('span', `pickKind ${row.kind}`, KIND_LABEL[row.kind] ?? row.kind))
        const bits = [`${row.wins}-${row.losses}`]
        if (row.played_on) bits.push(row.played_on)
        bits.push(leaderLabel(row.my_leader))
        b.append(top, el('div', 'pickMeta hint', bits.join(' · ')))
        b.onclick = () => pickDo(api.crewlogPick(row.id))
        return b
      }),
    )

  $('pickLogging').checked = !!c.logging
  $('pickLogging').disabled = !pick
  $('pickLoggingText').textContent = pick ? `Add finished games to ${pick.name}` : 'Pick an event to add games'

  const waiting = c.waiting ?? 0
  $('pickWaiting').hidden = !waiting
  if (waiting) {
    const what = `${waiting} game${waiting === 1 ? '' : 's'} waiting`
    $('pickWaitingText').textContent = c.waitingError ? `${what}: ${c.waitingError}` : `${what} for an event.`
    $('pickSend').textContent = pick ? `Send to ${pick.name}` : 'Send'
    $('pickSend').disabled = !pick
  }

  const box = $('pickLast')
  box.replaceChildren()
  const last = c.last
  if (last) {
    box.className = `hint ${last.ok ? '' : 'bad'}`
    box.append(last.text)
    if (last.url) {
      const a = el('a', null, 'View')
      a.href = '#'
      a.onclick = (e) => {
        e.preventDefault()
        void api.crewlogOpen(last.url)
      }
      box.append(' · ', a)
    }
  }
}
async function pickDo(p) {
  const res = await p
  pickErr = res?.ok ? null : (res?.error ?? 'Something went wrong.')
  status = await api.status()
  renderStatus()
}
$('pickFetch').onclick = async () => {
  pickBusy = true
  renderEventPicker()
  try {
    await pickDo(api.crewlogEvents())
  } finally {
    pickBusy = false
    renderEventPicker()
  }
}
$('pickLogging').onchange = (e) => pickDo(api.crewlogSetLogging(e.target.checked))
$('pickSend').onclick = () => pickDo(api.crewlogWaiting('send'))
$('pickDiscard').onclick = () => {
  const n = status?.crewlog?.waiting ?? 0
  if (confirm(`Discard ${n === 1 ? 'the waiting game' : `${n} waiting games`}? ${n === 1 ? 'It stays' : 'They stay'} in your library but won't go to Crewlog.`))
    void pickDo(api.crewlogWaiting('discard'))
}

// ─── Sidebar: filters ─────────────────────────────────────────────────────

const toggleIn = (arr, v) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v])
const anyFilter = () =>
  !!(
    filters.result ||
    filters.order ||
    filters.kind ||
    filters.event ||
    filters.starred ||
    filters.misplays ||
    filters.me.length ||
    filters.opp.length ||
    filters.userTags.length ||
    filters.text
  )

for (const seg of document.querySelectorAll('.seg[data-key]'))
  for (const b of seg.querySelectorAll('button'))
    b.onclick = () => {
      filters[seg.dataset.key] = b.dataset.v
      if (seg.dataset.key === 'kind' && b.dataset.v !== 'event') filters.event = ''
      renderAll()
    }
$('eventFilter').onchange = (e) => {
  filters.event = e.target.value
  renderAll()
}
$('starFilter').onclick = () => {
  filters.starred = !filters.starred
  renderAll()
}
$('misplayFilter').onclick = () => {
  filters.misplays = !filters.misplays
  renderAll()
}
$('search').oninput = (e) => {
  filters.text = e.target.value
  renderAll()
}
$('clearFilters').onclick = () => {
  Object.assign(filters, {
    result: '',
    order: '',
    kind: '',
    event: '',
    starred: false,
    misplays: false,
    me: [],
    opp: [],
    userTags: [],
    text: '',
  })
  $('search').value = ''
  renderAll()
}

function renderFilters() {
  for (const seg of document.querySelectorAll('.seg[data-key]'))
    for (const b of seg.querySelectorAll('button')) b.classList.toggle('on', filters[seg.dataset.key] === b.dataset.v)
  $('starFilter').classList.toggle('on', filters.starred)
  $('misplayFilter').classList.toggle('on', filters.misplays)
  renderStrip('me')
  renderStrip('opp')
  renderEventFilter()

  const counts = new Map()
  for (const r of recs) for (const t of r.userTags ?? []) counts.set(t, (counts.get(t) ?? 0) + 1)
  $('tagSection').hidden = counts.size === 0
  $('tagCloud').replaceChildren(
    ...[...counts]
      .sort((a, b) => b[1] - a[1])
      .map(([t, n]) => {
        const c = el('button', `tag${filters.userTags.includes(t) ? ' on' : ''}`)
        c.append(el('span', null, t), el('span', 'n', n))
        c.onclick = () => {
          filters.userTags = toggleIn(filters.userTags, t)
          renderAll()
        }
        return c
      }),
  )
  $('tagSuggest').replaceChildren(...[...counts.keys()].map((t) => new Option(t)))
  $('clearFilters').hidden = !anyFilter()
}

/** The specific-event picker, shown with the Events filter. */
function renderEventFilter() {
  const byId = new Map()
  const names = new Map()
  for (const r of recs) {
    const id = r.event?.client_id
    if (!id) continue
    byId.set(id, (byId.get(id) ?? 0) + 1)
    if (!names.has(id)) names.set(id, r.event.name)
  }
  for (const e of status?.events ?? []) names.set(e.client_id, e.name)
  const sel = $('eventFilter')
  sel.hidden = filters.kind !== 'event' || byId.size === 0
  const total = [...byId.values()].reduce((a, b) => a + b, 0)
  const want = [['', `All events (${total})`], ...[...byId].map(([id, n]) => [id, `${names.get(id) ?? id} (${n})`])]
  const have = [...sel.options].map((o) => [o.value, o.text])
  if (JSON.stringify(have) !== JSON.stringify(want)) sel.replaceChildren(...want.map(([v, t]) => new Option(t, v)))
  sel.value = filters.event
}

/** Leaders seen in the library on one side, most played first, plus any selected ones. */
function renderStrip(side) {
  const counts = new Map()
  for (const r of recs) {
    const id = r[side]?.leaderId
    if (id) counts.set(id, (counts.get(id) ?? 0) + 1)
  }
  for (const id of filters[side]) if (!counts.has(id)) counts.set(id, 0)
  const sel = (id) => (filters[side].includes(id) ? 1 : 0)
  const items = [...counts].sort((a, b) => sel(b[0]) - sel(a[0]) || b[1] - a[1])
  const strip = $(`${side}Strip`)
  if (!items.length) return strip.replaceChildren(el('span', 'hint', 'Leaders show up here once you record games.'))
  strip.replaceChildren(
    ...items.map(([id, n]) => {
      const b = el('button', `lchip${sel(id) ? ' on' : ''}`)
      b.title = `${LEADER.get(id)?.name ?? id} (${id})`
      b.append(avatar(id, 'sm'))
      if (n) b.append(el('span', 'badge', n))
      b.onclick = () => {
        filters[side] = toggleIn(filters[side], id)
        renderAll()
      }
      return b
    }),
  )
}

// ─── Leader picker ────────────────────────────────────────────────────────

let picking = 'me'
let pickSel = []
let pickColor = ''

for (const b of document.querySelectorAll('[data-pick]')) b.onclick = () => openPicker(b.dataset.pick)
$('colorFilter').replaceChildren(
  ...['', ...Object.keys(COLOR_HEX)].map((c) => {
    const b = el('button', 'cbtn', c ? '' : 'All')
    b.dataset.c = c
    if (c) {
      b.style.setProperty('--c', COLOR_HEX[c])
      b.title = c
    }
    b.onclick = () => {
      pickColor = c
      renderPicker()
    }
    return b
  }),
)
$('pickerSearch').oninput = () => renderPicker()
$('pickerPlayed').onchange = () => renderPicker()
$('pickerClose').onclick = () => ($('picker').hidden = true)
$('picker').onclick = (e) => {
  if (e.target === $('picker')) $('picker').hidden = true
}
$('pickerClear').onclick = () => {
  pickSel = []
  renderPicker()
}
$('pickerDone').onclick = () => {
  filters[picking] = pickSel
  $('picker').hidden = true
  renderAll()
}

function openPicker(side) {
  picking = side
  pickSel = [...filters[side]]
  $('pickerTitle').textContent = side === 'me' ? 'Filter by my leader' : 'Filter by opponent leader'
  $('pickerSearch').value = ''
  $('pickerSearch').placeholder = `Search ${LEADERS.length} leaders by name, set or id…`
  $('picker').hidden = false
  renderPicker()
  $('pickerSearch').focus()
}

function renderPicker() {
  const played = new Map()
  for (const r of recs) {
    const id = r[picking]?.leaderId
    if (id) played.set(id, (played.get(id) ?? 0) + 1)
  }
  const q = $('pickerSearch').value.trim().toLowerCase()
  const onlyPlayed = $('pickerPlayed').checked
  const list = LEADERS.filter(
    (l) =>
      (!pickColor || l.colors.includes(pickColor)) &&
      (!onlyPlayed || played.has(l.id)) &&
      (!q || `${l.name} ${l.id} ${l.colors.join(' ')}`.toLowerCase().includes(q)),
  ).sort((a, b) => b.id.localeCompare(a.id, 'en', { numeric: true })) // newest sets first
  for (const b of $('colorFilter').children) b.classList.toggle('on', b.dataset.c === pickColor)
  $('pickerGrid').replaceChildren(
    ...(list.length
      ? list.map((l) => {
          const t = el('button', `tile${pickSel.includes(l.id) ? ' on' : ''}`)
          const img = el('img')
          img.loading = 'lazy'
          img.alt = l.name
          img.src = `card://img/${l.id}`
          img.onerror = () => img.replaceWith(el('div', 'noimg big', l.id))
          const meta = el('div', 'tmeta')
          meta.append(el('div', 'tname', l.name), el('div', 'tid', l.id), colorDots(l.id))
          t.append(img, meta)
          if (played.get(l.id)) t.append(el('span', 'badge', played.get(l.id)))
          t.onclick = () => {
            pickSel = toggleIn(pickSel, l.id)
            t.classList.toggle('on', pickSel.includes(l.id))
            renderPickSel()
          }
          return t
        })
      : [el('div', 'hint', 'No leaders match.')]),
  )
  renderPickSel()
}
const renderPickSel = () =>
  ($('pickerSel').textContent = pickSel.length
    ? `${pickSel.length} selected: ${pickSel.map((id) => LEADER.get(id)?.name ?? id).join(', ')}`
    : 'Nothing selected: all leaders are shown')

// ─── Library list ─────────────────────────────────────────────────────────

function dayLabel(d) {
  const day = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime()
  const diff = Math.round((day(new Date()) - day(d)) / 864e5)
  if (diff === 0) return 'Today'
  if (diff === 1) return 'Yesterday'
  return d.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    year: diff > 300 ? 'numeric' : undefined,
  })
}

function renderStats(shown) {
  const s = recordStats(shown)
  const pct = (w, l) => (w + l ? `${Math.round((100 * w) / (w + l))}%` : '–')
  const stat = (label, value, sub) => {
    const d = el('div', 'stat')
    d.append(el('div', 'sv', value), el('div', 'sl', label))
    if (sub) d.append(el('div', 'ss', sub))
    return d
  }
  $('stats').replaceChildren(
    stat('Games', String(s.games), s.wins + s.losses ? `${s.wins}W ${s.losses}L` : ''),
    stat('Win rate', pct(s.wins, s.losses)),
    stat('Going 1st', pct(s.first.wins, s.first.losses), `${s.first.wins}–${s.first.losses}`),
    stat('Going 2nd', pct(s.second.wins, s.second.losses), `${s.second.wins}–${s.second.losses}`),
  )
  renderMatchups(shown)
}

// Win rate per opposing leader, split by turn order. Clicking a row filters to it.
function renderMatchups(shown) {
  const rows = matchupStats(shown)
  const box = $('matchups')
  box.hidden = rows.length < 1
  $('matchupCount').textContent = rows.length ? `${rows.length} leader${rows.length === 1 ? '' : 's'}` : ''
  const rate = (w, l) => {
    const span = el('span')
    if (!(w + l)) return span.append(el('span', 'na', '–')), span
    const p = Math.round((100 * w) / (w + l))
    span.append(el('span', p >= 55 ? 'good' : p <= 45 ? 'bad' : '', `${p}%`), el('small', null, `${w}–${l}`))
    return span
  }
  $('matchupRows').replaceChildren(
    ...rows.map((m) => {
      const b = el('button', 'mRow' + (filters.opp.length === 1 && filters.opp[0] === m.leaderId ? ' on' : ''))
      const name = el('span', 'mName')
      name.append(avatar(m.leaderId, 'xs'), el('b', null, LEADER.get(m.leaderId)?.name ?? m.leaderId))
      b.append(name, el('span', null, String(m.games)), rate(m.wins, m.losses), rate(m.first.wins, m.first.losses), rate(m.second.wins, m.second.losses))
      b.title = 'Show only games against this leader'
      b.onclick = () => {
        filters.opp = filters.opp.length === 1 && filters.opp[0] === m.leaderId ? [] : [m.leaderId]
        renderAll()
      }
      return b
    }),
  )
}
try {
  $('matchups').open = localStorage.getItem('matchupsOpen') === '1'
} catch {}
$('matchups').ontoggle = () => {
  try {
    localStorage.setItem('matchupsOpen', $('matchups').open ? '1' : '0')
  } catch {}
}

function renderList() {
  const shown = recs.filter((r) => matchesFilters(r, filters))
  renderStats(shown)
  $('count').textContent = anyFilter() ? `${shown.length} of ${recs.length} games` : `${recs.length} games`
  const out = []
  let last = ''
  for (const r of shown) {
    const label = dayLabel(new Date(r.startedAt))
    if (label !== last) out.push(el('div', 'day', (last = label)))
    out.push(row(r))
  }
  if (!out.length)
    out.push(
      el('div', 'emptyList', recs.length ? 'No games match these filters.' : 'No recordings yet. Play a game in OPTCG Sim!'),
    )
  $('list').replaceChildren(...out)
}

function row(r) {
  const b = el('button', `game${r.id === selId ? ' sel' : ''}`)
  const pair = el('div', 'pair')
  pair.append(avatar(r.me?.leaderId, 'md'), avatar(r.opp?.leaderId, 'md'))
  const body = el('div', 'gbody')
  const top = el('div', 'gtitle')
  top.append(el('span', 'me', leaderName(r.me)), el('span', 'vs', 'vs'), el('span', null, leaderName(r.opp)))
  const when = new Date(r.startedAt).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
  const bits = [
    when,
    r.firstSeat ? (r.firstSeat === 1 ? '1st' : '2nd') : null,
    r.turns ? `${r.turns} turns` : null,
    r.durationMs ? fmtDur(r.durationMs) : null,
  ]
  if (r.opp?.name) bits.push(shortName(r.opp.name))
  body.append(top, el('div', 'gsub', bits.filter(Boolean).join(' · ')))
  if (r.match?.source || r.event?.name) {
    const line = el('div', 'gtags')
    if (r.match?.source) line.append(el('span', `srcBadge ${r.match.source}`, SOURCE_LABEL[r.match.source] ?? r.match.source))
    if (r.event?.name) {
      const ev = el('span', 'evBadge', `◆ ${r.event.name}${r.set ? ` · G${r.set.game}` : ''}`)
      ev.title = [r.event.name, setLabel(r)].filter(Boolean).join(' · ')
      line.append(ev)
    }
    body.append(line)
  }
  const res = el('div', 'gres')
  if (r.status === 'recording') res.append(el('span', `res live${r.tracked ? ' trk' : ''}`, r.tracked ? 'TRK' : 'REC'))
  else if (r.winnerSeat) res.append(el('span', `res ${r.winnerSeat === 1 ? 'w' : 'l'}`, r.winnerSeat === 1 ? 'W' : 'L'))
  if (r.misplays?.length) {
    const mp = el('span', 'res mp', `⚑ ${r.misplays.length}`)
    mp.title = `${r.misplays.length} misplay${r.misplays.length === 1 ? '' : 's'} marked`
    res.append(mp)
  }
  if (r.tracked && r.status !== 'recording') {
    const lg = el('span', 'res lg', 'log')
    lg.title = 'Tracked only: result and log, no video'
    res.append(lg)
  }
  if (r.starred) res.append(el('span', 'star', '★'))
  b.append(pair, body, res)
  b.onclick = () => select(r.id)
  return b
}

function renderAll() {
  renderFilters()
  renderList()
}

async function refresh() {
  recs = await api.list()
  renderAll()
  if (selId) {
    const r = recs.find((x) => x.id === selId)
    if (!r) select(null)
    else renderDetail(r, false)
  }
}

// ─── Viewer ───────────────────────────────────────────────────────────────

const video = $('video')

function select(id) {
  selId = id
  const r = recs.find((x) => x.id === id)
  $('empty').hidden = !!r
  $('detail').hidden = !r
  if (r) renderDetail(r, true)
  else video.removeAttribute('src')
  renderList()
}

function bannerSide(s, label, won) {
  const d = el('div', `bside${won ? ' won' : ''}`)
  d.append(avatar(s?.leaderId, 'xl', false))
  const t = el('div', 'btext')
  t.append(
    el('div', 'blabel', label),
    el('div', 'bname', leaderName(s)),
    el('div', 'bplayer', s?.name ? shortName(s.name) : ''),
    colorDots(s?.leaderId),
  )
  d.append(t)
  return d
}

function renderDetail(r, fresh) {
  const mid = el('div', 'bmid')
  if (r.status === 'recording') mid.append(el('span', `res live big${r.tracked ? ' trk' : ''}`, r.tracked ? 'TRACKING' : 'LIVE'))
  else if (r.winnerSeat)
    mid.append(el('span', `res big ${r.winnerSeat === 1 ? 'w' : 'l'}`, r.winnerSeat === 1 ? 'Victory' : 'Defeat'))
  else mid.append(el('span', 'res big', 'Unfinished'))
  if (r.firstSeat) mid.append(el('div', 'border', `Went ${r.firstSeat === 1 ? '1st' : '2nd'}`))
  $('banner').replaceChildren(
    bannerSide(r.me, 'You', r.winnerSeat === 1),
    mid,
    bannerSide(r.opp, 'Opponent', r.winnerSeat === 2),
  )

  $('star').textContent = r.starred ? '★' : '☆'
  $('star').classList.toggle('on', !!r.starred)
  const facts = [new Date(r.startedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })]
  if (r.turns) facts.push(`${r.turns} turns`)
  if (r.durationMs) facts.push(fmtDur(r.durationMs))
  if (r.size) facts.push(fmtSize(r.size))
  if (r.endReason) facts.push(r.endReason.replace(/_/g, ' '))
  if (r.match?.source) facts.push(r.match.source === 'queue' ? 'Queue match' : 'Private room')
  if (r.set) facts.push(setLabel(r))
  $('facts').replaceChildren(...facts.map((f) => el('span', null, f)))

  // Leader/opponent tags are already shown by the banner.
  // So are the match source and the event (badge and event row).
  const auto = (r.tags ?? []).filter((t) => !/^(leader|opp|vs|event):/.test(t) && t !== 'queue' && t !== 'private')
  $('tags').replaceChildren(
    ...auto.map((t) => el('span', `chip auto ${t === 'win' ? 'w' : t === 'loss' ? 'l' : ''}`, t)),
    ...(r.userTags ?? []).map((t) => {
      const c = el('span', 'chip user', t)
      const x = el('button', 'x', '×')
      x.title = 'Remove tag'
      x.onclick = () => api.update(r.id, { userTags: r.userTags.filter((u) => u !== t) })
      c.append(x)
      return c
    }),
  )
  renderEventRow(r, fresh)
  if (fresh || document.activeElement !== $('notes')) $('notes').value = r.notes ?? ''
  if (fresh) $('userTagInput').value = ''
  $('del').disabled = r.status === 'recording'

  const tracked = isTracked(r)
  const live = r.status === 'recording' || !r.videoUrl
  $('player').hidden = tracked
  $('trackedView').hidden = !tracked
  for (const id of ['speed', 'keysWrap']) $(id).hidden = tracked || live
  $('live').hidden = !live || tracked
  $('live').classList.toggle('trk', !!r.tracked)
  $('liveTitle').textContent = r.tracked ? 'Tracking this game' : 'Recording in progress'
  $('liveText').textContent = r.tracked
    ? 'Result, turns and events are saved when it ends. No video.'
    : 'The video becomes playable as soon as the game ends.'
  video.hidden = live || tracked
  renderTurns(r, live || tracked)
  renderEvents(r, live || tracked)
  if (tracked) renderTracked(r)
  renderMisplays(fresh)
  if (tracked) {
    if (fresh) video.removeAttribute('src')
  } else if (fresh) {
    if (live) video.removeAttribute('src')
    else video.src = r.videoUrl
    video.playbackRate = 1
    markRate(1)
  } else if (!live && !video.getAttribute('src')) {
    video.src = r.videoUrl // finished saving while selected
  }
}

// ─── Event tag on a game ──────────────────────────────────────────────────

const setSize = (r) => (r.set?.id ? recs.filter((x) => x.set?.id === r.set.id).length : 1)

function renderEventRow(r, fresh) {
  const row = $('eventRow')
  if (fresh) $('eventTagBox').hidden = true
  const n = setSize(r)
  const scope = n > 1 ? ` (all ${n} games of this set)` : ''
  if (r.status === 'recording') {
    row.replaceChildren()
    $('eventTagBox').hidden = true
  } else if (r.event?.name) {
    const chip = el('span', 'chip evChip', `◆ ${r.event.name}`)
    const x = el('button', 'x', '×')
    x.title = `Move back to the sim session${scope}`
    x.onclick = () => void tagEvent(r, null)
    chip.append(x)
    const items = [chip]
    if (n > 1) items.push(el('span', 'hint', `Set of ${n} games`))
    row.replaceChildren(...items)
  } else {
    const b = el('button', 'mini evTagBtn', '◆ Tag event')
    b.title = `File this game under an event${scope}`
    b.onclick = () => {
      $('eventTagBox').hidden = false
      $('eventTagInput').value = status?.event?.name ?? status?.events?.[0]?.name ?? ''
      $('eventTagInput').focus()
      $('eventTagInput').select()
    }
    row.replaceChildren(b, el('span', 'hint', n > 1 ? `Sim session · tags all ${n} games of this set` : 'Sim session'))
  }
}

async function tagEvent(r, name) {
  const ev = name == null ? null : { name, client_id: eventByName(name)?.client_id }
  const res = await api.tagEvent(r.id, ev, { wholeSet: true })
  if (!res?.ok) return alert(res?.error ?? 'Could not tag the game.')
  $('eventTagBox').hidden = true
}
$('eventTagBox').onsubmit = (e) => {
  e.preventDefault()
  const r = recs.find((x) => x.id === selId)
  if (r) void tagEvent(r, $('eventTagInput').value)
}
$('eventTagCancel').onclick = () => ($('eventTagBox').hidden = true)

// MediaRecorder webm has no duration header: seek to the end once so the
// scrubber knows the length, then jump back.
video.addEventListener('loadedmetadata', () => {
  if (video.duration !== Infinity) return
  const back = () => {
    if (!Number.isFinite(video.duration)) return
    video.removeEventListener('durationchange', back)
    video.currentTime = 0
  }
  video.addEventListener('durationchange', back)
  video.currentTime = 1e101
})

// Turn jumps. Stamps come from a 2s log poll, so seek a little early to land
// before the turn starts rather than just after.
const TURN_LEAD_S = 2
let turnTimes = []

function renderTurns(r, live) {
  turnTimes = live ? [] : (r.turnTimes ?? [])
  const box = $('turns')
  box.hidden = !turnTimes.length
  if (!turnTimes.length) return box.replaceChildren()
  const mine = (n) => (r.firstSeat ? (n % 2 === 1) === (r.firstSeat === 1) : null)
  box.replaceChildren(
    el('span', 'turnsLabel', 'Turn'),
    ...turnTimes.map((t, i) => {
      const n = i + 1
      const who = mine(n)
      const b = el('button', who === null ? '' : who ? 'me' : 'opp', String(n))
      b.title = `Turn ${n}${who === null ? '' : who ? ' (you)' : ' (opponent)'} at ${fmtClock(t)}`
      b.onclick = () => {
        video.currentTime = Math.max(0, t - TURN_LEAD_S)
        void video.play()
      }
      return b
    }),
  )
  markTurn()
}

function fmtClock(s) {
  const m = Math.floor(s / 60)
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`
}

/** Highlight the turn being watched. */
function markTurn() {
  const t = video.currentTime + TURN_LEAD_S
  let cur = -1
  turnTimes.forEach((x, i) => x <= t && (cur = i))
  $('turns').querySelectorAll('button').forEach((b, i) => b.classList.toggle('on', i === cur))
}
video.addEventListener('timeupdate', markTurn)

// Event markers. Stamped by the same 2s poll as turns; land a bit earlier still so the
// play that caused the event is on screen.
const EVENT_LEAD_S = 3
const MERGE_FRAC = 0.01 // ticks closer than 1% of the bar become one, with a count
let events = []
let eventsRec = null

function renderEvents(r, live) {
  eventsRec = live ? null : r
  events = live ? [] : (r.events ?? [])
  drawEvents()
}

function eventText(e) {
  if (e.type === 'hit') return e.seat === 1 ? 'You lost a life' : e.seat === 2 ? 'Opponent lost a life' : 'Life lost'
  if (e.type === 'ko') {
    const side = e.seat === 1 ? ' (yours)' : e.seat === 2 ? " (opponent's)" : ''
    return `K.O.: ${e.card || 'a character'}${side}`
  }
  if (e.type === 'trigger') {
    const who = e.seat === 1 ? ' (you)' : e.seat === 2 ? ' (opponent)' : ''
    return `Trigger: ${e.card || '?'}${who}`
  }
  const how = { concede: 'you conceded', opponent_concede: 'opponent conceded', quit: 'you quit', opponent_quit: 'opponent quit' }[e.reason] ?? ''
  return `${e.seat === 1 ? 'You won' : e.seat === 2 ? 'You lost' : 'Game over'}${how ? ` · ${how}` : ''}`
}

const EVENT_RANK = { end: 4, hit: 3, trigger: 2, ko: 1 }

function drawEvents() {
  const box = $('events')
  const bar = $('eventBar')
  const dur = video.duration
  const marks = eventsRec?.misplays ?? []
  box.hidden = !eventsRec || (!events.length && !marks.length) || !Number.isFinite(dur) || dur <= 0
  if (box.hidden) return bar.replaceChildren()
  const r = eventsRec
  const pct = (t) => `${Math.min(100, Math.max(0, (t / dur) * 100))}%`
  const mine = (n) => (r.firstSeat ? (n % 2 === 1) === (r.firstSeat === 1) : null)

  // Faint bands behind your turns.
  const tt = r.turnTimes ?? []
  const bands = []
  tt.forEach((t, i) => {
    if (!mine(i + 1)) return
    const b = el('div', 'band')
    b.style.left = pct(t)
    b.style.width = `calc(${pct(tt[i + 1] ?? dur)} - ${pct(t)})`
    bands.push(b)
  })

  const groups = []
  for (const e of events) {
    const g = groups.at(-1)
    if (g && (e.t - g.t) / dur < MERGE_FRAC) g.items.push(e)
    else groups.push({ t: e.t, items: [e] })
  }
  const ticks = groups.map((g) => {
    const top = g.items.reduce((a, b) => (EVENT_RANK[b.type] > EVENT_RANK[a.type] ? b : a))
    const seatCls = top.type === 'hit' ? (top.seat === 1 ? ' me' : top.seat === 2 ? ' opp' : '') : ''
    const b = el('button', `tick ${top.type}${seatCls}`)
    b.style.left = pct(g.t)
    if (g.items.length > 1) b.append(el('span', 'count', String(g.items.length)))
    const who = top.turn ? mine(top.turn) : null
    const turn = top.turn ? `T${top.turn}${who === null ? '' : who ? ' (yours)' : ' (opponent)'} · ` : ''
    b.title = `${fmtClock(g.t)}  ${turn}${g.items.map(eventText).join('\n')}`
    b.onclick = () => {
      video.currentTime = Math.max(0, g.t - EVENT_LEAD_S)
      void video.play()
    }
    return b
  })
  const flags = marks.map((m) => {
    const b = el('button', 'flag')
    b.style.left = pct(m.t)
    b.title = `${fmtClock(m.t)}  Misplay${m.turn ? ` · ${turnLabel(r, m.turn)}` : ''}${m.note ? `\n${m.note}` : ''}`
    b.onclick = () => seekTo(m.t)
    return b
  })
  bar.replaceChildren(...bands, ...ticks, ...flags)
}
video.addEventListener('durationchange', drawEvents)

// N / P walk events and misplays together. Misplay times are already where to land.
function stepEvent(dir) {
  const ts = [...events.map((e) => Math.max(0, e.t - EVENT_LEAD_S)), ...(eventsRec?.misplays ?? []).map((m) => m.t)]
  if (!ts.length) return
  ts.sort((a, b) => a - b)
  const now = video.currentTime
  const t = dir > 0 ? ts.find((x) => x > now + 0.5) : ts.findLast((x) => x < now - 1.5)
  if (t != null) video.currentTime = t
}

function seekTo(t) {
  video.currentTime = Math.max(0, t)
  void video.play()
}

// ─── Tracked games (no video) ─────────────────────────────────────────────
// A tracked game keeps the log's result, turn stamps and events. Times are a game
// clock (seconds since the game started), so misplays are marked per turn.
const isTracked = (r) => !!r?.tracked && r.status !== 'recording'

function renderTracked(r) {
  const tile = (label, value, cls = '') => {
    const d = el('div', `tvTile ${cls}`)
    d.append(el('span', 'tvLabel', label), el('b', null, value))
    return d
  }
  const tt = r.turnTimes ?? []
  const len = r.durationMs ? fmtDur(r.durationMs) : tt.length ? `${fmtClock(tt.at(-1))}+` : '—'
  const res = r.winnerSeat === 1 ? ['Win', 'w'] : r.winnerSeat === 2 ? ['Loss', 'l'] : ['Unfinished', '']
  $('tvStats').replaceChildren(
    tile('Result', res[0], res[1]),
    tile('Ended by', r.endReason ? r.endReason.replace(/_/g, ' ') : r.winnerSeat ? 'life out' : '—'),
    tile('Turns', String(trackedTurns(r) || '—')),
    tile('Length', len),
  )
  const evs = r.events ?? []
  const marks = r.misplays ?? []
  const count = trackedTurns(r)
  const groups = []
  for (let n = 1; n <= count; n++) {
    const g = el('div', 'tvTurn')
    g.dataset.turn = String(n)
    const who = r.firstSeat ? (n % 2 === 1) === (r.firstSeat === 1) : null
    const head = el('div', `tvTurnHead${who === null ? '' : who ? ' me' : ' opp'}`)
    const flag = el('button', 'mini tvFlag', '⚑')
    flag.title = `Mark a misplay on turn ${n}`
    flag.onclick = () => openMisplay(null, n)
    head.append(el('span', 'tvT', turnLabel(r, n)), el('span', 'tvClock', tt[n - 1] != null ? fmtClock(tt[n - 1]) : ''), flag)
    g.append(head)
    for (const e of evs.filter((x) => x.turn === n)) g.append(el('div', `tvEv ${e.type}`, eventText(e)))
    for (const m of marks.filter((x) => x.turn === n))
      g.append(el('div', 'tvEv misplay', `⚑ Misplay${m.note ? `: ${m.note}` : ''}`))
    groups.push(g)
  }
  for (const e of evs.filter((x) => !x.turn)) groups.push(el('div', `tvEv ${e.type}`, eventText(e)))
  if (!groups.length) groups.push(el('div', 'muted', 'No turns or events were found in the log.'))
  $('tvTimeline').replaceChildren(...groups)
}

function scrollToTurn(n) {
  const g = $('tvTimeline').querySelector(`[data-turn="${n}"]`)
  if (!g) return
  g.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  g.classList.remove('flash')
  void g.offsetWidth
  g.classList.add('flash')
}

/** How many turns a tracked game has to mark on. */
function trackedTurns(r) {
  return Math.max(r.turnTimes?.length ?? 0, r.turns ?? 0, ...(r.events ?? []).map((e) => e.turn ?? 0))
}
/** A tracked mark's t: its turn's start on the game clock. */
const turnStart = (r, n) => r.turnTimes?.[n - 1] ?? 0

$('openLog').onclick = () => selId && api.openLog(selId)

// ─── Misplays ─────────────────────────────────────────────────────────────
// Marked while watching: the mark lands a few seconds before the key press, since you
// notice a misplay after it happens. Stored as meta.misplays [{ t, turn, note }].
const MISPLAY_LEAD_S = 3
let misplayEdit = null // { t, turn, index } while the note box is open; index null = new mark

function turnAt(r, t) {
  let n = null
  ;(r.turnTimes ?? []).forEach((x, i) => x <= t + TURN_LEAD_S && (n = i + 1))
  return n
}
function turnLabel(r, n) {
  const who = r.firstSeat ? (n % 2 === 1) === (r.firstSeat === 1) : null
  return `T${n}${who === null ? '' : who ? ' · yours' : ' · opp'}`
}
const curRec = () => recs.find((x) => x.id === selId)

function renderMisplays(fresh) {
  const r = curRec()
  const tracked = isTracked(r)
  const live = !r || r.status === 'recording' || (!r.videoUrl && !tracked)
  $('markMisplay').disabled = live || (tracked && !trackedTurns(r))
  $('markMisplay').title = tracked ? 'Mark a misplay on a turn (M)' : 'Mark a misplay 3 s before now (M)'
  if (fresh) closeMisplay()
  const list = live ? [] : (r.misplays ?? [])
  $('misplaySection').hidden = !list.length
  $('misplayCount').textContent = list.length ? String(list.length) : ''
  $('misplayList').replaceChildren(
    ...list.map((m, i) => {
      const row = el('div', 'mpRow')
      const seek = el('button', 'seek')
      seek.title = tracked ? 'Show this turn' : 'Jump to this misplay'
      seek.append(
        el('span', 'time', tracked ? (m.turn ? `T${m.turn}` : '—') : fmtClock(m.t)),
        el('span', 'who', m.turn ? turnLabel(r, m.turn) : '—'),
        el('span', `note${m.note ? '' : ' empty'}`, m.note || 'No note'),
      )
      seek.onclick = () => (tracked ? m.turn && scrollToTurn(m.turn) : seekTo(m.t))
      const edit = el('button', 'mini', 'Edit')
      edit.onclick = () => openMisplay(i)
      const del = el('button', 'mini', '✕')
      del.title = 'Remove this misplay'
      del.onclick = () => saveMisplays(r.misplays.filter((_, j) => j !== i))
      row.append(seek, edit, del)
      return row
    }),
  )
}

function openMisplay(index = null, onTurn = null) {
  const r = curRec()
  if (!r) return
  const sel = $('misplayTurn')
  if (isTracked(r)) {
    const n = trackedTurns(r)
    if (!n) return
    const m = index == null ? null : r.misplays?.[index]
    const turn = Math.min(Math.max(m?.turn ?? onTurn ?? n, 1), n)
    sel.replaceChildren(
      ...Array.from({ length: n }, (_, i) => {
        const o = el('option', null, turnLabel(r, i + 1))
        o.value = String(i + 1)
        return o
      }),
    )
    sel.value = String(turn)
    sel.hidden = false
    misplayEdit = { t: turnStart(r, turn), turn, index, tracked: true }
    $('misplayLabel').textContent = `⚑ ${m ? 'Edit misplay' : 'Misplay'} on`
    $('misplayNote').value = m?.note ?? ''
    $('misplayBox').hidden = false
    $('misplayNote').focus()
    return
  }
  if (video.hidden) return
  sel.hidden = true
  video.pause()
  const m = index == null ? null : r.misplays?.[index]
  const t = m ? m.t : Math.max(0, video.currentTime - MISPLAY_LEAD_S)
  const turn = m ? m.turn : turnAt(r, t)
  misplayEdit = { t, turn, index }
  $('misplayLabel').textContent = `⚑ ${m ? 'Edit misplay' : 'Misplay'} at ${fmtClock(t)}${turn ? ` · ${turnLabel(r, turn)}` : ''}`
  $('misplayNote').value = m?.note ?? ''
  $('misplayBox').hidden = false
  $('misplayNote').focus()
}

function closeMisplay() {
  misplayEdit = null
  $('misplayBox').hidden = true
  if (document.activeElement === $('misplayNote')) $('misplayNote').blur()
}

async function saveMisplays(list) {
  if (selId) await api.update(selId, { misplays: list })
}

$('markMisplay').onclick = () => openMisplay()
$('misplayCancel').onclick = closeMisplay
$('misplayNote').onkeydown = (e) => {
  if (e.key !== 'Escape') return
  e.stopPropagation()
  closeMisplay()
}
$('misplayBox').onsubmit = async (e) => {
  e.preventDefault()
  const r = curRec()
  const edit = misplayEdit
  if (!r || !edit) return closeMisplay()
  let { t, turn } = edit
  if (edit.tracked) {
    turn = Number($('misplayTurn').value) || null
    t = turn ? turnStart(r, turn) : 0
  }
  const mark = { t, turn, note: $('misplayNote').value.trim() }
  const list = [...(r.misplays ?? [])]
  if (edit.index == null) list.push(mark)
  else list[edit.index] = mark
  closeMisplay()
  await saveMisplays(list)
}

function markRate(rate) {
  for (const b of document.querySelectorAll('.speed button')) b.classList.toggle('on', Number(b.dataset.rate) === rate)
}
for (const b of document.querySelectorAll('.speed button'))
  b.onclick = () => {
    video.playbackRate = Number(b.dataset.rate)
    markRate(video.playbackRate)
  }

$('star').onclick = async () => {
  const r = recs.find((x) => x.id === selId)
  if (r) await api.update(r.id, { starred: !r.starred })
}
$('userTagInput').onkeydown = async (e) => {
  if (e.key !== 'Enter') return
  const r = recs.find((x) => x.id === selId)
  const t = e.target.value.trim()
  if (!r || !t) return
  e.target.value = ''
  if (!(r.userTags ?? []).some((u) => u.toLowerCase() === t.toLowerCase()))
    await api.update(r.id, { userTags: [...(r.userTags ?? []), t] })
}
$('notes').onchange = () => selId && api.update(selId, { notes: $('notes').value })
$('reveal').onclick = () => api.reveal(selId)
$('del').onclick = async () => {
  const r = recs.find((x) => x.id === selId)
  if (!r || !confirm(`Delete "${r.title}"? Its ${r.tracked ? 'log' : 'video'} file is removed permanently.`)) return
  video.removeAttribute('src')
  video.load()
  await api.remove(r.id)
}

// Keyboard (when not typing): space play/pause, ←/→ seek 5 s, [ / ] previous/next turn,
// N / P next/previous event or misplay, M mark a misplay, , / . slower/faster. Esc closes overlays.
const RATES = [1, 1.5, 2, 3]
function stepTurn(dir) {
  if (!turnTimes.length) return
  const t = video.currentTime + TURN_LEAD_S
  let cur = -1
  turnTimes.forEach((x, i) => x <= t + 0.25 && (cur = i))
  // "[" inside a turn goes back to its start first, like a music player's previous button.
  let next = cur + dir
  if (dir < 0 && cur >= 0 && video.currentTime - Math.max(0, turnTimes[cur] - TURN_LEAD_S) > 3) next = cur
  if (next < 0) return void (video.currentTime = 0)
  if (next >= turnTimes.length) return
  video.currentTime = Math.max(0, turnTimes[next] - TURN_LEAD_S)
}
function stepRate(dir) {
  const i = RATES.findIndex((r) => r >= video.playbackRate - 1e-6)
  const at = i < 0 ? RATES.length - 1 : i
  video.playbackRate = RATES[Math.min(RATES.length - 1, Math.max(0, at + dir))]
  markRate(video.playbackRate)
}
function toggleKeys(open = $('keysPanel').hidden) {
  $('keysPanel').hidden = !open
  $('keysBtn').setAttribute('aria-expanded', String(open))
}
$('keysBtn').onclick = (e) => {
  e.stopPropagation()
  toggleKeys()
}
document.addEventListener('click', (e) => {
  if (!$('keysPanel').hidden && !e.target.closest('.keysWrap')) toggleKeys(false)
})
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    $('picker').hidden = true
    $('settings').hidden = true
    toggleKeys(false)
    return
  }
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || $('detail').hidden) return
  if (video.hidden) {
    if ((e.key === 'm' || e.key === 'M') && isTracked(curRec())) {
      e.preventDefault()
      openMisplay()
    }
    return
  }
  if (e.key === ' ') {
    e.preventDefault()
    if (video.paused) void video.play()
    else video.pause()
  } else if (e.key === 'ArrowRight') video.currentTime += 5
  else if (e.key === 'ArrowLeft') video.currentTime = Math.max(0, video.currentTime - 5)
  else if (e.key === ']') stepTurn(1)
  else if (e.key === '[') stepTurn(-1)
  else if (e.key === 'n' || e.key === 'N') stepEvent(1)
  else if (e.key === 'p' || e.key === 'P') stepEvent(-1)
  else if (e.key === 'm' || e.key === 'M') openMisplay()
  else if (e.key === '.' || e.key === '>') stepRate(1)
  else if (e.key === ',' || e.key === '<') stepRate(-1)
  else return
  e.preventDefault()
})

// ─── Boot ─────────────────────────────────────────────────────────────────

api.onEvent((ev) => {
  if (ev.type === 'status') {
    status = ev.status
    renderStatus()
  } else if (ev.type === 'library') void refresh()
  else if (ev.type === 'leaders') {
    void loadLeaders().then(() => {
      void refresh()
      if (!$('picker').hidden) renderPicker()
    })
  }
})
status = await api.status()
renderStatus()
await loadLeaders()
await loadSources()
await refresh()
