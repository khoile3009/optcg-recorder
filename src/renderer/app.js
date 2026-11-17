import { matchesFilters, recordStats, shortName } from '../logtags.mjs'
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
const filters = { result: '', order: '', starred: false, me: [], opp: [], userTags: [], text: '' }

// ─── Helpers ──────────────────────────────────────────────────────────────

const fmtDur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
const fmtSize = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round((b ?? 0) / 1e6)} MB`)
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

function renderStatus() {
  if (!status) return
  const r = status.recording
  $('state').className = `pill ${r ? 'rec' : status.sourceDir && status.autoRecord ? 'armed' : 'idle'}`
  $('stateText').textContent = r
    ? `${r.stopping ? 'Saving…' : 'Recording'} ${fmtDur(Date.now() - r.startMs)} · ${fmtSize(r.bytes)}`
    : !status.sourceDir
      ? 'Choose the sim folder'
      : status.autoRecord
        ? 'Waiting for a game'
        : 'Auto-record off'
  $('recBtn').textContent = r ? '■ Stop' : '● Record now'
  $('recBtn').classList.toggle('stop', !!r)
  $('recBtn').disabled = !!r?.stopping
  $('autoRec').checked = status.autoRecord
  $('sysAudio').checked = !!status.systemAudio
  $('micOn').checked = !!status.mic
  $('micOpts').hidden = !status.mic
  if (document.activeElement !== $('micGain')) $('micGain').value = status.micGain ?? 1
  $('micGainLabel').textContent = `${Math.round(($('micGain').value || 1) * 100)}%`
  $('folderHint').textContent = status.sourceDir ? `Watching ${status.sourceDir}` : 'No sim folder chosen yet.'
  $('error').hidden = !status.lastError
  $('error').textContent = status.lastError ?? ''

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

$('recBtn').onclick = () => (status?.recording ? api.stop() : api.start())
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
$('autoRec').onchange = (e) => api.setSettings({ autoRecord: e.target.checked })
$('quality').onchange = (e) => api.setSettings({ quality: e.target.value })
$('capture').onfocus = loadSources
$('capture').onchange = (e) => api.setSettings({ capture: e.target.value })
$('folderBtn').onclick = async () => {
  const s = await api.chooseSourceDir()
  if (s.pickError) alert(s.pickError)
  status = s
  renderStatus()
}
$('libBtn').onclick = () => api.reveal(null)
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

// ─── Sidebar: filters ─────────────────────────────────────────────────────

const toggleIn = (arr, v) => (arr.includes(v) ? arr.filter((x) => x !== v) : [...arr, v])
const anyFilter = () =>
  !!(
    filters.result ||
    filters.order ||
    filters.starred ||
    filters.me.length ||
    filters.opp.length ||
    filters.userTags.length ||
    filters.text
  )

for (const seg of document.querySelectorAll('.seg'))
  for (const b of seg.querySelectorAll('button'))
    b.onclick = () => {
      filters[seg.dataset.key] = b.dataset.v
      renderAll()
    }
$('starFilter').onclick = () => {
  filters.starred = !filters.starred
  renderAll()
}
$('search').oninput = (e) => {
  filters.text = e.target.value
  renderAll()
}
$('clearFilters').onclick = () => {
  Object.assign(filters, { result: '', order: '', starred: false, me: [], opp: [], userTags: [], text: '' })
  $('search').value = ''
  renderAll()
}

function renderFilters() {
  for (const seg of document.querySelectorAll('.seg'))
    for (const b of seg.querySelectorAll('button')) b.classList.toggle('on', filters[seg.dataset.key] === b.dataset.v)
  $('starFilter').classList.toggle('on', filters.starred)
  renderStrip('me')
  renderStrip('opp')

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
  const res = el('div', 'gres')
  if (r.status === 'recording') res.append(el('span', 'res live', 'REC'))
  else if (r.winnerSeat) res.append(el('span', `res ${r.winnerSeat === 1 ? 'w' : 'l'}`, r.winnerSeat === 1 ? 'W' : 'L'))
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
  if (r.status === 'recording') mid.append(el('span', 'res live big', 'LIVE'))
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
  $('facts').replaceChildren(...facts.map((f) => el('span', null, f)))

  // Leader/opponent tags are already shown by the banner.
  const auto = (r.tags ?? []).filter((t) => !/^(leader|opp|vs):/.test(t))
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
  if (fresh || document.activeElement !== $('notes')) $('notes').value = r.notes ?? ''
  if (fresh) $('userTagInput').value = ''
  $('del').disabled = r.status === 'recording'

  const live = r.status === 'recording' || !r.videoUrl
  $('live').hidden = !live
  video.hidden = live
  renderTurns(r, live)
  if (fresh) {
    if (live) video.removeAttribute('src')
    else video.src = r.videoUrl
    video.playbackRate = 1
    markRate(1)
  } else if (!live && !video.getAttribute('src')) {
    video.src = r.videoUrl // finished saving while selected
  }
}

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
  if (!r || !confirm(`Delete "${r.title}"? The video file is removed permanently.`)) return
  video.removeAttribute('src')
  video.load()
  await api.remove(r.id)
}

// Keyboard: space play/pause, ←/→ seek 5 s (when not typing); Esc closes overlays.
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    $('picker').hidden = true
    $('settings').hidden = true
    return
  }
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || $('detail').hidden || video.hidden)
    return
  if (e.key === ' ') {
    e.preventDefault()
    if (video.paused) void video.play()
    else video.pause()
  } else if (e.key === 'ArrowRight') video.currentTime += 5
  else if (e.key === 'ArrowLeft') video.currentTime = Math.max(0, video.currentTime - 5)
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
