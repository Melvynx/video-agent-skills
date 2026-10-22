// Browser runtime: render(t) draws one 1080xH frame (H = 1920, or 1080 for spec.format 'square'), deterministic in t (SHORT time).
// Draw order: paper BG -> stage (clipped above the deckle seam, slides with the paper) -> camera (below seam)
// -> seam shadow -> speaker cutout -> 'over' scenes -> captions.
import * as K from './kit.js';
import { installEncoder } from './encode.js';
import { mapper, mapSpec, captionChunks } from './timeline.js';
import { SCENES, drawActor, actorNeeds, linkScenes } from './scenes.js';
import { CAPTION_DRAW } from './scenes-meta.js';
import { withStyle, themeOf, captionStyleIndex, CAPTION_STYLES, CAPTION_FONTS, mixHex } from './style.js';

const { C, W, H, S, clamp, lerp, track, noise1 } = K;
const pad5 = i => String(i).padStart(5, '0');

const PERF_BOOT = {};
export async function boot() {
  const q = new URLSearchParams(location.search), scale = +q.get('scale') || 1;
  // /style.json: the project's source/style.json (creator colors, font, captions, pace, music), {} for legacy projects
  const [tl, frames, style] = await Promise.all(['/p/assets/timeline.json', '/p/assets/frames.json', '/style.json'].map(u => fetch(u).then(r => r.json())));
  K.setTheme(themeOf(style));
  if (style.font?.src) { const f = new FontFace(style.font.family, 'url(/style-font)', { weight: '100 900' }); document.fonts.add(await f.load()); }
  const spec = mapSpec(withStyle(window.SPEC, style), mapper(tl)), FPS = tl.fps;
  for (const w of ['400', '500', '600', '700', '800']) await document.fonts.load(`${w} 40px ${K.F.sans}`);
  await document.fonts.load('500 40px "JetBrains Mono"');
  K.setDisplay(spec.display);   // big-text look (style.display): its families must be loaded before the first frame
  if (K.D.font) await document.fonts.load(`${K.D.weight} 40px ${K.D.font}`);
  if (K.D.text) for (const w of ['600', '800']) await document.fonts.load(`${w} 40px ${K.D.text}`);
  // board text items with their own family ({k: 'text', font, weight})
  for (const it of new Set((spec.scenes || []).flatMap(s => s.items || []).filter(it => it.font).map(it => `${it.weight || 400} 40px ${K.famCss(it.font)}`))) await document.fonts.load(it);

  const canvas = document.createElement('canvas'); canvas.width = Math.round(W * scale); canvas.height = Math.round(H * scale);
  document.body.appendChild(canvas);
  const ctx = canvas.getContext('2d', { alpha: false });
  K.initSheet(ctx);
  const bg0 = performance.now(), BG = K.makeBackground(); PERF_BOOT.bg = performance.now() - bg0; PERF_BOOT.fonts = bg0;

  // render benchmark (ms, per worker, see lib/encode.js): load = waiting on frame images (fetch + decode)
  // frames prefetched ahead of the one drawn (?ahead=n, default 8): fetch + JPEG decode run in parallel instead of one
  // frame at a time. Benchmark 2026-10-21, 5 shorts, M4 Max: images waited 11.6 ms per frame with 1 ahead, 3.7 with 8
  const AHEAD = +new URLSearchParams(location.search).get('ahead') || 8;
  const PERF = { load: 0, render: 0, submit: 0, encWait: 0, flush: 0, total: 0, frames: 0 };
  // ---- image cache (LRU of decoded bitmaps)
  const bitmap = url => fetch(url).then(r => r.ok ? r.blob() : null).then(b => b ? createImageBitmap(b) : null).catch(() => null);
  // a cutout frame is virtual: the cam JPG masked by frames/matte (gray+alpha PNG from matte.swift)
  const CUT = '/p/frames/cutout/', cutCv = new OffscreenCanvas(1, 1), cutCtx = cutCv.getContext('2d');
  const cutBitmap = async url => {
    const n = url.slice(CUT.length, -4), [c, m] = await Promise.all([bitmap(`/p/frames/cam/${n}.jpg`), bitmap(`/p/frames/matte/${n}.png`)]);
    if (!c || !m) { c?.close(); m?.close(); return null; }
    cutCv.width = c.width; cutCv.height = c.height;
    cutCtx.globalCompositeOperation = 'copy'; cutCtx.drawImage(m, 0, 0, c.width, c.height);
    // spec.cam.keep [[x, y, w, h, r]] (cam-crop px, r a number or [tl, tr, br, bl]): props in front of him that the
    // person matte drops (a mic and its arm) are always kept, instead of leaving a paper-coloured hole in his chest
    const keep = spec.cam?.keep;
    if (keep?.length) {
      cutCtx.globalCompositeOperation = 'source-over'; cutCtx.fillStyle = '#fff'; cutCtx.filter = 'blur(2px)';
      cutCtx.beginPath(); for (const [x, y, w, h, r = 0] of keep) cutCtx.roundRect(x, y, w, h, r); cutCtx.fill(); cutCtx.filter = 'none';
    }
    cutCtx.globalCompositeOperation = 'source-in'; cutCtx.drawImage(c, 0, 0);
    c.close(); m.close(); return createImageBitmap(cutCv);
  };
  const cache = new Map();
  let imgCap = 48;   // grows with the busiest frame, so a frame never evicts (and closes) its own images
  const load = url => {
    let p = cache.get(url);
    if (p) { cache.delete(url); cache.set(url, p); return p; }
    p = url.startsWith(CUT) ? cutBitmap(url) : bitmap(url);
    cache.set(url, p);
    while (cache.size > imgCap) { const [k, v] = cache.entries().next().value; cache.delete(k); v.then(b => b && b.close?.()); }
    return p;
  };
  const camURL = t => `/p/frames/cam/${pad5(clamp(Math.round(t * FPS), 0, frames.cam - 1))}.jpg`;
  // spec.cutout: one cutout or an array (e.g. a full-paper hook cutout, then a cam-mode magic backdrop later)
  const cuts = [].concat(spec.cutout || []).map(c => spec.cuts === 'hard' ? { hard: true, ...c } : c), cutURL = t => `/p/frames/cutout/${pad5(clamp(Math.round(t * FPS), 0, frames.cam - 1))}.png`;
  const cut = cuts.find(c => c.mode === 'cam'), camMode = !!cut, stdCuts = cuts.filter(c => c.mode !== 'cam');
  const onC = (c, t) => t >= c.from - .05 && t <= c.to + (c.mode === 'cam' ? 1.3 : 1);
  const cf = spec.capfly, ob = spec.orbit;
  const obOn = t => ob && t >= ob.orbitFrom - .1 && t <= ob.to + .3;
  const cutOn = t => cuts.some(c => onC(c, t)) || obOn(t), camCutOn = t => cut && onC(cut, t);
  // cam mode: the speaker stays where the camera shows him, but the room behind him is replaced by backdrops that
  // wipe in as circles from an origin (a finger snap). bg: [{at, kind: 'paper' | 'image' | 'cam', src, origin, w, sticker}]
  const layers = camMode ? [...(cut.bg || [])] : [];
  if (camMode && layers.at(-1)?.kind !== 'cam') layers.push({ at: cut.to, kind: 'cam', origin: [W / 2, H * .55] });
  // a layer's `img` (a full-frame alpha PNG, e.g. a giant title) sits between that layer and the person: text behind the head
  layers.forEach(L => { L.url = L.kind === 'image' ? '/p/' + L.src : null; L.imgUrl = L.img ? '/p/' + L.img : null; L.sticker ??= L.kind === 'paper'; });
  // m.alias: a frame identical to an earlier one loads that one (one fetch + decode, then the image cache hits)
  const mediaURL = (id, ct) => { const m = frames.media[id]; if (!m) return null; const i = clamp(Math.round(ct * FPS), 0, m.count - 1); return `/p/frames/media/${id}/${pad5(m.alias?.[i] ?? i)}.${m.ext || 'jpg'}`; };

  // image logos (any `logo` / `labelLogo` that is a project image path) load while their scene or actor is on screen
  const logoUsers = [...(spec.actors || []), ...(spec.scenes || [])].map(o => {
    const urls = new Set(), walk = v => { if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') for (const [k, x] of Object.entries(v)) k === 'imgs' && Array.isArray(x) ? x.forEach(u => typeof u === 'string' && urls.add('/p/' + u)) : k === 'imgKeys' && Array.isArray(x) ? x.forEach(e => typeof e?.[1] === 'string' && urls.add('/p/' + e[1])) : (k === 'logo' || k === 'labelLogo' || k === 'img' || k === 'avatarImg') && typeof x === 'string' && /\.(png|jpe?g|webp)$/i.test(x) ? urls.add('/p/' + x) : walk(x); };
    walk(o); return { from: o.from - (o.pre || 0), to: o.to, urls: [...urls] };
  }).filter(o => o.urls.length);
  const U = { cam: camURL, cut: cutURL };   // scenes' needs() may return these raw frame URLs
  // cuts: 'hard' (style or spec): every scene, media card (actor), cutout and B-roll appears and leaves in one frame, a straight cut like a
  // camera cut (Nico-style montage), instead of the default spring in / .26 s fade out. A scene or cutout can opt out with hard: false.
  const HARD = spec.cuts === 'hard';
  const actors = (spec.actors || []).map(a => (HARD ? { hard: true, ...a } : a)), scenes = linkScenes((spec.scenes || []).map(s => ({ layer: 'stage', ...(HARD ? { hard: true } : {}), ...s })));
  // full-screen B-roll: [{media, from, to, offset, zoom: .05}] covers camera and paper, captions stay on top.
  // Pair each with a media entry that has fill: true (cropped to the frame at prepare, sharp at full size).
  const brolls = spec.broll || [];
  const brollOn = (b, t) => t >= b.from - .05 && t <= b.to + .2;
  const brollA = (b, t) => {
    if (!brollOn(b, t)) return 0;
    const hard = b.hard ?? HARD, pin = hard ? +(t >= b.from) : S(t - b.from, 22), pout = hard ? +(t >= b.to) : S(t - b.to, 22);
    return Math.min(1, pin * 1.3) * (1 - pout);
  };
  const needs = t => {
    const out = frames.cam ? [camURL(t)] : [];   // paper-only (silent) shorts have no camera frames
    if (cutOn(t)) out.push(cutURL(t));
    if (cf && t >= cf.from - .05 && t <= cf.to + 1.5) out.push(cutURL(cf.from));
    const vn = spec.vanish;
    if (vn?.plate && t >= vn.from - .05 && t <= (vn.backAt ?? vn.to) + (vn.back ?? .45) + .05) out.push(cutURL(t), cutURL(vn.from), '/p/frames/plate.jpg');
    if (ob && t >= ob.from - .5 && t <= ob.to + .3) out.push('/p/' + ob.src);
    for (const L of layers) if (t >= L.at - .1 && t <= cut.to + 1.3) out.push(L.url, L.imgUrl);
    for (const a of actors) for (const [id, ct] of actorNeeds(a, t)) out.push(mediaURL(id, ct));
    for (const b of brolls) if (brollOn(b, t)) out.push(mediaURL(b.media, Math.max(0, (b.offset || 0) + t - b.from)));
    for (const o of logoUsers) if (t >= o.from - 1.5 && t <= (o.to ?? 1e9) + 1) for (const u of o.urls) out.push(u);
    for (const s of scenes) for (const n of SCENES[s.type]?.needs?.(s, t, U) || []) out.push(typeof n === 'string' ? n : mediaURL(n[0], n[1]));
    return out.filter(Boolean);
  };

  // ---- layout
  const seamKeys = spec.layout?.keys || [[0, 960]], zoomKeys = spec.zoom?.keys || [[0, 1]];
  // zoom.drift (scale per s, e.g. .02): a slow push-in on every camera shot, restarting from 1 at each seam key and each
  // instant punch (a zoom key with a spring of 60 or more, e.g. [t, 1.39, 400]), capped at 4 s of drift. Hard-cut styles
  // (nico-slowdown) never hold a still frame this way. zoom.wideOnly: only the wide shots push (keyed zoom 1.02 or less),
  // the punched-in shots hold still (aiwithremy).
  const DRIFT = spec.zoom?.drift || 0, shotStarts = DRIFT ? [...seamKeys.map(k => k[0]), ...zoomKeys.filter(k => (k[2] ?? 0) >= 60).map(k => k[0])].sort((a, b) => a - b) : [];
  const zoomAt = t => {
    let z = track(t, zoomKeys, 9);
    if (DRIFT && !(spec.zoom?.wideOnly && z > 1.02)) { let s0 = 0; for (const a of shotStarts) if (a <= t) s0 = a; z *= 1 + DRIFT * Math.min(4, t - s0); }
    return z;
  };
  // Hand-off: a standard cutout whose end meets a seam key leaving full paper (1920) for a split. The seam does not rise
  // from the bottom: it switches at once, the room fades in around the speaker and the cutout glides onto the camera
  // framing (same pixels, so it vanishes once aligned). He never leaves the screen. Opt out with cutout.handoff: false.
  const seamLive = seamKeys.map((k, i) => {
    const c = stdCuts.find(c => Math.abs(c.to - k[0]) < .15);
    if (!c || c.handoff === false || !(seamKeys[i - 1]?.[1] >= H - 1) || !(k[1] > 0 && k[1] < H - 1)) return k;
    c.ho = k[0]; return [k[0], k[1], 400];
  });
  const LW = spec.layout?.w ?? 10;   // seam spring stiffness for split <-> split and paper moves
  // Split <-> full camera (seam 0) is a "window": the camera panel lifts into a rounded card that opens to full screen
  // over the still paper, and closes back into the panel (layout.dur s, default .62). render() composites it.
  const LD = spec.layout?.dur ?? .62;
  const E5 = x => x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (x * (x * 6 - 15) + 10);
  const trans = seamKeys.flatMap((k, i) => {
    const a = seamKeys[i - 1]?.[1]; return i && (a === 0) !== (k[1] === 0) && Math.max(a, k[1]) < H - 1 ? [{ i, at: k[0] }] : [];
  });
  const trAt = t => { for (const r of trans) if (t >= r.at && t < r.at + LD) return { ...r, p: E5((t - r.at) / LD) }; return null; };
  // track(), except the window keys switch at once (the card does the move). force {i, p} pins key i's progress,
  // to draw the layout before (0) or after (1) it.
  const seamEval = (t, keys, force) => {
    let v = keys[0][1];
    for (let i = 1; i < keys.length; i++) {
      const k = keys[i];
      const p = force?.i === i ? force.p : trans.some(r => r.i === i) ? +(t >= k[0]) : S(t - k[0], k[2] ?? LW);
      if (p <= 0) break; v += (k[1] - keys[i - 1][1]) * p;
    }
    return v;
  };
  const seamAt = (t, force) => seamEval(t, seamLive, force), seamSmooth = t => seamEval(t, seamKeys);
  const hoCut = t => stdCuts.find(c => c.ho != null && t >= c.ho - .05 && onC(c, t));
  // Stage offset: only when the paper goes to / comes back from full-camera (0) does its content ride with it.
  // Between two split layouts the content stays put (each scene is authored for its own seam).
  const stageRef = t => { let i = 0; while (i + 1 < seamKeys.length && seamKeys[i + 1][0] <= t) i++; const cur = seamKeys[i][1], prev = seamKeys[i - 1]?.[1]; return cur === 0 ? (prev || 960) : prev === 0 ? cur : null; };
  const EDGE = Array.from({ length: Math.ceil(W / 6) + 2 }, (_, i) => (noise1(i * .16) - .5) * 3.2 + (noise1(i * .9 + 40) - .5) * 1.1);
  const edgePath = (seam, below) => {
    const p = new Path2D();
    // full camera (seam 0): the whole frame, no deckle, or its teeth leave a jagged paper strip along the top edge
    if (seam <= 0) { if (below) p.rect(0, 0, W, H); return p; }
    p.moveTo(0, below ? H : 0);
    for (let i = 0; i < EDGE.length; i++) p.lineTo(Math.min(W, i * 6), seam + EDGE[i]);
    p.lineTo(W, below ? H : 0); p.closePath(); return p;
  };
  const edgeLine = seam => { const p = new Path2D(); for (let i = 0; i < EDGE.length; i++) p[i ? 'lineTo' : 'moveTo'](Math.min(W, i * 6), seam + EDGE[i]); return p; };
  // Card layout (the clean look, layout.card: true or {x, y, w, h, r, zoom, bias, capY}): the camera sits in one fixed
  // rounded card at the bottom for the whole short, the stage owns everything above it, captions sit between the two.
  // No seam, no window transitions, no cutout. layout.keys is ignored.
  const CARD = spec.layout?.card ? { x: 66, y: 1082, w: 948, h: 715, r: 44, zoom: 1.08, bias: .27, ...(spec.layout.card === true ? {} : spec.layout.card) } : null;
  if (CARD) CARD.capY ??= CARD.y - 114;
  // Framed camera (layout.frame: true or {m, gap, bottom, r, border}): in split the camera is a photo pinned on the paper
  // (side margins, rounded corners, white paper border, the style's deep shadow) instead of a full-width panel under a
  // deckle edge. Seam keys and full-screen moves are unchanged: the window transition melts margins, corners and border
  // to 0 as it opens to full screen, and grows them back as it closes. frame.bleed: the photo runs off the left, right and
  // bottom edges of the frame (no margin, no border there, square bottom corners): only its top edge keeps the rounded
  // corners and the white border, so platform UIs never crop a thin paper strip around it.
  const FR = !CARD && spec.layout?.frame ? { m: 40, gap: 26, bottom: 46, r: 40, border: 9, ...(spec.layout.frame === true ? {} : spec.layout.frame) } : null;
  if (FR?.bleed) { FR.m = 0; FR.bottom = 0; }
  // the camera's video rect below `seam` (legacy: the whole width down to the bottom)
  const camRect = seam => {
    if (!FR) return { x: 0, y: seam, w: W, h: H - seam, r: 0, b: 0 };
    const f = clamp(seam / 400);
    return { x: FR.m * f, y: seam + FR.gap * f, w: W - 2 * FR.m * f, h: H - seam - (FR.gap + FR.bottom) * f, r: FR.r * f, b: FR.border * f };
  };
  const lerpRect = (A, B, p) => ({ x: lerp(A.x, B.x, p), y: lerp(A.y, B.y, p), w: lerp(A.w, B.w, p), h: lerp(A.h, B.h, p), r: lerp(A.r, B.r, p), b: lerp(A.b, B.b, p) });
  const rectPath = R => { const p = new Path2D(); p.roundRect(R.x, R.y, R.w, R.h, FR?.bleed ? [R.r, R.r, 0, 0] : R.r); return p; };
  const camClip = seam => FR && seam > 2 ? rectPath(camRect(seam)) : edgePath(seam, true);
  // the white border plate under the video, lifted off the paper like a sheet (no plate once it is full screen)
  function framePlate(R, a = 1) {
    if (FR.bleed && FR.border === 0) {   // layout.frame {border: 0}: no white border, a soft shadow cast up onto the paper instead (the creator 2026-10-14)
      const s = FR.shadow ?? 40, y = R.y; if (y <= 2 || y >= H) return;
      const g = ctx.createLinearGradient(0, y - s, 0, y);
      g.addColorStop(0, 'rgba(20,16,8,0)'); g.addColorStop(.6, `rgba(20,16,8,${(.07 * a).toFixed(3)})`); g.addColorStop(1, `rgba(20,16,8,${(.24 * a).toFixed(3)})`);
      ctx.save(); ctx.fillStyle = g; ctx.fillRect(R.x, y - s, R.w, s); ctx.restore(); return;
    }
    if (R.b < .3 && R.r < .3) return;
    if (FR.bleed) return K.sheet(ctx, R.x, R.y - R.b, R.w, R.h + R.b + R.r + 80, R.r && R.r + R.b, { elev: 1.1, alpha: a });   // bottom corners off frame
    K.sheet(ctx, R.x - R.b, R.y - R.b, R.w + 2 * R.b, R.h + 2 * R.b, R.r + R.b, { elev: 1.1, alpha: a });
  }
  function frameEdge(R, a = 1) {   // a hairline where the video meets the border, so it never looks pasted
    if (R.b < .3) return;
    ctx.save(); ctx.globalAlpha *= a * Math.min(1, R.b / 4); ctx.strokeStyle = 'rgba(20,16,8,.16)'; ctx.lineWidth = 1.2;
    if (FR.bleed) { ctx.beginPath(); ctx.rect(1, 0, W - 2, R.y + R.r + 1); ctx.clip(); }   // the top edge and its corners only
    ctx.stroke(rectPath(R)); ctx.restore();
  }

  // ---- captions
  const cap = spec.captions || {};
  // captions.hook {spans: [[a, b], ...] (source s), ...stack settings}: the base look (rise) reads everywhere, and only
  // inside those spans (the hook, the re-hook, a payoff, the CTA) the line turns into the 'stack' pile drawn with the base
  // captions overridden by the hook's own keys (size, maxWords, big, emph...). One chunk list, each chunk cut by its look.
  const HOOK = cap.style !== 'stack' && cap.hook?.spans?.length ? cap.hook : null, scap = HOOK ? { ...cap, ...HOOK } : cap;
  const outside = sp => { const r = []; let a = -1e9; for (const [x, y] of [...sp].sort((p, q) => p[0] - q[0])) { r.push([a, x]); a = y; } return [...r, [a, 1e9]]; };
  const chunks = !HOOK ? captionChunks(tl.words, { ...cap, hide: cap.hide || [], bleep: spec.bleep })
    : [...captionChunks(tl.words, { ...cap, hide: [...(cap.hide || []), ...HOOK.spans], bleep: spec.bleep }),
      ...captionChunks(tl.words, { ...scap, hide: [...(cap.hide || []), ...outside(HOOK.spans)], bleep: spec.bleep }).map(c => Object.assign(c, { stack: true }))]
      .sort((a, b) => a.start - b.start);
  if (HOOK) chunks.forEach((c, i) => c.next = chunks[i + 1]?.start ?? Infinity);
  // captions.upper: every caption word in capitals (e.g. black mono chips), measured and drawn that way
  const upper = cs => { if (cap.upper) for (const c of cs) c.words = c.words.map(w => ({ ...w, text: w.text.toUpperCase() })); return cs; };
  upper(chunks);
  // Captions are "paper sticker" words: bold ink with a thick paper outline and a soft drop shadow. No box behind
  // them, so nothing resizes between chunks; they read the same on the paper stage and on the camera.
  // spec.captions.style: one of the capStyles looks by name or 1-based number ('sticker' = this per-word default)
  // 'rise' / 'hard' (CAPTION_FONTS): word blocks, each word padded .18em, .05em apart, in their own family (captions.font)
  const CSTY = captionStyleIndex(cap.style), CNAME = CAPTION_STYLES[CSTY], BLOCK = CAPTION_FONTS[CNAME], cdraw = BLOCK ? null : CAPTION_DRAW[CSTY];
  const CS = cap.size || cdraw?.base || (BLOCK ? 82 : 84), WT = cap.weight || BLOCK?.[1] || 800, LS = cap.tracking != null ? CS * cap.tracking : BLOCK ? -CS * .012 : -1.5, STROKE = Math.round(CS * .22);
  const CF = cap.font || BLOCK ? K.famCss(cap.font || BLOCK[0]) : K.F.sans, NOBLK = CNAME === 'rise' && cap.block === false, PADX = CS * (NOBLK ? .1 : .18), GAP = CS * .05;
  if (CF !== K.F.sans) await document.fonts.load(`${WT} 40px ${CF}`);
  const STACK = CNAME === 'stack', SCS = scap.size || CS, SWT = scap.weight || WT, SCF = scap.font ? K.famCss(scap.font) : CF;
  const LBF = scap.labelFont ? K.famCss(scap.labelFont) : SCF, LBW = scap.labelWeight || 500;
  const BIGF = scap.bigFont ? K.famCss(scap.bigFont) : 'Archivo', BIGW = scap.bigWeight || (scap.bigFont ? 800 : 900);
  if (STACK || HOOK) { for (const f of [`${BIGW} 40px ${BIGF}`, `${LBW} 40px ${LBF}`, `${SWT} 40px ${SCF}`]) await document.fonts.load(f); }
  const wordW = w => K.measure(ctx, w.text, CS, WT, LS, CF);
  // captions.space: word gap as a multiple of the font's space (a pixel font's space is wide: .6 = aiwithremy's tight gap)
  const spW = () => K.measure(ctx, ' ', CS, WT, LS, CF) * (cap.space ?? 1);
  const chunkW = c => { const sp = BLOCK ? GAP + 2 * PADX : spW(); return c.words.reduce((a, w, i) => a + wordW(w) + (i ? sp : 0), BLOCK ? 2 * PADX : 0); };
  chunks.forEach(c => c.w = chunkW(c));
  const allChunks = upper(captionChunks(tl.words, { ...cap, hide: [], bleep: spec.bleep }));   // unhidden, for scenes that draw captions themselves (capStyles)
  // the caption's rest line for a layout: captions.yKeys [[t, y]] pins it from t on (a scene that moves the camera
  // itself, e.g. camSplit; null = back to the seam rule), else above the camera in split, on the video full screen.
  // Block looks never straddle the seam: in split the line sits on the paper just above the camera.
  // captions.straddle (rise): in split the line's middle sits on the camera's top edge instead, ink above it, white below.
  // captions.straddleDy (px): the straddle line sits that far below the camera's top edge, fully on the video (white words
  // on a soft dark shadow, no paper halo: the creator 2026-10-14 wanted shadows instead of the white border).
  const camTopAt = seam => FR ? camRect(seam).y - camRect(seam).b : seam;
  const capRest = (t, seam) => {
    const yk = (cap.yKeys || []).reduce((v, k) => t >= k[0] ? k[1] : v, null);
    const pin = yk != null || !!CARD || seam >= 1900 && cap.paperY != null;
    if (!pin && cap.straddle && seam >= 760 && seam < 1900) return { y: camTopAt(seam) + (cap.straddleDy || 0), pin };
    const y = yk != null ? yk : CARD ? CARD.capY : seam >= 1900 && cap.paperY != null ? cap.paperY : seam >= 760 ? Math.min(seam, 1400) : lerp(cap.fullY ?? 1180, 760, seam / 760);
    return { y: BLOCK && !pin ? y - (CS * .61 + 6) * clamp(seam / 760) : y, pin };
  };
  // A layout move never drags a readable line across the stage. Window (split <-> full): the line goes from rest line to
  // rest line (render passes {from, to, p}). Split <-> split: it rides the camera card but dips out for the middle of the
  // move (gone from 40% to 70% of the travel) and settles back in rising 14 px, so it never crosses the stage content.
  const capMove = t => {
    let i = 0; while (i + 1 < seamKeys.length && seamKeys[i + 1][0] <= t) i++;
    const a = seamKeys[i - 1]?.[1], b = seamKeys[i][1];
    if (!i || a === b || !a || !b || trans.some(r => r.i === i)) return null;
    const p = S(t - seamKeys[i][0], seamKeys[i][2] ?? LW); return p < .985 ? { a, b, p } : null;
  };
  function captions(t, seam, mv) {
    let c = null; for (const ch of chunks) if (ch.start - .02 <= t) c = ch; else break;
    if (!c || t >= c.stop || t > c.end + .25 && c.next - c.end > .55) return;
    // a full-screen B-roll hides the camera card: the line reads as over video (white words, soft shadow), never the
    // straddle's ink half with its paper outline nor the ink look of bare paper; the stack takes its full-camera look
    const onB = brolls.some(b => brollA(b, t) > .5);
    if (STACK || c.stack) return stackCaption(c, t, onB ? 0 : seam);
    let { y, pin } = capRest(t, seam), ga = 1;
    if (!pin && mv) y = lerp(capRest(t, mv.from).y, capRest(t, mv.to).y, mv.p);
    else if (!pin && (mv = capMove(t))) {
      const out = mv.p < .55, q = out ? 1 - smooth(clamp(mv.p / .4)) : smooth(clamp((mv.p - .7) / .28));
      y += out ? 0 : 14 * (1 - q); ga = q;
      if (ga <= .002) return;
    }
    const base = K.midBase(y, CS);
    // captions.scaleKeys [[t, k]]: a chunk starting at or after t is drawn k times bigger (a hook that hits harder),
    // grown up from the bottom of its line so it never reaches the camera card, and capped to fit the frame width
    const sk = Math.min((cap.scaleKeys || []).reduce((v, k) => c.start >= k[0] ? k[1] : v, 1), (W - 80) / Math.max(1, c.w));
    const big = Math.abs(sk - 1) > .01, ay = y + CS * .61;
    if (ga < 1 || big) { ctx.save(); ctx.globalAlpha *= ga; }
    if (big) { ctx.translate(W / 2, ay); ctx.scale(sk, sk); ctx.translate(-W / 2, -ay); }
    if (BLOCK) blockCaption(c, t, y, seam, onB ? -1e4 : mv?.camTop, big ? [ay, sk] : null); else captionLine(c, t, y, base);
    if (ga < 1 || big) ctx.restore();
  }
  // 'stack' (nico-slowdown): hard cuts, no box, no slide. Full camera: the chunk builds word by word into a stack
  // (captions.fullY = its middle, default 760): small words in the caption font, a word or two per short line
  // (captions.smallW px wide), each line nudged left or right (captions.stagger px), the key word (captions.emph, else
  // the chunk's longest content word) alone on its own line, uppercase, Archivo 900 (captions.stretch, default
  // extra-condensed), captions.big times the caption size, shrunk to fit the width. Paper alone: every word is a key
  // word, a centered column of big words (captions.paperY, default 960). White (captions.color) with a soft shadow on
  // the video, flat on the paper. Split: only the word being said, captions.labelFont (default the caption font) at
  // captions.labelWeight (500) and captions.labelSize, accent text on a tight white label across the camera's top edge.
  // captions.zoomDrop (px per 1x of zoom): on a punch-in the face grows down, so the full-camera stack slides down with it.
  // captions.outline {color (accent), width (.07 of the word size), until (source s, default the first chunk's end)}: the
  // hook's big words get a thick colored outline under the white fill (Nico's orange-rimmed hook), later ones stay plain.
  // captions.tall (default 1): every stack word is drawn that many times taller than wide (Nico's 1.5: tall, tight
  // poster letters, lines almost touching). captions.smallDisplay: the small words use the big words' face (Archivo 900
  // condensed, lowercase) instead of the caption font. captions.snap: each word cuts in at once (no fade, no scale).
  // captions.bigFont / bigWeight: the big words' face instead of Archivo 900 (e.g. Bricolage Grotesque 800,
  // condensed through its wdth axis). captions.paperColor: the words on bare paper (ink on a white paper, where white
  // vanishes). captions.split 'stack': on a split the stack stays (instead of the one-word label), centered on the
  // camera card's top edge + captions.splitDy, scaled by captions.splitScale (default .62). captions.yKeys [[t, y]]: the
  // full-camera stack's middle from t on (a CTA overlay that takes the bottom). captions.bigBlock: each big word sits on the
  // accent block (white on blue, rise's block; on bare paper only the emph words get it; 'emph': only the emph words
  // anywhere). captions.paperScale: on bare paper the same stack as on the camera (one big key word, the rest small)
  // drawn that many times bigger, instead of every word big. captions.keyMin: the shortest word (letters) that may become the big key word (default 4). captions.blurIn: every stack word
  // blurs in like rise (no scale, no snap).
  const STOP = new Set(('le la les un une des de du d l et à a en au aux ce ces cet cette ça il elle on nous vous ils elles je j tu me m te t se s sa son ses mon ma mes ton ta tes leur leurs que qu qui quoi pour par sur sous dans avec sans pas ne n plus mais ou où donc est c sont été être avoir ai as avons avez ont fait va vais très tout tous toute aussi comme si y cest nest jai quil quelle sil ny jen lui ' +
    'the an of to and in on for is are it its this that with you your we our they i my me be was were do does just so').split(' '));
  const normW = s => String(s).toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
  const bare = s => String(s).replace(/^[«"“'(]+|[.,!?;:…»"”')]+$/g, '');
  const stackCache = new Map(), SBIG = SCS * (scap.big || 3.2), OUT = scap.outline, OUT_END = OUT ? OUT.until ?? chunks[0]?.end ?? 0 : -1;
  const TALL = scap.tall || 1, SDISP = !!scap.smallDisplay, BB = !!scap.bigBlock, BLUR = !!scap.blurIn, BH = BB ? 1.04 : .8;
  const fSmall = () => { if (SDISP) return fBig(SCS); ctx.font = K.font(SCS, SWT, SCF); ctx.fontStretch = 'normal'; ctx.letterSpacing = -SCS * .04 + 'px'; };
  const fBig = sz => { ctx.font = `${BIGW} ${sz}px ${BIGF}`; ctx.fontStretch = scap.stretch || 'extra-condensed'; ctx.letterSpacing = -sz * .02 + 'px'; };
  function stackLayout(c, paper) {
    const id = c.start + (paper ? 'p' : 'c'); let L = stackCache.get(id); if (L) return L;
    const PS = paper && scap.paperScale, key = paper && !PS || c.words.some(w => w.emph) ? null : c.words.reduce((b, w) => { const n = normW(w.text); return n.length >= (scap.keyMin ?? 4) && !STOP.has(n) && (!b || n.length > normW(b.text).length) ? w : b; }, null);
    const maxW = (W - 2 * (scap.margin ?? 90)) / (PS || 1), smallW = scap.smallW ?? 380, st = scap.stagger ?? 70, lines = []; let cur = null;
    ctx.save();
    // captions.paperBig (x the caption size): on bare paper the words pack into full-width poster lines at that size
    // (each line shrunk to fit), like Nico's « FAUT LE / TRANSFORMER / EN / VIDÉO », instead of one word per line
    if (paper && scap.paperBig && !PS) {
      const PB = SCS * scap.paperBig; fBig(PB); const sp = ctx.measureText(' ').width * 1.6; let ln = null;
      for (const w of c.words) {
        const text = bare(w.text).toUpperCase(), wd = ctx.measureText(text).width;
        if (!ln || ln.width + sp + wd > maxW && ln.items.length) lines.push(ln = { big: PB, items: [], width: -sp, dx: 0 });
        ln.width += sp; ln.items.push({ w, text, x: ln.width }); ln.width += wd;
      }
      lines.forEach((l, i) => { const k = Math.min(1, maxW / l.width); l.big = PB * k; l.h = l.big * BH * TALL; l.paper = true; l.width *= k; l.items.forEach(it => it.x *= k);
        l.dx = lines.length > 1 ? st * .8 * [-1, 1, .4, -.6][i % 4] * Math.min(1, (maxW - l.width) / (2 * st)) : 0; });
      ctx.restore(); L = place(lines, SCS * .05); stackCache.set(id, L); return L;
    }
    for (const w of c.words) {
      if (paper && !PS || w.emph || w === key) {
        const text = bare(w.text).toUpperCase(); fBig(SBIG); const k = Math.min(1, maxW / ctx.measureText(text).width), sz = SBIG * k;
        lines.push({ big: sz, h: sz * BH * TALL, dx: 0, width: ctx.measureText(text).width * k, items: [{ w, text, x: 0 }] }); cur = null; continue;
      }
      fSmall(); const text = bare(w.text), wd = ctx.measureText(text).width, sp = ctx.measureText(' ').width;
      if (!cur || cur.width + sp + wd > smallW) lines.push(cur = { big: 0, h: SCS * (SDISP ? .8 : .98) * TALL, items: [], width: -sp, dx: st * [-1, .6, 1, -.5][lines.length % 4] * (Math.round(c.start * 10) % 2 ? 1 : -1) });
      cur.width += sp; cur.items.push({ w, text, x: cur.width, wd }); cur.width += wd;
    }
    ctx.restore();
    // captions.tuck: a short small line just before a big word sits beside it, left of its top (Nico's « étant ASSEZ »),
    // and a short small line just after it hangs right-aligned under it (« COMPÉTENT / maintenant »)
    if (scap.tuck) lines.forEach((l, i) => {
      if (!l.big) return; const mL = scap.margin ?? 90, g = SCS * .3, bl = W / 2 - l.width / 2 + l.dx, pv = lines[i - 1], nx = lines[i + 1];
      if (pv && !pv.big && !pv.tuck && pv.items.length <= 2 && bl - g - pv.width >= mL) { pv.tuck = l; pv.dx = bl - g - pv.width / 2 - W / 2; }
      if (nx && !nx.big && nx.items.length <= 2 && i + 2 >= lines.length) nx.dx = Math.min(bl + l.width, W - mL) - nx.width / 2 - W / 2;
    });
    L = place(lines, SCS * (TALL > 1 ? .05 : .1)); stackCache.set(id, L); return L;
  }
  // each line's top inside the stack (a tucked line takes no room: it rides on the big word after it)
  function place(lines, gap) {
    let y = 0; for (const l of lines) if (!l.tuck) { l.y = y; y += l.h + gap; }
    for (const l of lines) if (l.tuck) l.y = l.tuck.y + l.tuck.big * ((BB ? .88 : .76) * TALL - .62);
    return { lines, h: Math.max(0, y - gap), gap };
  }
  function stackCaption(c, t, seam) {
    const SPL = !CARD && seam >= 760 && seam < 1900;
    if (SPL && scap.split !== 'stack') {   // split: the word being said on a white label
      let w = null; for (const x of c.words) if (x.start - .03 <= t) w = x; if (!w) return;
      const yk = (scap.yKeys || []).reduce((v, k) => t >= k[0] ? k[1] : v, null), y = yk ?? camTopAt(seam), sz = scap.labelSize || SCS, text = bare(w.text);
      ctx.save(); ctx.font = K.font(sz, LBW, LBF); ctx.letterSpacing = -sz * .01 + 'px'; ctx.textAlign = 'center'; ctx.textBaseline = 'alphabetic';
      const tw = ctx.measureText(text).width, px = sz * .14, h = sz * 1.12;
      ctx.fillStyle = C.sheet; ctx.fillRect(W / 2 - tw / 2 - px, y - h / 2, tw + 2 * px, h);
      ctx.fillStyle = C.blue; ctx.fillText(text, W / 2, K.midBase(y, sz)); ctx.restore(); return;
    }
    const onCam = seam < 1900, L = stackLayout(c, !onCam), yk = (scap.yKeys || []).reduce((v, k) => t >= k[0] ? k[1] : v, null);
    const cy = SPL ? camTopAt(seam) + (scap.splitDy ?? 0) : onCam ? (yk ?? scap.fullY ?? 760) + (zoomAt(t) - 1) * (scap.zoomDrop ?? 0) : scap.paperY ?? 960;
    let top = cy - L.h / 2;
    ctx.save(); ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.fillStyle = !onCam && scap.paperColor ? scap.paperColor : scap.color || '#FFFFFF';
    const sk = SPL ? scap.splitScale ?? .62 : !onCam && scap.paperScale || 1;
    if (sk !== 1) { ctx.translate(W / 2, cy); ctx.scale(sk, sk); ctx.translate(-W / 2, -cy); }
    if (onCam) { ctx.shadowColor = 'rgba(0,0,0,.38)'; ctx.shadowBlur = SCS * .3; ctx.shadowOffsetY = SCS * .04; }
    const ga = ctx.globalAlpha;
    for (const l of L.lines) {
      const base = top + l.y + (l.big ? l.big * (BB ? .88 : .76) : SCS * .8) * TALL, x0 = l.big ? 0 : W / 2 - l.width / 2 + l.dx;
      if (l.big) fBig(l.big); else fSmall();
      for (const it of l.items) {
        const p = BLUR ? S(t - it.w.start + .03, 28) : scap.snap ? (t >= it.w.start - .03 ? 1 : 0) : S(t - it.w.start + .03, 40); if (p <= .002) continue;
        const x = l.big ? W / 2 - l.width / 2 + l.dx + it.x : x0 + it.x, k = l.big && !BLUR ? lerp(1.12, 1, p) : 1;
        if (BLUR && p < .998) ctx.filter = `blur(${((1 - p) * (l.big || SCS) * .12).toFixed(2)}px)`;
        ctx.globalAlpha = ga * Math.min(1, p * 1.6);
        if (k !== 1) { ctx.save(); ctx.translate(W / 2, base - l.big * .36); ctx.scale(k, k); ctx.translate(-W / 2, -(base - l.big * .36)); }
        if (TALL !== 1) { ctx.save(); ctx.translate(0, base); ctx.scale(1, TALL); ctx.translate(0, -base); }
        if (l.big && it.w.start < OUT_END) {
          ctx.save(); ctx.shadowColor = 'transparent'; ctx.lineJoin = 'round'; ctx.lineWidth = l.big * (OUT.width ?? .07) * 2;
          ctx.strokeStyle = OUT.color || C.blue; ctx.strokeText(it.text, x, base); ctx.restore();
        }
        if (l.big && BB && (it.w.emph || !l.paper && scap.bigBlock !== 'emph')) {   // the accent block under the big word, white on blue
          const tw = ctx.measureText(it.text).width, px = l.big * .12;
          ctx.save(); ctx.fillStyle = C.blue; ctx.beginPath(); ctx.roundRect(x - px, base - l.big * .84, tw + 2 * px, l.big * .98, l.big * .12); ctx.fill();
          ctx.shadowColor = 'transparent'; ctx.fillStyle = C.onBlue; ctx.fillText(it.text, x, base); ctx.restore();
        } else ctx.fillText(it.text, x, base);
        ctx.filter = 'none';
        if (TALL !== 1) ctx.restore();
        if (k !== 1) ctx.restore();
      }
    }
    ctx.restore();
  }
  // captions.radius: corner radius of the band block as a multiple of size (.06); captions.shadow: a soft drop under it
  // captions.active (a colour, e.g. '#8A8A8A'): karaoke on the band, the words not being said take that colour and the
  // word being said takes captions.color (white); an emphasised word keeps captions.hi when it is not the current one
  function bandCaption(c, y, t) {
    const sp = spW(), padX = CS * .2, h = CS * 1.2, x0 = W / 2 - c.w / 2, b = K.midBase(y, CS);
    // captions.bg 'none': no block, the words sit on the video with a soft shadow (captions.shadow false = none)
    ctx.save(); if (cap.bg === 'none') { if (cap.shadow !== false) K.drop(ctx, .35, CS * .25, CS * .04, '0,0,0'); }
    else { ctx.beginPath(); ctx.roundRect(x0 - padX, y - h / 2, c.w + 2 * padX, h, CS * (cap.radius ?? .06)); ctx.fillStyle = cap.bg || C.ink; if (cap.shadow) K.drop(ctx, .28, CS * .45, CS * .17, '0,0,0'); ctx.fill(); ctx.shadowColor = 'transparent'; }
    ctx.font = K.font(CS, WT, CF); ctx.letterSpacing = LS + 'px'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    // captions.bold: faux bold for a single-weight font, a square stroke in the text colour of bold x size px (pixel fonts stay square)
    const BW = cap.bold ? cap.bold * CS : 0; if (BW) { ctx.lineWidth = BW; ctx.lineJoin = 'miter'; ctx.miterLimit = 2; }
    let cur = -1; if (cap.active && t !== undefined) c.words.forEach((w, i) => { if (w.start - .02 <= t) cur = i; });
    let x = x0; for (const [i, w] of c.words.entries()) {
      const fg = cap.color || '#FFFFFF';
      ctx.fillStyle = ctx.strokeStyle = cap.active ? (i === cur ? fg : w.emph ? cap.hi || C.tint : cap.active) : w.emph ? cap.hi || C.tint : fg;
      if (BW) ctx.strokeText(w.text, x, b); ctx.fillText(w.text, x, b); x += wordW(w) + sp;
    }
    ctx.restore();
  }
  // 'dim' (speedy-devv): the phrase builds word by word on 1-2 centered lines; spoken words grey (captions.color,
  // captions.dimWeight), the current word white (captions.hi) at captions.weight, an emphasised word keeps its dark
  // pill (captions.pill, full radius) once said. Each word blurs in like rise's block-less words. Lines are laid out
  // on the whole chunk, so a word appears in place and the line never re-centers under the reader.
  function dimCaption(c, t, y) {
    const sp = spW(), DW = cap.dimWeight || 500, LH = CS * 1.22, maxW = W - 320;
    let cur = -1; c.words.forEach((w, i) => { if (w.start - .02 <= t) cur = i; });
    if (cur < 0) return;
    ctx.save(); ctx.font = K.font(CS, WT, CF);
    // laid out on the VISIBLE words only, re-centered as the phrase builds (his "These" sits alone, dead center)
    const vis = c.words.slice(0, cur + 1).map((w, i) => ({ w, ww: wordW(w), gi: i }));
    const lines = [[]]; let lw = 0;
    for (const o of vis) { if (lw && lw + sp + o.ww > maxW) { lines.push([]); lw = 0; } lw += (lw ? sp : 0) + o.ww; lines[lines.length - 1].push(o); }
    ctx.letterSpacing = LS + 'px'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    lines.forEach((l, li) => {
      const cy = y + (li - (lines.length - 1) / 2) * LH, b = K.midBase(cy, CS);
      let x = W / 2 - l.reduce((a, o, i) => a + o.ww + (i ? sp : 0), 0) / 2;
      for (const o of l) {
        const { w, ww, gi } = o, wx = x; x += ww + sp;
        const q = smooth(clamp((t - w.start) / .18)), emph = !!w.emph, isCur = gi === cur;
        ctx.save(); ctx.globalAlpha *= Math.max(q, .001);
        const bl = (1 - q) * CS * .13; if (bl > .3) ctx.filter = `blur(${(bl * ctx.getTransform().a).toFixed(2)}px)`;
        if (emph) { const h = CS * 1.24; ctx.beginPath(); ctx.roundRect(wx - CS * .34, cy - h / 2, ww + CS * .68, h, h / 2); ctx.fillStyle = cap.pill || '#2B2B2B'; ctx.fill(); }
        ctx.font = K.font(CS, isCur || emph ? WT : DW, CF); ctx.fillStyle = isCur || emph ? cap.hi || '#FFFFFF' : cap.color || '#8E8E8E';
        ctx.fillText(w.text, wx, b); ctx.restore();
      }
    });
    ctx.restore();
  }
  function captionLine(c, t, y, base) {
    if (CNAME === 'band') return bandCaption(c, y, t);
    if (CNAME === 'dim') return dimCaption(c, t, y);
    if (CSTY) {   // whole-chunk look: fades and rises per chunk like capStyles, scaled from its 84 px design size
      const p = S(t - c.start + .12, 30), k = CS / (cdraw.base || 84); ctx.save(); ctx.globalAlpha *= Math.min(1, p * 1.4);
      ctx.translate(W / 2, y + (1 - p) * 18); ctx.scale(k, k); ctx.translate(-W / 2, -y); cdraw(ctx, c, y, t); ctx.restore(); return;
    }
    const sp = K.measure(ctx, ' ', CS, WT, LS, CF); let wx = W / 2 - c.w / 2;
    const vis = c.words.map(w => { const p = S(t - w.start + .04, 30), x = wx; wx += wordW(w) + sp; return { w, p, x }; }).filter(v => v.p > .002);
    ctx.save(); ctx.font = K.font(CS, WT, CF); ctx.letterSpacing = LS + 'px'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.lineJoin = 'round'; ctx.lineWidth = STROKE; ctx.strokeStyle = C.sheet;
    K.drop(ctx, .28, 22, 6); const ga = ctx.globalAlpha;
    for (const { w, p, x } of vis) { ctx.globalAlpha = ga * Math.min(1, p * 1.4); ctx.strokeText(w.text, x, base + (1 - p) * 18); }
    ctx.shadowColor = 'transparent';
    for (const { w, p, x } of vis) { ctx.globalAlpha = ga * Math.min(1, p * 1.4); ctx.fillStyle = w.emph ? C.blue : C.ink; ctx.fillText(w.text, x, base + (1 - p) * 18); }
    ctx.restore();
  }
  // Word-block captions: the word being said sits on an accent block from its start until the next word starts.
  // rise: the line blurs in per chunk (blur .12em -> 0 + fade, no slide), white words with a soft shadow (ink once the
  // line sits on bare paper, where white would vanish); the full-height block + white word blur in over ~.15 s
  // (blur .16em -> 0, scale 1.04 -> 1, fade) and fade out in place (.12 s) when the next word starts. Nothing grows,
  // shrinks or slides. hard: the line rises in (.24em), ink words with a paper outline, the block is a flat rect with a
  // hard ink shadow that fades in over .1 s. Inside the block the word is C.onBlue (white, ink on a light accent like
  // yellow), clipped to the block.
  let riseL = null;   // scratch layer for the rise blur-in / fade-out: block + white word composited at one alpha (an exact crossfade)
  const smooth = x => x * x * (3 - 2 * x);
  function blockCaption(c, t, y, seam, camTop0, hook) {
    // captions.blur false (rise only): no blur, no settle; the line snaps in and the block jumps word to word (.05 s cuts)
    const rise = CNAME === 'rise', crisp = rise && cap.blur === false, base = K.midBase(y, CS), bh = CS * 1.22, top = y - bh * .5, lead = .04;
    const p = crisp ? clamp((t - c.start + .04) / .05) : S(t - c.start + .08, 30);
    // rise: ink while the line sits on bare paper (white would vanish there), white once it is over the video
    const camTop = camTop0 ?? (seam <= 2 ? -1e4 : camTopAt(seam));
    // across the camera edge: each half its own ink; a scaled hook line is drawn in its own space, so map the edge into it
    const edge = hook ? hook[0] + (camTop - hook[0]) / hook[1] : camTop, split = rise && cap.straddle && edge > top && edge < top + bh;
    const inkMix = rise && cap.color ? 0 : rise ? split ? 1 : clamp((camTop - y) / (bh * .5)) : 1, R = CS * (rise ? .14 : .1);
    let x = W / 2 - c.w / 2;
    const ws = c.words.map((w, i) => {
      const bw = wordW(w) + 2 * PADX, a = w.start - lead, b = i + 1 < c.words.length ? c.words[i + 1].start - lead : Infinity;
      const q = crisp ? clamp((t - a) / .05) : rise ? S(t - a, 28) : clamp((t - a) / .1) * (1 - clamp((t - b) / .1));
      const f = crisp ? 1 - clamp((t - b) / .05) : rise ? 1 - smooth(clamp((t - b) / .12)) : 1;
      const o = { w, x, bw, q, f }; x += bw + GAP; return o;
    });
    const word = (o, fill) => { ctx.fillStyle = fill; ctx.fillText(o.w.text, o.x + PADX, base); };
    // captions.block false (rise only): no accent block; each word appears when said and blurs in on its own (.16em -> 0)
    const lineB = rise && !crisp && !NOBLK ? (1 - p) * CS * .12 : 0;   // rise: the line blurs in, no slide
    ctx.save(); ctx.globalAlpha *= Math.min(1, p * 1.4); if (!rise) ctx.translate(0, (1 - p) * CS * .24);
    if (lineB > .3) ctx.filter = `blur(${(lineB * ctx.getTransform().a).toFixed(2)}px)`;
    ctx.font = K.font(CS, WT, CF); ctx.letterSpacing = LS + 'px'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic'; ctx.lineJoin = 'round';
    const ga = ctx.globalAlpha, inkC = rise ? cap.color || mixHex('#FFFFFF', C.ink, inkMix) : C.ink;   // captions.color (rise): one word color everywhere, e.g. white on a dark paper
    if (split) {   // ink words on a soft paper glow (no hard outline: the creator 2026-10-14 found the white border dirty), so they read on the video
      ctx.save(); ctx.shadowColor = C.sheet; ctx.shadowOffsetY = 0;
      for (const bl of [.5, .22]) { ctx.shadowBlur = CS * bl; for (const o of ws) word(o, C.ink); }
      ctx.restore();
      for (const o of ws) word(o, C.ink);
    } else if (rise) {
      // captions.shadow (rise, default 1): strength of the soft shadow under the white words on the video
      const SH = cap.shadow ?? 1;
      ctx.shadowColor = `rgba(0,0,0,${Math.min(.9, .45 * SH * (1 - inkMix)).toFixed(3)})`; ctx.shadowBlur = CS * .13 * Math.sqrt(SH); ctx.shadowOffsetY = CS * .03 * SH;
      if (NOBLK) for (const o of ws) {
        if (o.q <= .002) continue;
        const b = crisp ? 0 : (1 - o.q) * CS * .16;
        ctx.save(); ctx.globalAlpha = ga * Math.min(1, o.q * 1.25); if (b > .3) ctx.filter = `blur(${(b * ctx.getTransform().a).toFixed(2)}px)`;
        word(o, inkC); ctx.restore();
      } else for (const o of ws) word(o, inkC);
      ctx.shadowColor = 'transparent';
    } else {   // paper outline + the line's soft drop shadow; a word's outline fades out as its block fades in
      ctx.shadowColor = 'rgba(40,28,10,.3)'; ctx.shadowBlur = CS * .09; ctx.shadowOffsetY = CS * .05; ctx.lineWidth = CS * .22; ctx.strokeStyle = C.sheet;
      for (const o of ws) if (o.q < .998) { ctx.globalAlpha = ga * (1 - o.q); ctx.strokeText(o.w.text, o.x + PADX, base); }
      ctx.globalAlpha = ga; ctx.shadowColor = 'transparent';
      for (const o of ws) if (o.q < .998) { ctx.globalAlpha = ga * (1 - o.q); word(o, inkC); }   // ink crossfades to the white word
      ctx.globalAlpha = ga;
    }
    const riseBlock = (g, o, by, h, r) => {
      g.beginPath(); g.roundRect(o.x, by, o.bw, h, r); g.fillStyle = C.blue; g.fill(); g.clip();
      g.fillStyle = C.onBlue; g.fillText(o.w.text, o.x + PADX, base);
    };
    ctx.filter = 'none';
    if (NOBLK) { ctx.restore(); return; }
    for (const o of ws) {
      if (o.q <= .002 || o.f <= .002) continue;
      const h = bh, by = top, r = Math.min(R, h / 2);
      if (rise && (o.q < .998 || o.f < .998 || lineB > .3)) {   // blurring in or fading out: draw it sharp on a layer, composite once
        const m = ctx.getTransform(), cw = canvas.width, chh = canvas.height;
        const b = crisp ? 0 : Math.hypot((1 - o.q) * CS * .16, lineB), sc = crisp ? 1 : 1 + .04 * (1 - o.q), pad = 3 * b + o.bw * .05 + 4;
        const sx = Math.max(0, Math.floor(m.a * (o.x - pad) + m.e)), sy = Math.max(0, Math.floor(m.d * (by - pad) + m.f));
        const sw = Math.min(cw, Math.ceil(m.a * (o.x + o.bw + pad) + m.e)) - sx, sh = Math.min(chh, Math.ceil(m.d * (by + h + pad) + m.f)) - sy;
        if (sw <= 0 || sh <= 0) continue;
        const L = riseL ||= new OffscreenCanvas(cw, chh).getContext('2d');
        L.setTransform(1, 0, 0, 1, 0, 0); L.clearRect(sx, sy, sw, sh); L.setTransform(m);
        L.font = ctx.font; L.letterSpacing = ctx.letterSpacing; L.textAlign = 'left'; L.textBaseline = 'alphabetic';
        L.save(); riseBlock(L, o, by, h, r); L.restore();
        const cx = m.a * (o.x + o.bw / 2) + m.e, cy = m.d * (by + h / 2) + m.f;   // scale about the block center: it settles in place
        ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = ga * Math.min(1, o.q * 1.25) * o.f;
        if (b > .3) ctx.filter = `blur(${(b * m.a).toFixed(2)}px)`;
        ctx.drawImage(L.canvas, sx, sy, sw, sh, cx + (sx - cx) * sc, cy + (sy - cy) * sc, sw * sc, sh * sc); ctx.restore();
        continue;
      }
      ctx.save();
      if (rise) { riseBlock(ctx, o, by, h, r); ctx.restore(); continue; }
      if (!rise) {   // hard: the block fades in with a solid ink offset shadow, under the line's soft one
        ctx.globalAlpha = ga * o.q; ctx.shadowColor = 'rgba(40,28,10,.3)'; ctx.shadowBlur = CS * .09; ctx.shadowOffsetY = CS * .05;
        ctx.beginPath(); ctx.roundRect(o.x + CS * .07, by + CS * .07, o.bw, h, r); ctx.fillStyle = C.ink; ctx.fill(); ctx.shadowColor = 'transparent';
      }
      ctx.beginPath(); ctx.roundRect(o.x, by, o.bw, h, r); ctx.fillStyle = C.blue; ctx.fill();
      word(o, C.onBlue); ctx.restore();
    }
    ctx.restore();
  }

  // ---- camera
  const eyes = spec.cam?.eyes || [600, 400], [, , CW, CHh] = spec.cam?.crop || [0, 0, 1200, 1080];
  const camFit = (t, seam) => {
    const full = 1 - clamp(seam / 760), R = camRect(seam), z = zoomAt(t) * lerp(spec.cam?.splitZoom ?? 1.2, 1, full);
    const s = Math.max(R.w / CW, R.h / CHh) * z, bias = lerp(FR ? .37 : .32, .36, full);   // framed: a bit more headroom in the shorter card
    const y0 = clamp(R.y + R.h * bias - eyes[1] * s, R.y + R.h - CHh * s, R.y);
    return { s, x0: clamp(R.x + R.w / 2 - eyes[0] * s, R.x + R.w - CW * s, R.x), y0 };
  };
  // where a standard cutout stands on the paper (eyes at x, feet of the frame at bottom)
  const cutT = c => { const s = c.scale || 1.15; return { s, x0: (c.x ?? W / 2) - eyes[0] * s, y0: (c.bottom ?? H) - CHh * s }; };
  // during a hand-off the camera rides with the cutout: eyes glide from the cutout spot to the camera framing
  const lerpT = (A, B, p) => ({ s: lerp(A.s, B.s, p), x0: lerp(A.x0, B.x0, p), y0: lerp(A.y0, B.y0, p) });
  // a ride cutout reframes the camera: bottom-aligned at its scale, so the head can sit above the seam (the matte draws it there)
  const rideCut = t => stdCuts.find(c => c.ride && t >= c.from && t < c.to);
  const camT = (t, seam) => {
    const rc = rideCut(t);
    if (rc) { const s = Math.max(W / CW, rc.scale ?? 1.3) * zoomAt(t); return { s, x0: clamp(W / 2 - eyes[0] * s, W - CW * s, 0), y0: H - CHh * s }; }
    const T = camFit(t, seam), c = hoCut(t); if (!c) return T;
    const p = S(t - c.ho, 9); if (p >= .999) return T;
    const A = cutT(c), s = lerp(A.s, T.s, p);
    const ex = lerp(A.x0 + eyes[0] * A.s, T.x0 + eyes[0] * T.s, p), ey = lerp(A.y0 + eyes[1] * A.s, T.y0 + eyes[1] * T.s, p);
    return { s, x0: ex - eyes[0] * s, y0: ey - eyes[1] * s };
  };
  const roomIn = t => { const c = hoCut(t); return c ? Math.min(1, S(t - c.ho, 10) * 1.15) : 1; };
  // pause (tl.pause): the frozen frame drains to grey, colour comes back on resume
  const pz = tl.pause, pauseP = t => pz ? S(t - pz.t0, 18) * (1 - S(t - pz.t0 - pz.dur, 18)) : 0;
  const SIL = new OffscreenCanvas(CW, CHh), silx = SIL.getContext('2d');
  function backdrops(t, T, cam, cutImg) {
    const wipe = L => L.hard ? +(t >= L.at) : S(t - L.at, L.w || 6);
    let i0 = -1; layers.forEach((L, i) => { if (wipe(L) >= .999) i0 = i; });
    if (i0 >= 0 && layers[i0].kind === 'cam' && !layers[i0].img && i0 === layers.length - 1) return;   // back to the real room
    const draw = (L, imgs) => {
      if (L.kind === 'paper') ctx.drawImage(BG, 0, 0);
      else if (L.kind === 'cam') { if (cam) ctx.drawImage(cam, T.x0, T.y0, CW * T.s, CHh * T.s); }
      else { const im = imgs.get(L.url); if (im) { const k = 1.08 - .06 * clamp((t - L.at) / 12); K.cover(ctx, im, W / 2 - W * k / 2, H / 2 - H * k / 2, W * k, H * k, 0, L.focus || [.5, .5]); } }
      const ti = L.imgUrl && imgs.get(L.imgUrl); if (ti) ctx.drawImage(ti, 0, 0, W, H);
    };
    let top = null, prevSt = 0, topP = 1;
    layers.forEach((L, i) => {
      if (i < Math.max(0, i0) || t < L.at) return;
      const p = wipe(L); if (p <= .001) return;
      const [ox, oy] = L.origin || [W / 2, H / 2], R0 = Math.hypot(Math.max(ox, W - ox), Math.max(oy, H - oy)) * p;
      ctx.save(); ctx.beginPath(); ctx.arc(ox, oy, R0, 0, Math.PI * 2); ctx.clip(); draw(L, R_imgs); ctx.restore();
      if (p < .995) { ctx.save(); ctx.beginPath(); ctx.arc(ox, oy, R0, 0, Math.PI * 2); ctx.strokeStyle = 'rgba(252,251,248,.9)'; ctx.lineWidth = 10 * (1 - p) + 2; ctx.stroke(); ctx.restore(); }
      prevSt = top ? (top.sticker ? 1 : 0) : 0; top = L; topP = p;
    });
    if (!top || !cutImg) return;
    const cw = CW * T.s, ch = CHh * T.s, onCam = top.kind === 'cam';
    const stick = lerp(prevSt, top.sticker ? 1 : 0, topP), a = onCam ? 1 - topP : 1;
    if (stick > .01) {   // paper-cut sticker: white silhouette offset around the person, with a soft drop shadow
      silx.globalCompositeOperation = 'source-over'; silx.clearRect(0, 0, CW, CHh); silx.drawImage(cutImg, 0, 0, CW, CHh);
      silx.globalCompositeOperation = 'source-in'; silx.fillStyle = C.sheet; silx.fillRect(0, 0, CW, CHh);
      ctx.save(); ctx.globalAlpha = stick * a;
      K.drop(ctx, .28, 30, 12, '40,28,10'); ctx.drawImage(SIL, T.x0, T.y0 + 4, cw, ch); ctx.shadowColor = 'transparent';
      const r = 9; for (let k = 0; k < 12; k++) { const an = k * Math.PI / 6; ctx.drawImage(SIL, T.x0 + Math.cos(an) * r, T.y0 + Math.sin(an) * r, cw, ch); }
      ctx.restore();
    }
    if (cf && t >= cf.from && t <= cf.to + 1.2) capFly(t, T, cutImg);
    else ctx.drawImage(cutImg, T.x0, T.y0, cw, ch);
  }

  // ---- capfly {from, to, land: [x, y], scale}: the white cap leaves the head, flies into the backdrop, comes back.
  // The cap is keyed out of the person cutout (bright, unsaturated pixels in the top of the frame).
  const capCache = new WeakMap();
  function capKey(img) {
    let r = capCache.get(img); if (r) return r;
    const w = img.width, h = img.height, cv = new OffscreenCanvas(w, h), c = cv.getContext('2d', { willReadFrequently: true });
    c.drawImage(img, 0, 0); const d = c.getImageData(0, 0, w, h), px = d.data, sp = new OffscreenCanvas(w, h), sc = sp.getContext('2d'), sd = sc.createImageData(w, h);
    const lim = Math.round(eyes[1] * .86 * h / CHh); let x0 = w, y0 = h, x1 = 0, y1 = 0;
    const soft = Math.round(eyes[1] * .86 * h / CHh), isCap = i => px[i + 3] > 60 && Math.min(px[i], px[i + 1], px[i + 2]) > 62 && Math.max(px[i], px[i + 1], px[i + 2]) - Math.min(px[i], px[i + 1], px[i + 2]) < 38;
    for (let y = 0; y < lim; y++) {
      if (y >= soft) { let n = 0; for (let x = 0; x < w; x++) if (isCap((y * w + x) * 4)) n++; if (n < 140) continue; }   // brim rows only, never the glasses
      for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4, R = px[i], G = px[i + 1], B = px[i + 2], A = px[i + 3];
      if (isCap(i)) {
        sd.data.set([R, G, B, A], i); px[i] = 30; px[i + 1] = 22; px[i + 2] = 20;
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    } }
    for (let y = 0; y < lim; y++) {   // close the holes (logo, seams): fill each solid cap row between its first and last key
      let a0 = -1, a1 = -1, n = 0;
      for (let x = 0; x < w; x++) { const i = (y * w + x) * 4; if (sd.data[i + 3]) { n++; if (a0 < 0) a0 = x; a1 = x; } }
      if (n < 140) continue;
      for (let x = a0; x <= a1; x++) { const i = (y * w + x) * 4; if (px[i + 3] > 60 && !sd.data[i + 3]) { sd.data.set([px[i], px[i + 1], px[i + 2], px[i + 3]], i); px[i] = 30; px[i + 1] = 22; px[i + 2] = 20; } }
    }
    c.putImageData(d, 0, 0); sc.putImageData(sd, 0, 0);
    r = { cv, sp, box: x1 > x0 ? [x0, y0, x1 - x0 + 1, y1 - y0 + 1] : null, k: CW / w }; capCache.set(img, r); return r;
  }
  function capFly(t, T, cutImg) {
    const cur = capKey(cutImg), src = R_imgs.get(cutURL(cf.from)), spr = src && capKey(src);
    const back = S(t - cf.to, 5), done = back > .985;
    ctx.drawImage(done ? cutImg : cur.cv, T.x0, T.y0, CW * T.s, CHh * T.s);
    if (!done && back > .6) { ctx.save(); ctx.globalAlpha = (back - .6) / .4; ctx.drawImage(cutImg, T.x0, T.y0, CW * T.s, CHh * T.s); ctx.restore(); }
    if (done || !spr?.box) return;
    const k = spr.k * T.s, [bx, by, bw, bh] = spr.box, home = (b, kk) => [T.x0 + (b[0] + b[2] / 2) * kk, T.y0 + (b[1] + b[3] / 2) * kk];
    const [hx, hy] = home(spr.box, k), [rx, ry] = cur.box ? home(cur.box, cur.k * T.s) : [hx, hy];
    const go = S(t - cf.from, 4.2), [lx, ly] = cf.land || [880, 620], ls = cf.scale ?? .35;
    let x = lerp(hx, lx, go), y = lerp(hy, ly, go) - Math.sin(go * Math.PI) * 180, sc = lerp(1, ls, go), rot = go * -.5;
    x = lerp(x, rx, back); y = lerp(y, ry, back) - Math.sin(back * Math.PI) * 140; sc = lerp(sc, 1, back); rot = lerp(rot, 0, back);
    ctx.save(); ctx.translate(x, y); ctx.rotate(rot); ctx.scale(sc, sc);
    K.drop(ctx, .35, 24, 10, '0,0,0');
    ctx.drawImage(spr.sp, bx, by, bw, bh, -bw * k / 2, -bh * k / 2, bw * k, bh * k); ctx.restore();
  }

  // ---- orbit {src, from, orbitFrom, jumpAt, to, w}: a screenshot card presented, then orbiting around the head
  // (behind him on the far side, using the matte), then diving into his stomach.
  function orbit(t, seam, cutImg) {
    if (!ob || t < ob.from - .5 || t > ob.to + .3) return;
    const im = R_imgs.get('/p/' + ob.src); if (!im) return;
    const T = camT(t, seam), fx = T.x0 + eyes[0] * T.s, fy = T.y0 + eyes[1] * T.s, w0 = ob.w || 600, ar = im.height / im.width;
    const pin = S(t - ob.from + .3, 11), orb = S(t - ob.orbitFrom, 7), jump = S(t - ob.jumpAt, 6);
    const th = Math.max(0, t - ob.orbitFrom) * TAU * (ob.rev ?? .55), dep = Math.cos(th);
    let x = lerp(W / 2, fx + Math.sin(th) * 360, orb), y = lerp(250 + w0 * ar / 2, fy - 40 + dep * 60, orb), w = lerp(w0, w0 * (.5 + .14 * dep), orb);
    const bx = fx, by = fy + 560 * T.s / 1.6;
    x = lerp(x, bx, jump); y = lerp(y, by, jump) - Math.sin(jump * Math.PI) * 220; w = lerp(w, 30, jump);
    const behind = orb > .3 && (jump > .55 || (dep < 0 && jump < .2));
    const a = Math.min(1, pin * 1.4) * (1 - S(t - ob.to, 14)), h = w * ar;
    if (a < .003) return;
    ctx.save(); ctx.globalAlpha = a; ctx.translate(x, y + (1 - pin) * 60); ctx.rotate(orb * (1 - jump) * Math.sin(th) * .12 + jump * .8);
    K.drop(ctx, .35, 40, 14, '0,0,0');
    ctx.beginPath(); ctx.roundRect(-w / 2, -h / 2, w, h, w * .05); ctx.fillStyle = '#fff'; ctx.fill(); ctx.shadowColor = 'transparent';
    ctx.clip(); ctx.drawImage(im, -w / 2, -h / 2, w, h); ctx.restore();
    if (behind && cutImg) { ctx.save(); ctx.clip(camClip(seam)); ctx.drawImage(cutImg, T.x0, T.y0, CW * T.s, CHh * T.s); ctx.restore(); }
  }
  const TAU = Math.PI * 2;
  let R_imgs = new Map();
  // ---- vanish (spec.vanish {from, to, backAt, back .45, cell 12}): the camera turns to dust between from and to, swept left
  // to right (each block drifts up and right, shrinks, fades), the paper shows through, then from backAt the dust flies
  // back in. Keep it clear of a split <-> full window transition.
  // vanish.plate (an image of the empty room, see short.mjs plateFrame): only the speaker turns to dust, the room stays.
  // His silhouette, a bit dilated, is filled with the plate, so the wall and the props behind him show through.
  const VN = spec.vanish, VC = VN ? new OffscreenCanvas(W, H) : null, vcx = VC?.getContext('2d');
  const RF = VN?.plate ? new OffscreenCanvas(1, 1) : null, rfx = RF?.getContext('2d');
  let vnBox = null;
  function roomFill(cutI, plate) {
    RF.width = cutI.width; RF.height = cutI.height;
    rfx.globalCompositeOperation = 'source-over'; rfx.filter = `blur(${VN.grow ?? 10}px)`;
    for (let k = 0; k < 5; k++) rfx.drawImage(cutI, 0, 0);   // stacked blurs = his alpha grown by a few px, soft edge
    rfx.filter = 'none'; rfx.globalCompositeOperation = 'source-in'; rfx.drawImage(plate, 0, 0, RF.width, RF.height);
    return RF;
  }
  // his box at vanish.from (fractions of the cam frame), fixed so the dust grid never shifts while he moves
  function personBox(cutI) {
    if (vnBox) return vnBox;
    const w = 120, h = Math.round(w * cutI.height / cutI.width), cv = new OffscreenCanvas(w, h), c = cv.getContext('2d', { willReadFrequently: true });
    c.drawImage(cutI, 0, 0, w, h);
    const d = c.getImageData(0, 0, w, h).data;
    let a = w, b = h, e = -1, f = -1;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) if (d[(y * w + x) * 4 + 3] > 40) { a = Math.min(a, x); b = Math.min(b, y); e = Math.max(e, x); f = Math.max(f, y); }
    return vnBox = e < 0 ? [0, 0, 1, 1] : [a / w, b / h, (e + 1) / w, (f + 1) / h];
  }
  const vanishP = t => !VN || t < VN.from ? 0 : VN.backAt != null && t >= VN.backAt ? 1 - E5(clamp((t - VN.backAt) / (VN.back ?? .45))) : clamp((t - VN.from) / Math.max(.1, VN.to - VN.from));
  function dust(p, bx, by, bw, bh) {
    const c = VN.cell ?? 12, cols = Math.ceil(bw / c), rows = Math.ceil(bh / c), keep = new Path2D(), fly = [];
    for (let j = 0; j < rows; j++) {
      let run = -1;
      for (let i = 0; i <= cols; i++) {
        const n = K.hash(i * 13.1 + j * 71.7), q = i < cols ? clamp((p - (.62 * i / cols + .12 * (1 - j / rows) + .26 * n) * .72) / .28) : 1;
        if (q <= 0) { if (run < 0) run = i; continue; }
        if (run >= 0) { keep.rect(bx + run * c, by + j * c, (i - run) * c, c); run = -1; }
        if (q < 1) fly.push(i, j, q, n);
      }
    }
    ctx.save(); ctx.clip(keep); ctx.drawImage(VC, 0, 0, W, H); ctx.restore();
    ctx.save();
    for (let k = 0; k < fly.length; k += 4) {
      const sx = bx + fly[k] * c, sy = by + fly[k + 1] * c, q = fly[k + 2], n = fly[k + 3], z = 1 - .65 * q;
      const dx = q ** 1.5 * (240 + 420 * n), dy = -(q ** 1.2) * (160 + 300 * K.hash(n * 91 + 3)) + Math.sin(q * 5 + n * 9) * 18 * q;
      ctx.globalAlpha = (1 - q) ** 1.3; ctx.drawImage(VC, sx, sy, c, c, sx + dx, sy + dy, c * z, c * z);
    }
    ctx.restore();
  }
  function camera(img, t, seam, cutImg) {
    if (!img || seam >= H - 1) return;
    const T = camT(t, seam), { s, x0, y0 } = T, fade = roomIn(t);
    if (fade <= .002) return;
    const FRm = FR && seam > 2 ? camRect(seam) : null;
    if (FRm && FRm.h < 4) return;
    const vp = vanishP(t);
    const plate = vp > 0 && VN.plate ? R_imgs.get('/p/frames/plate.jpg') : null, cutI = plate && R_imgs.get(cutURL(t)), cut0 = cutI && R_imgs.get(cutURL(VN.from));
    if (cut0) {   // vanish.plate: the room stays, only he turns to dust
      const clipP = FRm ? rectPath(FRm) : edgePath(seam, true), dw = CW * s, dh = CHh * s;
      if (FRm) framePlate(FRm, fade);
      ctx.save(); ctx.globalAlpha = fade; ctx.clip(clipP); ctx.drawImage(img, x0, y0, dw, dh); ctx.drawImage(roomFill(cutI, plate), x0, y0, dw, dh); ctx.restore();
      if (vp < 1) {
        vcx.setTransform(1, 0, 0, 1, 0, 0); vcx.clearRect(0, 0, W, H); vcx.save(); vcx.clip(clipP); vcx.drawImage(cutI, x0, y0, dw, dh); vcx.restore();
        const [a, b, e, f] = personBox(cut0), pad = 36, bx = Math.max(0, x0 + a * dw - pad), by = Math.max(FRm ? FRm.y : seam, y0 + b * dh - pad);
        ctx.save(); ctx.globalAlpha = fade; dust(vp, bx, by, Math.min(W, x0 + e * dw + pad) - bx, Math.min(H, y0 + f * dh + pad) - by); ctx.restore();
      }
      if (FRm) frameEdge(FRm, fade);
      return;
    }
    if (vp >= 1) return;
    if (FRm) framePlate(FRm, fade * (1 - vp));
    if (vp > 0) {   // vanish: the clipped camera goes to a layer that dust() breaks up
      const clipP = FRm ? rectPath(FRm) : edgePath(seam, true), top = FRm ? FRm.y : seam;
      vcx.setTransform(1, 0, 0, 1, 0, 0); vcx.clearRect(0, 0, W, H); vcx.save(); vcx.clip(clipP); vcx.drawImage(img, x0, y0, CW * s, CHh * s); vcx.restore();
      ctx.save(); ctx.globalAlpha = fade; dust(vp, FRm ? FRm.x : 0, top, FRm ? FRm.w : W, FRm ? FRm.h : H - top); ctx.restore();
      if (FRm) frameEdge(FRm, fade * (1 - vp));
      return;
    }
    ctx.save(); ctx.globalAlpha = fade; ctx.clip(FRm ? rectPath(FRm) : edgePath(seam, true)); ctx.drawImage(img, x0, y0, CW * s, CHh * s);
    const g = pauseP(t);
    if (g > .002) { ctx.save(); ctx.globalAlpha = g; ctx.filter = 'grayscale(1) contrast(.9) brightness(1.04)'; ctx.drawImage(img, x0, y0, CW * s, CHh * s); ctx.restore(); }
    if (camCutOn(t) && t >= layers[0].at) backdrops(t, T, img, cutImg);
    ctx.restore();
    if (FRm) return frameEdge(FRm, fade);
    // paper casts a soft shadow onto the video, plus a crisp deckle edge
    if (seam > 2) {
      ctx.save(); ctx.globalAlpha = fade; ctx.clip(edgePath(seam, true));
      const dp = K.depth(), sh = 44 * (.5 + .5 * dp), g = ctx.createLinearGradient(0, seam, 0, seam + sh);
      g.addColorStop(0, `rgba(25,18,6,${Math.min(.6, .30 * dp).toFixed(3)})`); g.addColorStop(1, 'rgba(25,18,6,0)');
      ctx.fillStyle = g; ctx.fillRect(0, seam - 6, W, sh + 8); ctx.restore();
      ctx.save(); ctx.globalAlpha = fade; ctx.strokeStyle = 'rgba(60,45,20,.16)'; ctx.lineWidth = 1.5; ctx.stroke(edgeLine(seam)); ctx.restore();
    }
  }

  // ---- card camera: the take cover-fits the card, eyes at `bias` of its height, zoom.keys still punch in
  const cardFit = t => {
    const { x, y, w, h } = CARD, s = Math.max(w / CW, h / CHh) * CARD.zoom * zoomAt(t);
    return { s, x0: clamp(x + w / 2 - eyes[0] * s, x + w - CW * s, x), y0: clamp(y + h * CARD.bias - eyes[1] * s, y + h - CHh * s, y) };
  };
  function cardCamera(img, t) {
    const { x, y, w, h, r } = CARD, card = new Path2D(); card.roundRect(x, y, w, h, r);
    K.shadow(ctx, x, y, w, h, r, 44, .13, 18); K.shadow(ctx, x, y, w, h, r, 5, .06, 2);
    ctx.save(); ctx.clip(card); ctx.fillStyle = '#1b1f27'; ctx.fillRect(x, y, w, h);
    if (img) {
      const T = cardFit(t); ctx.drawImage(img, T.x0, T.y0, CW * T.s, CHh * T.s);
      const g = pauseP(t);
      if (g > .002) { ctx.save(); ctx.globalAlpha = g; ctx.filter = 'grayscale(1) contrast(.9) brightness(1.04)'; ctx.drawImage(img, T.x0, T.y0, CW * T.s, CHh * T.s); ctx.restore(); }
    }
    ctx.restore();
    ctx.save(); ctx.strokeStyle = 'rgba(255,255,255,.5)'; ctx.lineWidth = 3; ctx.stroke(card);
    ctx.strokeStyle = `rgba(${K.edgeRGB()},.10)`; ctx.lineWidth = 1; ctx.beginPath(); ctx.roundRect(x - .5, y - .5, w + 1, h + 1, r + .5); ctx.stroke(); ctx.restore();
  }
  // ---- header (spec.header {brand, mark, tagline, x, y, size}): a heavy italic wordmark top left (mark in the accent),
  // a gray tagline top right. Fixed on every frame of a card layout.
  const HDR = spec.header;
  function header() {
    if (!HDR || (!HDR.brand && !HDR.mark && !HDR.tagline)) return;
    const x = HDR.x ?? 62, y = HDR.y ?? 120, sz = HDR.size ?? 42;
    ctx.save(); ctx.font = `italic 900 ${sz}px ${K.F.sans}`; ctx.letterSpacing = '-1.2px'; ctx.textAlign = 'left'; ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = C.ink; ctx.fillText(HDR.brand || '', x, y);
    if (HDR.mark) { ctx.fillStyle = C.blue; ctx.fillText(HDR.mark, x + (HDR.brand ? ctx.measureText(HDR.brand).width + 1.2 : 0), y); }
    ctx.restore();
    if (HDR.tagline) K.text(ctx, HDR.tagline, W - x, y - 6, { size: HDR.tagSize ?? 27, weight: 500, ls: -.2, color: C.ink3, align: 'right' });
  }

  // ---- cutout: the speaker without background, standing on the paper (frames/cutout, made by matte.swift at prepare)
  // {from, to, scale: 1.15, x: 540, bottom: 1920}. Pair it with a seam of 1920 so the whole screen is paper.
  // {from, to, ride: true, scale: 1.3}: over a split, the camera is bottom-aligned at `scale` and he is drawn unclipped,
  // so his head pokes up in front of the board above the seam; in and out on the frame.
  function cutout(img, t) {
    const cut = stdCuts.find(c => onC(c, t));
    if (!img || !cut) return;
    const pin = cut.from <= 0 || cut.hard ? 1 : S(t - cut.from, 12);
    if (cut.ride) {   // ride: he stays in the camera framing, unclipped, so his head pokes up over the board above the seam
      if (t < cut.from || t >= cut.to) return;
      const { s, x0, y0 } = camT(t, seamAt(t));
      ctx.drawImage(img, x0, y0, CW * s, CHh * s); return;
    }
    if (cut.ho != null && t >= cut.ho - .05) {   // hand-off: ride the camera transform, drop the shadow, fade once aligned
      const p = S(t - cut.ho, 9), a = 1 - S(t - cut.ho - .55, 16), { s, x0, y0 } = camT(t, seamAt(t));
      if (a <= .002) return;
      ctx.save(); ctx.globalAlpha = a;
      K.drop(ctx, .22 * (1 - p), 36, 10);
      ctx.drawImage(img, x0, y0, CW * s, CHh * s); ctx.restore(); return;
    }
    const pout = cut.hard ? +(t >= cut.to) : K.leave(t - cut.to), a = Math.min(1, pin * 1.4) * (1 - pout);
    if (a <= .002) return;
    const s = cut.scale || 1.15, w = img.width * s, h = img.height * s;
    const x = (cut.x ?? W / 2) - eyes[0] * s, y = (cut.bottom ?? H) - h + (1 - pin) * 60 + pout * 60;
    ctx.save(); ctx.globalAlpha = a;
    K.drop(ctx, .22, 36, 10);
    ctx.drawImage(img, x, y, w, h); ctx.restore();
  }

  // ---- frame
  // one whole layout at `seam`: paper BG, stage, camera (cam: false leaves bare paper), cutout, orbit, 'over' scenes.
  // Captions are drawn once on top, by render().
  function frame(t, seam, imgs, { cam = true } = {}) {
    const ref = stageRef(t), cutImg = imgs.get(cutURL(t));
    const R = { ctx, t, spec, tl, cam: imgs.get(camURL(t)), frame: (id, ct) => imgs.get(mediaURL(id, ct)) || null, media: id => frames.media[id], img: u => imgs.get(u) || null, U, camT, camFit: sm => camFit(t, sm), camEdge: edgePath, CW, CHh, pause: pz, pauseP: pauseP(t), allChunks, seam, seamRef: ref ?? seam };
    ctx.drawImage(BG, 0, 0);
    if (CARD) {   // card layout: stage above the card, header, the camera card, then 'over' scenes
      ctx.save(); ctx.beginPath(); ctx.rect(0, 0, W, CARD.y - 6); ctx.clip();
      for (const a of actors) drawActor(R, a, t);
      for (const s of scenes) if (s.layer === 'stage' && t > s.from - 1 && t < (s.to ?? 1e9) + 1) SCENES[s.type]?.draw(R, s, t);
      ctx.restore();
      header();
      if (cam) cardCamera(R.cam, t);
      for (const s of scenes) if (s.layer === 'over' && t > s.from - 1 && t < (s.to ?? 1e9) + 1) SCENES[s.type]?.draw(R, s, t);
      return;
    }
    if (seam > 4) {
      ctx.save(); if (FR) { ctx.beginPath(); ctx.rect(0, 0, W, camRect(seam).y); ctx.clip(); } else ctx.clip(edgePath(seam, false)); if (ref != null) ctx.translate(0, Math.min(0, seam - ref));
      for (const a of actors) drawActor(R, a, t);
      for (const s of scenes) if (s.layer === 'stage' && t > s.from - 1 && t < (s.to ?? 1e9) + 1) SCENES[s.type]?.draw(R, s, t);
      ctx.restore();
    }
    if (cam) {
      camera(R.cam, t, seam, cut && cutImg);
      if (stdCuts.length) cutout(cutImg, t);
      orbit(t, seam, cutImg);
    }
    for (const s of scenes) if (s.layer === 'over' && t > s.from - 1 && t < (s.to ?? 1e9) + 1) SCENES[s.type]?.draw(R, s, t);
  }
  // quick fade + settle in (a cut that breathes), slow push while it plays, quick fade out
  function fullBroll(t, imgs) {
    for (const b of brolls) {
      if (!brollOn(b, t)) continue;
      const img = imgs.get(mediaURL(b.media, Math.max(0, (b.offset || 0) + t - b.from)));
      const hard = b.hard ?? HARD, pin = hard ? +(t >= b.from) : S(t - b.from, 22), a = brollA(b, t);
      if (!img || a <= .002) continue;
      const k = 1 + .035 * (1 - pin) + (b.zoom ?? .05) * clamp((t - b.from) / Math.max(1, b.to - b.from));
      ctx.save(); ctx.globalAlpha = a; K.cover(ctx, img, W / 2 - W * k / 2, H / 2 - H * k / 2, W * k, H * k, 0, b.focus || [.5, .5]); ctx.restore();
    }
  }
  // spec.glitch {keys: [[t, dur: .4, amp: 1]]}: a digital glitch of the whole frame centred on t (under a zhhh transition):
  // an RGB split and torn horizontal bands slid sideways, re-rolled every 2 frames, strongest at t, gone by t +- dur / 2
  const GL = spec.glitch?.keys || [], hr = x => { const v = Math.sin(x * 127.1 + 311.7) * 43758.5453; return v - Math.floor(v); };
  let glA, glB, glC;
  function glitch(t) {
    let e = 0, seed = 0;
    GL.forEach(([k, dur = .4, amp = 1], i) => { const u = Math.abs(t - k) / (dur / 2); if (u < 1 && amp * (1 - u) ** .7 > e) { e = amp * (1 - u) ** .7; seed = i * 17.3; } });
    const f = Math.floor(t * FPS / 2) + seed;
    if (e < .03 || (e < .6 && hr(f * 3.3) < .25)) return;   // a few clean frames inside the burst, so it stutters
    const cw = canvas.width, ch = canvas.height, px = cw / W;
    const mk = () => { const c = document.createElement('canvas'); c.width = cw; c.height = ch; return c.getContext('2d'); };
    glA ??= mk(); glB ??= mk(); glC ??= mk();
    glA.drawImage(canvas, 0, 0);
    for (const [g, col] of [[glB, '#f00'], [glC, '#0ff']]) {
      g.globalCompositeOperation = 'source-over'; g.drawImage(glA.canvas, 0, 0);
      g.globalCompositeOperation = 'multiply'; g.fillStyle = col; g.fillRect(0, 0, cw, ch);
    }
    const sx = Math.round((10 + 26 * hr(f * 1.7)) * e * px), sy = Math.round((hr(f * 2.9) - .5) * 8 * e * px);
    ctx.save(); ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.globalAlpha = 1; ctx.filter = 'none';
    ctx.globalCompositeOperation = 'source-over'; ctx.fillStyle = '#000'; ctx.fillRect(0, 0, cw, ch);
    ctx.drawImage(glB.canvas, sx, sy);
    ctx.globalCompositeOperation = 'lighter'; ctx.drawImage(glC.canvas, -sx, -sy);
    ctx.globalCompositeOperation = 'source-over';
    glA.drawImage(canvas, 0, 0);
    const n = 2 + Math.round(6 * e * hr(f * 5.1 + 2));
    for (let j = 0; j < n; j++) {
      const y = Math.floor(hr(f * 7.3 + j * 9.1) * ch), h = Math.ceil((8 + 150 * hr(f * 3.7 + j * 4.3) ** 2) * px), dx = Math.round((hr(f * 6.1 + j * 2.7) - .5) * 2 * 110 * e * px);
      ctx.drawImage(glA.canvas, 0, y, cw, h, dx, y, cw, h);
    }
    ctx.restore();
  }
  async function render(t) { await compose(t); if (GL.length) glitch(t); }
  async function compose(t) {
    const urls = needs(t); imgCap = Math.max(imgCap, urls.length * (AHEAD + 2) + 16);
    const w0 = performance.now(), imgs = new Map(await Promise.all(urls.map(async u => [u, await load(u)])));
    PERF.load += performance.now() - w0;
    for (let k = 1; k <= AHEAD; k++) needs(t + k / FPS).forEach(load);  // prefetch: AHEAD frames fetched and decoded in parallel
    R_imgs = imgs;
    ctx.setTransform(scale, 0, 0, scale, 0, 0);
    if (spec.shake?.keys) {   // spec.shake {keys: [[t, amp px, dur .5]]}: an impact shake of the whole frame, slightly zoomed so no edge shows
      let ox = 0, oy = 0, am = 0;
      spec.shake.keys.forEach(([k, amp = 24, dur = .5], i) => { const u = (t - k) / dur; if (u < 0 || u >= 1) return; const d = (1 - u) ** 2 * amp; am = Math.max(am, d);
        ox += d * (noise1(t * 34 + i * 7.7) - .5) * 2; oy += d * (noise1(t * 31 + i * 3.1 + 50) - .5) * 2; });
      if (am > .05) { const z = 1 + 2.4 * am / W; ctx.setTransform(scale * z, 0, 0, scale * z, scale * (W / 2 * (1 - z) + ox), scale * (H / 2 * (1 - z) + oy)); }
    }
    ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; ctx.filter = 'none';
    if (CARD) { frame(t, CARD.y, imgs); fullBroll(t, imgs); return captions(t, CARD.y); }
    const tr = trAt(t);
    if (!tr) { frame(t, seamAt(t), imgs); fullBroll(t, imgs); return captions(t, seamSmooth(t)); }
    // window: the paper stays still at the split seam, the camera card opens over it (margins and corners bulge mid-move)
    const sA = seamAt(t, { i: tr.i, p: 0 }), sB = seamAt(t, { i: tr.i, p: 1 }), p = tr.p, cam = imgs.get(camURL(t));
    const split = sA || sB, top = lerp(sA, sB, p), open = 1 - top / split, bump = Math.sin(Math.PI * p), m = 34 * bump, r = 56 * bump;
    frame(t, split, imgs, { cam: false });
    if (FR) {   // framed: the photo itself grows to full screen (and shrinks back), border and corners melting away
      const Rc = lerpRect(camRect(sA), camRect(sB), p), T = lerpT(camFit(t, sA), camFit(t, sB), p), o = 1 - Rc.y / camRect(split).y;
      ctx.fillStyle = `rgba(20,16,8,${(.22 * o).toFixed(3)})`; ctx.fillRect(0, 0, W, H);
      framePlate(Rc);
      ctx.save(); ctx.clip(rectPath(Rc)); if (cam) ctx.drawImage(cam, T.x0, T.y0, CW * T.s, CHh * T.s); ctx.restore();
      frameEdge(Rc); fullBroll(t, imgs);
      return captions(t, top, { from: sA, to: sB, p, camTop: top <= 2 ? -1e4 : Rc.y - Rc.b });
    }
    ctx.fillStyle = `rgba(20,16,8,${(.22 * open).toFixed(3)})`; ctx.fillRect(0, 0, W, H);
    const T = lerpT(camFit(t, sA), camFit(t, sB), p), card = new Path2D(); card.roundRect(m, top, W - 2 * m, H - top - m, r);
    ctx.save(); ctx.shadowColor = 'rgba(20,16,8,.34)'; ctx.shadowBlur = 44; ctx.shadowOffsetY = 12; ctx.fillStyle = '#2a241c'; ctx.fill(card); ctx.restore();
    ctx.save(); ctx.clip(card); if (cam) ctx.drawImage(cam, T.x0, T.y0, CW * T.s, CHh * T.s); ctx.restore();
    fullBroll(t, imgs);
    captions(t, top, { from: sA, to: sB, p, camTop: top <= 2 ? -1e4 : top });
  }

  // window.encodeStart / encodeUnit / encodeEnd: render and hardware-encode right here (lib/encode.js)
  installEncoder(canvas, render, PERF);
  window.framePNG = async t => { await render(t); return canvas.toDataURL('image/png').split(',')[1]; };   // lossless, for QC
  window.frameJPEG = async (t, q = .92) => { await render(t); return canvas.toDataURL('image/jpeg', q).split(',')[1]; };
  window.DUR = tl.duration;
  window.LIVE = { render, spec, tl, canvas, FPS };   // the live preview (lib/player.js) drives render(t) itself
  PERF_BOOT.ready = performance.now(); window.PERF_BOOT = PERF_BOOT;
  window.READY = true;
}
