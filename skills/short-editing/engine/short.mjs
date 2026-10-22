#!/usr/bin/env node
// short-editing engine CLI. Every heavy step runs niced (and optionally on efficiency cores with --eco).
//   node short.mjs init    <project> [--source take.mp4|latest]   new project: folders, starter spec framed on the take, style snapshot
//   node short.mjs words   <project> [lang]     word timestamps: whisper.cpp on this computer (ElevenLabs Scribe when ELEVEN_KEY is set) -> assets/words-scribe.json (lang: profile creator.lang)
//   node short.mjs prepare <project>            tighten silences, splice voice, extract cam + media frames
//   node short.mjs rough   <project>            silences cut, full frame, spliced voice -> output/<slug>-rough.mp4 (studio first pass)
//   node short.mjs stills  <project> [t...]     render PNG stills (SHORT time; suffix "s" = source time) + contact sheet
//   node short.mjs capture <project> <page.html> --dur <s> [--size 1080x1920] [--alpha] [--out assets/x.mov] [--at t,t]  HTML motion component (window.setT) -> clip + sheet
//   node short.mjs render  <project> [--scale .5] [--fps 30] [--from a --to b] [--workers 2] [--jpeg] [--eco] [--out file.mp4]
//   node short.mjs audio   <project>            music bed + SFX + ducked voice -> assets/mix.wav
//   node short.mjs final   <project>            mux, poster, QC -> output/<slug>.mp4
//   node short.mjs all     <project>            render (audio mixed beside it) + final
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import vm from 'node:vm';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mapper, mapSpec } from './lib/timeline.js';
import { withStyle } from './lib/style.js';
import { openChrome } from './chrome.mjs';
import { CHROME, FFMPEG, FFPROBE, eco, h264, hasEncoder, visionTool } from './platform.mjs';

const ENGINE = path.dirname(fileURLToPath(import.meta.url));
const FPS = 30, SR = 48000;
const BT709 = ['-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709'];

const argv = process.argv.slice(2);
const cmd = argv[0], PROJ = argv[1] && path.resolve(argv[1].replace(/^~/, os.homedir()));
const flag = (k, d) => { const i = argv.indexOf('--' + k); return i < 0 ? d : (argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : true); };
const pos = argv.slice(2).filter((a, i, A) => !a.startsWith('--') && !(A[i - 1] || '').startsWith('--'));
if (!cmd || !PROJ) { console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('\n').slice(1, 10).join('\n')); process.exit(1); }

// Be a good citizen: low priority for us and every child (ffmpeg, Chrome inherit it).
try { os.setPriority(0, 15); } catch {}
if (flag('eco')) eco();

const P = (...a) => path.join(PROJ, ...a);
const readJSON = f => JSON.parse(fs.readFileSync(f, 'utf8'));
// source/style.json (creator style snapshot, lib/style.js) fills what the spec leaves out; absent = legacy project
const loadStyle = () => fs.existsSync(P('source/style.json')) ? readJSON(P('source/style.json')) : null;
// the style's illustration library (<profile>/styles/<style>/illustrations/library, engine/library.mjs): an
// assets/images/<name> missing from the project is read there, so a spec can use any illustration of its style
let libMemo;
const styleLib = () => libMemo !== undefined ? libMemo : (libMemo = (() => {
  const name = String(loadStyle()?.name || '').toLowerCase(), dir = path.join(HOME(), 'styles');
  if (!name || !fs.existsSync(dir)) return null;
  const nameOf = d => { try { return String(readJSON(path.join(d, 'style.json')).name || '').toLowerCase(); } catch { return ''; } };
  const d = fs.readdirSync(dir).map(n => path.join(dir, n)).find(d => nameOf(d) === name || path.basename(d).toLowerCase() === name);
  return d && fs.existsSync(path.join(d, 'illustrations/library')) ? path.join(d, 'illustrations/library') : null;
})());
const projFile = r => {
  const f = path.resolve(PROJ, r), img = path.join(PROJ, 'assets/images') + path.sep;
  if (fs.existsSync(f) || !f.startsWith(img) || !styleLib()) return f;
  const g = path.join(styleLib(), f.slice(img.length));
  return fs.existsSync(g) ? g : f;
};
const loadSpec = () => { const ctx = { window: {} }; vm.runInNewContext(fs.readFileSync(P('source/spec.js'), 'utf8'), ctx); return withStyle(ctx.window.SPEC, loadStyle()); };
// spec.format: 'square' renders 1080x1080 (X feed), 'wide' 1920x1080 (16:9), 'youtube' 1920x1080 long-form
// (lib/runtime-yt.js: a 1080x1080 paper stage left of the camera), default is the 1080x1920 short.
const frameWH = () => ({ square: [1080, 1080], wide: [1920, 1080], youtube: [1920, 1080] })[loadSpec().format] || [1080, 1920];
// the scenes' stage: format 'youtube' draws them on a 1080x1080 square, composited into the 1920x1080 frame
const stageWH = () => loadSpec().format === 'youtube' ? [1080, 1080] : frameWH();
const frameH = () => frameWH()[1];
const expand = p => p.replace(/^~/, os.homedir());
const ff = (args, o = {}) => execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', ...args], { stdio: ['ignore', 'inherit', 'inherit'], ...o });
const probe = (f, e = 'format=duration') => execFileSync(FFPROBE, ['-v', 'error', '-show_entries', e, '-of', 'default=nw=1:nk=1', f]).toString().trim();
const snap = x => Math.round(x * FPS) / FPS;
const log = (...a) => console.log('[short]', ...a);
const md5 = b => crypto.createHash('md5').update(b).digest('hex');
const pad5 = i => String(i).padStart(5, '0');

// ---------------------------------------------------------------- prepare
// Loudness of the source voice in 10 ms frames (dB), used to find the real silences between words.
function voiceFrames() {
  const raw = execFileSync(FFMPEG, ['-v', 'error', '-i', P('assets/source.wav'), '-f', 'f32le', '-ac', '1', '-ar', '16000', '-'], { maxBuffer: 1 << 30 });
  const x = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4), hop = 160, db = new Float32Array(Math.floor(x.length / hop));
  for (let f = 0; f < db.length; f++) { let e = 0; for (let i = f * hop; i < (f + 1) * hop; i++) e += x[i] * x[i]; db[f] = 10 * Math.log10(e / hop + 1e-12); }
  const ref = Float32Array.from(db).sort()[Math.floor(db.length * .95)];
  return { db, quiet: ref - 21, dt: .01 };
}

function tighten(spec) {
  // Micro-silence cutter. At every word boundary, find the longest truly quiet run in the audio (21 dB under the
  // voice) and cut it down to pOut + pIn: a tiny breath, never a clipped consonant. g = the breath budget for that
  // boundary (sentence / comma / word). speed > 1 plays the whole short faster.
  // Long-form: T.gap = only quiet runs longer than this are cut (natural breathing stays, a few cuts per minute instead
  // of a jump every sentence), T.minKeep = a keep shorter than this folds into its neighbour across an automatic gap
  // (never across spec.cut), T.paper = { sentence, comma, word, gap } overrides where the layout shows full paper
  // (face hidden, a tighter cut is invisible).
  const T = { sentence: .10, comma: .06, word: .03, lead: .03, tail: .9, gap: 0, minKeep: 0, ...(spec.tighten || {}) };
  const LK = spec.layout?.keys || [];
  const layAt = t => { let x = 0; for (const [kt, kx] of LK) { if (kt <= t) x = kx; else break; } return x; };
  const sp = spec.speed || 1;
  const words = readJSON(P('assets/words-scribe.json')).words.filter(w => w.type === 'word');
  const dur = +probe(P('assets/source.mp4'));
  const V = voiceFrames();
  const quietRun = (t0, t1) => {
    let best = null, st = -1;
    const f0 = Math.max(0, Math.floor(t0 / V.dt)), f1 = Math.min(V.db.length, Math.ceil(t1 / V.dt));
    for (let f = f0; f <= f1; f++) {
      const q = f < f1 && V.db[f] < V.quiet;
      if (q && st < 0) st = f;
      if (!q && st >= 0) { if (!best || f - st > best[1] - best[0]) best = [st, f]; st = -1; }
    }
    return best && [best[0] * V.dt, best[1] * V.dt];
  };
  const quietShare = (t0, t1) => {
    const f0 = Math.max(0, Math.floor(t0 / V.dt)), f1 = Math.min(V.db.length, Math.ceil(t1 / V.dt));
    if (f1 <= f0) return 1;
    let n = 0; for (let f = f0; f < f1; f++) n += V.db[f] < V.quiet; return n / (f1 - f0);
  };
  let keeps = [], a = Math.max(0, words[0].start - T.lead);
  for (let i = 0; i < words.length - 1; i++) {
    const c = words[i], n = words[i + 1];
    const TT = T.paper && layAt(c.end) >= 1920 ? { ...T, ...T.paper } : T;
    const g = /[.!?…]$/.test(c.text) ? TT.sentence : /[,;:]$/.test(c.text) ? TT.comma : TT.word;
    const pOut = Math.max(.035, g * .6), pIn = Math.max(.025, g * .4);
    // cut = the wider of the quiet run in the audio and the gap between the word timings
    // the word-timing gap only counts when the audio there is really quiet: Scribe often ends a word early or starts the
    // next one late ("10 M" = "dix millions" with "mil-" outside both words), and cutting that gap clipped the word
    const qa = quietRun(c.end - .06, n.start + .06), qw = quietShare(c.end, n.start) >= .5 ? [c.end, n.start] : null;
    const q = qa && (!qw || qa[1] - qa[0] > qw[1] - qw[0]) ? qa : qw;
    if (q && q[1] - q[0] > Math.max(pOut + pIn + .02, TT.gap)) { keeps.push([a, q[0] + pOut]); a = q[1] - pIn; }
  }
  keeps.push([a, Math.min(dur, words.at(-1).end + T.tail)]);
  // spec.hold: [[a, b]] SOURCE ranges kept verbatim, silences included (a sung rhythm, a beat left for an effect)
  for (const [ha, hb] of spec.hold || []) keeps.push([ha, hb]);
  keeps.sort((x, y) => x[0] - y[0]);
  for (const [ca, cb] of spec.cut || []) keeps = keeps.flatMap(([a, b]) => cb <= a || ca >= b ? [[a, b]] : [[a, ca], [cb, b]].filter(([x, y]) => y - x > .02));
  keeps = keeps.map(([a, b]) => [snap(a), snap(b)]).filter(([a, b]) => b > a);
  const merged = [];
  for (const k of keeps) { const l = merged.at(-1); if (l && k[0] <= l[1]) l[1] = Math.max(l[1], k[1]); else merged.push(k); }
  if (T.minKeep) {   // fold a too-short keep into the neighbour with the smaller automatic gap (the silence comes back)
    const userGap = (a, b) => (spec.cut || []).some(([ca, cb]) => ca < b && cb > a);
    for (let i = 0; i < merged.length;) {
      const [a, b] = merged[i], p = merged[i - 1], n = merged[i + 1];
      const gp = p && !userGap(p[1], a) ? a - p[1] : Infinity, gn = n && !userGap(b, n[0]) ? n[0] - b : Infinity;
      if (b - a >= T.minKeep || (gp === Infinity && gn === Infinity)) { i++; continue; }
      if (gp <= gn) { p[1] = b; merged.splice(i, 1); i--; } else { merged[i][1] = n[1]; merged.splice(i + 1, 1); }
    }
  }
  // spec.pause: the whole short stops at SOURCE time `at` for the length of an inserted voice (a narrator),
  // then resumes. The keep that contains `at` is split so the pause lands exactly there.
  const PZ = spec.pause && { ...spec.pause, at: snap(spec.pause.at) };
  if (PZ) {
    PZ.words = PZ.words ? readJSON(P(PZ.words)) : [];
    PZ.dur = snap(+probe(P(PZ.voice)) + (PZ.tail ?? .12));
    const i = merged.findIndex(([a, b]) => PZ.at > a && PZ.at < b);
    if (i >= 0) merged.splice(i, 1, [merged[i][0], PZ.at], [PZ.at, merged[i][1]]);
  }
  // spec.inserts: [{at, voice, tail?, gain?}] short voice clips (a chapter line, "Piège numéro deux") dropped between
  // two sentences at SOURCE time `at`: the short makes room for each one, the camera holds its frame, the music runs
  // on (no grey drain, no tape stop). Time slots take 'iK+X' = X seconds into insert K.
  const INS = (spec.inserts || []).map((v, k) => ({ k, at: snap(v.at), dur: snap(+probe(P(v.voice)) + (v.tail ?? .12)) }));
  for (const v of INS) {
    const i = merged.findIndex(([a, b]) => v.at > a && v.at < b);
    if (i >= 0) merged.splice(i, 1, [merged[i][0], v.at], [v.at, merged[i][1]]);
  }
  // o = SHORT-time start of each keep (already divided by speed)
  let off = 0, pause = null;
  const ins = [], todo = [...INS].sort((x, y) => x.at - y.at);
  const K = merged.map(([a, b]) => {
    if (PZ && !pause && a >= PZ.at) { pause = { t0: snap(off), dur: PZ.dur, at: PZ.at }; off = pause.t0 + PZ.dur; }
    while (todo.length && a >= todo[0].at) { const v = todo.shift(); ins[v.k] = { t0: snap(off), dur: v.dur, at: v.at }; off = ins[v.k].t0 + v.dur; }
    const r = [a, b, +off.toFixed(6)]; off += (b - a) / sp; return r;
  });
  for (const v of todo) { ins[v.k] = { t0: snap(off), dur: v.dur, at: v.at }; off += v.dur; }
  // spec.outro: seconds added after the last word (an end card): silent voice, the camera holds its last frame
  const OUT = Math.max(0, +spec.outro || 0);
  const tl = { fps: FPS, speed: sp, duration: +(off + OUT).toFixed(6), source: +dur.toFixed(3), keeps: K, words: [] };
  if (pause) tl.pause = pause;
  if (INS.length) tl.inserts = ins;
  if (OUT) tl.outro = { t0: +off.toFixed(6), dur: OUT };
  const m = mapper(tl);
  // words inside a spec.cut never reach the captions. A word the micro-silence cutter swallowed (Scribe gave a fast
  // "je", "me", "que" a sliver in a quiet run, the real voice sits next to its neighbour) folds into that neighbour.
  const mid = w => (w.start + w.end) / 2;
  const kept = w => K.some(([a, b]) => mid(w) >= a && mid(w) <= b);
  const userCut = w => (spec.cut || []).some(([a, b]) => mid(w) >= a && mid(w) <= b);
  const ws = [];
  let carry = '';
  for (const w of words) {
    if (userCut(w)) continue;
    if (!kept(w)) {
      const l = ws.at(-1);
      if (l && !/[.!?…]$/.test(l.text) && w.start - l.e0 < .6) l.text += ' ' + w.text;
      else carry += w.text + ' ';
      continue;
    }
    ws.push({ text: carry + w.text, start: +m(w.start).toFixed(3), end: +m(w.end).toFixed(3), s0: w.start, e0: w.end });
    carry = '';
  }
  tl.words = ws;
  if (pause) {   // narrator words, in SHORT time, with s0 = null (words.md prints them as p+X)
    tl.words.push(...PZ.words.map(w => ({ text: w.text, start: +(pause.t0 + w.start).toFixed(3), end: +(pause.t0 + w.end).toFixed(3), s0: null, e0: null, narrator: true })));
    tl.words.sort((x, y) => x.start - y.start);
  }
  return tl;
}

