// Audio for a short: cleaned voice + music bed ducked under it + spec-driven paper SFX -> assets/mix.wav (48k, 24-bit).
// Voice: ffmpeg high-pass 80 Hz + gentle compression, then normalised to -16 LUFS. Bed and SFX are auto-levelled
// to LUFS targets relative to that (spec.mix = {music: -28, sfx: -29.5, duck: .5}), master limited to -14 LUFS / -1.5 dBTP.
// The SFX level is measured on the event hits only (pops, ticks, taps, bells...). Noise strokes (slides, whooshes,
// highlights) ride at the same gain but stay out of the measurement, so thinning or softening them makes the short
// quieter instead of pushing every other hit up.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mapper, mapSpec } from './lib/timeline.js';
import { SR, studio, freeverb, lufs, limit, clamp } from './lib/dsp.js';
import { sfxCues, kitHits, score } from './lib/cues.js';
import { FFMPEG } from './platform.mjs';

const db = x => Math.pow(10, x / 20);

// spec.music.bed: a bed of the skill's library by id (assets/music/<id>.mp3, see references/music.md).
// spec.music.src: any track file instead (mp3, wav, m4a...; ~, absolute or project-relative path). Either replaces the
// generated score. Read from music.offset s into the file, laid from music.start to music.end (SHORT time), looped
// when the track is shorter, faded in .4 s / out 1.2 s. The mixer still levels it to mix.music and ducks it.
function trackBed(M, src, P, T, X) {
  const f = src.replace(/^~/, os.homedir()), file = path.isAbsolute(f) ? f : P(f);
  if (!fs.existsSync(file)) throw new Error(`music.src not found: ${file}`);
  const i0 = Math.max(0, Math.round((M.start ?? 0) * SR)), i1 = Math.min(X.N, Math.round(Math.min(T, M.end ?? T) * SR)), fi = (M.fi ?? .4) * SR, fo = (M.fo ?? 1.2) * SR;
  // decode only the stretch laid (+1 s): the library beds run 150 s, a short uses 30
  const pcm = execFileSync(FFMPEG, ['-v', 'error', ...(M.offset ? ['-ss', String(M.offset)] : []), '-i', file, '-t', String(Math.max(0, i1 - i0) / SR + 1), '-ac', '2', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
  const a = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4), L = a.length >> 1; if (!L) throw new Error(`music.src decoded empty: ${file}`);
  for (let i = i0; i < i1; i++) {
    const k = (i - i0) % L, e = Math.min(1, (i - i0) / fi, (i1 - i) / fo);
    X.MUS[0][i] += a[2 * k] * e; X.MUS[1][i] += a[2 * k + 1] * e;
  }
}

export async function buildAudio(proj, raw) {
  const P = (...a) => path.join(proj, ...a), t0 = Date.now();
  const tl = JSON.parse(fs.readFileSync(P('assets/timeline.json'), 'utf8')), m = mapper(tl), T = tl.duration;
  const spec = mapSpec(raw, m); spec._map = m; spec._jumps = (raw.cut || []).map(([a]) => m(a));
  const mm = v => v != null ? m(v) : undefined;
  if (spec.music) spec.music = { ...spec.music, breaks: (raw.music?.breaks || []).map(([a, b]) => [m(a), m(b)]), end: mm(raw.music?.end), start: mm(raw.music?.start), drops: (raw.music?.drops || []).map(m) };
  const mixCfg = { music: -28, sfx: -29.5, duck: .5, ...(spec.mix || {}) };

  // ---- voice
  const X = studio(T), N = X.N, V = new Float32Array(N);
  if (!raw.silent) {   // spec.silent: paper-only piece, music + SFX only
    const pcm = execFileSync(FFMPEG, ['-v', 'error', '-i', P('assets/voice.wav'), '-af',
      'highpass=f=80,lowpass=f=15000,acompressor=threshold=0.125:ratio=3:attack=5:release=90:makeup=2',
      '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
    const vsrc = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4);
    V.set(vsrc.subarray(0, Math.min(N, vsrc.length)));
    const vg = db(-16 - lufs([V, V])); for (let i = 0; i < N; i++) V[i] *= vg;
  }
  // inserted narrator (spec.pause): same chain, own -16 LUFS normalisation, dropped into the silent gap
  if (tl.pause && raw.pause?.voice) {
    const np = execFileSync(FFMPEG, ['-v', 'error', '-i', P(raw.pause.voice), '-af', 'highpass=f=90,lowpass=f=15000,acompressor=threshold=0.125:ratio=3:attack=5:release=90:makeup=2',
      '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
    const nv = new Float32Array(np.buffer, np.byteOffset, np.length / 4), ng = db(-16 - lufs([nv, nv])) * db(raw.pause.gain ?? 0), i0 = Math.round(tl.pause.t0 * SR);
    for (let i = 0; i < nv.length && i0 + i < N; i++) V[i0 + i] += nv[i] * ng;
  }
  // spec.inserts: each clip in its own gap (tl.inserts), same chain, fixed RMS gain like spec.voices (too short to gate)
  (raw.inserts || []).forEach((v, k) => {
    const g = tl.inserts?.[k]; if (!g) return;
    const np = execFileSync(FFMPEG, ['-v', 'error', '-i', P(v.voice), '-af', 'highpass=f=90,lowpass=f=15000,acompressor=threshold=0.125:ratio=3:attack=5:release=90:makeup=2',
      '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
    const nv = new Float32Array(np.buffer, np.byteOffset, np.length / 4), l = lufs([nv, nv]);
    let rms = 0; for (let i = 0; i < nv.length; i++) rms += nv[i] * nv[i]; rms = Math.sqrt(rms / nv.length);
    const ng = (l > -70 ? db(-16 - l) : db(-19) / Math.max(1e-4, rms)) * db(v.gain ?? 0), i0 = Math.round(g.t0 * SR);
    for (let i = 0; i < nv.length && i0 + i < N; i++) V[i0 + i] += nv[i] * ng;
  });
  // spec.voices: [{at, src, gain}] extra voice clips (an AI answering on camera) laid into held gaps at 1x speed.
  // Each clip is normalised on its own: 1 s clips are too short to gate, so they use a fixed RMS-based gain.
  (spec.voices || []).forEach((v, k) => {
    const np = execFileSync(FFMPEG, ['-v', 'error', '-i', P(raw.voices[k].src), '-af', 'highpass=f=90,lowpass=f=15000,acompressor=threshold=0.125:ratio=3:attack=5:release=90:makeup=2',
      '-ac', '1', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
    const nv = new Float32Array(np.buffer, np.byteOffset, np.length / 4), l = lufs([nv, nv]);
    let rms = 0; for (let i = 0; i < nv.length; i++) rms += nv[i] * nv[i]; rms = Math.sqrt(rms / nv.length);
    const ng = (l > -70 ? db(-16 - l) : db(-19) / Math.max(1e-4, rms)) * db(v.gain ?? 0), i0 = Math.round(v.at * SR);
    for (let i = 0; i < nv.length && i0 + i < N; i++) V[i0 + i] += nv[i] * ng;
  });

  // spec.bleep: [[a, b]] SOURCE ranges censored. The voice is fully cut there (6 ms crossfade) and a 1 kHz tone at about
  // -18 LUFS (just under the voice) takes its place, so nothing of the word leaks. Cover the whole word, its tail included.
  for (const [a, b] of spec.bleep || []) {
    const i0 = Math.max(0, Math.round(a * SR)), i1 = Math.min(N, Math.round(b * SR)), e = Math.round(.006 * SR), A = db(-17.3);
    for (let i = i0; i < i1; i++) { const f = Math.min(1, (i - i0) / e, (i1 - i) / e); V[i] = V[i] * (1 - f) + A * f * Math.sin(2 * Math.PI * 1000 * (i - i0) / SR); }
  }

  // spec.thump: [[a, b, dB]] SOURCE ranges where a mic plosive ("p", "b") thumps: the voice is high-passed at 240 Hz there
  // (two biquads, 24 dB/oct, 12 ms crossfades) and moved by dB (default -3). Cover the burst only: read it on the 80-160 Hz band.
  for (const [a, b, g = -3] of spec.thump || []) {
    const e = Math.round(.012 * SR), i0 = Math.max(0, Math.round(a * SR)), i1 = Math.min(N, Math.round(b * SR)), G = db(g);
    const w = 2 * Math.PI * 240 / SR, al = Math.sin(w) / Math.SQRT2, c = Math.cos(w), a0 = 1 + al;
    const b0 = (1 + c) / 2 / a0, b1 = -(1 + c) / a0, a1 = -2 * c / a0, a2 = (1 - al) / a0, st = new Float64Array(8);
    for (let i = Math.max(0, i0 - 4 * e); i < Math.min(N, i1 + e); i++) {
      let x = V[i];
      for (let o = 0; o < 8; o += 4) { const y = b0 * x + b1 * st[o] + b0 * st[o + 1] - a1 * st[o + 2] - a2 * st[o + 3]; st[o + 1] = st[o]; st[o] = x; st[o + 3] = st[o + 2]; st[o + 2] = y; x = y; }
      const f = clamp(Math.min((i - i0 + e) / e, (i1 + e - i) / e)); V[i] = V[i] * (1 - f) + x * G * f;
    }
  }

  // ---- ducking envelope: fast attack, slow release, so the bed breathes back in between sentences
  const DK = new Float32Array(N), aA = Math.exp(-1 / (.012 * SR)), aR = Math.exp(-1 / (.35 * SR)), thr = db(-30);
  let env = 0, sm = 0; const aS = Math.exp(-1 / (.06 * SR));
  for (let i = 0; i < N; i++) { const x = Math.abs(V[i]); env = x > env ? x + (env - x) * aA : x + (env - x) * aR; const d = clamp(env / thr); sm = d + (sm - d) * aS; DK[i] = 1 - mixCfg.duck * sm; }

  // ---- score + sfx
  const lib = path.join(path.dirname(fileURLToPath(import.meta.url)), '../assets/music'), bed = raw.music?.bed && path.join(lib, `${raw.music.bed}.mp3`);
  // free pack: the beds are not in git, each one is generated in code the first time it is used (about 30 s)
  if (bed && !fs.existsSync(bed) && JSON.parse(fs.readFileSync(path.join(lib, 'tracks.json'), 'utf8')).some(x => x.id === raw.music.bed)) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bed-'));
    console.log(`[audio] music: generating the "${raw.music.bed}" bed once (about 30 s)`);
    execFileSync(process.execPath, [path.join(path.dirname(fileURLToPath(import.meta.url)), 'music.mjs'), raw.music.bed, '--out', tmp], { stdio: 'inherit' });
    if (fs.existsSync(path.join(tmp, `${raw.music.bed}.mp3`))) fs.copyFileSync(path.join(tmp, `${raw.music.bed}.mp3`), bed);
  }
  if (bed && !fs.existsSync(bed)) throw new Error(`music.bed "${raw.music.bed}" not in ${lib} (ids: ${fs.readdirSync(lib).filter(f => f.endsWith('.mp3')).map(f => f.slice(0, -4)).join(', ')})`);
  // music.chapters: [[at, bedId], ...] (SOURCE s): long-form, one library bed per chapter, 2 s crossfade on each change
  const ch = !spec.music?.mute && raw.music?.chapters;
  if (ch?.length) ch.forEach(([at, id], k) => {
    const f = path.join(lib, `${id}.mp3`); if (!fs.existsSync(f)) throw new Error(`music.chapters bed "${id}" not in ${lib}`);
    const a = k ? m(at) - 1 : 0, b = k < ch.length - 1 ? m(ch[k + 1][0]) + 1 : T;
    trackBed({ start: a, end: b, fi: k ? 2 : .4, fo: k < ch.length - 1 ? 2 : 1.2 }, f, P, T, X);
  });
  else if ((bed || spec.music?.src) && !spec.music.mute) trackBed(spec.music, bed || raw.music.src, P, T, X);
  else if (!spec.music?.mute) score(spec, tl, X);
  sfxCues(spec, tl, X);
  // nothing sent to the reverb (no synth SFX): its output is all zeros, skip the 8 combs x 2 over the whole short
  const RV = X.REV.some(c => c.some(v => v !== 0)) ? freeverb(X.REV[0], X.REV[1], N) : [new Float32Array(N), new Float32Array(N)];
  const BED = [new Float32Array(N), new Float32Array(N)], FX = [new Float32Array(N), new Float32Array(N)], EV = [new Float32Array(N), new Float32Array(N)];
  for (let c = 0; c < 2; c++) for (let i = 0; i < N; i++) { BED[c][i] = X.MUS[c][i] + X.DRM[c][i] * .9 + RV[c][i] * .5; EV[c][i] = X.SFX[c][i]; FX[c][i] = X.SFX[c][i] + X.NZ[c][i] + RV[c][i] * .5; }
  // soft sfx (spec.sfx.appear = 'slide'): the slides live on the noise bus, so normalize the whole FX bus
  const lb = lufs(BED), le = lufs(EV), lf = le > -90 && spec.sfx?.appear !== 'slide' ? le : lufs(FX), gb = lb > -90 ? db(mixCfg.music - lb) : 0, gf = lf > -90 ? db(mixCfg.sfx - lf) : 0;

  // spec.sfx.files: [{at | endAt, src, gain -10, pan 0, peak, offset, len}] designed sound files (an ElevenLabs impact, a riser).
  // Each is levelled on its own to (-16 + gain) LUFS, i.e. gain dB under the voice, and stays out of the SFX bus measurement.
  // at = where the file starts (SOURCE time); peak: true puts its loudest sample on `at` instead (impacts, whoosh hits);
  // endAt = where it ends (a riser that lands on the payoff). offset / len trim it (s), with a short fade out.
  const SF = [new Float32Array(N), new Float32Array(N)], kit = kitHits(spec, T), decoded = new Map();
  [...(spec.sfx?.files || []), ...kit.files].forEach(f => {
    const file = P(f.src); if (!fs.existsSync(file)) throw new Error(`sfx.${f.kit ? 'kit.' + f.kit : 'files'} src not found: ${file}`);
    const ck = [file, f.offset, f.len].join('|'), pcm = decoded.get(ck) || execFileSync(FFMPEG, ['-v', 'error', ...(f.offset ? ['-ss', String(f.offset)] : []), ...(f.len ? ['-t', String(f.len)] : []), '-i', file, '-ac', '2', '-ar', String(SR), '-f', 'f32le', '-'], { maxBuffer: 1 << 30 });
    decoded.set(ck, pcm);
    const a = new Float32Array(pcm.buffer, pcm.byteOffset, pcm.length / 4), L = a.length >> 1; if (!L) return;
    const ch = [new Float32Array(L), new Float32Array(L)]; let pk = 0, pi = 0, rms = 0;
    for (let i = 0; i < L; i++) { ch[0][i] = a[2 * i]; ch[1][i] = a[2 * i + 1]; const v = Math.abs(a[2 * i]) + Math.abs(a[2 * i + 1]); if (v > pk) { pk = v; pi = i; } rms += a[2 * i] ** 2 + a[2 * i + 1] ** 2; }
    rms = Math.sqrt(rms / (2 * L));
    const l = lufs(ch), g = (l > -70 ? db(-16 + (f.gain ?? -10) - l) : db(-19 + (f.gain ?? -10)) / Math.max(1e-4, rms));
    const pan = clamp(f.pan ?? 0, -1, 1), gl = g * Math.cos((pan + 1) * Math.PI / 4) * Math.SQRT2, gr = g * Math.sin((pan + 1) * Math.PI / 4) * Math.SQRT2;
    const i0 = f.endAt != null ? Math.round(f.endAt * SR) - L : Math.round((f.at ?? 0) * SR) - (f.peak ? pi : 0), fo = Math.round(.04 * SR);
    for (let i = 0; i < L; i++) { const j = i0 + i; if (j < 0 || j >= N) continue; const e = f.len ? Math.min(1, (L - i) / fo) : 1; SF[0][j] += ch[0][i] * gl * e; SF[1][j] += ch[1][i] * gr * e; }
  });

  // music.drops: [t] SOURCE s where the bed cuts out for music.dropLen s (default .3) and slams back, as on a punch-in.
  // music.dropOn: 'punch' adds one on every sfx.kit punch (instant zoom), 'cut' on every kit cut too.
  const DR = new Float32Array(N).fill(1), dl = spec.music?.dropLen ?? .3, dd = spec.music?.dropDepth ?? .06, ed = Math.round(.008 * SR);
  const dOn = [].concat(spec.music?.dropOn || []), drops = [...(spec.music?.drops || []), ...kit.files.filter(f => dOn.includes(f.kit)).map(f => f.at)];
  for (const a of drops) { const i0 = Math.round(a * SR), i1 = i0 + Math.round(dl * SR);
    for (let i = Math.max(0, i0 - ed); i < Math.min(N, i1 + ed); i++) DR[i] = Math.min(DR[i], dd + (1 - dd) * (1 - clamp(Math.min((i - i0 + ed) / ed, (i1 + ed - i) / ed)))); }

  // ---- sum + master
  const fadeIn = Math.round(.02 * SR), fadeOut = Math.round(.35 * SR), Mx = [new Float32Array(N), new Float32Array(N)];
  for (let c = 0; c < 2; c++) for (let i = 0; i < N; i++) {
    const f = Math.min(1, i / fadeIn, (N - i) / fadeOut);
    Mx[c][i] = (V[i] + BED[c][i] * gb * DK[i] * DR[i] + FX[c][i] * gf + SF[c][i]) * f;
  }
  // sample-peak ceiling; AAC can add ~1.5 dB of overs on sharp transients, so lower it (spec.mix.ceil, dBFS) if QC fails
  let gain = 1, Y, I; const ceil = db(spec.mix?.ceil ?? -1.5);
  for (let it = 0; it < 6; it++) { Y = limit(Mx, gain, ceil); I = lufs(Y); if (Math.abs(I + 14) < .05) break; gain *= db(-14 - I); }
  let peak = 0; for (let c = 0; c < 2; c++) for (let i = 0; i < N; i++) { if (!Number.isFinite(Y[c][i])) throw new Error('NaN in mix at ' + (i / SR).toFixed(3)); peak = Math.max(peak, Math.abs(Y[c][i])); }

  const buf = Buffer.alloc(44 + N * 6);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + N * 6, 4); buf.write('WAVEfmt ', 8); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(2, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 6, 28); buf.writeUInt16LE(6, 32); buf.writeUInt16LE(24, 34); buf.write('data', 36); buf.writeUInt32LE(N * 6, 40);
  for (let i = 0; i < N; i++) for (let c = 0; c < 2; c++) {   // 24-bit little endian by hand (faster than writeIntLE)
    const v = Math.max(-8388608, Math.min(8388607, Math.round(Y[c][i] * 8388607))), o = 44 + i * 6 + c * 3;
    buf[o] = v & 255; buf[o + 1] = v >> 8 & 255; buf[o + 2] = v >> 16 & 255;
  }
  fs.writeFileSync(P('assets/mix.wav'), buf);
  // spec.mix.stem: also write assets/fx.wav = music + SFX without the voice, pre-master, levelled against a -16 LUFS voice.
  // The youtube-editing mix route lays it over the Tella master's own voice (scripts/mix_splice.mjs).
  if (spec.mix?.stem) {
    const sb = Buffer.alloc(44 + N * 8);
    sb.write('RIFF', 0); sb.writeUInt32LE(36 + N * 8, 4); sb.write('WAVEfmt ', 8); sb.writeUInt32LE(16, 16); sb.writeUInt16LE(3, 20); sb.writeUInt16LE(2, 22);
    sb.writeUInt32LE(SR, 24); sb.writeUInt32LE(SR * 8, 28); sb.writeUInt16LE(8, 32); sb.writeUInt16LE(32, 34); sb.write('data', 36); sb.writeUInt32LE(N * 8, 40);
    for (let i = 0; i < N; i++) for (let c = 0; c < 2; c++) sb.writeFloatLE(BED[c][i] * gb * DK[i] * DR[i] + FX[c][i] * gf + SF[c][i], 44 + i * 8 + c * 4);
    fs.writeFileSync(P('assets/fx.wav'), sb);
  }
  console.log(`[short] mix.wav: ${T.toFixed(2)}s, voice -16 LUFS, ${lb > -90 ? `bed ${mixCfg.music} LUFS (duck ${Math.round(mixCfg.duck * 100)}%)` : 'no music'}, ${lf > -90 ? `sfx ${mixCfg.sfx} LUFS` : 'no synth sfx'}${(spec.sfx?.files?.length || 0) + kit.files.length ? `, ${(spec.sfx?.files?.length || 0) + kit.files.length} sfx files` : ''} -> master ${I.toFixed(2)} LUFS, peak ${(20 * Math.log10(peak)).toFixed(2)} dBFS (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
}
