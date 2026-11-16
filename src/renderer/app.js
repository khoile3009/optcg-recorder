import { matchesQuery } from '../logtags.mjs'

const api = window.recorder
const $ = (id) => document.getElementById(id)

let recs = []
let status = null
let selId = null

// ─── Status bar ───────────────────────────────────────────────────────────

const fmtDur = (ms) => {
  const s = Math.max(0, Math.round(ms / 1000))
  const h = Math.floor(s / 3600)
  const m = Math.floor((s % 3600) / 60)
  const ss = String(s % 60).padStart(2, '0')
  return h ? `${h}:${String(m).padStart(2, '0')}:${ss}` : `${m}:${ss}`
}
const fmtSize = (b) => (b > 1e9 ? `${(b / 1e9).toFixed(1)} GB` : `${Math.round((b ?? 0) / 1e6)} MB`)

function renderStatus() {
  if (!status) return
  const r = status.recording
  $('state').className = `state ${r ? 'rec' : 'idle'}`
  $('stateText').textContent = r
    ? `${r.stopping ? 'Saving…' : 'Recording'} ${fmtDur(Date.now() - r.startMs)} · ${fmtSize(r.bytes)}`
    : status.sourceDir
      ? status.autoRecord
        ? 'Waiting for a game'
        : 'Idle (auto-record off)'
      : 'Sim folder not found'
  $('recBtn').textContent = r ? 'Stop recording' : 'Record now'
  $('recBtn').classList.toggle('on', !!r)
  $('recBtn').disabled = !!r?.stopping
  $('autoRec').checked = status.autoRecord
  $('folderBtn').title = status.sourceDir ?? 'Not found: choose the OPTCG Sim folder'
  $('folderHint').textContent = status.sourceDir
    ? `Watching ${status.sourceDir}`
    : 'Could not find OPTCG Sim. Use "Sim folder…" to point at its install folder.'
  $('error').hidden = !status.lastError
  $('error').textContent = status.lastError ?? ''
  if ($('capture').value !== status.capture && [...$('capture').options].some((o) => o.value === status.capture))
    $('capture').value = status.capture
}
setInterval(renderStatus, 1000)

async function loadSources() {
  const sources = await api.listSources()
  const sel = $('capture')
  sel.replaceChildren(new Option('Auto: OPTCG Sim window, else screen', 'auto'))
  for (const s of sources) sel.add(new Option(`${s.id.startsWith('screen:') ? 'Screen' : 'Window'}: ${s.name}`, s.name))
  if (status?.capture && status.capture !== 'auto' && ![...sel.options].some((o) => o.value === status.capture))
    sel.add(new Option(`(not open) ${status.capture}`, status.capture))
  sel.value = status?.capture ?? 'auto'
}

$('recBtn').onclick = () => (status?.recording ? api.stop() : api.start())
$('autoRec').onchange = (e) => api.setSettings({ autoRecord: e.target.checked })
$('capture').onfocus = loadSources
$('capture').onchange = (e) => api.setSettings({ capture: e.target.value })
$('folderBtn').onclick = async () => {
  status = await api.chooseSourceDir()
  renderStatus()
}
$('libBtn').onclick = () => api.reveal(null)

// ─── Library list ─────────────────────────────────────────────────────────

const RESULT = (r) => (r.status === 'recording' ? 'live' : r.winnerSeat === 1 ? 'W' : r.winnerSeat === 2 ? 'L' : '')

function renderChips() {
  // The most common tags across the library, as one-click filters.
  const counts = new Map()
  for (const r of recs) for (const t of [...(r.tags ?? []), ...(r.userTags ?? [])]) counts.set(t, (counts.get(t) ?? 0) + 1)
  const top = [...counts].sort((a, b) => b[1] - a[1]).slice(0, 18)
  const q = $('search').value.toLowerCase().split(/\s+/)
  $('chips').replaceChildren(
    ...top.map(([t, n]) => {
      const tok = t.replace(/ /g, '_').toLowerCase()
      const c = document.createElement('span')
      c.className = `chip${q.includes(tok) ? ' on' : ''}`
      c.textContent = `${t} · ${n}`
      c.onclick = () => toggleToken(tok)
      return c
    }),
  )
}

function toggleToken(tok) {
  const toks = $('search').value.split(/\s+/).filter(Boolean)
  const i = toks.findIndex((t) => t.toLowerCase() === tok)
  if (i >= 0) toks.splice(i, 1)
  else toks.push(tok)
  $('search').value = toks.join(' ')
  renderList()
}