function spliceVoice(tl) {
  const raw = execFileSync(FFMPEG, ['-v', 'error', '-i', P('assets/source.wav'), '-f', 'f32le', '-ac', '1', '-ar', String(SR), '-'], { maxBuffer: 1 << 30 });
  const src = new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4), sp = tl.speed || 1;
  const N = Math.round(tl.duration * sp * SR), out = new Float32Array(N), F = Math.round(.006 * SR);
  for (const [a, b, o] of tl.keeps) {
    const s0 = Math.round(a * SR), n = Math.round((b - a) * SR), d0 = Math.round(o * sp * SR);
    for (let i = 0; i < n && d0 + i < N; i++) {
      const g = Math.min(1, (i + 1) / F, (n - i) / F);
      out[d0 + i] = (src[s0 + i] || 0) * (a === 0 && i < F ? 1 : g);
    }
  }
  const tmp = P('assets/voice.f32');
  fs.writeFileSync(tmp, Buffer.from(out.buffer));
  ff(['-f', 'f32le', '-ar', String(SR), '-ac', '1', '-i', tmp, ...(sp !== 1 ? ['-af', `atempo=${sp}`] : []), '-c:a', 'pcm_s16le', P('assets/voice.wav')]);
  fs.unlinkSync(tmp);
}

// the source voice track (words makes it too); words from elsewhere skip that step
function sourceWav() {
  const wav = P('assets/source.wav');
  if (!fs.existsSync(wav) || fs.statSync(wav).mtimeMs < fs.statSync(P('assets/source.mp4')).mtimeMs)
    ff(['-i', P('assets/source.mp4'), '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', wav]);
}

// ffmpeg select expression keeping the timeline's SOURCE ranges
function keepSelect(tl) {
  // balanced (a+b)+(c+d) tree: a flat a+b+c+... sum of ~100+ keeps overflows ffmpeg's expression parser
  const tree = a => a.length === 1 ? a[0] : `(${tree(a.slice(0, a.length >> 1))}+${tree(a.slice(a.length >> 1))})`;
  // a - .001: a keep starting on a frame whose time rounds up at 4 decimals would lose that frame (1 per keep, ~0.7 s drift)
  return tree(tl.keeps.map(([a, b]) => `between(t,${(a - .001).toFixed(4)},${(b - .001).toFixed(4)})`));
}

// grade: true = the default look, fitted to the take's exposure: it measures the face (a box under cam.eyes, median of 5
// frames). DIM (face luma <= 80, a dim warm room): brighter face and mids, solid blacks, 0.84 saturation so the wood and
// lamps stop glowing orange, a slight cool shift. NATURAL (face luma >= 100, every normal take): no colour shift at all,
// 0.96 saturation, the black point stays, and a gentle mids lift that fades out as the take gets brighter (full at face
// luma 108 or less, none at 128). 80 to 100 blends the two. Both add a touch of clarity. A string = your own ffmpeg filter
// chain, false/absent = the raw take. Baked into frames/cam (and so into the cutout matte); prepare writes stills/grade.jpg
// (raw | graded, same frame) to check it. Rejected: a contrasty cool grade ("trop saturé, pas assez lumineux"), the DIM lift
// on a well lit take ("les couleurs de la caméra sont pas bonnes": washed out face, pale greenish skin), then the old
// DIM/LIT blend on a 108 take (red cut in the mids, lifted blacks: grey washed out skin, "les couleurs de la caméra sont
// pas top", 2026-10-10).
const GRADE_X = [0, .12, .3, .5, .75];
const DIM = { rs: -.025, bs: .015, rm: -.035, bm: .01, curve: [.012, .18, .46, .69, .89], sat: .84 };
const NAT = { rs: 0, bs: 0, rm: 0, bm: 0, lift: [0, .005, .025, .04, .03], sat: .96 };
function faceLuma(spec) {   // mean luma (0-255) of a box on the face, median over 5 frames; null when it cannot measure
  const [cx, cy, cw, ch] = spec.cam?.crop || [400, 0, 1200, 1080], [ex, ey] = spec.cam?.eyes || [cw / 2, ch * .4];
  const s = Math.round(ch * .22), x = Math.max(0, Math.round(cx + ex - s / 2)), y = Math.max(0, Math.round(cy + ey - s / 4));
  try {
    const d = +execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', P('assets/source.mp4')]).toString().trim();
    const ys = [.2, .35, .5, .65, .8].map(p => {
      const out = execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', (d * p).toFixed(2), '-i', P('assets/source.mp4'), '-frames:v', '1',
        '-vf', `crop=${s}:${s}:${x}:${y},signalstats,metadata=print:file=-`, '-f', 'null', '-']).toString();
      return +(out.match(/YAVG=([\d.]+)/)?.[1] ?? NaN);
    }).filter(Number.isFinite).sort((a, b) => a - b);
    return ys.length ? ys[ys.length >> 1] : null;
  } catch { return null; }
}
// white point: a webcam balanced for the warm lamp turns a white cap or shirt lit by the window mint/cyan ("les couleurs
// sont pas top"). Mean of the near-white pixels on him (a box under cam.eyes, skips the wood and the lamp-lit wall),
// 5 frames; each channel's highlights are bent so that white reads neutral (at most .07), the shadows and mids barely move,
// so the skin and the wood keep their colour. cam.wb: false turns it off. Returns a curves filter or ''.
function whitePoint(spec) {
  if (spec.cam?.wb === false) return '';
  const [cx, cy, cw, ch] = spec.cam?.crop || [400, 0, 1200, 1080], [ex, ey] = spec.cam?.eyes || [cw / 2, ch * .4];
  const bw = Math.round(cw * .5), bx = Math.round(Math.min(Math.max(0, ex - bw / 2), cw - bw)), by = Math.round(Math.max(0, ey - ch * .35)), bh = ch - by;
  try {
    const d = +execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', P('assets/source.mp4')]).toString().trim();
    const sum = [0, 0, 0]; let n = 0, all = 0;
    for (const p of [.2, .35, .5, .65, .8]) {
      const px = execFileSync(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-ss', (d * p).toFixed(2), '-i', P('assets/source.mp4'), '-frames:v', '1',
        '-vf', `crop=${bw}:${bh}:${cx + bx}:${cy + by},scale=96:-2:in_color_matrix=${srcMatrix()}:in_range=tv,format=rgb24`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 24 });
      for (let i = 0; i + 2 < px.length; i += 3) {
        const r = px[i], g = px[i + 1], b = px[i + 2], lo = Math.min(r, g, b), hi = Math.max(r, g, b); all++;
        if (lo > 140 && hi < 252 && hi - lo < 55) { sum[0] += r; sum[1] += g; sum[2] += b; n++; }
      }
    }
    if (n < all * .02) return '';
    const w = sum.map(v => v / n / 255), t = (w[0] + w[1] + w[2]) / 3, f = v => +v.toFixed(3);
    if (Math.max(...w.map(v => Math.abs(t - v))) < .012) return '';
    const ch3 = ['r', 'g', 'b'].map((c, i) => {
      const dv = Math.max(-.07, Math.min(.07, t - w[i]));
      return `${c}='0/0 .5/${f(.5 + dv * .3)} ${f(w[i])}/${f(w[i] + dv)} 1/${f(dv < 0 ? 1 + dv * .25 : 1)}'`;
    });
    log(`grade: white point ${w.map(v => Math.round(v * 255)).join(',')} -> neutral`);
    return `curves=${ch3.join(':')}`;
  } catch { return ''; }
}
let gradeMemo = null;
function gradeOf(spec) {
  if (spec.grade !== true) return typeof spec.grade === 'string' && spec.grade.trim() ? spec.grade.trim() : '';
  if (gradeMemo != null) return gradeMemo;
  const y = faceLuma(spec), cl = v => Math.min(1, Math.max(0, v));
  const k = y == null ? 0 : cl((100 - y) / 20), a = y == null ? 1 : cl((128 - y) / 20);   // k: 1 = DIM, 0 = NATURAL; a: NATURAL's lift
  const mix = (d, n) => +(n + (d - n) * k).toFixed(3);
  const curve = GRADE_X.map((x, i) => `${x}/${mix(DIM.curve[i], x + NAT.lift[i] * a)}`).join(' '), wp = whitePoint(spec);
  const cb = ['rs', 'bs', 'rm', 'bm'].map(c => [c, mix(DIM[c], NAT[c])]).filter(([, v]) => v);
  log(`grade: face luma ${y == null ? '?' : y.toFixed(0)} -> ${k >= .99 ? 'dim room' : k > .01 ? `blend ${k.toFixed(2)} dim` : `natural, lift ${a.toFixed(2)}`}`);
  return gradeMemo = (wp ? wp + ',' : '') + (cb.length ? `colorbalance=${cb.map(([c, v]) => `${c}=${v}`).join(':')},` : '')
    + `curves=master='${curve} 1/1',eq=saturation=${mix(DIM.sat, NAT.sat)},unsharp=5:5:.3`;
}
// stills/grade.jpg: the same frame of the take raw (left) and graded (right), to check the skin at every prepare
function gradeSheet(spec, g) {
  const [cx, cy, cw, ch] = spec.cam?.crop || [400, 0, 1200, 1080], m = srcMatrix();
  try {
    const d = +execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', P('assets/source.mp4')]).toString().trim();
    fs.mkdirSync(P('stills'), { recursive: true });
    ff(['-ss', (d * .35).toFixed(2), '-i', P('assets/source.mp4'), '-frames:v', '1', '-filter_complex',
      `[0]crop=${cw}:${ch}:${cx}:${cy},split[a][b];[a]scale=in_color_matrix=${m}:in_range=tv,format=gbrp,scale=out_color_matrix=bt601:out_range=pc,format=yuvj420p,scale=720:-2[r];`
      + `[b]${gradeChain(g)},scale=720:-2[g];[r][g]hstack`, '-q:v', '3', P('stills/grade.jpg')]);
    log('grade: stills/grade.jpg (raw | graded)');
  } catch { }
}
// a graded take is decoded to RGB with its real matrix (untagged HD = BT.709, as players show it), then written as JPEG (BT.601 full range)
function srcMatrix() {
  const [cs, h] = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_space,height', '-of', 'default=nw=1:nk=1', P('assets/source.mp4')]).toString().trim().split('\n');
  return ({ bt709: 'bt709', smpte170m: 'bt601', bt470bg: 'bt601', bt2020nc: 'bt2020' })[cs] || (+h >= 720 ? 'bt709' : 'bt601');
}
function gradeChain(g) {
  return `scale=in_color_matrix=${srcMatrix()}:in_range=tv,format=gbrp,${g},scale=out_color_matrix=bt601:out_range=pc,format=yuvj420p`;
}

