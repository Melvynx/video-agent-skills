// Browser runtime for spec.format 'youtube': a 1920x1080 long-form frame, deterministic in t (SHORT time).
// The paper stage is a 1080x1080 square (kit W = H = 1080, the same coordinates as format 'square', so every scene
// and actor works unchanged) on the LEFT; the camera fills the rest of the frame on the RIGHT.
// layout.keys [[t, x]]: x = left edge of the camera. 1080 = split (paper left, camera right), 1920 = paper only (the
// stage glides to the centre, for full-screen sources), 0 = camera only (the paper slides out to the left).
// layout.side 'left' mirrors it: camera on the LEFT, paper on the right; x keeps its meaning (the paper width), so
// 1280 = camera 1/3 left + paper 2/3 right, and the stage is centred in the paper.
// Draw order: page paper -> stage (clipped left of the deckle edge) -> camera -> edge shadow -> 'over' scenes (output px, 1920x1080, unmoved by the layout) ->
// full-screen B-roll -> 'top' scenes (output px, above the B-roll) -> captions (off unless captions.on).
import * as K from './kit.js';
import { installEncoder } from './encode.js';
import { mapper, mapSpec, captionChunks } from './timeline.js';
import { SCENES, drawActor, actorNeeds, linkScenes } from './scenes.js';
import { withStyle, themeOf, CAPTION_FONTS, mixHex } from './style.js';

const { C, W: SW, H: SH, S, clamp, lerp, track, noise1 } = K;
const pad5 = i => String(i).padStart(5, '0');

