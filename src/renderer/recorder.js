// Hidden window: captures the source main picks (setDisplayMediaRequestHandler)
// and streams webm chunks back to main, which writes them to disk.
let mr = null
let stream = null
let curId = null

function mimeType() {
  for (const t of ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'])
    if (MediaRecorder.isTypeSupported(t)) return t
  return ''
}

window.capture.onStart(async ({ id, fps, bitrate }) => {
  curId = id
  try {
    stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: fps }, audio: false })
    mr = new MediaRecorder(stream, { mimeType: mimeType(), videoBitsPerSecond: bitrate })
    // Chunks must reach main in order; serialize the async buffer reads.
    let chain = Promise.resolve()
    mr.ondataavailable = (e) => {
      if (!e.data.size) return
      chain = chain.then(async () => window.capture.chunk(id, new Uint8Array(await e.data.arrayBuffer())))
    }
    mr.onstop = () => {
      chain.then(() => {
        stream?.getTracks().forEach((t) => t.stop())
        stream = null
        mr = null
        window.capture.stopped(id)
      })
    }
    // If the captured window closes, end the recording.
    stream.getVideoTracks()[0].onended = () => mr?.state === 'recording' && mr.stop()
    mr.start(1000)
  } catch (e) {
    window.capture.error(id, `Screen capture failed: ${e?.message ?? e}`)
  }
})

window.capture.onStop(({ id }) => {
  if (id !== curId || !mr) return window.capture.stopped(id)
  if (mr.state !== 'inactive') mr.stop()
})
