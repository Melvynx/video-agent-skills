// Offline synth kit for shorts: a quiet music bed + paper-soft UI sound design. Deterministic (seeded).
// studio(dur) returns buses (MUS sidechained to the voice, SFX dry-ish, REV send) and instruments that write into them.
// Everything is intentionally soft: no risers, no booms, no glitches. Think Apple keynote, not trailer.
export const SR = 48000, TAU = Math.PI * 2;
export const clamp = (x, a = 0, b = 1) => x < a ? a : x > b ? b : x;
export const hz = m => 440 * Math.pow(2, (m - 69) / 12);

export class SVF { // TPT state variable filter, stable under per-sample cutoff sweeps
  constructor() { this.a = 0; this.b = 0; this.lp = this.bp = this.hp = 0; }
  run(x, fc, q = .707) {
    const g = Math.tan(Math.PI * clamp(fc, 10, SR * .45) / SR), k = 1 / q, a1 = 1 / (1 + g * (g + k)), a2 = g * a1, a3 = g * a2;
    const v3 = x - this.b, v1 = a1 * this.a + a2 * v3, v2 = this.b + a2 * this.a + a3 * v3;
    this.a = 2 * v1 - this.a; this.b = 2 * v2 - this.b; this.lp = v2; this.bp = v1; this.hp = x - k * v1 - v2; return v2;
  }
}
const blep = (t, dt) => t < dt ? (t /= dt, t + t - t * t - 1) : t > 1 - dt ? (t = (t - 1) / dt, t * t + t + t + 1) : 0;