function renderList() {
  const q = $('search').value
  const shown = recs.filter((r) => matchesQuery(r, q))
  $('count').textContent = `${shown.length} of ${recs.length} games`
  $('list').replaceChildren(
    ...shown.map((r) => {
      const li = document.createElement('li')
      if (r.id === selId) li.className = 'sel'
      const t = document.createElement('div')
      t.className = 't'
      t.textContent = `${r.starred ? '★ ' : ''}${r.me?.leaderName ?? r.title ?? r.id} vs ${r.opp?.leaderName ?? '?'}`
      const res = RESULT(r)
      if (res) {
        const b = document.createElement('span')
        b.className = `res ${res}`
        b.textContent = res === 'live' ? 'REC' : res
        t.append(b)
      }
      const s = document.createElement('div')
      s.className = 's'
      const when = new Date(r.startedAt).toLocaleString()
      const bits = [when, r.firstSeat ? (r.firstSeat === 1 ? '1st' : '2nd') : null, r.durationMs ? fmtDur(r.durationMs) : null]
      if (r.opp?.name) bits.push(`vs ${r.opp.name.replace(/#\d+$/, '')}`)
      s.textContent = bits.filter(Boolean).join(' · ')
      li.append(t, s)
      li.onclick = () => select(r.id)
      return li
    }),
  )
  renderChips()
}
$('search').oninput = renderList

async function refresh() {
  recs = await api.list()
  renderList()
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

function renderDetail(r, fresh) {
  $('title').textContent = r.title ?? r.id
  $('star').textContent = r.starred ? '★' : '☆'
  $('star').classList.toggle('on', !!r.starred)
  const facts = [new Date(r.startedAt).toLocaleString()]
  if (r.me?.name) facts.push(`${r.me.name} (${r.me.leaderName} ${r.me.leaderId}) vs ${r.opp?.name} (${r.opp?.leaderName} ${r.opp?.leaderId})`)
  if (r.turns) facts.push(`${r.turns} turns`)
  if (r.durationMs) facts.push(fmtDur(r.durationMs))
  if (r.size) facts.push(fmtSize(r.size))
  if (r.endReason) facts.push(`ended: ${r.endReason.replace(/_/g, ' ')}`)
  $('facts').textContent = facts.join(' · ')
  $('tags').replaceChildren(
    ...(r.tags ?? []).map((t) => chip(t, t === 'win' ? 'win' : t === 'loss' ? 'loss' : '')),
    ...(r.userTags ?? []).map((t) => chip(t, 'user')),
  )
  if (fresh || document.activeElement !== $('userTags')) $('userTags').value = (r.userTags ?? []).join(', ')
  if (fresh || document.activeElement !== $('notes')) $('notes').value = r.notes ?? ''
  $('del').disabled = r.status === 'recording'
  if (fresh) {
    if (r.status === 'recording' || !r.videoUrl) video.removeAttribute('src')
    else video.src = r.videoUrl
    video.playbackRate = 1
    markRate(1)
  } else if (r.status !== 'recording' && r.videoUrl && !video.getAttribute('src')) {
    video.src = r.videoUrl // just finished saving while selected
  }
}

function chip(t, cls) {
  const c = document.createElement('span')
  c.className = `chip ${cls}`
  c.textContent = t
  c.title = 'Filter by this tag'
  c.onclick = () => toggleToken(t.replace(/ /g, '_').toLowerCase())
  return c
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
const saveText = async () => {
  if (!selId) return
  const userTags = $('userTags')
    .value.split(',')
    .map((s) => s.trim())
    .filter(Boolean)
  await api.update(selId, { userTags, notes: $('notes').value })
}
$('userTags').onchange = saveText
$('notes').onchange = saveText
$('reveal').onclick = () => api.reveal(selId)
$('del').onclick = async () => {
  const r = recs.find((x) => x.id === selId)
  if (!r || !confirm(`Delete "${r.title}"? The video file is removed permanently.`)) return
  video.removeAttribute('src')
  video.load()
  await api.remove(r.id)
}

// Keyboard: space play/pause, ←/→ seek 5 s (when not typing).
document.addEventListener('keydown', (e) => {
  if (['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName) || $('detail').hidden) return
  if (e.key === ' ') {
    e.preventDefault()
    video.paused ? video.play() : video.pause()
  } else if (e.key === 'ArrowRight') video.currentTime += 5
  else if (e.key === 'ArrowLeft') video.currentTime = Math.max(0, video.currentTime - 5)
})

// ─── Boot ─────────────────────────────────────────────────────────────────

api.onEvent((ev) => {
  if (ev.type === 'status') {
    status = ev.status
    renderStatus()
  } else if (ev.type === 'library') void refresh()
})
status = await api.status()
renderStatus()
await loadSources()
await refresh()