export async function boot() {
  const q = new URLSearchParams(location.search), scale = +q.get('scale') || 1, OW = +q.get('ow') || 1920, OH = +q.get('oh') || 1080;
  const [tl, frames, style] = await Promise.all(['/p/assets/timeline.json', '/p/assets/frames.json', '/style.json'].map(u => fetch(u).then(r => r.json())));
  K.setTheme(themeOf(style));
  if (style.font?.src) { const f = new FontFace(style.font.family, 'url(/style-font)', { weight: '100 900' }); document.fonts.add(await f.load()); }
  const spec = mapSpec(withStyle(window.SPEC, style), mapper(tl)), FPS = tl.fps;
  for (const w of ['400', '500', '600', '700', '800']) await document.fonts.load(`${w} 40px ${K.F.sans}`);
  await document.fonts.load('500 40px "JetBrains Mono"');
  K.setDisplay(spec.display);   // big-text look (style.display): its families must be loaded before the first frame
  if (K.D.font) await document.fonts.load(`${K.D.weight} 40px ${K.D.font}`);
  if (K.D.text) for (const w of ['600', '800']) await document.fonts.load(`${w} 40px ${K.D.text}`);

  const canvas = document.createElement('canvas'); canvas.width = Math.round(OW * scale); canvas.height = Math.round(OH * scale);
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d', { alpha: false });
  K.initSheet(ctx);
  const BG = K.makeBackground(Math.round(OW * scale), Math.round(OH * scale), scale);   // native res, drawn back at OWxOH

  // ---- image cache (LRU of decoded bitmaps)
  const bitmap = url => fetch(url).then(r => r.ok ? r.blob() : null).then(b => b ? createImageBitmap(b) : null).catch(() => null);
  const cache = new Map();
  // prefetch depth (?ahead=n, default 8) and an LRU that grows with it, so a prefetch never evicts the frame being drawn
  const AHEAD = +new URLSearchParams(location.search).get('ahead') || 8;
  const PERF = { load: 0, render: 0, submit: 0, encWait: 0, flush: 0, total: 0, frames: 0 };   // see runtime.js
  let imgCap = 48;
  const load = url => {
    let p = cache.get(url);
    if (p) { cache.delete(url); cache.set(url, p); return p; }
    p = bitmap(url); cache.set(url, p);
    while (cache.size > imgCap) { const [k, v] = cache.entries().next().value; cache.delete(k); v.then(b => b && b.close?.()); }
    return p;
  };
  const camURL = t => `/p/frames/cam/${pad5(clamp(Math.round(t * FPS), 0, frames.cam - 1))}.jpg`;
  // a media with sync: true was extracted on the cut timeline (short.mjs), its frame index is SHORT time like the cam
  const brollT = (b, t) => frames.media[b.media]?.sync ? t : Math.max(0, (b.offset || 0) + t - b.from);
  // m.alias: a frame identical to an earlier one loads that one (one fetch + decode, then the image cache hits)
  const mediaURL = (id, ct) => { const m = frames.media[id]; if (!m) return null; const i = clamp(Math.round(ct * FPS), 0, m.count - 1); return `/p/frames/media/${id}/${pad5(m.alias?.[i] ?? i)}.${m.ext || 'jpg'}`; };
  const logoUsers = [...(spec.actors || []), ...(spec.scenes || [])].map(o => {
    const urls = new Set(), walk = v => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) k === 'imgs' && Array.isArray(x) ? x.forEach(u => typeof u === 'string' && urls.add('/p/' + u)) : k === 'imgKeys' && Array.isArray(x) ? x.forEach(e => typeof e?.[1] === 'string' && urls.add('/p/' + e[1])) : (k === 'logo' || k === 'labelLogo' || k === 'img' || k === 'avatarImg') && typeof x === 'string' && /\.(png|jpe?g|webp)$/i.test(x) ? urls.add('/p/' + x) : walk(x); };
    walk(o); return { from: o.from - (o.pre || 0), to: o.to, urls: [...urls] };
  }).filter(o => o.urls.length);
  const U = { cam: camURL, cut: camURL };
  const actors = spec.actors || [], scenes = linkScenes((spec.scenes || []).map(s => ({ layer: 'stage', ...s })));
  const brolls = spec.broll || [], brollOn = (b, t) => t >= b.from - .05 && t <= b.to + .2;
  const needs = t => {
    const out = frames.cam ? [camURL(t)] : [];
    for (const a of actors) for (const [id, ct] of actorNeeds(a, t)) out.push(mediaURL(id, ct));
    for (const b of brolls) if (brollOn(b, t)) out.push(mediaURL(b.media, brollT(b, t)));
    for (const o of logoUsers) if (t >= o.from - 1.5 && t <= (o.to ?? 1e9) + 1) for (const u of o.urls) out.push(u);
    for (const s of scenes) for (const n of SCENES[s.type]?.needs?.(s, t, U) || []) out.push(typeof n === 'string' ? n : mediaURL(n[0], n[1]));
    return out.filter(Boolean);
  };

  // ---- layout: one vertical edge, sprung between keys (layout.w = stiffness, softer than shorts: the moves are longer)
  const seamKeys = spec.layout?.keys || [[0, SW]], LW = spec.layout?.w ?? 9;
  const seamAt = t => clamp(track(t, seamKeys, LW), 0, OW), LEFT = spec.layout?.side === 'left';
  const edgeAt = x => LEFT ? OW - x : x;   // where the deckle edge sits on screen
  // stage offset: centred in the paper, pushed out (its inner edge on the seam) toward full camera
  const stageX = x => LEFT ? OW - x + Math.max(0, x - SW) / 2 : x >= SW ? (x - SW) / 2 : x - SW;
  const EDGE = Array.from({ length: Math.ceil(OH / 6) + 2 }, (_, i) => (noise1(i * .16) - .5) * 3.2 + (noise1(i * .9 + 40) - .5) * 1.1);
  const edgePath = (x, right) => {
    const p = new Path2D(); p.moveTo(right ? OW : 0, 0);
    for (let i = 0; i < EDGE.length; i++) p.lineTo(x + EDGE[i], Math.min(OH, i * 6));
    p.lineTo(right ? OW : 0, OH); p.closePath(); return p;
  };
  const edgeLine = x => { const p = new Path2D(); for (let i = 0; i < EDGE.length; i++) p[i ? 'lineTo' : 'moveTo'](x + EDGE[i], Math.min(OH, i * 6)); return p; };

  // ---- camera. cam.crop is the full take (16:9) so the same frames serve the panel and full camera.
  // zoom.keys [[t, z]] punch in (springs); zoom.jumps (default on) alternates 1 / zoom.punch at every real jump cut
  // (a removed gap >= zoom.gap s, at most one switch per zoom.hold s), as a hard cut, so jump cuts read as a new angle.
  const eyes = spec.cam?.eyes || [960, 400], [, , CW, CHh] = spec.cam?.crop || [0, 0, 1920, 1080];
  const zoomKeys = spec.zoom?.keys || [[0, 1]], Z = spec.zoom || {};
  // zoom.jumpKeys [[t], ...]: jump cuts already baked into the source (a Tella edit used as the take, youtube-editing mix)
  const jumps = []; if (Z.jumps !== false) {
    const hold = Z.hold ?? 4;
    if (Z.jumpKeys) {
      // mix: each keep is a motion range spliced back into the master, so a keep junction is not a visible cut.
      // The punch restarts at 1 on every range and a range never ends punched in (its exit seam must match the master).
      for (const [a, b, o] of tl.keeps) {
        const end = o + (b - a) / (tl.speed || 1), seq = [];
        let last = -1e9, on = false;
        for (const [k] of [...Z.jumpKeys].sort((x, y) => x[0] - y[0])) if (k > o && k < end && k - last >= hold) { on = !on; last = k; seq.push([k, on]); }
        if (on) seq.pop();
        jumps.push([o, false], ...seq);
      }
    } else {
      const cand = [];
      for (let i = 1; i < tl.keeps.length; i++) {
        const [a, , o] = tl.keeps[i], gap = a - tl.keeps[i - 1][1];
        if (gap >= (Z.gap ?? .6)) cand.push(o);
      }
      let last = -1e9, on = false;
      for (const o of cand.sort((x, y) => x - y)) if (o - last >= hold) { on = !on; last = o; jumps.push([o, on]); }
    }
  }
  const punch = t => { let on = false; for (const [o, v] of jumps) if (o <= t + 1e-4) on = v; else break; return on ? Z.punch ?? 1.1 : 1; };
  const camFit = (t, x) => {
    const rw = OW - x, full = 1 - clamp(x / SW), z = track(t, zoomKeys, 9) * punch(t) * lerp(spec.cam?.splitZoom ?? 1.12, 1, full);
    const s = Math.max(rw / CW, OH / CHh) * z, x1 = LEFT ? 0 : x;   // the camera panel spans x1 .. x1 + rw
    return { s, x0: clamp(x1 + rw / 2 - eyes[0] * s, x1 + rw - CW * s, x1), y0: clamp(OH * .36 - eyes[1] * s, OH - CHh * s, 0) };
  };
  const pz = tl.pause, pauseP = t => pz ? S(t - pz.t0, 18) * (1 - S(t - pz.t0 - pz.dur, 18)) : 0;
  function camera(img, t, x) {
    if (!img || x >= OW - 1) return;
    // full camera (x 0): no deckle clip, its +-3 px jitter would show a paper sliver on the frame edge (a mix seam)
    const { s, x0, y0 } = camFit(t, x), e = edgeAt(x), clip = x <= .5 ? null : edgePath(e, !LEFT);
    ctx.save(); if (clip) ctx.clip(clip); ctx.drawImage(img, x0, y0, CW * s, CHh * s);
    const g = pauseP(t);
    if (g > .002) { ctx.globalAlpha = g; ctx.filter = 'grayscale(1) contrast(.9) brightness(1.04)'; ctx.drawImage(img, x0, y0, CW * s, CHh * s); }
    ctx.restore();
    if (x > 2) {   // the paper casts a soft shadow onto the video, plus a crisp deckle edge
      ctx.save(); ctx.clip(clip);
      const dp = K.depth(), sh = 44 * (.5 + .5 * dp), gr = ctx.createLinearGradient(e, 0, LEFT ? e - sh : e + sh, 0);
      gr.addColorStop(0, `rgba(25,18,6,${Math.min(.6, .30 * dp).toFixed(3)})`); gr.addColorStop(1, 'rgba(25,18,6,0)');
      ctx.fillStyle = gr; ctx.fillRect(LEFT ? e - sh - 2 : e - 6, 0, sh + 8, OH); ctx.restore();
      ctx.save(); ctx.strokeStyle = 'rgba(60,45,20,.16)'; ctx.lineWidth = 1.5; ctx.stroke(edgeLine(e)); ctx.restore();
    }
  }

  // ---- captions: off by default (long-form keeps the frame clean, YouTube CC carries the words).
  // captions.on: true draws small paper-sticker chunks at the bottom of the camera (or of the frame on full paper,
  // and centred on the frame over a full-screen B-roll). captions.style 'rise' (the profile's) draws the word blocks of
  // the shorts instead: white words, the spoken word on an accent block that blurs in (captions.blur false = crisp).
  // captions.x (output px): the line's centre while the camera shares the frame (default: the camera's centre); a
  // 'rise' word sitting on bare paper turns ink (white would vanish there), white again over the camera or a B-roll.
  const cap = spec.captions || {}, BLOCK = CAPTION_FONTS[String(cap.style || '').toLowerCase()] && String(cap.style).toLowerCase() === 'rise';
  const chunks = cap.on ? captionChunks(tl.words, { maxWords: 5, maxChars: 30, ...cap, hide: cap.hide || [], bleep: spec.bleep }) : [];
  const allChunks = captionChunks(tl.words, { ...cap, hide: [], bleep: spec.bleep });
  const CF = BLOCK ? K.famCss(cap.font || CAPTION_FONTS.rise[0]) : K.F.sans;
  const CS = cap.size || 50, WT = cap.weight || (BLOCK ? CAPTION_FONTS.rise[1] : 800), LS = BLOCK ? -CS * .012 : -1, STROKE = Math.round(CS * .22);
  if (cap.on && BLOCK) await document.fonts.load(`${WT} 40px ${CF}`);
  const brollCover = t => brolls.reduce((m, b) => brollOn(b, t) ? Math.max(m, Math.min(1, S(t - b.from, 22) * 1.3) * (1 - S(t - b.to, 22))) : m, 0);
  const smooth = v => v * v * (3 - 2 * v);
  function blockCaption(c, t, cx, y, x, bc) {
    const crisp = cap.blur === false, base = K.midBase(y, CS), bh = CS * 1.22, top = y - bh / 2, PADX = CS * .18, GAP = CS * .05;
    const ww = w => K.measure(ctx, w.text, CS, WT, LS, CF), dev = ctx.getTransform().a;
    let wx = cx - c.words.reduce((a, w, i) => a + ww(w) + 2 * PADX + (i ? GAP : 0), 0) / 2;
    const p = crisp ? clamp((t - c.start + .04) / .05) : S(t - c.start + .08, 30), lineB = crisp ? 0 : (1 - p) * CS * .12;
    const ws = c.words.map((w, i) => {
      const bw = ww(w) + 2 * PADX, a = w.start - .04, b = i + 1 < c.words.length ? c.words[i + 1].start - .04 : Infinity;
      const o = { w, x: wx, bw, q: crisp ? clamp((t - a) / .05) : S(t - a, 28), f: crisp ? 1 - clamp((t - b) / .05) : 1 - smooth(clamp((t - b) / .12)) };
      wx += bw + GAP; return o;
    });
    ctx.save(); ctx.globalAlpha = Math.min(1, p * 1.4); if (lineB > .3) ctx.filter = `blur(${(lineB * dev).toFixed(2)}px)`;
    ctx.font = K.font(CS, WT, CF); ctx.letterSpacing = LS + 'px'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    const xs = clamp(x, 0, OW), camL = LEFT ? 0 : xs, camR = LEFT ? OW - xs : OW;
    for (const o of ws) {   // per word: ink on paper, white with a soft shadow over the camera (40 px crossfade at its edge)
      const wc = o.x + o.bw / 2, onCam = camR - camL < 2 ? 0 : clamp(Math.min(wc - camL + 40, camR + 40 - wc) / 40);
      const ink = (1 - onCam) * (1 - bc);
      ctx.shadowColor = `rgba(0,0,0,${(.45 * (1 - ink)).toFixed(3)})`; ctx.shadowBlur = CS * .13; ctx.shadowOffsetY = CS * .03;
      ctx.fillStyle = mixHex('#FFFFFF', C.ink, ink); ctx.fillText(o.w.text, o.x + PADX, base);
    }
    ctx.shadowColor = 'transparent'; ctx.filter = 'none';
    const ga = ctx.globalAlpha;
    for (const o of ws) {   // the spoken word's block: blurs in (scale 1.04 -> 1) and fades out in place
      if (o.q <= .002 || o.f <= .002) continue;
      const b = crisp ? 0 : Math.hypot((1 - o.q) * CS * .16, lineB), sc = crisp ? 1 : 1 + .04 * (1 - o.q), mx = o.x + o.bw / 2;
      ctx.save(); ctx.globalAlpha = ga * Math.min(1, o.q * 1.25) * o.f; if (b > .3) ctx.filter = `blur(${(b * dev).toFixed(2)}px)`;
      ctx.translate(mx, y); ctx.scale(sc, sc); ctx.translate(-mx, -y);
      ctx.beginPath(); ctx.roundRect(o.x, top, o.bw, bh, CS * .14); ctx.fillStyle = C.blue; ctx.fill(); ctx.clip();
      ctx.fillStyle = C.onBlue || '#FFFFFF'; ctx.fillText(o.w.text, o.x + PADX, base); ctx.restore();
    }
    ctx.restore();
  }
  function captions(t, x) {
    let c = null; for (const ch of chunks) if (ch.start - .02 <= t) c = ch; else break;
    if (!c || t > c.end + .25 && c.next - c.end > .55) return;
    const camC = x >= OW - 1 ? OW / 2 : LEFT ? (OW - Math.max(0, x)) / 2 : (Math.max(0, x) + OW) / 2, bc = brollCover(t);
    const cx = lerp(x >= OW - 1 ? OW / 2 : cap.x ?? camC, OW / 2, bc), cy = lerp(cap.y ?? OH - 120, cap.brollY ?? cap.y ?? OH - 120, bc);
    if (BLOCK) {   // captions.scaleKeys [[t, k]]: a chunk starting at or after t is drawn k times bigger and centred on the whole
      // frame, across a split (the cold open), capped to the frame width
      const lw = c.words.reduce((a, w) => a + K.measure(ctx, w.text, CS, WT, LS, CF) + CS * .41, 0);
      const sk = Math.min((cap.scaleKeys || []).reduce((v, k) => c.start >= k[0] ? k[1] : v, 1), (OW - 80) / Math.max(1, lw));
      if (Math.abs(sk - 1) < .01) return blockCaption(c, t, cx, cy, x, bc);
      const scx = lerp(OW / 2, cx, bc);
      ctx.save(); ctx.translate(scx, cy); ctx.scale(sk, sk); ctx.translate(-scx, -cy); blockCaption(c, t, scx, cy, x, bc); ctx.restore(); return;
    }
    const base = K.midBase(cy, CS);
    const sp = K.measure(ctx, ' ', CS, WT, LS), tw = c.words.reduce((a, w, i) => a + K.measure(ctx, w.text, CS, WT, LS) + (i ? sp : 0), 0);
    let wx = cx - tw / 2;
    const vis = c.words.map(w => { const p = S(t - w.start + .04, 30), x0 = wx; wx += K.measure(ctx, w.text, CS, WT, LS) + sp; return { w, p, x: x0 }; }).filter(v => v.p > .002);
    ctx.save(); ctx.font = K.font(CS, WT); ctx.letterSpacing = LS + 'px'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round'; ctx.lineWidth = STROKE; ctx.strokeStyle = C.sheet; K.drop(ctx, .28, 18, 5);
    for (const { w, p, x: wx0 } of vis) { ctx.globalAlpha = Math.min(1, p * 1.4); ctx.strokeText(w.text, wx0, base + (1 - p) * 12); }
    ctx.shadowColor = 'transparent';
    for (const { w, p, x: wx0 } of vis) { ctx.globalAlpha = Math.min(1, p * 1.4); ctx.fillStyle = w.emph ? C.blue : C.ink; ctx.fillText(w.text, wx0, base + (1 - p) * 12); }
    ctx.restore();
  }

  // ---- frame
  function fullBroll(t, imgs) {
    for (const b of brolls) {
      if (!brollOn(b, t)) continue;
      const img = imgs.get(mediaURL(b.media, brollT(b, t)));
      const pin = S(t - b.from, 22), pout = S(t - b.to, 22), a = Math.min(1, pin * 1.3) * (1 - pout);
      if (!img || a <= .002) continue;
      ctx.save(); ctx.globalAlpha = a;
      if (b.keys) {   // a screen demo: [[t, zoom, fx, fy]] = from t, glide (~.7 s) to that framing and hold it (no slow push)
        let [, z, fx, fy] = b.keys[0];
        for (const [kt, kz, kx, ky] of b.keys) { if (t < kt) break; const p = S(t - kt, 9); z = lerp(z, kz, p); fx = lerp(fx, kx, p); fy = lerp(fy, ky, p); }
        K.cover(ctx, img, 0, 0, OW, OH, 0, [fx, fy], z);
      } else {
        const k = 1 + .035 * (1 - pin) + (b.zoom ?? .05) * clamp((t - b.from) / Math.max(1, b.to - b.from));
        K.cover(ctx, img, OW / 2 - OW * k / 2, OH / 2 - OH * k / 2, OW * k, OH * k, 0, b.focus || [.5, .5]);
      }
      ctx.restore();
    }
  }
  async function render(t) {
    const urls = needs(t); imgCap = Math.max(imgCap, urls.length * (AHEAD + 2) + 16);
    const w0 = performance.now(), imgs = new Map(await Promise.all(urls.map(async u => [u, await load(u)])));
    PERF.load += performance.now() - w0;
    for (let k = 1; k <= AHEAD; k++) needs(t + k / FPS).forEach(load);   // prefetch AHEAD frames in parallel (see runtime.js)
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
    const x = seamAt(t), dx = stageX(x);
    const camT = () => camFit(t, x);
    const R = { ctx, t, spec, tl, cam: imgs.get(camURL(t)), frame: (id, ct) => imgs.get(mediaURL(id, ct)) || null, media: id => frames.media[id], img: u => imgs.get(u) || null, U, camT, pause: pz, pauseP: pauseP(t), allChunks, seam: SH, seamRef: SH };
    ctx.drawImage(BG, 0, 0, OW, OH);
    if (x > 4) {
      ctx.save(); ctx.clip(edgePath(edgeAt(x), LEFT)); ctx.translate(dx, 0);
      for (const a of actors) drawActor(R, a, t);
      for (const s of scenes) if (s.layer === 'stage' && t > s.from - 1 && t < (s.to ?? 1e9) + 1) SCENES[s.type]?.draw(R, s, t);
      ctx.restore();
    }
    camera(R.cam, t, x);
    ctx.save();   // 'over' scenes draw in output px (1920x1080), whatever the layout
    for (const s of scenes) if (s.layer === 'over' && t > s.from - 1 && t < (s.to ?? 1e9) + 1) SCENES[s.type]?.draw(R, s, t);
    ctx.restore();
    fullBroll(t, imgs);
    ctx.save();   // 'top' scenes: output px like 'over', but above the full-screen B-roll (a name label on interview footage)
    for (const s of scenes) if (s.layer === 'top' && t > s.from - 1 && t < (s.to ?? 1e9) + 1) SCENES[s.type]?.draw(R, s, t);
    ctx.restore();
    captions(t, x);
  }

  installEncoder(canvas, render, PERF);   // window.encodeStart / encodeUnit / encodeEnd (lib/encode.js)
  window.framePNG = async t => { await render(t); return canvas.toDataURL('image/png').split(',')[1]; };
  window.frameJPEG = async (t, q = .92) => { await render(t); return canvas.toDataURL('image/jpeg', q).split(',')[1]; };
  window.DUR = tl.duration;
  window.READY = true;
}
