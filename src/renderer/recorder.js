// Hidden window: captures the source main picks (setDisplayMediaRequestHandler)
// and streams webm chunks back to main, which writes them to disk.
// Optional audio: system sound (loopback) and a microphone, mixed into one
// Opus track (MediaRecorder only records the first audio track, and a single
// mixed track is what video sites expect).
let mr = null
let curId = null
let cleanup = () => {}

function mimeType(withAudio) {
  const types = withAudio
    ? ['video/webm;codecs=vp9,opus', 'video/webm;codecs=vp8,opus', 'video/webm']
    : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
  for (const t of types) if (MediaRecorder.isTypeSupported(t)) return t
  return ''
}

async function openDisplay(video, systemAudio, id) {
  if (systemAudio) {
    try {
      return await navigator.mediaDevices.getDisplayMedia({ video, audio: true })
    } catch (e) {
      window.capture.warn(id, `Game sound unavailable, recording without it: ${e?.message ?? e}`)
    }
  }
  return navigator.mediaDevices.getDisplayMedia({ video, audio: false })
}

async function openMic(mic, id) {
  try {
    const deviceId = mic.deviceId && mic.deviceId !== 'default' ? { exact: mic.deviceId } : undefined
    return await navigator.mediaDevices.getUserMedia({
      audio: { deviceId, echoCancellation: false, noiseSuppression: true, autoGainControl: false },
      video: false,
    })
  } catch (e) {
    window.capture.warn(id, `Microphone unavailable, recording without it: ${e?.message ?? e}`)
    return null
  }
}

/** Mixes the given audio streams into one track; returns null if there are none. */
function mixAudio(inputs) {
  const live = inputs.filter((x) => x.stream?.getAudioTracks().length)
  if (!live.length) return null
  const ctx = new AudioContext({ sampleRate: 48000 })
  const dest = ctx.createMediaStreamDestination()
  for (const { stream, gain } of live) {
    const g = ctx.createGain()
    g.gain.value = gain
    ctx.createMediaStreamSource(new MediaStream(stream.getAudioTracks())).connect(g).connect(dest)
  }
  return { ctx, track: dest.stream.getAudioTracks()[0] }
}

window.capture.onStart(async ({ id, fps, height, bitrate, systemAudio, mic }) => {
  curId = id
  const streams = []
  let ctx = null
  cleanup = () => {
    for (const s of streams) s.getTracks().forEach((t) => t.stop())
    void ctx?.close().catch(() => {})
    cleanup = () => {}
  }
  try {
    const video = { frameRate: { max: fps }, height: { max: height }, width: { max: Math.round((height * 16) / 9) } }
    const display = await openDisplay(video, systemAudio, id)
    streams.push(display)
    // Desktop capture can ignore the initial constraints; re-apply to force the downscale.
    await display.getVideoTracks()[0].applyConstraints({ ...video, resizeMode: 'crop-and-scale' }).catch(() => {})
    const micStream = mic ? await openMic(mic, id) : null
    if (micStream) streams.push(micStream)

    const mixed = mixAudio([
      { stream: display, gain: 1 },
      { stream: micStream, gain: mic?.gain ?? 1 },
    ])
    ctx = mixed?.ctx ?? null
    const out = new MediaStream([display.getVideoTracks()[0], ...(mixed ? [mixed.track] : [])])
    mr = new MediaRecorder(out, {
      mimeType: mimeType(!!mixed),
      videoBitsPerSecond: bitrate,
      ...(mixed ? { audioBitsPerSecond: 160_000 } : {}),
    })
    // Chunks must reach main in order; serialize the async buffer reads.
    let chain = Promise.resolve()
    mr.ondataavailable = (e) => {
      if (!e.data.size) return
      chain = chain.then(async () => window.capture.chunk(id, new Uint8Array(await e.data.arrayBuffer())))
    }
    mr.onstop = () => {
      chain.then(() => {
        cleanup()
        mr = null
        window.capture.stopped(id)
      })
    }
    // If the captured window closes, end the recording.
    display.getVideoTracks()[0].onended = () => mr?.state === 'recording' && mr.stop()
    mr.start(1000)
  } catch (e) {
    cleanup()
    window.capture.error(id, `Screen capture failed: ${e?.message ?? e}`)
  }
})

window.capture.onStop(({ id }) => {
  if (id !== curId || !mr) return window.capture.stopped(id)
  if (mr.state !== 'inactive') mr.stop()
})
