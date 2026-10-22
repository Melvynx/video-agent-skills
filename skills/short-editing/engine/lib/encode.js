// Hardware H.264 encode of the canvas, right in the page (WebCodecs, Annex B, VideoToolbox on a Mac). One encoder per
// render worker, kept open across work units: short.mjs hands each worker 2 s units (encodeUnit), each opening on a
// keyframe (an IDR with its SPS/PPS), so units from different workers concatenate as is. The bytes of a unit stream in
// order to the CLI's local server (`sink`, ?n = frames out so far, &end = the unit is complete); nothing big crosses CDP.
// PERF (ms, summed over the units): load = waiting on frame images, render = the whole render(t) including load,
// submit = VideoFrame + encode(), encWait = encoder backpressure, flush = the final flush.
export function installEncoder(canvas, render, PERF) {
  let enc = null, err = null, fps = 30, k = 0, units = [], post = Promise.resolve();
  const send = (u, end) => {
    if (!u.size && !end) return;
    const body = new Blob(u.buf), url = `${u.sink}?n=${u.out}${end ? '&end=1' : ''}`; u.buf = []; u.size = 0;
    post = post.then(() => fetch(url, { method: 'POST', body }));
  };
  window.encodeStart = (f, bitrate) => {
    fps = f; k = 0; err = null; units = []; post = Promise.resolve();
    // nobody looks at this page: a hidden canvas is not composited after every frame (same pixels, checked by hash of
    // the VideoFrame on 180 frames; -0.7 ms of image wait per frame, benchmark 2026-10-21)
    canvas.style.display = 'none';
    for (const key in PERF) PERF[key] = 0;
    enc = new VideoEncoder({
      // outputs come back with the timestamp of their frame: k = the worker's frame counter, which unit it belongs to
      output: c => {
        const i = Math.round(c.timestamp * fps / 1e6), u = units.find(u => i >= u.k0 && i < u.k0 + u.n); if (!u) return;
        const b = new Uint8Array(c.byteLength); c.copyTo(b); u.buf.push(b); u.size += b.length; u.out++;
        if (u.out === u.n) { send(u, true); units.splice(units.indexOf(u), 1); } else if (u.size > 2e6) send(u);
      },
      error: e => err = e,
    });
    enc.configure({ codec: 'avc1.640034', width: canvas.width, height: canvas.height, bitrate, framerate: fps, bitrateMode: 'variable',
      latencyMode: 'quality', hardwareAcceleration: /Mac/.test(navigator.userAgent) ? 'prefer-hardware' : 'no-preference', avc: { format: 'annexb' } });
  };
  // frames [a, b): returns once they are all submitted (the encoder keeps running while the CLI sends the next unit)
  window.encodeUnit = async (a, b, sink) => {
    const T0 = performance.now(); units.push({ sink, k0: k, n: b - a, out: 0, buf: [], size: 0 });
    for (let n = a; n < b; n++) {
      if (err) throw err;
      const r0 = performance.now(); await render(n / fps);
      const e0 = performance.now(); PERF.render += e0 - r0;
      const f = new VideoFrame(canvas, { timestamp: Math.round(k * 1e6 / fps), duration: Math.round(1e6 / fps) });
      enc.encode(f, { keyFrame: n === a }); f.close(); k++;
      const q0 = performance.now(); PERF.submit += q0 - e0;
      while (enc.encodeQueueSize > 3) await new Promise(r => enc.addEventListener('dequeue', r, { once: true }));
      PERF.encWait += performance.now() - q0;
    }
    PERF.total += performance.now() - T0; PERF.frames += b - a;
  };
  window.encodeEnd = async () => {
    const f0 = performance.now(); await enc.flush(); if (err) throw err;
    for (const u of units) send(u, true);   // only if the encoder dropped a frame: the CLI checks the count
    units = []; await post; enc.close(); enc = null;
    PERF.flush = performance.now() - f0; PERF.total += PERF.flush;
    return { ...PERF };
  };
  window.HAS_WEBCODECS = typeof VideoEncoder === 'function';
}