function extractCam(spec, tl) {
  const [cx, cy, cw, ch] = spec.cam?.crop || [400, 0, 1200, 1080], g = gradeOf(spec);
  const dir = P('frames/cam'); fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
  const sel = keepSelect(tl);
  // software decode on all cores: 6 s for a 143 s HEVC take, VideoToolbox (copy-back) and -threads 4 are ~8 s
  // fps= BEFORE select: a VFR phone/Tella take is first put on the exact 30 fps grid, so every keep yields exactly
  // (b - a) * 30 frames and the picture never drifts from the voice (select on raw VFR lost ~7 frames over 12 min).
  // spec.cam.q = JPEG quality (2 = near lossless for long-form, 3 = default)
  ff(['-threads', '0', '-i', P('assets/source.mp4'), '-vf', `fps=${FPS},select='${sel}',setpts=N/${FPS * (tl.speed || 1)}/TB,fps=${FPS},crop=${cw}:${ch}:${cx}:${cy}${g ? ',' + gradeChain(g) : ''}`,
    '-fps_mode', 'passthrough', '-an', '-q:v', String(spec.cam?.q ?? 3), '-start_number', '0', path.join(dir, '%05d.jpg')]);
  let n = fs.readdirSync(dir).filter(f => f.endsWith('.jpg')).length;
  // freeze (spec.pause, spec.inserts), earliest first: shift every frame after the gap, then fill it with the last frame before it
  for (const g of [tl.pause, ...(tl.inserts || [])].filter(Boolean).sort((x, y) => x.t0 - y.t0)) {
    const i0 = Math.round(g.t0 * FPS), k = Math.round(g.dur * FPS), f = i => path.join(dir, `${String(i).padStart(5, '0')}.jpg`);
    for (let i = n - 1; i >= i0; i--) fs.renameSync(f(i), f(i + k));
    for (let i = i0; i < i0 + k; i++) fs.linkSync(f(Math.max(0, i0 - 1)), f(i));
    n += k;
  }
  return n;
}

// media.sync: true = a second track of the take (a screen recording on the same clock as source.mp4): it is cut like
// the camera, frames indexed in SHORT time, only over media.spans [[a, b]] (SOURCE s, default the whole take).
function extractSynced(m, dir, tl, fill, w) {
  const sp = tl.speed || 1, spans = m.spans || [[0, 1e9]];
  for (const [a, b, o] of tl.keeps) for (const [sa, sb] of spans) {
    const a1 = Math.max(a, sa), b1 = Math.min(b, sb); if (b1 - a1 < 1 / FPS) continue;
    const n0 = Math.round((o + (a1 - a) / sp) * FPS), n = Math.round((o + (b1 - a) / sp) * FPS) - n0; if (n < 1) continue;
    ff(['-threads', '4', '-ss', String(a1), '-i', path.resolve(PROJ, expand(m.src)), '-vf', `setpts=(PTS-STARTPTS)/${sp},fps=${FPS},${fill}scale=${w}:-2:flags=lanczos`,
      '-frames:v', String(n), '-an', '-q:v', String(m.q ?? 2), '-start_number', String(n0), path.join(dir, '%05d.jpg')]);
  }
}
// spec.vanish.plate: the empty room (one frame of the take at its own size, the speaker removed) goes through the same
// crop and grade as the camera, so it lines up with frames/cam pixel for pixel -> frames/plate.jpg
function plateFrame(spec) {
  const src = spec.vanish?.plate; if (!src) return;
  const [cx, cy, cw, ch] = spec.cam?.crop || [400, 0, 1200, 1080], g = gradeOf(spec);
  const [sw, sh] = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', P('assets/source.mp4')]).toString().trim().split(',');
  ff(['-i', P(src), '-frames:v', '1', '-vf', `scale=${sw}:${sh},crop=${cw}:${ch}:${cx}:${cy}${g ? ',' + gradeChain(g) : ''}`, '-q:v', '2', P('frames/plate.jpg')]);
  log('vanish: plate -> frames/plate.jpg');
}
// true when every use of media `id` in the spec is an `overlay` scene's media (the only draw that maps a cropped frame
// back to its place); any other mention of the id (an actor, a card, a tweet avatar, a list) keeps the whole frame
function overlayOnly(spec, id) {
  let ok = false;
  const walk = (o, k, parent) => {
    if (o === id) { if (k === 'media' && parent?.type === 'overlay' && !Array.isArray(parent)) ok ||= true; else throw 0; return; }
    if (o && typeof o === 'object') for (const [kk, v] of Object.entries(o)) walk(v, kk, o);
  };
  try { for (const [k, v] of Object.entries(spec)) if (k !== 'media') walk(v, k, spec); } catch { return false; }
  return ok;
}
// alpha media drawn only by overlay scenes: the box that is ever visible (alpha > 0 on any frame, + 2 px so edge
// filtering stays the same), measured on the exact frames the extraction makes (same input, same -vf).
// -> {box: [x, y, w, h], w, h (the whole frame)}, or null when the box would save under 10 % of the pixels
function alphaBox(input, vf) {
  const r = spawnSync(FFMPEG, ['-hide_banner', ...input, '-vf', vf + ',alphaextract,bbox=min_val=1', '-an', '-f', 'null', '-'], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const size = r.stderr.match(/Output #0[\s\S]*?Stream #0:0[^\n]*?, (\d+)x(\d+)/);
  if (r.status || !size) return null;
  const W0 = +size[1], H0 = +size[2];
  let x1 = 1e9, y1 = 1e9, x2 = -1, y2 = -1;
  for (const m of r.stderr.matchAll(/x1:(\d+) x2:(\d+) y1:(\d+) y2:(\d+)/g)) {
    const [a, b, c, d] = m.slice(1).map(Number); if (b < a || d < c) continue;
    x1 = Math.min(x1, a); x2 = Math.max(x2, b); y1 = Math.min(y1, c); y2 = Math.max(y2, d);
  }
  if (x2 < 0) return null;
  x1 = Math.max(0, x1 - 2); y1 = Math.max(0, y1 - 2); x2 = Math.min(W0 - 1, x2 + 2); y2 = Math.min(H0 - 1, y2 + 2);
  const box = [x1, y1, x2 - x1 + 1, y2 - y1 + 1];
  return box[2] * box[3] > .9 * W0 * H0 ? null : { box, w: W0, h: H0 };
}
// frames identical to an earlier one (a UI holding still, a frozen B-roll) -> {frame: first identical frame}: the page
// fetches and decodes each picture once (mediaURL in the runtimes)
function repeats(dir) {
  const alias = {}, seen = new Map();
  for (const f of fs.readdirSync(dir).sort()) {
    const i = parseInt(f, 10); if (!(i >= 0)) continue;
    const h = md5(fs.readFileSync(path.join(dir, f))); if (seen.has(h)) alias[i] = seen.get(h); else seen.set(h, i);
  }
  return alias;
}
function extractMedia(spec, prev, tl) {
  const out = {};
  for (const [id, m] of Object.entries(spec.media || {})) {
    // the key holds the file's size and mtime too: a clip re-encoded under the same name (a component captured again) is re-extracted
    const fp = path.resolve(PROJ, expand(m.src)), fst = fs.existsSync(fp) ? fs.statSync(fp) : null, stamp = fst && [fst.size, Math.round(fst.mtimeMs)];
    const crops = !!m.alpha && !m.sync && overlayOnly(spec, id);
    const key = JSON.stringify(m.sync ? [m, tl.keeps, tl.speed, stamp] : [m, stamp, ...(crops ? ['crop1'] : [])]), dir = P('frames/media', id);
    if (prev?.[id]?.key === key && fs.existsSync(dir)) { out[id] = { ...prev[id], alias: prev[id].alias || repeats(dir) }; continue; }
    fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true });
    // fill: true crops the clip to the frame's aspect first (full-screen B-roll, spec.broll), around focus [x, y] (0..1)
    const [FW, FH] = frameWH(), [fx, fy] = m.focus || [.5, .5], w = m.width || (m.fill ? FW : 960);
    const fill = m.fill ? `crop='min(iw,ih*${FW}/${FH})':'min(ih,iw*${FH}/${FW})':'(iw-ow)*${fx}':'(ih-oh)*${fy}',` : '';
    // alpha: true keeps the clip's transparency (a UI overlay rendered on a transparent background, e.g. a png-in-mov or a
    // ProRes 4444) as RGBA PNG frames, for the `overlay` scene; every other clip is JPG
    const ext = m.alpha ? 'png' : 'jpg', enc = m.alpha ? ['-pix_fmt', 'rgba'] : ['-q:v', '1', '-qmin', '1'];
    let crop = null;
    if (m.sync) extractSynced(m, dir, tl, fill, w);
    else {
      const input = ['-threads', '4', ...(m.from ? ['-ss', String(m.from)] : []), ...(m.dur ? ['-t', String(m.dur)] : []), '-i', path.resolve(PROJ, expand(m.src))];
      let vf = `fps=${FPS},${fill}scale=${w}:-2:flags=lanczos${m.alpha ? ',format=rgba' : ''}`;
      // an overlay is mostly transparent: only its visible box is stored (about half the pixels to decode and draw per frame)
      if (crops && (crop = alphaBox(input, vf))) vf += `,crop=${crop.box[2]}:${crop.box[3]}:${crop.box[0]}:${crop.box[1]}`;
      ff([...input, '-vf', vf, '-an', ...enc, '-start_number', '0', path.join(dir, `%05d.${ext}`)]);
    }
    const jpgs = fs.readdirSync(dir).filter(f => f.endsWith('.' + ext)).sort(), count = m.sync ? parseInt(jpgs.at(-1) || '-1', 10) + 1 : jpgs.length;
    const [iw, ih] = crop ? [crop.w, crop.h] : probe(path.join(dir, jpgs[0]), 'stream=width,height').split('\n').map(Number);
    const alias = repeats(dir), reps = Object.keys(alias).length;
    out[id] = { count, w: iw, h: ih, key, ...(m.sync ? { sync: true } : {}), ...(m.alpha ? { ext } : {}), ...(crop ? { crop: crop.box } : {}), alias };
    log(`media ${id}: ${count} frames ${iw}x${ih}${crop ? `, visible box ${crop.box[2]}x${crop.box[3]}` : ''}${reps ? `, ${reps} repeats` : ''}`);
  }
  return out;
}