export function studio(dur, seed0 = 7) {
  const N = Math.ceil(dur * SR), at = t => Math.round(t * SR);
  let seed = seed0;
  const rand = () => { seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
  const rnd = () => rand() * 2 - 1;
  class Osc {
    constructor(ph = rand()) { this.p = ph; }
    step(f) { const dt = f / SR; this.p += dt; if (this.p >= 1) this.p -= 1; return dt; }
    sin(f) { this.step(f); return Math.sin(TAU * this.p); }
    tri(f) { this.step(f); return 1 - 4 * Math.abs(this.p - .5); }
    saw(f) { const dt = this.step(f); return 2 * this.p - 1 - blep(this.p, dt); }
  }
  const bus = () => [new Float32Array(N), new Float32Array(N)];
  const MUS = bus(), DRM = bus(), SFX = bus(), NZ = bus(), REV = bus();   // NZ: noise strokes (swish/scratch/marker), kept out of the SFX level measurement
  function put(B, i, v, p = 0, rv = 0) {
    if (i < 0 || i >= N) return; p = clamp(p, -1, 1);
    const l = v * Math.sqrt(1 - p), r = v * Math.sqrt(1 + p);
    B[0][i] += l; B[1][i] += r;
    if (rv) { REV[0][i] += l * rv; REV[1][i] += r * rv; }
  }

  // ---------------- music (MUS/DRM buses, both ducked under the voice)
  function kick(t, g = 1) { // round, short, felt-like
    const o = new Osc(0), i0 = at(t);
    for (let i = 0; i < SR * .35; i++) { const s = i / SR, f = 48 + 90 * Math.exp(-s * 38); put(DRM, i0 + i, Math.tanh(o.sin(f) * 1.6) * Math.exp(-s * 9) * Math.min(1, s / .002) * g * .55); }
  }
  function rim(t, g = 1) { // soft rimshot/snap, very dry
    const f = new SVF(), i0 = at(t);
    for (let i = 0; i < SR * .12; i++) { const s = i / SR; f.run(rnd(), 1800, 1.6); put(DRM, i0 + i, f.bp * Math.exp(-s * 45) * g * .35, .1, .12); }
  }
  function clap(t, g = 1) { // music.drive backbeat: three tight noise flams + a short tail, on the drum bus
    const f = new SVF(), i0 = at(t);
    for (let i = 0; i < SR * .16; i++) { const s = i / SR, fl = s < .022 ? Math.exp(-((s % .0075) * 420)) : Math.exp(-(s - .022) * 32); f.run(rnd(), 1300, 1.3); put(DRM, i0 + i, f.bp * fl * g * .42, -.05, .18); }
  }
  function hat(t, g = 1, p = .15) {
    const f = new SVF(), i0 = at(t);
    for (let i = 0; i < SR * .05; i++) { const s = i / SR; f.run(rnd(), 9000, .8); put(DRM, i0 + i, f.hp * Math.exp(-s * 80) * g * .16, p); }
  }
  function pad(t0, t1, notes, g = 1, att = .6, rel = .9) { // warm detuned triangles through a slow low-pass
    const os = notes.flatMap(m => [-.06, .06].map(d => [new Osc(), hz(m + d)])), fl = [new SVF(), new SVF()], i0 = at(t0), n = at(t1) - i0, nr = at(rel);
    for (let i = 0; i < n + nr; i++) {
      const s = i / SR, e = Math.min(1, s / att) * (i < n ? 1 : Math.pow(1 - (i - n) / nr, 2));
      let l = 0, r = 0; os.forEach(([o, f], k) => { const v = o.tri(f) * .6 + o.saw(f) * .08; if (k & 1) r += v; else l += v; });
      fl[0].run(l, 1400); fl[1].run(r, 1400);
      const j = i0 + i; if (j >= N) break; MUS[0][j] += fl[0].lp * e * g * .045; MUS[1][j] += fl[1].lp * e * g * .045;
      REV[0][j] += fl[0].lp * e * g * .012; REV[1][j] += fl[1].lp * e * g * .012;
    }
  }
  function bass(t, f, len, g = 1) {
    const o = new Osc(0), fl = new SVF(), i0 = at(t);
    for (let i = 0; i < SR * (len + .04); i++) { const s = i / SR, e = Math.min(1, s / .004) * (s < len ? 1 : Math.max(0, 1 - (s - len) / .04)); fl.run(o.saw(f) * .5 + Math.sin(TAU * f * s) * .8, 180 + 700 * Math.exp(-s * 18), .9); put(MUS, i0 + i, fl.lp * e * g * .32); }
  }
  function mallet(t, f, g = .1, p = 0, B = MUS) { // marimba-ish: sine + 4x partial, fast decay
    const i0 = at(t);
    for (let i = 0; i < SR * .7; i++) { const s = i / SR; put(B, i0 + i, (Math.sin(TAU * f * s) * Math.exp(-s * 7) + Math.sin(TAU * f * 4 * s) * Math.exp(-s * 40) * .25) * Math.min(1, s / .001) * g, p, .25); }
  }
  function bell(t, f, g = .06, p = 0, dec = 1.2, B = SFX) { // 2-op FM glass bell
    let pc = 0, pm = 0; const i0 = at(t);
    for (let i = 0; i < SR * dec * 2.5; i++) { const s = i / SR; pc = (pc + f / SR) % 1; pm = (pm + f * 3.5 / SR) % 1; put(B, i0 + i, Math.sin(TAU * pc + 1.8 * Math.exp(-s * 6) * Math.sin(TAU * pm)) * Math.exp(-s / dec * 2.3) * Math.min(1, s / .001) * g, p, .35); }
  }

  // ---------------- paper UI sound design (SFX bus)
  function swish(t0, len, g = .3, { p0 = 0, p1 = 0, f0 = 700, f1 = 2600, pk = .45 } = {}) { // paper sliding over paper
    const a = new SVF(), b = new SVF(), i0 = at(t0), n = at(len);
    for (let i = 0; i < n; i++) {
      const u = i / n, e = u < pk ? Math.pow(u / pk, 1.8) : Math.pow(1 - (u - pk) / (1 - pk), 1.5), fc = f0 * Math.pow(f1 / f0, u < pk ? u / pk : 1 - (u - pk) / (1 - pk) * .5), x = rnd();
      a.run(x, fc, .8); b.run(x, fc * 2.4, 1.2);
      put(NZ, i0 + i, (a.bp * .9 + b.bp * .35) * e * (1 + .25 * rnd()) * g, p0 + (p1 - p0) * u, .12);
    }
  }
  function slide(t, g = .25, p = 0) { swish(t - .12, .38, g, { p0: p - .2, p1: p + .2 }); } // card lands: peaks just before t
  function tap(t, g = .3, p = 0) { // trackpad click: tight transient + tiny body
    const f = new SVF(), i0 = at(t); let ph = 0;
    for (let i = 0; i < SR * .03; i++) { const s = i / SR; f.run(rnd(), 3600, 1.8); ph += 1300 / SR; put(SFX, i0 + i, (f.bp * Math.exp(-s * 420) * 1.3 + Math.sin(TAU * ph) * Math.exp(-s * 240) * .45) * g, p, .04); }
  }
  function key(t, g = .1, p = 0) { // soft laptop key
    const f = new SVF(), i0 = at(t), fc = 2600 + rand() * 1600, th = 240 + rand() * 50; let ph = 0;
    for (let i = 0; i < SR * .045; i++) { const s = i / SR; f.run(rnd(), fc, 1.5); ph += th / SR; put(SFX, i0 + i, (f.bp * Math.exp(-s * 170) + Math.sin(TAU * ph) * Math.exp(-s * 80) * .3) * g, p, .03); }
  }
  function tick(t, f = 2400, g = .05, p = 0) {
    let ph = 0; const i0 = at(t);
    for (let i = 0; i < SR * .03; i++) { const s = i / SR; ph += f / SR; put(SFX, i0 + i, Math.sin(TAU * ph) * Math.exp(-s * 190) * Math.min(1, s / .0005) * g, p, .05); }
  }
  function pop(t, f = 520, g = .12, p = 0) { // soft wooden blip for chips landing
    let ph = 0; const i0 = at(t);
    for (let i = 0; i < SR * .12; i++) { const s = i / SR; ph += f * (.7 + .4 * (1 - Math.exp(-s * 50))) / SR; put(SFX, i0 + i, Math.sin(TAU * ph) * Math.exp(-s * 38) * Math.min(1, s / .0015) * g, p, .1); }
  }
  function scratch(t0, len, g = .2, p = 0) { // pencil / marker stroke: grainy band-passed noise
    const a = new SVF(), i0 = at(t0), n = at(len); let gr = 0;
    for (let i = 0; i < n; i++) {
      const u = i / n; if (i % 90 === 0) gr = .55 + .45 * rand();
      a.run(rnd(), 2600 + 1400 * u, 1.4);
      put(NZ, i0 + i, a.bp * gr * Math.min(1, u / .08, (1 - u) / .15) * g, p - .2 + .4 * u, .06);
    }
  }
  function marker(t0, len = .28, g = .1, p = 0) { // highlighter felt on paper: soft, dark, short (not a scratch)
    const a = new SVF(), b = new SVF(), i0 = at(t0), n = at(len); let gr = .8;
    for (let i = 0; i < n; i++) {
      const u = i / n; if (i % 240 === 0) gr = .8 + .2 * rand();
      a.run(rnd(), 1300 + 500 * u, .9); b.run(a.bp, 2400, .7);
      put(NZ, i0 + i, b.lp * gr * Math.min(1, u / .18) * Math.pow(Math.min(1, (1 - u) / .35), 1.5) * g, p - .15 + .3 * u, .05);
    }
  }
  function tom(t, g = .5, f0 = 110, p = 0) { // hand drum (tam-tam): pitched skin + a slap of noise, on the SFX bus
    const o = new Osc(0), f = new SVF(), i0 = at(t);
    for (let i = 0; i < SR * .45; i++) { const s = i / SR; f.run(rnd(), 1200, 1.2); put(SFX, i0 + i, (Math.tanh(o.sin(f0 * (1 + .6 * Math.exp(-s * 30))) * 1.4) * Math.exp(-s * 7) + f.bp * Math.exp(-s * 60) * .6) * Math.min(1, s / .002) * g, p, .15); }
  }
  function thud(t, g = .3) { // paper settling on a desk: low soft knock
    const o = new Osc(0), f = new SVF(), i0 = at(t);
    for (let i = 0; i < SR * .2; i++) { const s = i / SR; f.run(rnd(), 400, .8); put(SFX, i0 + i, (Math.sin(TAU * (70 + 60 * Math.exp(-s * 40)) * s) * .8 + f.lp * .5) * Math.exp(-s * 24) * Math.min(1, s / .002) * g, 0, .08); }
  }
  function shutter(t, g = .3, p = 0) { // camera shutter: two mechanical clacks (open, close) with a little body
    for (const [dt, fc, k] of [[0, 4200, 1], [.072, 2700, .75]]) {
      const a = new SVF(), b = new SVF(), i0 = at(t + dt);
      for (let i = 0; i < SR * .05; i++) { const s = i / SR, x = rnd(); a.run(x, fc, 1.6); b.run(x, 900, 1); put(SFX, i0 + i, (a.bp * Math.exp(-s * 260) * 1.3 + b.bp * Math.exp(-s * 120) * .5) * Math.min(1, s / .0003) * g * k, p, .06); }
    }
  }
  function air(t0, len, g = .12) { swish(t0, len, g, { f0: 300, f1: 1400, pk: .5 }); } // layout / seam move
  function snap(t, g = .5, p = 0) { // finger snap: bright band-passed crack + a short skin body
    const a = new SVF(), b = new SVF(), i0 = at(t);
    for (let i = 0; i < SR * .09; i++) { const s = i / SR, x = rnd(); a.run(x, 2900, 2.2); b.run(x, 1100, 1.4); put(SFX, i0 + i, (a.bp * Math.exp(-s * 140) * 1.4 + b.bp * Math.exp(-s * 60) * .5) * Math.min(1, s / .0003) * g, p, .18); }
  }
  function chirp(t, f0 = 3200, f1 = 4600, len = .09, g = .03, p = 0) { // small bird: sine sweep with a flutter
    let ph = 0; const i0 = at(t), n = at(len);
    for (let i = 0; i < n; i++) { const u = i / n, f = f0 + (f1 - f0) * Math.sin(u * Math.PI * .5) + 180 * Math.sin(TAU * 38 * i / SR); ph += f / SR; put(SFX, i0 + i, Math.sin(TAU * ph) * Math.sin(Math.PI * u) * g, p, .3); }
  }
  function stop(t, len = .5, g = .2) { // tape stop: a soft chord whose pitch and speed sink to nothing
    const os = [48, 55, 64].map(m => [new Osc(0), hz(m)]), fl = new SVF(), i0 = at(t), n = at(len);
    for (let i = 0; i < n; i++) { const u = i / n, k = Math.pow(1 - u, 1.6); let v = 0; os.forEach(([o, f]) => v += o.saw(f * k + 1) * .3); fl.run(v, 300 + 2400 * k, .8); put(SFX, i0 + i, fl.lp * Math.min(1, u / .02) * (1 - u) * g, 0, .1); }
  }
  function start(t, len = .35, g = .16) { // tape start: the same chord winding back up to speed
    const os = [48, 55, 64].map(m => [new Osc(0), hz(m)]), fl = new SVF(), i0 = at(t), n = at(len);
    for (let i = 0; i < n; i++) { const u = i / n, k = Math.pow(u, .7); let v = 0; os.forEach(([o, f]) => v += o.saw(f * k + 1) * .3); fl.run(v, 300 + 2400 * k, .8); put(SFX, i0 + i, fl.lp * Math.min(1, u / .05, (1 - u) / .15) * g, 0, .1); }
  }

  // ---------------- modern accents (spec.sfx.accents): a few soft glassy hits. On the NZ bus, so they sit on top of
  // the measured hit level instead of lowering every other hit.
  function blip(t, f = 1200, g = .05, p = 0) { // glassy UI blip: sine gliding up a fourth + a faint octave
    let a = 0, b = 0; const i0 = at(t);
    for (let i = 0; i < SR * .16; i++) {
      const s = i / SR, fr = f * (.75 + .25 * (1 - Math.exp(-s * 90))); a += fr / SR; b += fr * 2.01 / SR;
      put(NZ, i0 + i, (Math.sin(TAU * a) + Math.sin(TAU * b) * .22 * Math.exp(-s * 40)) * Math.exp(-s * 26) * Math.min(1, s / .002) * g, p, .3);
    }
  }
  function zip(t0, len = .22, g = .05, p = 0) { // quick drawn line: a short rising band sweep
    const f = new SVF(), i0 = at(t0), n = at(len);
    for (let i = 0; i < n; i++) { const u = i / n; f.run(rnd(), 1400 + 4200 * u, 2.2); put(NZ, i0 + i, f.bp * Math.min(1, u / .2) * Math.pow(1 - u, 1.2) * g, p - .25 + .5 * u, .08); }
  }

  return { N, at, MUS, DRM, SFX, NZ, REV, rand, blip, zip, kick, rim, clap, hat, pad, bass, mallet, bell, swish, slide, tap, key, tick, pop, scratch, marker, thud, tom, air, shutter, snap, chirp, stop, start };
}

// ---------------- mixing helpers
export function freeverb(inL, inR, N, { room = .8, damp = .4, pre = .02 } = {}) {
  const k = SR / 44100, fb = room * .28 + .7, d1 = damp * .4, d2 = 1 - d1;
  const mk = (arr, sp) => arr.map(c => ({ b: new Float32Array(Math.round((c + sp) * k)), i: 0, f: 0 }));
  const ch = [0, 23].map(sp => [mk([1116, 1188, 1277, 1356, 1422, 1491, 1557, 1617], sp), mk([556, 441, 341, 225], sp)]);
  const out = [new Float32Array(N), new Float32Array(N)], P = Math.round(pre * SR), hp = new SVF();
  for (let n = 0; n < N; n++) {
    hp.run(n >= P ? (inL[n - P] + inR[n - P]) * .5 : 0, 300); const x = hp.hp * .03;
    for (let c = 0; c < 2; c++) {
      let y = 0;
      for (const cb of ch[c][0]) { const o = cb.b[cb.i]; cb.f = o * d2 + cb.f * d1; cb.b[cb.i] = x + cb.f * fb; if (++cb.i >= cb.b.length) cb.i = 0; y += o; }
      for (const ap of ch[c][1]) { const bo = ap.b[ap.i], o = bo - y; ap.b[ap.i] = y + bo * .5; if (++ap.i >= ap.b.length) ap.i = 0; y = o; }
      out[c][n] = y;
    }
  }
  return out;
}

// BS.1770 integrated loudness of a stereo pair (K-weighting, 400 ms blocks, 75% overlap, -70 abs / -10 rel gates).
export function lufs(B) {
  const N = B[0].length, zs = [];
  const kw = B.map(x => {
    const y = new Float32Array(N); let a1 = 0, a2 = 0, b1 = 0, b2 = 0, c1 = 0, c2 = 0, d1 = 0, d2 = 0;
    for (let i = 0; i < N; i++) {
      const s = 1.53512485958697 * x[i] - 2.69169618940638 * a1 + 1.19839281085285 * a2 + 1.69065929318241 * b1 - .73248077421585 * b2; a2 = a1; a1 = x[i]; b2 = b1; b1 = s;
      const h = s - 2 * c1 + c2 + 1.99004745483398 * d1 - .99007225036621 * d2; c2 = c1; c1 = s; d2 = d1; d1 = h; y[i] = h;
    }
    return y;
  });
  // a 400 ms block = 4 hops of 100 ms: sum each hop once instead of each sample 4 times
  const bl = Math.round(.4 * SR), hop = Math.round(.1 * SR), hs = [];
  for (let i = 0; i + hop <= N; i += hop) { let z = 0; for (let j = i; j < i + hop; j++) z += kw[0][j] ** 2 + kw[1][j] ** 2; hs.push(z); }
  for (let k = 0; k + 4 <= hs.length; k++) zs.push((hs[k] + hs[k + 1] + hs[k + 2] + hs[k + 3]) / bl);
  const L = z => -.691 + 10 * Math.log10(z + 1e-12), abs = zs.filter(z => L(z) > -70);
  if (!abs.length) return -99;
  const rel = L(abs.reduce((a, b) => a + b, 0) / abs.length) - 10, g = abs.filter(z => L(z) > rel);
  return L(g.reduce((a, b) => a + b, 0) / g.length);
}

// Lookahead brickwall (5 ms), 80 ms release, box-smoothed so it never overshoots the ceiling.
export function limit(B, gain, ceil = Math.pow(10, -1.5 / 20)) {
  const N = B[0].length, la = Math.round(.005 * SR), rel = Math.exp(-1 / (.08 * SR)), req = new Float32Array(N), env = new Float32Array(N), out = [new Float32Array(N), new Float32Array(N)];
  for (let i = 0; i < N; i++) { const pk = Math.max(Math.abs(B[0][i]), Math.abs(B[1][i])) * gain; req[i] = pk > ceil ? ceil / pk : 1; }
  const dq = []; let e = 1, h = 0;
  for (let i = 0; i < N + la; i++) {
    if (i < N) { while (dq.length > h && req[dq[dq.length - 1]] >= req[i]) dq.pop(); dq.push(i); }
    const k = i - la; if (k < 0) continue; while (dq[h] < k) h++;
    const m = req[dq[h]]; e = m < e ? m : m + (e - m) * rel; env[k] = e;
  }
  let acc = la; for (let i = 0; i < N; i++) { acc += env[i] - (i >= la ? env[i - la] : 1); const g = acc / la * gain; out[0][i] = B[0][i] * g; out[1][i] = B[1][i] * g; }
  return out;
}