// Speaker matte (spec.cutout, matteSpans): person masks -> frames/matte/*.png (gray+alpha, the runtime composites them
// over the cam JPGs). On a Mac, Apple Vision (matte.swift, prebuilt or compiled once, platform.mjs) as 3 parallel workers
// (the Neural Engine saturates near 30 fps); elsewhere MediaPipe in headless Chrome (vision-web.mjs), one worker. Raw masks
// are cached by cam JPG content in frames/.matte-cache, so after a `cut` change only never-seen frames hit the model;
// the cheap EMA + blur pass reruns.
async function cutoutFrames(spec, tl, camKey, prevKey, camN) {
  const mm = mapSpec({ cutout: spec.cutout || [], matteSpans: spec.matteSpans || [], vanish: spec.vanish?.plate ? spec.vanish : null }, mapper(tl));
  const v = mm.vanish;   // vanish.plate: only the person turns to dust, so the whole vanish needs his matte
  const cs = [].concat(mm.cutout, mm.matteSpans.map(([from, to]) => ({ from, to })), v ? [{ from: v.from, to: (v.backAt ?? v.to) + (v.back ?? .45) }] : []);
  if (!cs?.length) return null;
  const n0 = Math.max(0, Math.min(...cs.map(c => Math.floor(c.from * FPS) - 2)));
  const n1 = Math.min(camN - 1, Math.max(...cs.map(c => Math.ceil((c.to + (c.mode === 'cam' ? 1.3 : 1.1)) * FPS))));
  const tool = visionTool('matte'), binH = tool.id, q = process.env.MATTE_QUALITY || 'accurate';
  const key = JSON.stringify([camKey, n0, n1, binH, q]), dir = P('frames/matte');
  if (key === prevKey && fs.existsSync(dir)) return key;
  const t0 = Date.now(), cache = P('frames/.matte-cache'), jobs = P('frames/.matte-jobs');
  for (const d of [dir, jobs, P('frames/cutout')]) fs.rmSync(d, { recursive: true, force: true });   // frames/cutout: old RGBA format
  for (const d of [dir, jobs, cache]) fs.mkdirSync(d, { recursive: true });
  const m0 = Math.max(0, n0 - 8), raw = {}, cost = {};
  for (let i = m0; i <= n1; i++) {
    raw[i] = path.join(cache, md5([tool.web ? 'w1' : 'r1', q, md5(fs.readFileSync(P('frames/cam', `${pad5(i)}.jpg`)))].join()) + '.png');
    cost[i] = fs.existsSync(raw[i]) ? 1 : 7;   // ~5 ms cached vs ~35 ms through Vision
  }
  // W contiguous slices of equal cost; each primes its EMA on the 8 frames before it (cheap once cached)
  const W = Math.max(1, Math.min(+flag('matte-workers', tool.web ? 1 : 3), Math.ceil((n1 - n0 + 1) / 60))), total = Object.values(cost).reduce((x, y) => x + y, 0);
  const fresh = Object.values(cost).filter(c => c > 1).length, slices = [];
  for (let i = n0, acc = 0, a = n0; i <= n1; i++) { acc += cost[i]; if (i === n1 || acc >= total * (slices.length + 1) / W) { slices.push([a, i]); a = i + 1; } }
  log(`matte: frames ${n0}-${n1}, ${fresh} through ${tool.web ? 'MediaPipe' : 'Vision'} (${n1 - m0 + 1 - fresh} cached), ${slices.length} workers`);
  const done = new Map(), N = n1 - n0 + 1; let shown = -1;
  const tick = () => { const d = [...done.values()].reduce((x, y) => x + y, 0), pc = Math.floor(100 * d / N);
    if (pc >= shown + 10) { shown = pc - pc % 10; const fps = d / ((Date.now() - t0) / 1e3); log(`matte ${pc}% (${d}/${N}) ${fps.toFixed(1)} fps, eta ${Math.round((N - d) / Math.max(fps, .1))}s`); } };
  await Promise.all(slices.map(([a, b], k) => new Promise((res, rej) => {
    const lines = []; for (let i = Math.max(m0, a - 8); i <= b; i++) lines.push(`${i} ${raw[i]} ${i >= a ? 1 : 0}`);
    const jf = path.join(jobs, `${k}.txt`); fs.writeFileSync(jf, lines.join('\n'));
    const p = spawn(tool.cmd, [...tool.args, P('frames/cam'), dir, jf], { stdio: ['ignore', 'pipe', 'inherit'] });
    p.stdout.on('data', d => { const m = [...String(d).matchAll(/matte (\d+)/g)].at(-1); if (m) { done.set(k, +m[1]); tick(); } });
    p.on('close', c => c ? rej(new Error(`matte exited ${c}`)) : (done.set(k, b - a + 1), tick(), res()));
  })));
  fs.rmSync(jobs, { recursive: true, force: true });
  const used = new Set(Object.values(raw).map(f => path.basename(f)));
  for (const f of fs.readdirSync(cache)) if (!used.has(f)) fs.unlinkSync(path.join(cache, f));   // keep the cache to the current cut
  log(`matte: ${N} frames ready in ${((Date.now() - t0) / 1e3).toFixed(1)}s`);
  return key;
}

function wordsDoc(tl) {
  const lines = ['# Words', '', 'Source time (what spec.js uses) -> short time. Regenerated by `short.mjs prepare`.', '',
    `Short duration: ${tl.duration.toFixed(2)}s (source ${tl.source}s, ${tl.keeps.length} keeps)`, '', '| src | short | word |', '|---|---|---|'];
  for (const w of tl.words) lines.push(`| ${w.s0 == null ? 'p+' + (w.start - tl.pause.t0).toFixed(2) : w.s0.toFixed(2)} | ${w.start.toFixed(2)} | ${w.text.replace(/\|/g, '/')} |`);
  fs.writeFileSync(P('files/words.md'), lines.join('\n') + '\n');
}

// spec.silent: a paper-only motion piece with no Tella take (no voice, no camera, no captions).
// spec.duration is the length; times in spec.js are plain seconds (SOURCE = SHORT).
function prepareSilent(spec) {
  const d = snap(spec.duration);
  const tl = { fps: FPS, speed: 1, duration: d, source: d, keeps: [[0, d, 0]], words: [] };
  fs.writeFileSync(P('assets/timeline.json'), JSON.stringify(tl));
  const prevF = fs.existsSync(P('assets/frames.json')) ? readJSON(P('assets/frames.json')) : {};
  const media = extractMedia(spec, prevF.media, tl);
  fs.writeFileSync(P('assets/frames.json'), JSON.stringify({ cam: 0, media }));
  log(`silent timeline: ${d}s, no voice, no camera`);
}

// iPhone takes are HDR (HLG, BT.2020): read as SDR they come out grey, washed and purple. Tone-map them once to SDR
// BT.709 with Apple's own mapping (avconvert H.264 preset = the iPhone's SDR export look); the HDR original stays as
// assets/source-hlg.mp4. Same frames and duration, the rotation is applied (ffmpeg already showed it rotated).
function sdrSource() {
  const s = P('assets/source.mp4');
  if (!fs.existsSync(s)) return;
  const trc = execFileSync(FFPROBE, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=color_transfer', '-of', 'default=nw=1:nk=1', s]).toString().trim();
  if (trc !== 'arib-std-b67' && trc !== 'smpte2084') return;
  if (process.platform !== 'darwin') { log(`WARNING: HDR take (${trc}), colors will look washed: convert it to SDR BT.709 first`); return; }
  const hdr = P('assets/source-hlg.mp4'), tmp = P('assets/source-sdr.mov');
  if (!fs.existsSync(hdr)) fs.copyFileSync(s, hdr, fs.constants.COPYFILE_FICLONE);
  execFileSync('avconvert', ['-s', hdr, '-o', tmp, '-p', 'Preset1920x1080', '--replace'], { stdio: ['ignore', 'ignore', 'inherit'] });
  ff(['-i', tmp, '-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', s]);
  fs.rmSync(tmp);
  log(`source: HDR (${trc}) tone-mapped to SDR BT.709, original kept as assets/source-hlg.mp4`);
}

async function prepare() {
  const spec = loadSpec();
  fs.mkdirSync(P('files'), { recursive: true }); fs.mkdirSync(P('assets'), { recursive: true });
  if (spec.silent) return prepareSilent(spec);
  sdrSource();
  sourceWav();
  const tl = tighten(spec);
  fs.writeFileSync(P('assets/timeline.json'), JSON.stringify(tl));
  log(`timeline: ${tl.source}s -> ${tl.duration.toFixed(2)}s, ${tl.keeps.length} keeps${tl.pause ? `, pause ${tl.pause.dur}s at ${tl.pause.t0}s` : ''}${tl.inserts ? `, ${tl.inserts.length} inserts` : ''}`);
  spliceVoice(tl); log('voice.wav spliced');
  wordsDoc(tl);
  const prevF = fs.existsSync(P('assets/frames.json')) ? readJSON(P('assets/frames.json')) : {};
  const srcStat = fs.statSync(P('assets/source.mp4'));
  const camKey = JSON.stringify([srcStat.size, Math.round(srcStat.mtimeMs), tl.keeps, tl.speed, spec.cam?.crop, tl.pause, tl.inserts, ...(gradeOf(spec) ? [gradeOf(spec)] : []), ...(spec.cam?.q != null ? [spec.cam.q] : [])]);
  let cam = prevF.cam;
  if (!(prevF.camKey === camKey && fs.existsSync(P('frames/cam')))) {
    cam = extractCam(spec, tl); log(`cam: ${cam} frames (expected ${Math.round(tl.duration * FPS)})`);
    if (gradeOf(spec)) gradeSheet(spec, gradeOf(spec));
  }
  plateFrame(spec);
  const media = extractMedia(spec, prevF.media, tl);
  const cutKey = await cutoutFrames(spec, tl, camKey, prevF.cutKey, cam);
  fs.writeFileSync(P('assets/frames.json'), JSON.stringify({ cam, camKey, media, cutKey }));
  log('prepare done');
}

// The review studio's first pass: the take with every micro silence cut (and spec.cut), full frame, the spliced
// voice, no motion design. Same timeline as prepare, so the studio's SHORT times map back to spec.js exactly.
function rough() {
  const spec = loadSpec();
  if (spec.silent) throw new Error('rough needs a take (this project is paper only)');
  fs.mkdirSync(P('files'), { recursive: true }); fs.mkdirSync(P('output'), { recursive: true });
  sourceWav();
  const tl = tighten(spec);
  fs.writeFileSync(P('assets/timeline.json'), JSON.stringify(tl));
  spliceVoice(tl); wordsDoc(tl);
  if (tl.pause || tl.inserts) log('rough: spec.pause / spec.inserts are not frozen in the rough cut, the voice runs ahead after them');
  const out = P('output', `${path.basename(PROJ)}-rough.mp4`);
  ff(['-threads', '0', '-i', P('assets/source.mp4'), '-i', P('assets/voice.wav'), '-map', '0:v:0', '-map', '1:a',
    '-vf', `fps=${FPS},select='${keepSelect(tl)}',setpts=N/${FPS * (tl.speed || 1)}/TB,scale=-2:'min(1080,ih)'`, '-r', String(FPS),
    ...(hasEncoder('h264_videotoolbox') ? ['-c:v', 'h264_videotoolbox', '-b:v', '8M'] : ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22']), '-pix_fmt', 'yuv420p',
    ...AAC(), '-t', tl.duration.toFixed(3), '-movflags', '+faststart', out]);
  log(`rough: ${tl.source}s -> ${tl.duration.toFixed(2)}s, ${tl.keeps.length} keeps -> ${out}`);
}

// ---------------------------------------------------------------- browser
const MIME = { '.wav': 'audio/wav', '.otf': 'font/otf', '.woff2': 'font/woff2', '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.jpg': 'image/jpeg', '.png': 'image/png', '.ttf': 'font/ttf', '.css': 'text/css' };
function serve(sinks = {}, port = 0, home = null) {
  const srv = http.createServer((req, res) => {
    const u = decodeURIComponent(req.url.split('?')[0]);
    if (home && u === '/') { res.writeHead(302, { location: home }); return res.end(); }
    // POST /sink/<k>?n=<frames done>[&end=1]: encoded video bytes of one work unit from a render worker, in order
    if (req.method === 'POST' && u.startsWith('/sink/')) {
      const k = u.slice(6), sk = sinks[k];
      if (!sk) { res.writeHead(404); return res.end(); }
      req.on('data', b => sk.data(b));
      req.on('end', () => { const q = new URL(req.url, 'http://x').searchParams; sk.done = +q.get('n'); sk.tick?.(); if (q.has('end')) sk.end?.(); res.end(); });
      return;
    }
    // /style.json: the project's style snapshot ({} when none), /style-font: its font file (style.font.src)
    if (u === '/style.json') { res.writeHead(200, { 'content-type': MIME['.json'], 'cache-control': 'no-store' }); return res.end(JSON.stringify(loadStyle() || {})); }
    const fsrc = u === '/style-font' && loadStyle()?.font?.src;
    const f = fsrc ? expand(fsrc) : u.startsWith('/engine/') ? path.join(ENGINE, u.slice(8)) : u.startsWith('/p/') ? projFile(u.slice(3)) : null;
    if (!f || !fs.existsSync(f) || fs.statSync(f).isDirectory()) { console.log('  page 404:', u); res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' });
    fs.createReadStream(f).pipe(res);
  });
  return new Promise(r => srv.listen(port, '127.0.0.1', () => r(srv)));
}

// Live preview: the same runtime as the render, played in a normal Chrome tab (no encode, no mp4). render(t) runs on
// each animation frame at the time of the audio clock (assets/mix.wav, else the spliced voice). spec.js is re-read on
// every reload, so edit it and press R. Long-lived: run it in the background, --port fixed (default 41190).
async function preview() {
  const [SW, SH] = stageWH(), [WW, HH] = frameWH(), port = +flag('port', 41190), scale = +flag('scale', .5);
  const home = `/engine/short.html?scale=${scale}&w=${SW}&h=${SH}&ow=${WW}&oh=${HH}&play=1`;
  await serve({}, port, home);
  log(`preview: http://127.0.0.1:${port}/ (${path.basename(PROJ)}, scale ${scale})`);
  await new Promise(() => {});
}

// No GPU switches: headless Chrome on Apple silicon already draws the canvas, rasterizes and encodes on the GPU (ANGLE
// Metal). Benchmarked 2026-10-21 with --use-angle=metal --enable-gpu-rasterization --ignore-gpu-blocklist: no gain.
// One headless Chrome with the runtime booted. Each worker gets its own browser, so its own renderer process.
// projects prepared before the mask-only matte still have RGBA frames/cutout: rematte instead of rendering him away
async function ensureMatte() {
  const f = fs.existsSync(P('assets/frames.json')) && readJSON(P('assets/frames.json'));
  if (f?.cutKey && !fs.existsSync(P('frames/matte'))) { log('matte missing (old format), re-running prepare'); await prepare(); }
}

const bootLog = b => b && log(`boot: fonts ${b.fonts?.toFixed(0)} ms, paper background ${b.bg?.toFixed(0)} ms, ready at ${b.ready?.toFixed(0)} ms`);

// One headless Chrome on the runtime page, driven over its DevTools pipe (chrome.mjs): the page boots ~0.3 s sooner than
// through Playwright (benchmark 2026-10-21, M4 Max: 0.9 -> 0.6 s for 2 render workers). Playwright stays as the fallback
// when that Chrome does not start; an error of the page itself (window.READY_ERROR) is thrown as is.
async function openPage(srv, scale) {
  const [WW, HH] = frameWH(), [SW, SH] = stageWH();
  const url = `http://127.0.0.1:${srv.address().port}/engine/short.html?scale=${scale}&w=${SW}&h=${SH}&ow=${WW}&oh=${HH}${flag('ahead') ? '&ahead=' + flag('ahead') : ''}`;
  try {
    const pg = await openChrome(CHROME, url, { width: WW / 2, height: HH / 2, args: ['--renderer-process-limit=1'] });
    if (flag('bench')) bootLog(await pg.evaluate(() => window.PERF_BOOT));
    return { page: { evaluate: pg.evaluate }, close: pg.close };
  } catch (e) { if (e.page) throw e; log(`chrome pipe failed (${e.message.split('\n')[0]}), Playwright instead`); }
  const { chromium } = await import('playwright-core');
  // launchServer + kill: a graceful browser.close() of headless Chrome takes ~2.4 s on macOS, kill() ~30 ms. Nothing is
  // lost: every caller awaits its last result (encodeEnd awaits its final POST) before closing.
  const bs = await chromium.launchServer({ executablePath: CHROME, headless: true, args: ['--renderer-process-limit=1', '--disable-extensions', '--mute-audio'] });
  const browser = await chromium.connect(bs.wsEndpoint()), kill = () => bs.kill();
  const page = await browser.newPage({ viewport: { width: WW / 2, height: HH / 2 } });
  page.on('console', m => { if (m.type() === 'error' || m.text().startsWith('[rt]')) console.log('  page:', m.text()); });
  page.on('pageerror', e => console.log('  pageerror:', e.message));
  await page.goto(url);
  await page.waitForFunction(() => window.READY === true || window.READY_ERROR, null, { timeout: 60000 });
  const err = await page.evaluate(() => window.READY_ERROR);
  if (err) { await kill(); throw new Error(err); }
  if (flag('bench')) bootLog(await page.evaluate(() => window.PERF_BOOT));
  return { page, close: kill };
}

async function withPage(scale, fn) {
  const srv = await serve(), pg = await openPage(srv, scale).catch(e => { srv.close(); throw e; });
  try { return await fn(pg.page); } finally { await pg.close(); srv.close(); }
}

async function stills() {
  await ensureMatte();
  const tl = readJSON(P('assets/timeline.json')), m = mapper(tl);
  let ts = pos.length ? pos.map(x => x.endsWith('s') ? m(parseFloat(x)) : parseFloat(x)) : Array.from({ length: 12 }, (_, i) => (i + .5) * tl.duration / 12);
  const dir = P('stills'); fs.mkdirSync(dir, { recursive: true });
  for (const f of fs.readdirSync(dir)) if (/^t\d/.test(f)) fs.unlinkSync(path.join(dir, f));
  const scale = +flag('scale', 1), png = !!flag('png', false);   // --png: lossless stills (frame-to-frame motion QC)
  await withPage(scale, async page => {
    for (const t of ts) {
      const b64 = await page.evaluate(([t, png]) => png ? window.framePNG(t) : window.frameJPEG(t, .9), [t, png]);
      fs.writeFileSync(path.join(dir, `t${t.toFixed(2).padStart(5, '0')}.${png ? 'png' : 'jpg'}`), Buffer.from(b64, 'base64'));
    }
  });
  const files = fs.readdirSync(dir).filter(f => /^t\d.*\.(jpg|png)$/.test(f)).sort();
  const cols = Math.min(6, files.length), rows = Math.ceil(files.length / cols), CW = frameWH()[0] / 4, CH = frameH() / 4;
  ff([...files.flatMap(f => ['-i', path.join(dir, f)]), '-filter_complex',
    files.map((f, i) => `[${i}]scale=${CW}:${CH}[v${i}]`).join(';') + ';' +
    (files.length === 1 ? '[v0]null' : files.map((f, i) => `[v${i}]`).join('') + `xstack=inputs=${files.length}:layout=${files.map((f, i) => `${(i % cols) * CW}_${Math.floor(i / cols) * CH}`).join('|')}:fill=black`),
    '-frames:v', '1', '-q:v', '3', path.join(dir, 'contact.jpg')]);
  log(`${files.length} stills + contact.jpg in ${dir} (row-major: ${files.map(f => f.slice(1, -4)).join(' ')})`);
}

// ---------------------------------------------------------------- capture
// One motion component (an app UI played, an illustration that acts) written as an HTML page -> a clip the spec plays as
// `media`. The page draws its whole state at t seconds in window.setT(t) (no CSS transitions, no timers, no rAF loops),
// so every frame is exact: one screenshot per 1/fps. --alpha keeps the transparency (png in mov, for an `overlay` scene
// over the camera), else near-lossless H.264 (an actor card). The engine fonts are loaded into the page by family name
// (Bricolage Grotesque, DM Sans, Inter, JetBrains Mono, Archivo, Instrument Serif). Writes the clip and
// stills/<name>-sheet.jpg (the frames at --at, else 8 even ones, over gray) to check it without a render.
async function capture() {
  if (!pos[0] || !(+flag('dur', 0) > 0)) throw new Error('usage: capture <project> <page.html> --dur <s> [--size 1080x1920] [--alpha] [--fps 30] [--out assets/<name>.mov|mp4] [--at t1,t2,...]');
  const html = path.resolve(PROJ, expand(pos[0])), name = path.basename(html, '.html'), dur = +flag('dur');
  const [w, h] = String(flag('size', '1080x1920')).split('x').map(Number), alpha = !!flag('alpha', false), fps = +flag('fps', FPS);
  const o = flag('out', true), out = path.resolve(PROJ, expand(o === true ? `assets/${name}.${alpha ? 'mov' : 'mp4'}` : o));
  const n = Math.max(1, Math.round(dur * fps)), tmp = fs.mkdtempSync(path.join(os.tmpdir(), `capture-${name}-`));
  const faces = fs.readFileSync(path.join(ENGINE, 'short.html'), 'utf8').match(/@font-face[^}]*\}/g).join('\n')
    .replace(/url\('fonts\//g, `url('${pathToFileURL(path.join(ENGINE, 'fonts')).href}/`);
  const { chromium } = await import('playwright-core');
  const bs = await chromium.launchServer({ executablePath: CHROME, headless: true, args: ['--disable-extensions', '--mute-audio', '--allow-file-access-from-files'] });
  const browser = await chromium.connect(bs.wsEndpoint());   // killed at the end, not closed (see openPage)
  try {
    const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: 1 });
    page.on('pageerror', e => console.log('  pageerror:', e.message));
    page.on('console', m => { if (m.type() === 'error') console.log('  page:', m.text()); });
    page.on('requestfailed', r => console.log('  missing:', r.url()));
    await page.goto(pathToFileURL(html).href);
    await page.addStyleTag({ content: faces });
    await page.evaluate(() => Promise.all([...document.fonts].map(f => f.load().catch(() => {})))
      .then(() => Promise.all([...document.images].map(i => i.decode().catch(() => {})))));
    if (!(await page.evaluate(() => typeof window.setT === 'function'))) throw new Error(`${html}: no window.setT(t)`);
    for (let i = 0; i < n; i++) {
      await page.evaluate(t => window.setT(t), i / fps);
      fs.writeFileSync(path.join(tmp, `${pad5(i)}.png`), await page.screenshot({ omitBackground: alpha, type: 'png' }));
    }
  } finally { await bs.kill(); }
  fs.mkdirSync(path.dirname(out), { recursive: true });
  ff(['-framerate', String(fps), '-i', path.join(tmp, '%05d.png'), ...(alpha ? ['-c:v', 'png', '-pix_fmt', 'rgba']
    : ['-c:v', 'libx264', '-crf', '10', '-preset', 'medium', '-pix_fmt', 'yuv420p', ...BT709]), out]);
  const at = flag('at', null), ts = at && at !== true ? String(at).split(',').map(Number) : Array.from({ length: 8 }, (_, i) => i * dur / 7);
  const ids = ts.map(t => Math.min(n - 1, Math.max(0, Math.round(t * fps)))), cols = Math.min(4, ids.length), CW = Math.round(w / 4), CH = Math.round(h / 4);
  fs.mkdirSync(P('stills'), { recursive: true });
  ff([...ids.flatMap(i => ['-i', path.join(tmp, `${pad5(i)}.png`)]), '-filter_complex',
    ids.map((x, i) => `color=c=0x808080:s=${CW}x${CH}[g${i}];[${i}]scale=${CW}:${CH}[s${i}];[g${i}][s${i}]overlay=shortest=1[v${i}]`).join(';') + ';' +
    (ids.length === 1 ? '[v0]null' : ids.map((x, i) => `[v${i}]`).join('') + `xstack=inputs=${ids.length}:layout=${ids.map((x, i) => `${(i % cols) * CW}_${Math.floor(i / cols) * CH}`).join('|')}:fill=gray`),
    '-frames:v', '1', '-q:v', '3', P('stills', `${name}-sheet.jpg`)]);
  for (const f of fs.readdirSync(tmp)) fs.unlinkSync(path.join(tmp, f)); fs.rmdirSync(tmp);
  log(`capture ${name}: ${n} frames ${w}x${h}${alpha ? ' alpha' : ''} -> ${out.startsWith(PROJ) ? path.relative(PROJ, out) : out} (${(n / fps).toFixed(2)} s) + stills/${name}-sheet.jpg (t ${ts.map(t => t.toFixed(2)).join(' ')})`);
}

// decode check of an Annex B piece (software decode, about 1 s per 30 s of 1080x1920): resolves, or rejects with the error
const decodes = (buf, a, b) => new Promise((res, rej) => {
  const p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-f', 'h264', '-i', '-', '-f', 'null', '-'], { stdio: ['pipe', 'ignore', 'pipe'] }); let e = '';
  p.stderr.on('data', d => { e += d; }); p.stdin.on('error', () => {}); p.once('error', rej);
  p.once('close', c => c ? rej(new Error(`frames ${a}-${b} do not decode: ${e.slice(-300)}`)) : res());
  p.stdin.end(buf);
});

// Render cache keys. global: the engine code, style, timeline, prepared frames, the output settings and every spec field
// that is not windowed. Per chunk: the windowed timed items that can draw in it (scenes, actors, broll: from - pre - 2
// to to + 2) and the layout/zoom keys that move it (the last key 6 s before the chunk onward: the spring has settled by then),
// plus the size and mtime of every image or video file those items name.
const CH = 300;
function renderChunks(tl, n0, n1, fps, W, H, rate, scale) {
  const raw = loadSpec(), spec = mapSpec(raw, mapper(tl)), fstat = f => { try { const s = fs.statSync(f); return `${s.size}:${s.mtimeMs}`; } catch { return '-'; } };
  const eng = ['short.html', ...fs.readdirSync(path.join(ENGINE, 'lib')).filter(f => f.endsWith('.js')).map(f => 'lib/' + f)].map(f => fs.readFileSync(path.join(ENGINE, f)));
  const items = ['scenes', 'actors', 'broll'].flatMap(k => (spec[k] || []).map(o => ({ k, o, a: typeof o.from === 'number' ? o.from - (o.pre || 0) - 2 : -1e9, b: typeof o.from === 'number' ? (o.to ?? 1e9) + 2 : 1e9 })));
  const keyed = [['layout', spec.layout?.keys], ['zoom', spec.zoom?.keys]].filter(([, k]) => k?.length);
  const rest = { ...spec, scenes: 0, actors: 0, broll: 0, layout: { ...spec.layout, keys: 0 }, zoom: { ...spec.zoom, keys: 0 } };
  const files = o => { const out = []; JSON.stringify(o, (k, v) => (typeof v === 'string' && /\.(png|jpe?g|webp|gif|svg|mp4|mov)$/i.test(v) && out.push(v + '=' + fstat(projFile(expand(v)))), v)); return out; };
  // assets/source.mp4 too: a recomposed source (new crops, same frame count) rewrites the camera frames, not frames.json
  const st = loadStyle(), glob = md5(Buffer.concat([...eng, Buffer.from(JSON.stringify([st, st?.font?.src && fstat(expand(st.font.src)), rest, files(rest), W, H, fps, rate, scale, CH, fstat(P('assets/source.mp4'))]))]
    .concat(['assets/timeline.json', 'assets/frames.json'].filter(f => fs.existsSync(P(f))).map(f => fs.readFileSync(P(f))))));
  const dir = P('.cache/render', `${W}x${H}@${fps}`); fs.mkdirSync(dir, { recursive: true });
  const out = [];
  for (let c = Math.floor(n0 / CH); c * CH < n1; c++) {
    const a = Math.max(n0, c * CH), b = Math.min(n1, (c + 1) * CH), t0 = a / fps, t1 = b / fps;
    const its = items.filter(i => i.b >= t0 && i.a <= t1).map(i => [i.k, i.o, files(i.o)]);
    const ks = keyed.map(([n, k]) => { const j = Math.max(0, k.findLastIndex(e => e[0] <= t0 - 6)); return [n, k.slice(j).filter(e => e[0] < t1 + 1 / fps)]; });
    out.push({ id: c, a, b, f: path.join(dir, `${md5(glob + JSON.stringify([a, b, its, ks]))}.h264`) });
  }
  return out;
}

// The mp4 mux, started before the encode: chunks go into ffmpeg's stdin in order as soon as each one is there (cached,
// or just encoded), so most of the parsing overlaps the encode and no joined .h264 is written. Every chunk starts on an
// IDR with its own SPS/PPS, so the Annex B streams concatenate as is. Chrome's SPS timing confuses the raw parser:
// rebuild timestamps from the frame index (setts), tag bt709 limited range, in the SPS and in the MP4 colr box (left
// alone, the box keeps WebCodecs' sRGB transfer and players trust the box). Written to <out>.part, renamed when done,
// so a failed render leaves the previous video in place.
function muxer(chunks, out, fps) {
  const part = out + '.part', p = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'h264', '-i', '-', '-c:v', 'copy', '-bsf:v',
    `h264_metadata=video_full_range_flag=0:colour_primaries=1:transfer_characteristics=1:matrix_coefficients=1,setts=ts=N/(${fps}*TB):duration=1/(${fps}*TB)`,
    ...BT709, '-video_track_timescale', String(fps * 1000), '-movflags', '+faststart', '-f', 'mp4', part], { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res, rej) => p.on('close', c => c ? rej(new Error('ffmpeg mux exit ' + c)) : res())); done.catch(() => {});
  p.stdin.on('error', () => {});   // a dead ffmpeg surfaces through `done`
  const write = b => new Promise(r => p.stdin.write(b, () => r()));
  let i = 0, chain = Promise.resolve();
  const feed = () => (chain = chain.then(async () => { for (; i < chunks.length && chunks[i].ready; i++) await write(chunks[i].buf || fs.readFileSync(chunks[i].f)); }));
  return {
    feed,
    async end() { await feed(); if (i < chunks.length) throw new Error('mux: chunk missing'); p.stdin.end(); await done; fs.renameSync(part, out); },
    abort() { p.kill(); try { fs.unlinkSync(part); } catch {} },
  };
}

async function render() {
  await ensureMatte();
  const tl = readJSON(P('assets/timeline.json'));
  const scale = +flag('scale', 1), fps = +flag('fps', FPS), draft = scale < 1;
  const t0 = +flag('from', 0), t1 = Math.min(tl.duration, +flag('to', tl.duration));
  const n0 = Math.round(t0 * fps), n1 = Math.round(t1 * fps), N = n1 - n0;
  fs.mkdirSync(P('output'), { recursive: true });
  const out = flag('out') ? path.resolve(PROJ, flag('out')) : P('output', draft ? 'draft-video.mp4' : 'video.mp4');   // --out <path>: e.g. a test clip
  const W = Math.round(frameWH()[0] * scale / 2) * 2, H = Math.round(frameH() * scale / 2) * 2;
  const rate = draft ? 4e6 : W * H > 1.5e6 ? 32e6 : 18e6;
  // workers: parallel Chrome renderers sharing 2 s work units (default 2; the hardware encoder is the limit: 3 workers or a
  // deeper encode queue are 5-10 % slower, benchmark 2026-10-21 on an M4 Max; --workers n)
  const K = Math.max(1, Math.min(+flag('workers', 2), Math.floor(N / 30) || 1));
  const start = Date.now(), jpeg = () => renderJPEG({ scale, fps, n0, N, out, W, H, draft, start });
  if (flag('jpeg')) return jpeg();
  // chunk cache: 10 s chunks on absolute frame numbers, each keyed by what can change its pixels. A spec fix
  // re-encodes only the chunks it touches; the rest are reused byte for byte (each chunk opens on an IDR). --fresh skips it.
  const chunks = renderChunks(tl, n0, n1, fps, W, H, rate, scale), fresh = !!flag('fresh');
  for (const c of chunks) c.hit = c.ready = !fresh && fs.existsSync(c.f);
  let mux = null;
  const todo = chunks.filter(c => !c.hit), N2 = todo.reduce((x, c) => x + c.b - c.a, 0);
  log(`render ${N} frames ${W}x${H}@${fps}: ${chunks.length - todo.length}/${chunks.length} chunks cached, ${N2} frames to encode, ${Math.min(K, todo.reduce((x, c) => x + Math.ceil((c.b - c.a) / (2 * fps)), 0))} workers -> ${out}`);
  let fallback = null;
  if (todo.length) {
    // work units: 2 s pieces of the chunks to encode, each opening on a keyframe (the same keyframes as one encoder per
    // chunk). Each worker starts on its own contiguous run, an equal share of the frames (its image cache stays warm); a
    // worker that runs out takes the back half of the longest run left, so the workers finish together instead of one
    // waiting on the other's last 10 s chunk. A chunk lands in the cache (.part, then rename) once all its units are in.
    const G = 2 * fps, units = [];
    for (const c of todo) { c.parts = []; for (let a = c.a; a < c.b; a += G) { const u = { c, a, b: Math.min(c.b, a + G), bufs: [] }; c.parts.push(u); units.push(u); } c.left = c.parts.length; }
    const nw = Math.min(K, units.length), runs = Array.from({ length: nw }, () => []);
    { let acc = 0; for (const u of units) { runs[Math.min(nw - 1, Math.floor((acc + (u.b - u.a) / 2) * nw / N2))].push(u); acc += u.b - u.a; } }
    let steals = 0;
    const next = run => {
      if (!run.length) { const v = runs.reduce((m, r) => r.length > m.length ? r : m); if (v.length) { steals++; run.push(...v.splice(v.length >> 1)); } }
      return run.shift();
    };
    const sinks = {}, perf = {}, writes = []; let lastPct = -1, base = 0, uid = 0, bad = null;
    const tick = () => {
      const d = base + Object.values(sinks).reduce((x, s) => x + s.done, 0), pct = Math.floor(d / N2 * 20) * 5;
      if (pct !== lastPct) { lastPct = pct; const el = (Date.now() - start) / 1000; log(`${pct}% (${d}/${N2}) ${(d / el).toFixed(1)} fps, eta ${Math.round((N2 - d) / (d / el || 1))}s`); }
    };
    const finish = u => {   // every frame of unit u is in
      const done = sinks[u.id].done; delete sinks[u.id]; base += u.b - u.a;
      if (done !== u.b - u.a) bad ||= new Error(`frames ${u.a}-${u.b}: the encoder returned ${done} of ${u.b - u.a} frames`);
      // decode check: the unit opens on an IDR with its SPS/PPS, so it decodes on its own, while the hardware encoder
      // works on the next units (the CPU is mostly idle then). `final` no longer decodes the whole video after the render.
      u.ok = decodes(Buffer.concat(u.bufs), u.a, u.b); u.ok.catch(() => {});
      const c = u.c; if (--c.left) return;
      c.buf = Buffer.concat(c.parts.flatMap(p => p.bufs)); c.ready = true;
      // into the cache once every unit of it decoded
      const w = Promise.all(c.parts.map(p => p.ok)).then(() => fs.promises.writeFile(c.f + '.part', c.buf)).then(() => fs.promises.rename(c.f + '.part', c.f)).then(() => { c.buf = null; });
      w.catch(() => {}); writes.push(w); c.parts = null;
      mux?.feed();
    };
    const s2 = await serve(sinks);
    try {
      const b0 = Date.now(), pages = await Promise.all(Array.from({ length: nw }, () => openPage(s2, scale)));
      perf.boot = Date.now() - b0;
      try {
        fallback = !(await pages[0].page.evaluate(async ([width, height, bitrate]) => window.HAS_WEBCODECS && (await VideoEncoder.isConfigSupported({ codec: 'avc1.640034', width, height, bitrate, framerate: 30, avc: { format: 'annexb' } }).catch(() => ({}))).supported, [W, H, rate]));
        if (!fallback) {
          mux = muxer(chunks, out, fps);
          await Promise.all(pages.map(async ({ page }, w) => {
            await page.evaluate(([fps, rate]) => window.encodeStart(fps, rate), [fps, rate]);
            for (let u; (u = next(runs[w]));) {
              u.id = String(++uid); sinks[u.id] = { data: b => u.bufs.push(b), end: () => finish(u), done: 0, tick };
              await page.evaluate(([a, b, sink]) => window.encodeUnit(a, b, sink), [u.a, u.b, `/sink/${u.id}`]);
            }
            const r = await page.evaluate(() => window.encodeEnd());
            for (const [k, v] of Object.entries(r || {})) perf[k] = (perf[k] || 0) + v;
          }));
          if (bad) throw bad;
          await Promise.all(units.map(u => u.ok));   // every unit decoded
          await Promise.all(writes);
        }
      } finally { await Promise.all(pages.map(p => p.close().catch(() => {}))); }
    } catch (e) { mux?.abort(); throw e; } finally { s2.close(); }
    if (fallback) { log('no H.264 WebCodecs in this browser: JPEG fallback'); return jpeg(); }
    // benchmark: where each frame's time goes, summed over the workers (ms per frame), and the wall clock of the encode
    if (perf.frames) { const per = k => (perf[k] / perf.frames).toFixed(1), wall = (Date.now() - start) / 1000;
      log(`bench: boot ${(perf.boot / 1000).toFixed(1)}s, ${N2} frames in ${wall.toFixed(1)}s = ${(N2 / wall).toFixed(0)} fps (${(N2 / fps / wall).toFixed(1)}x realtime), per frame: images ${per('load')} ms, draw ${(+per('render') - +per('load')).toFixed(1)} ms, encode ${(+per('submit') + +per('encWait')).toFixed(1)} ms, ${steals} steals`);
      if (flag('bench')) fs.writeFileSync(flag('bench'), JSON.stringify({ frames: N2, wall, workers: nw, steals, ...perf }, null, 2)); }
  }
  mux ||= muxer(chunks, out, fps);
  const now = new Date();
  for (const c of chunks) if (c.hit) fs.utimesSync(c.f, now, now);   // cache recency, for the prune below
  await mux.end();
  // every frame of this file decoded (now, or when its cached chunk was made): `final` skips its own decode of it
  { const f = P('.cache/render/qc.json'), qc = fs.existsSync(f) ? readJSON(f) : {}, st = fs.statSync(out); qc[out] = `${st.size}:${st.mtimeMs}`; fs.writeFileSync(f, JSON.stringify(qc, null, 2)); }
  // a full-length render prunes the chunks it did not use (same size and fps), so the cache stays about one video big
  if (n0 === 0 && n1 === Math.round(tl.duration * fps)) {
    const keep = new Set(chunks.map(c => path.basename(c.f))), dir = path.dirname(chunks[0].f);
    for (const f of fs.readdirSync(dir)) if (!keep.has(f)) fs.unlinkSync(path.join(dir, f));
  }
  log(`video done in ${((Date.now() - start) / 1000).toFixed(1)}s`);
}

// Fallback (--jpeg, or no H.264 WebCodecs): one page, canvas JPEG over CDP, piped to ffmpeg (Apple hardware encoder, else x264).
async function renderJPEG({ scale, fps, n0, N, out, W, H, draft, start }) {
  const enc = spawn(FFMPEG, ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-',
    '-vf', `scale=${W}:${H}:in_range=full:out_range=tv,format=yuv420p`, ...h264(draft ? '4M' : W * H > 1.5e6 ? '32M' : '18M', draft ? '6M' : W * H > 1.5e6 ? '44M' : '26M'),
    '-profile:v', 'high', '-color_range', 'tv', '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-r', String(fps), '-movflags', '+faststart', out],
    { stdio: ['pipe', 'inherit', 'inherit'] });
  const done = new Promise((res, rej) => enc.on('close', c => c ? rej(new Error('ffmpeg exit ' + c)) : res()));
  let lastPct = -1;
  log(`render ${N} frames ${W}x${H}@${fps} (JPEG path) -> ${out}`);
  await withPage(scale, async page => {
    for (let i = 0; i < N; i++) {
      const b64 = await page.evaluate(t => window.frameJPEG(t, .97), (n0 + i) / fps);
      if (!enc.stdin.write(Buffer.from(b64, 'base64'))) await new Promise(r => enc.stdin.once('drain', r));
      const pct = Math.floor((i + 1) / N * 20) * 5;
      if (pct !== lastPct) { lastPct = pct; const el = (Date.now() - start) / 1000, f = (i + 1) / el; log(`${pct}% (${i + 1}/${N}) ${f.toFixed(1)} fps, eta ${Math.round((N - i - 1) / f)}s`); }
    }
  });
  enc.stdin.end(); await done;
  log(`video done in ${((Date.now() - start) / 1000).toFixed(0)}s`);
}

// ---- init / words: project setup without any personal path. The creator profile is LOCAL, never global: $SHORT_EDITING_HOME,
// else the nearest .short-editing/ folder in the short's folder or a parent (the home folder excluded: ~/.short-editing is
// never a style), else none (engine default). It holds .env (ELEVEN_KEY) and the styles (from the studio-setup skill),
// each in its own folder <profile>/styles/<name>/, the default one included: <profile>/style.json then only names it,
// {"default": "<name>"} (a plain file, no link). An older profile keeps its default style right in <profile>/style.json.
const HOME = (start = PROJ || process.cwd()) => expand(process.env.SHORT_EDITING_HOME || (s => { for (let d = s; d !== path.dirname(d); d = path.dirname(d)) if (d !== os.homedir() && (fs.existsSync(path.join(d, '.short-editing')) || fs.existsSync(path.join(d, 'video-agent')))) return path.join(d, fs.existsSync(path.join(d, '.short-editing')) ? '.short-editing' : 'video-agent'); return path.join(s, '.short-editing'); })(path.resolve(start)));
const styleDir = (home, name) => { if (name) return path.join(home, 'styles', name); try { const d = readJSON(path.join(home, 'style.json')).default; if (typeof d === 'string') return path.join(home, 'styles', d); } catch {} return home; };
const KEYFILES = () => [path.join(HOME(), '.env'), path.join(process.cwd(), '.env'), path.join(os.homedir(), '.short-editing/.env')];   // keys only may be shared machine-wide
// newest take in the profile's A-roll folder (style.folders.aroll), for `init --source latest`
function latestTake(st) {
  const dir = st?.folders?.aroll && expand(st.folders.aroll);
  if (!dir || !fs.existsSync(dir)) throw new Error('--source latest needs folders.aroll in the creator profile (run studio-setup)');
  const vids = fs.readdirSync(dir).filter(f => /\.(mp4|mov|m4v)$/i.test(f) && !f.startsWith('.')).map(f => path.join(dir, f));
  if (!vids.length) throw new Error(`no video in the A-roll folder ${dir}`);
  return vids.sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
}
async function init() {
  if (fs.existsSync(P('source/spec.js'))) throw new Error(`${P('source/spec.js')} already exists, not overwriting`);
  for (const d of ['assets', 'files', 'source', 'output', 'stills']) fs.mkdirSync(P(d), { recursive: true });
  // --style <name>: a named style of the profile (<profile>/styles/<name>/), else the default one; the style's assets/
  // folder (e.g. a mascot pose pack) is copied into the project so the short stays self-contained
  const sname = flag('style'), sdir = styleDir(HOME(), sname && sname !== true ? sname : null);
  if (sdir !== HOME() && !fs.existsSync(path.join(sdir, 'style.json'))) throw new Error(`no style "${sname || path.basename(sdir)}": ${sdir}/style.json missing`);
  const prof = path.join(sdir, 'style.json'), st = fs.existsSync(prof) ? prof : path.join(ENGINE, 'templates/style.json');
  fs.copyFileSync(st, P('source/style.json'));
  if (sdir !== HOME() && fs.existsSync(path.join(sdir, 'assets'))) fs.cpSync(path.join(sdir, 'assets'), P('assets'), { recursive: true });
  const style = readJSON(P('source/style.json'));
  let src = flag('source'); if (src === true) src = null;
  if (src === 'latest') src = latestTake(style);
  if (src) fs.copyFileSync(expand(src), P('assets/source.mp4'), fs.constants.COPYFILE_FICLONE);   // APFS clone: instant, no extra disk
  // a Recorder take (its <take>.json sidecar names the script slug): origin.json links the video to the take, and through it to
  // the script, so the studio shows Script -> Take -> Video both ways. The copy above no longer knows where it came from.
  if (src) try { if (readJSON(expand(src).replace(/\.\w+$/, '.json')).slug) fs.writeFileSync(P('origin.json'), JSON.stringify({ takes: [path.basename(expand(src))] }, null, 2) + '\n'); } catch {}
  const take = fs.existsSync(P('assets/source.mp4'));   // copied now, or already downloaded there (Tella)
  // camera framing: the profile's (same take size) or detected on this take (Apple Vision, ~2 s), else the template's
  const yt = flag('format') === 'youtube';   // long-form 16:9: templates/youtube.js, the camera keeps the whole take (crop = full frame)
  let spec = fs.readFileSync(path.join(ENGINE, yt ? 'templates/youtube.js' : 'templates/spec.js'), 'utf8'), cam = null, how = 'template default, check a frame';
  const camera = await import('./camera.mjs'), sz = take && camera.size(P('assets/source.mp4'));   // rotation-aware (iPhone)
  if (yt && take) try { const f = camera.detectCamera(P('assets/source.mp4'));
    cam = { crop: [0, 0, sz.w, sz.h], eyes: [f.crop[0] + f.eyes[0], f.crop[1] + f.eyes[1]] }; how = f.faces ? 'full take, face detected' : 'full take, no face found'; } catch (e) { log(`camera detection skipped: ${e.message}`); }
  else if (style.camera?.crop && (!sz || (sz.w === style.camera.w && sz.h === style.camera.h))) { cam = style.camera; how = 'creator profile'; }
  else if (take) try { cam = camera.detectCamera(P('assets/source.mp4')); how = cam.faces ? 'face detected on this take' : 'no face found, centered'; } catch (e) { log(`camera detection skipped: ${e.message}`); }
  if (cam) spec = spec.replace(/cam: \{[^\n]*\},[^\n]*/, `cam: { crop: [${cam.crop.join(', ')}], eyes: [${cam.eyes.join(', ')}] },   // ${how}`);
  // a creator style with a fixed camera card (layout.seam): one seam for the whole short, written in the starter spec
  const seam = style.layout?.seam;
  if (!yt && Number.isFinite(seam)) spec = spec.replace(/ *\/\/ seam: [^\n]*\n *layout: \{[^\n]*\},[^\n]*/, `  // seam fixed by the creator style (layout.seam): the camera card never resizes. Only 1920 (paper alone) or 0 (full camera) when its notes allow it\n  layout: { keys: [[0, ${seam}]] },`);
  fs.writeFileSync(P('source/spec.js'), spec);
  log(`init ${PROJ}: style from ${st === prof ? prof : 'engine default (no profile, run studio-setup)'}${src ? `, take ${path.basename(src)} -> assets/source.mp4` : ''}, cam: ${how}`);
}

function elevenKey() {
  if (process.env.ELEVEN_KEY || process.env.ELEVENLABS_API_KEY) return process.env.ELEVEN_KEY || process.env.ELEVENLABS_API_KEY;
  for (const env of KEYFILES()) {
    const m = fs.existsSync(env) && fs.readFileSync(env, 'utf8').match(/^\s*(?:export\s+)?(?:ELEVEN_KEY|ELEVENLABS_API_KEY)\s*=\s*["']?([^"'\s#]+)/m);
    if (m) return m[1];
  }
  throw new Error(`no ElevenLabs key: set ELEVEN_KEY or put ELEVEN_KEY=... in ${KEYFILES()[0]}`);
}
async function words() {
  const lang = pos[0] || loadStyle()?.creator?.lang, wav = P('assets/source.wav');   // default: the creator's language
  if (!fs.existsSync(wav) || fs.statSync(wav).mtimeMs < fs.statSync(P('assets/source.mp4')).mtimeMs)
    ff(['-i', P('assets/source.mp4'), '-vn', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_s16le', wav]);
  let key; try { key = elevenKey(); } catch { return (await import('./whisper.mjs')).whisperWords(PROJ, lang, wav, log); }
  const t0 = Date.now();
  for (let k = 1; ; k++) {
    const fd = new FormData();
    fd.append('model_id', 'scribe_v1'); fd.append('timestamps_granularity', 'word'); fd.append('diarize', 'false');
    if (lang) fd.append('language_code', lang);
    fd.append('file', new Blob([fs.readFileSync(wav)], { type: 'audio/wav' }), 'source.wav');
    let r; try { r = await fetch('https://api.elevenlabs.io/v1/speech-to-text', { method: 'POST', headers: { 'xi-api-key': key }, body: fd, signal: AbortSignal.timeout(300000) }); }
    catch (e) { if (k >= 3) throw e; log(`network error (${e.message}), retry ${k}/3`); await new Promise(z => setTimeout(z, 5000 * k)); continue; }
    if (r.status === 401 || r.status === 403) throw new Error(`ElevenLabs auth failed (HTTP ${r.status}): check the key`);
    if (!r.ok) { if (k >= 3 || ![429, 500, 502, 503, 504].includes(r.status)) throw new Error(`ElevenLabs HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`); log(`HTTP ${r.status}, retry ${k}/3`); await new Promise(z => setTimeout(z, 5000 * k)); continue; }
    const res = await r.json(), n = (res.words || []).filter(w => w.type === 'word').length;
    if (!n) throw new Error('transcription returned 0 words (silent audio? wrong language?)');
    fs.writeFileSync(P('assets/words-scribe.json'), JSON.stringify(res, null, 2));
    return log(`words: ${n} words, lang ${res.language_code} (${((Date.now() - t0) / 1000).toFixed(1)}s) -> assets/words-scribe.json`);
  }
}

async function audio() { await import('./audio.mjs').then(m => m.buildAudio(PROJ, loadSpec())); }

// Apple AAC when ffmpeg has it: the native encoder at 192k can burst +8 dB on one frame (true peak +6.5 dBTP from a -2.2 dBFS mix)
const AAC = () => hasEncoder('aac_at') ? ['-c:a', 'aac_at', '-b:a', '192k'] : ['-c:a', 'aac', '-b:a', '256k'];

// async ffmpeg: resolves with its stderr (ebur128 writes a line per 100 ms of audio), rejects on a non-zero exit
const ffRun = args => new Promise((res, rej) => {
  const p = spawn(FFMPEG, ['-hide_banner', ...args], { stdio: ['ignore', 'ignore', 'pipe'] }); let e = '';
  p.stderr.on('data', d => { e += d; }); p.once('error', rej);
  p.once('close', c => c ? rej(new Error(e.slice(-400))) : res(e));
});

async function final() {
  const tl = readJSON(P('assets/timeline.json'));
  const slug = path.basename(PROJ), vid = fs.existsSync(P('output/video.mp4')) ? P('output/video.mp4') : P('output/draft-video.mp4');
  const out = P('output', `${slug}${vid.includes('draft') ? '-draft' : ''}.mp4`);
  // the video stream is copied as is: the decode check (a full software decode, ~1 s for 30 s of 1080x1920, VideoToolbox
  // is 3x slower here) and the poster read the render itself while the audio is encoded and muxed
  const st = fs.statSync(vid), qf = P('.cache/render/qc.json'), inRender = fs.existsSync(qf) && readJSON(qf)[vid] === `${st.size}:${st.mtimeMs}`;
  const check = inRender ? Promise.resolve(null) : ffRun(['-nostats', '-i', vid, '-map', '0:v', '-f', 'null', '-']).then(() => null, e => e);
  const poster = ffRun(['-loglevel', 'error', '-y', '-ss', String(flag('poster', 1.2)), '-i', vid, '-frames:v', '1', '-q:v', '2', P('output', `${slug}-poster.jpg`)]).then(() => null, e => e);
  // written next to it then renamed: the open studio reloads on a new render and must never catch a half-written file
  const part = path.join(path.dirname(out), `.${path.basename(out)}.part`);
  await ffRun(['-loglevel', 'error', '-y', '-i', vid, '-i', P('assets/mix.wav'), '-map', '0:v', '-map', '1:a', '-c:v', 'copy', ...BT709, ...AAC(), '-ar', '48000',
    '-t', tl.duration.toFixed(3), '-movflags', '+faststart', '-f', 'mp4', part]);
  fs.renameSync(part, out);
  // loudness on the muxed AAC (it can add overs the mix did not have)
  const eb = await ffRun(['-nostats', '-i', out, '-map', '0:a', '-af', 'ebur128=peak=true', '-f', 'null', '-']);
  const v = probe(out, 'stream=codec_name,width,height,r_frame_rate').split('\n').slice(0, 4), d = +probe(out);
  const ce = await check; if (ce) throw new Error(`QC decode failed: ${ce.message}`);
  const pe = await poster; if (pe) throw new Error(`poster failed: ${pe.message}`);
  const I = eb.match(/I:\s+(-?[\d.]+) LUFS/g)?.pop()?.match(/-?[\d.]+/)[0], tp = eb.match(/Peak:\s+(-?[\d.]+) dBFS/g)?.pop()?.match(/-?[\d.]+/)[0];
  log(`QC: ${v.join(' ')} | ${d.toFixed(2)}s (timeline ${tl.duration.toFixed(2)}s) | ${I} LUFS, true peak ${tp} dBTP | decode ok${inRender ? ' (checked in render)' : ''}`);
  log(`final: ${out}`);
}

const run = { init, words, prepare, rough, stills, capture, render, audio, final, preview, all: async () => {
  // the mix does not need the render: it runs beside it, in its own process (its DSP would stall this event loop, which
  // streams the encoded units out of Chrome)
  const a = new Promise((res, rej) => { const p = spawn(process.execPath, [fileURLToPath(import.meta.url), 'audio', ...process.argv.slice(3)], { stdio: 'inherit' });
    p.once('error', rej); p.once('close', c => c ? rej(new Error('audio exit ' + c)) : res()); });
  a.catch(() => {}); await render(); await a; await final();
} }[cmd];
if (!run) { console.error('unknown command', cmd); process.exit(1); }
await run();
