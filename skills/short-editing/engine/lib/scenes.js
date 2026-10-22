// Scene library. A scene is {type, from, to, layer?: 'stage' | 'over', ...params} in spec.scenes (times already
// mapped to SHORT time). Stage scenes live on the paper above the seam; 'over' scenes float above everything.
// R = runtime handle: {ctx, t, seam, spec, tl, frame(mediaId, clipT) -> bitmap|null, cam -> bitmap}.
import { C, D, W, H, clamp, lerp, seg, E, S, leave, vis, press, track, sheet, shadow, text, measure, midBase, wrap, chip, cursor, cover, checkIcon, sheetFill, hash, noise1, zoomLayer, zoomAt } from './kit.js';
import { typing } from './timeline.js';
import { STORY } from './scenes-story.js';
import { LIFE } from './scenes-life.js';
import { META } from './scenes-meta.js';
import { FACE } from './scenes-faceless.js';
import { MASTER } from './scenes-master.js';
import { CRASH } from './scenes-crash.js';
import { CLEAN } from './scenes-clean.js';

const TAU = Math.PI * 2;
const hex = c => [1, 3, 5].map(i => parseInt(c.slice(i, i + 2), 16));
export const mix = (a, b, p) => { const x = hex(a), y = hex(b); return `rgb(${x.map((v, i) => Math.round(lerp(v, y[i], clamp(p)))).join(',')})`; };
function alpha(ctx, a, fn) { if (a <= .002) return; ctx.save(); ctx.globalAlpha *= a; fn(); ctx.restore(); }
// Rise-in: p 0..1 from a spring. Content slides up `dist` px and fades in. No overshoot, ever.
function rise(ctx, p, dist, fn, dx = 0) { alpha(ctx, Math.min(1, p * 1.35), () => { ctx.translate(dx * (1 - p), dist * (1 - p)); fn(); }); }
// Real logos: a `logo` that is a project image path ('assets/logos/x.png') is drawn as an app icon (contain, rounded clip).
export const isImgLogo = v => typeof v === 'string' && /\.(png|jpe?g|webp)$/i.test(v);
function logoImg(R, ctx, src, x, y, size, r = size * .22, o = {}) {
  const im = R.img('/p/' + src); if (!im) return;
  const k = Math.min(size / im.width, size / im.height), w = im.width * k, h = im.height * k;
  ctx.save(); ctx.beginPath(); ctx.roundRect(x, y, size, size, r); ctx.clip();
  if (o.gray) ctx.filter = `grayscale(${o.gray})`;
  ctx.imageSmoothingQuality = 'high'; ctx.drawImage(im, x + (size - w) / 2, y + (size - h) / 2, w, h); ctx.restore();
}
// Scene-level envelope: enter spring, exit fade + small lift.
// _gate (linkScenes): right after another scene's exit, the enter waits until the old one is mostly gone.
// push: 0.04 = a slow push-in over the whole scene (scale 1 -> 1.04 from `from` to `to`, sine eased), around pushAt
// (default the stage centre; give output px for an 'over' scene). Long-form: keeps a held card alive without a cut.
function env(ctx, s, t, fn) {
  const out = s.to == null ? 0 : s.hard ? +(t >= s.to) : leave(t - s.to), at = Math.max(s.from - (s.pre || 0), s._gate ?? -1e9);   // pre: enter early (hook on frame 1)
  alpha(ctx, 1 - out, () => {
    ctx.translate(0, -36 * out * out);
    if (s.push) {
      const u = Math.min(1, Math.max(0, (t - at) / Math.max(.5, (s.to ?? at + 6) - at))), k = 1 + s.push * (1 - Math.cos(Math.PI * u)) / 2;
      const [px, py] = s.pushAt || [540, 540];
      zoomAt(ctx, k, px, py);
    }
    fn(S(t - at, 12));
  });
}
const clipTime = (t, from, offset = 0) => Math.max(0, offset + t - from);

// ---------------------------------------------------------------- media card ("actor")
export function actorNeeds(a, t) {
  const pre = a.pre || 0;
  if (t < a.from - pre - .05 || t > (a.to ?? 1e9) + .7) return [];
  return [[a.media, clipTime(t, a.from, a.offset)]];
}

function card(R, x, y, w, h, img, o = {}) {
  const { ctx } = R;
  if (o.stack) alpha(ctx, o.stack, () => {
    ctx.save(); ctx.translate(x + w / 2 + 10, y + h / 2 + 12); ctx.rotate(-.028); ctx.translate(-(x + w / 2), -(y + h / 2));
    sheet(ctx, x - 12, y - 12, w + 24, h + 24, 30, { elev: .7 }); ctx.restore();
  });
  sheet(ctx, x - 12, y - 12, w + 24, h + 24, 30, { elev: o.elev ?? 1.2 });
  cover(ctx, img, x, y, w, h, 20);
  ctx.save(); ctx.beginPath(); ctx.roundRect(x, y, w, h, 20); ctx.strokeStyle = 'rgba(20,22,27,.08)'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.restore();
  if (o.dim > .002) {
    ctx.save(); ctx.beginPath(); ctx.roundRect(x - 12, y - 12, w + 24, h + 24, 30); ctx.clip();
    ctx.globalCompositeOperation = 'saturation'; ctx.globalAlpha = o.dim; ctx.fillStyle = '#808080'; ctx.fillRect(x - 12, y - 12, w + 24, h + 24);
    ctx.globalCompositeOperation = 'source-over'; ctx.globalAlpha = o.dim * .5; ctx.fillStyle = C.paper; ctx.fillRect(x - 12, y - 12, w + 24, h + 24);
    ctx.restore();
  }
}

// Card label: a plain line of text above the card's sheet (never on top of the content). dot = colour or null.
export function cardLabel(ctx, x, y, label, dot, a = 1, dy = 0, logo = null) {
  if (a <= .002) return;
  const size = 42, by = y - 12 - 26 + dy;
  alpha(ctx, a, () => {
    let tx = x - 4;
    if (logo) { logo(tx, by - size * .36 - 25, 50); tx += 66; }
    else if (dot) { ctx.beginPath(); ctx.arc(tx + 10, by - size * .36, 10, 0, TAU); ctx.fillStyle = dot; ctx.fill(); tx += 34; }
    text(ctx, label, tx, by, { size, weight: 700, ls: -.8, color: C.ink });
  });
}

function labelAt(list, t) { let cur = null, prev = null, at = -1e9; for (const [k, v] of list || []) if (t >= k) { prev = cur; cur = v; at = k; } return { cur, prev, at }; }

export function drawActor(R, a, t) {
  const { ctx } = R, pre = a.pre || 0;
  // hard (cuts: 'hard' style or the actor's own hard: true): the card is there in one frame and gone in one frame, no slide
  const pin = a.hard ? +(t >= a.from - pre) : S(t - (a.from - pre), 12), pout = a.to == null ? 0 : a.hard ? +(t >= a.to) : leave(t - a.to);
  if (pin <= .001 || pout >= .999) return;
  const [x, y, w] = track(t, a.keys, 11), h = w * (a.ar || 9 / 16);  // ar = h/w (16 / 9 for a phone-format card)
  const img = R.frame(a.media, clipTime(t, a.from, a.offset));
  const right = a.enter === 'right';
  ctx.save();
  ctx.globalAlpha *= Math.min(1, pin * 1.35) * (1 - pout);
  ctx.translate(right ? (1 - pin) * 700 : 0, (right ? 0 : (1 - pin) * 90) - pout * 50);
  const sc = .965 + .035 * pin, cx = x + w / 2, cy = y + h / 2;
  ctx.translate(cx, cy); ctx.scale(sc, sc); ctx.translate(-cx, -cy);
  const dim = a.dimAt != null ? S(t - a.dimAt, 10) : 0;
  card(R, x, y, w, h, img, { stack: a.stack ? S(t - (a.from - pre) - .12, 10) : 0, dim });
  // highlighter strokes sweeping over phrases in the card: rect = [dx, dy, w, h] from the card's top-left.
  // mark = one stroke, marks = several (a phrase that wraps = one stroke per line, staggered `at`)
  for (const mk of [].concat(a.mark || [], a.marks || [])) {
    const { at, dur = .6, rect: [dx, dy, mw, mh] } = mk, p = E.cubic(seg(t, at, at + dur));
    if (p > .002) { ctx.save(); ctx.globalCompositeOperation = 'multiply'; ctx.fillStyle = 'rgba(37,142,255,.3)'; ctx.beginPath(); ctx.roundRect(x + dx - 8, y + dy - 4, (mw + 16) * p, mh + 8, 10); ctx.fill(); ctx.restore(); }
  }
  if (a.ringAt != null) {
    const p = S(t - a.ringAt, 12);
    alpha(ctx, p, () => { ctx.beginPath(); ctx.roundRect(x - 12 - 7 * (1 - p) - 4, y - 12 - 7 * (1 - p) - 4, w + 32 + 14 * (1 - p), h + 32 + 14 * (1 - p), 34); ctx.strokeStyle = C.blue; ctx.lineWidth = 5; ctx.stroke(); });
  }
  const L = labelAt(a.labelKeys, t);
  if (L.cur) {
    const sw = S(t - L.at, 16), dot = a.dot === 'blue' ? C.blue : a.dot === 'gray' ? C.ink3 : null;
    const lg = isImgLogo(a.labelLogo) ? (lx, ly, sz) => logoImg(R, ctx, a.labelLogo, lx, ly, sz) : null;   // labelLogo replaces the dot
    if (L.prev && sw < 1) cardLabel(ctx, x, y, L.prev, dot, 1 - sw, -18 * sw, lg);
    cardLabel(ctx, x, y, L.cur, dot, L.prev ? sw : 1, L.prev ? 18 * (1 - sw) : 0, lg);
  }
  if (a.badge) {
    const p = S(t - a.badge.at - .1, 13);
    if (p > .002) chip(ctx, x + w + 12, y - 12 - 26 - 15, a.badge.text, { align: 'right', size: 38, h: 76, fill: C.blue, color: C.white, check: true, checkP: E.out(seg(t, a.badge.at + .15, a.badge.at + .5)), alpha: Math.min(1, p * 1.4), scale: .9 + .1 * p, border: false });
  }
  ctx.restore();
}

// ---------------------------------------------------------------- scenes
const stat = {
  draw(R, s, t) {
    const { ctx } = R;
    env(ctx, s, t, pin => {
      const fam = D.font || undefined, wt = D.font ? D.weight : 800;   // style.display family when set
      const size = s.size || 300, ls = -size * (D.font ? .03 : .035), slot = measure(ctx, '0', size, wt, ls, fam) + ls;
      const fin = String(s.value), cnt = E.out(seg(t, s.countFrom, s.countTo)), cur = String(Math.round(s.value * cnt));
      const sw = s.suffix ? measure(ctx, s.suffix, size, wt, ls, fam) : 0, total = fin.length * slot + sw + size * .02;
      const x0 = W / 2 - total / 2, base = s.y;
      rise(ctx, pin, 70, () => {
        for (let i = 0; i < fin.length; i++) { const j = i - (fin.length - cur.length); if (j >= 0) text(ctx, cur[j], x0 + i * slot + slot / 2, base, { size, weight: wt, ls, fam, align: 'center' }); }
        if (s.suffix) text(ctx, s.suffix, x0 + fin.length * slot + size * .02, base, { size, weight: wt, ls, fam, color: C.blue });
      });
      if (s.chip) { const p = S(t - s.chip.at, 13); if (p > .002) rise(ctx, p, 26, () => chip(ctx, W / 2, s.chip.y, s.chip.text, { size: 40, h: 80, fill: C.blue, color: C.white, border: false })); }
    });
  },
};

const bars = {
  draw(R, s, t) {
    const { ctx } = R, bw = s.w || 900, x0 = (W - bw) / 2, bh = 108;   // centred, so it also works on the 1920-wide format
    env(ctx, s, t, () => {
      // tags row: final layout computed up front so chips never shift when a new one lands
      const tags = s.tags || [], tw = tags.map(g => measure(ctx, g.text, 40, 700, -.3) + 60), gap = 16;
      let tx = W / 2 - (tw.reduce((a, b) => a + b, 0) + gap * (tags.length - 1)) / 2;
      tags.forEach((g, i) => {
        const p = S(t - g.at, 13), cx = tx + tw[i] / 2; tx += tw[i] + gap;
        if (p > .002) rise(ctx, p, 22, () => chip(ctx, cx, 250, g.text, { size: 40, h: 82, padX: 30, fill: g.blue ? C.blue : undefined, color: g.blue ? C.white : C.ink, border: !g.blue }));
      });
      const rowY = i => s.y + i * 230;
      s.rows.forEach((r, i) => {
        const p = S(t - r.at, 12), ly = rowY(i), by = ly + 30;
        rise(ctx, p, 40, () => {
          text(ctx, r.label, x0, ly, { size: 54, weight: 800, color: r.blue ? C.ink : C.ink2, ls: -.8 });
          ctx.beginPath(); ctx.roundRect(x0, by, bw, bh, 30); ctx.fillStyle = 'rgba(40,30,10,.05)'; ctx.fill();
          ctx.strokeStyle = 'rgba(40,30,10,.06)'; ctx.lineWidth = 1.5; ctx.stroke();
          const g = S(t - r.at - .08, 6.5), bwv = Math.max(bh, bw * r.value * g);
          if (g > .002) { ctx.beginPath(); ctx.roundRect(x0, by, bwv, bh, 30); ctx.fillStyle = r.blue ? C.blue : r.dark ? C.ink3 : C.dim; ctx.fill(); }
        });
      });
      if (s.gapAt != null && s.rows.length > 1) {
        const a = s.rows[1], b = s.rows[0], gx1 = x0 + bw * a.value, gx2 = x0 + bw * b.value, by1 = rowY(1) + 30;
        const p1 = E.out(seg(t, s.gapAt, s.gapAt + .5)), p2 = E.out(seg(t, s.gapAt + .15, s.gapAt + .7)), yb = rowY(1) + 30 + bh + 50;
        alpha(ctx, p1, () => {  // ghost of the missing bar: tucked under the short bar's round end, flush with the long bar's end
          ctx.save(); const clip = new Path2D(); clip.rect(0, 0, W, 2000); clip.roundRect(x0, by1, gx1 - x0, bh, 30); ctx.clip(clip, 'evenodd');
          ctx.beginPath(); ctx.roundRect(gx1 - 30, by1, gx2 - gx1 + 30, bh, 30); ctx.fillStyle = 'rgba(37,142,255,.12)'; ctx.fill();
          ctx.setLineDash([10, 9]); ctx.strokeStyle = 'rgba(37,142,255,.7)'; ctx.lineWidth = 2.5; ctx.stroke(); ctx.setLineDash([]); ctx.restore();
          ctx.save(); ctx.setLineDash([6, 8]); ctx.strokeStyle = 'rgba(37,142,255,.7)'; ctx.lineWidth = 2.5;   // guide from the long bar's end
          ctx.beginPath(); ctx.moveTo(gx2 - 1, rowY(0) + 30 + bh + 8); ctx.lineTo(gx2 - 1, by1 - 8); ctx.stroke(); ctx.restore();
        });
        ctx.save(); ctx.strokeStyle = C.ink; ctx.lineWidth = 3; ctx.lineCap = 'round';
        for (const gx of [gx1, gx2]) { ctx.beginPath(); ctx.moveTo(gx, yb - 16); ctx.lineTo(gx, lerp(yb - 16, yb + 16, p2)); ctx.stroke(); }
        const mx = (gx1 + gx2) / 2, hw = (gx2 - gx1) / 2 * p2;
        if (p2 > 0) { ctx.beginPath(); ctx.moveTo(mx - hw, yb); ctx.lineTo(mx + hw, yb); ctx.stroke(); }
        ctx.restore();
        if (s.gapChip) { const p = S(t - s.gapChip.at, 13); if (p > .002) rise(ctx, p, 20, () => chip(ctx, mx, yb + 62, s.gapChip.text, { size: 36, h: 72 })); }
      }
    });
  },
};

const tiles = {
  draw(R, s, t) {
    const { ctx } = R, n = s.items.length, size = 250, gap = 40, x0 = W / 2 - (n * size + (n - 1) * gap) / 2, y = s.y;
    env(ctx, s, t, pin => {
      if (s.header) rise(ctx, S(t - s.header.at + (s.pre || 0), 12), 40, () => text(ctx, s.header.text, W / 2, y - 70, { size: 64, weight: 800, ls: -1.5, align: 'center' }));
      s.items.forEach((it, i) => {
        const p = S(t - it.at + (s.pre || 0), 13), x = x0 + i * (size + gap);
        if (p <= .002) return;
        rise(ctx, p, 50, () => {
          const st = it.strikeAt != null ? E.out(seg(t, it.strikeAt, it.strikeAt + .3)) : 0, off = it.strikeAt != null ? S(t - it.strikeAt - .15, 12) : 0;
          sheet(ctx, x, y, size, size, 58, { elev: 1.1 - .5 * off });
          if (isImgLogo(it.logo)) alpha(ctx, 1 - .55 * off, () => logoImg(R, ctx, it.logo, x + 45, y + 45, 160, 38, { gray: off }));
          else text(ctx, it.glyph, x + size / 2, midBase(y + size / 2, 116), { size: 116, weight: 800, ls: -3, align: 'center', color: mix(C.ink, C.ink3, off) });
          text(ctx, it.label, x + size / 2, y + size + 66, { size: 42, weight: 700, align: 'center', color: mix(C.ink2, C.ink3, off) });
          if (st > 0) {
            ctx.save(); ctx.strokeStyle = C.ink; ctx.lineWidth = 11; ctx.lineCap = 'round';
            const ax = x - 14, ay = y + size + 14, bx = x + size + 14, by = y - 14;
            ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(lerp(ax, bx, st), lerp(ay, by, st)); ctx.stroke(); ctx.restore();
          }
        });
      });
    });
  },
};

const title = {
  draw(R, s, t) {
    const { ctx } = R, size = s.size || 124, ls = -size * .03, lh = size * 1.12, cy = s.y ?? 470;
    env(ctx, s, t, () => {
      s.lines.forEach((ln, li) => {
        const words = ln.text.split(' '), ws = words.map(w => measure(ctx, w, size, 800, ls)), sp = measure(ctx, ' ', size, 800, ls);
        let x = W / 2 - (ws.reduce((a, b) => a + b, 0) + sp * (words.length - 1)) / 2;
        const base = midBase(cy - (s.lines.length - 1) * lh / 2 + li * lh, size);
        words.forEach((w, i) => {
          const p = S(t - ln.at + (s.pre || 0) - i * .06, 13), isE = ln.emph && ln.emph.split(' ').includes(w);
          const col = isE ? (ln.emphAt != null ? mix(C.ink, C.blue, S(t - ln.emphAt, 14)) : C.blue) : C.ink, wx = x;
          if (p > .002) rise(ctx, p, 60, () => text(ctx, w, wx, base, { size, weight: 800, ls, color: col }));
          x += ws[i] + sp;
        });
      });
    });
  },
};

// ---- chat mock: new chat -> focus -> word-synced typing -> send -> working -> result card
const chat = {
  needs(s, t) { const r = s.result; return r && t >= r.at - .3 && t <= (s.to ?? 1e9) + .7 ? [[r.media, clipTime(t, r.at, r.offset)]] : []; },
  prep(s, R) {
    if (s._p) return s._p;
    const { ctx } = R, [X, Y, Wd, Hd] = s.rect, fs = 40, lh = 54, tw = Wd - 72 - 72 - 96;
    const lines = wrap(ctx, s.prompt.text, tw, fs, 500);
    const toks = typing(s.prompt.text, R.tl.words, s.prompt.from, s.prompt.to);
    const charAt = []; let c = 0;  // cumulative char count at the end of each token
    toks.forEach((k, i) => { c += k.tok.length + (i ? 1 : 0); charAt.push(c); });
    const lineStart = []; let acc = 0; lines.forEach(l => { lineStart.push(acc); acc += l.length + 1; });
    const hKeys = [[0, 1]];
    lines.forEach((l, i) => { if (i) { const ti = charAt.findIndex(v => v > lineStart[i]); if (ti >= 0) hKeys.push([toks[ti].start, i + 1]); } });
    hKeys.push([s.sendAt, 1]);
    const bfs = 36, blh = 48, bl0 = wrap(ctx, s.prompt.text, Wd - 180, bfs, 500), bl = bl0.length > 3 ? [...bl0.slice(0, 2), bl0[2].replace(/\s*\S*$/, '') + '…'] : bl0, bw = Math.max(...bl.map(l => measure(ctx, l, bfs, 500))) + 56, bh = bl.length * blh + 44;
    return (s._p = { X, Y, Wd, Hd, fs, lh, tw, lines, toks, charAt, lineStart, hKeys, bfs, blh, bl, bw, bh });
  },
  draw(R, s, t) {
    const { ctx } = R, P = chat.prep(s, R), { X, Y, Wd, Hd, fs, lh, lines, toks } = P;
    env(ctx, s, t, pin => rise(ctx, pin, 90, () => {
      sheet(ctx, X, Y, Wd, Hd, 40, { elev: 1.5 });
      // header
      const hy = Y + 66;
      ctx.beginPath(); ctx.arc(X + 58, hy, 11, 0, TAU); ctx.fillStyle = C.blue; ctx.fill();
      text(ctx, 'Claude', X + 82, midBase(hy, 40), { size: 40, weight: 700, ls: -.5 });
      const pr = press(t, s.newChatAt, .22);
      chip(ctx, X + Wd - 30, hy, '+ Nouveau chat', { align: 'right', size: 34, h: 70, padX: 26, fill: pr > 0 ? mix('#FCFBF8', '#E6F0FD', pr) : undefined, scale: 1 - .05 * pr, elev: .3 });
      ctx.fillStyle = C.line; ctx.fillRect(X + 30, Y + 130, Wd - 60, 1.5);
      // old conversation skeleton, swept away by "Nouveau chat"
      const old = 1 - S(t - s.newChatAt, 16);
      alpha(ctx, old, () => {
        ctx.translate(0, -40 * (1 - old));
        const bar = (x, y, w, h, c) => { ctx.beginPath(); ctx.roundRect(x, y, w, h, h / 2); ctx.fillStyle = c; ctx.fill(); };
        bar(X + Wd - 44 - 380, Y + 176, 380, 64, C.tint);
        [700, 640, 730, 420].forEach((w, i) => bar(X + 44, Y + 290 + i * 44, w, 18, '#E8E3D8'));
        bar(X + Wd - 44 - 280, Y + 500, 280, 64, C.tint);
        [720, 600, 680].forEach((w, i) => bar(X + 44, Y + 614 + i * 44, w, 18, '#E8E3D8'));
      });
      // greeting
      const gOut = S(t - s.sendAt + .05, 30), gP = S(t - s.newChatAt - .12, 12) * (1 - gOut);
      if (gP > .002) rise(ctx, Math.min(1, S(t - s.newChatAt - .12, 12)), 30, () => alpha(ctx, 1 - gOut, () => {
        ctx.translate(0, -30 * gOut);
        text(ctx, s.greeting ?? "Qu'est-ce qu'on crée ?", X + Wd / 2, Y + 420, { size: 54, weight: 700, ls: -1.2, align: 'center' });
      }));
      // composer
      const nL = track(t, P.hKeys, 20), ch = 44 + nL * lh + 40, cb = Y + Hd - 34, ct = cb - ch, cx = X + 34, cw = Wd - 68;
      const focus = S(t - s.focusAt, 20), sent = t >= s.sendAt;
      shadow(ctx, cx, ct, cw, ch, 30, 10, .06, 3);
      ctx.beginPath(); ctx.roundRect(cx, ct, cw, ch, 30); ctx.fillStyle = C.white; ctx.fill();
      ctx.strokeStyle = focus > .01 && !sent ? mix('#E3DED3', '#258EFF', focus) : C.line; ctx.lineWidth = 1.5 + 1.5 * (sent ? 0 : focus); ctx.stroke();
      let n = 0;  // revealed chars
      if (!sent) toks.forEach((k, i) => { const sp = i ? 1 : 0, d = Math.min(.26, Math.max(.08, k.end - k.start)); n += t >= k.start ? sp + Math.round(k.tok.length * clamp((t - k.start) / d)) : 0; });
      const tx = cx + 36, ty0 = ct + 44 + fs * .74;
      if (n === 0) text(ctx, sent ? 'Répondre…' : s.placeholder ?? 'Décris ta vidéo…', tx, ty0, { size: fs, weight: 500, color: C.ink3 });
      let cxr = tx, cyr = ty0;
      lines.forEach((l, i) => {
        const vis_ = clamp(n - P.lineStart[i], 0, l.length); if (vis_ <= 0) return;
        const str = l.slice(0, vis_), yy = ty0 + i * lh;
        text(ctx, str, tx, yy, { size: fs, weight: 500, color: C.ink }); cxr = tx + measure(ctx, str, fs, 500); cyr = yy;
      });
      if (focus > .01 && !sent) alpha(ctx, focus, () => { ctx.fillStyle = C.blue; ctx.fillRect(cxr + 3, cyr - fs * .8, 3.5, fs * .98); });
      const sbx = cx + cw - 32 - 34, sby = cb - 32 - 34, has = n > 0 ? 1 : 0, sp = press(t, s.sendAt, .2);
      ctx.save(); ctx.translate(sbx, sby); ctx.scale(1 - .1 * sp, 1 - .1 * sp);
      ctx.beginPath(); ctx.arc(0, 0, 34, 0, TAU); ctx.fillStyle = has ? C.blue : C.dim; ctx.fill();
      ctx.strokeStyle = C.white; ctx.lineWidth = 5; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
      ctx.beginPath(); ctx.moveTo(0, 13); ctx.lineTo(0, -13); ctx.moveTo(-11, -2); ctx.lineTo(0, -13); ctx.lineTo(11, -2); ctx.stroke(); ctx.restore();
      // sent bubble travels from the composer to the thread (FLIP-style)
      if (sent) {
        const p = S(t - s.sendAt, 11), bx = X + Wd - 44 - P.bw, by = Y + 168, sc = lerp(fs / P.bfs, 1, p);
        const fy = lerp(ct, by, p), fx = lerp(tx - 28, bx, p);
        alpha(ctx, Math.min(1, p * 4), () => {
          ctx.translate(fx, fy); ctx.scale(sc, sc);
          ctx.beginPath(); ctx.roundRect(0, 0, P.bw, P.bh, 30); ctx.fillStyle = C.tint; ctx.fill();
          P.bl.forEach((l, i) => text(ctx, l, 28, 22 + P.bfs * .76 + i * P.blh + 2, { size: P.bfs, weight: 500, color: C.ink }));
        });
        const ry = by + P.bh + 50;
        const wP = S(t - s.workFrom, 13) * (s.result ? 1 - S(t - s.result.at, 18) : 1);
        alpha(ctx, wP, () => {
          ctx.beginPath(); ctx.arc(X + 56, ry, 10, 0, TAU); ctx.fillStyle = C.blue; ctx.fill();
          text(ctx, s.workText || 'Opus 5.5 crée ta vidéo', X + 80, midBase(ry, 40), { size: 40, weight: 700, color: C.ink2 });
          ctx.beginPath(); ctx.roundRect(X + 44, ry + 48, 520, 10, 5); ctx.fillStyle = C.line; ctx.fill();
          const g = E.io(seg(t, s.workFrom + .1, s.workTo));
          if (g > 0) { ctx.beginPath(); ctx.roundRect(X + 44, ry + 48, Math.max(10, 520 * g), 10, 5); ctx.fillStyle = C.blue; ctx.fill(); }
        });
        const r = s.result, rp = r ? S(t - r.at, 12) : 0;
        if (rp > .002) rise(ctx, rp, 60, () => {
          const w = Math.min(760, Wd - 112), h = w * 9 / 16, x = X + 56, y = ry + 44;
          card(R, x, y, w, h, R.frame(r.media, clipTime(t, r.at, r.offset)), { elev: 1 });
          cardLabel(ctx, x, y, r.label || 'Opus 5.5', C.blue);
        });
      }
      // pointer: springs between targets, presses on each click
      const pill = [X + Wd - 130, hy + 6], comp = [X + 360, ct + 60], send = [sbx + 6, sby + 8], rest = [X + Wd + 40, Y + Hd + 200];
      const keys = [[s.from, rest], [s.newChatAt - .6, pill], [s.focusAt - .55, comp], [s.focusAt + .5, [X + Wd - 150, Y + Hd - 260]], [s.sendAt - .6, send], [s.sendAt + .5, rest]];
      const [px, py] = track(t, keys, 9), ca = vis(t, s.from + .3, s.sendAt + .55, 10, 10);
      cursor(ctx, px, py, { alpha: ca, press: Math.max(press(t, s.newChatAt, .2), press(t, s.focusAt, .2), press(t, s.sendAt, .2)) });
    }));
  },
};

// ---- convo: a live Claude thread. The creator's lines type into blue bubbles on his own spoken words, Opus streams its
// replies word by word on its TTS clip (spec.voices), and an image reply resolves from coarse pixels. The thread
// scrolls up as it grows; every message keeps its final size from the moment it appears.
let CNOISE = null;
const convo = {
  needs(s, t) { return t > s.from - 1 && t < (s.to ?? 1e9) + 1 ? s.msgs.filter(m => m.image && t >= m.at - .4).map(m => '/p/' + m.image) : []; },
  prep(s, R) {
    if (s._p) return s._p;
    const { ctx } = R, [X, Y, Wd, Hd] = s.rect, fs = s.size || 42, lh = Math.round(fs * 1.3), gap = s.gap ?? 30, ls = -.3;
    const head = 128, top = Y + head + 34, view = Y + Hd - 36 - top, tx = 92;
    const place = (lines, wt) => lines.flatMap((l, li) => { let x = 0; return l.split(' ').map(w => { const o = { w, x, li }; x += measure(ctx, w + ' ', fs, wt, ls); return o; }); });
    let y = 0;
    const items = s.msgs.map(m => {
      let it;
      if (m.who === 'me') {
        const padX = 34, padY = 24, lines = wrap(ctx, m.text, Math.min(740, Wd - 180) - padX * 2, fs, 600, ls);
        const bw = Math.max(...lines.map(l => measure(ctx, l, fs, 600, ls))) + padX * 2, h = lines.length * lh + padY * 2 - (lh - fs) + 4;
        it = { y, h, bw, padX, padY, ws: place(lines, 600), toks: typing(m.text, R.tl.words, m.from, m.to), t0: m.from - .12 };
      } else if (m.image) it = { y, h: m.size || 560, t0: m.at };
      else {
        const lines = wrap(ctx, m.text, Wd - tx - 60, fs, 500, ls);
        it = { y, h: lines.length * lh - (lh - fs) + 8, ws: place(lines, 500), t0: m.at };
      }
      it.m = m; y += it.h + gap; return it;
    });
    const sKeys = [[-1e9, 0]];
    for (const it of items) sKeys.push([it.t0, Math.max(0, it.y + it.h - view), 9]);
    return (s._p = { X, Y, Wd, Hd, fs, lh, ls, head, top, view, tx, items, sKeys });
  },
  draw(R, s, t) {
    const { ctx } = R, P = convo.prep(s, R), { X, Y, Wd, Hd, fs, lh, ls, head, top, tx } = P;
    env(ctx, s, t, pin => rise(ctx, pin, 90, () => {
      sheet(ctx, X, Y, Wd, Hd, 40, { elev: 1.5 });
      const hy = Y + 66;
      LOGO.claude(ctx, X + 66, hy, 26, C.ink);
      text(ctx, s.title || 'Claude', X + 108, midBase(hy, 42), { size: 42, weight: 800, ls: -.6 });
      chip(ctx, X + Wd - 32, hy, s.model || 'Opus 5.5', { align: 'right', size: 34, h: 70, padX: 26, dot: C.blue, elev: .3 });
      ctx.fillStyle = C.line; ctx.fillRect(X + 30, Y + head, Wd - 60, 1.5);
      const sc = track(t, P.sKeys, 9);
      ctx.save(); ctx.beginPath(); ctx.roundRect(X, Y + head + 2, Wd, Hd - head - 2, [0, 0, 40, 40]); ctx.clip();
      ctx.translate(0, top - sc);
      for (const it of P.items) {
        const m = it.m, p = S(t - it.t0, 13);
        if (p <= .002 || it.y + it.h < sc - 40 || it.y > sc + P.view + 60) continue;
        if (m.who === 'me') rise(ctx, p, 30, () => {
          const bx = X + Wd - 36 - it.bw, by = it.y;
          shadow(ctx, bx, by, it.bw, it.h, 30, 10, .08, 3);
          ctx.beginPath(); ctx.roundRect(bx, by, it.bw, it.h, [32, 32, 10, 32]); ctx.fillStyle = C.blue; ctx.fill();
          it.ws.forEach((w, k) => {
            const q = S(t - (it.toks[k]?.start ?? it.t0), 24);
            if (q > .002) alpha(ctx, Math.min(1, q * 1.3), () => text(ctx, w.w, bx + it.padX + w.x, by + it.padY + fs * .8 + w.li * lh + (1 - q) * 10, { size: fs, weight: 600, ls, color: C.white }));
          });
        });
        else if (m.image) rise(ctx, p, 40, () => {
          const x = X + tx, y = it.y, sz = it.h, img = R.img('/p/' + m.image), q = E.io(seg(t, m.genFrom, m.sharpAt));
          sheet(ctx, x - 10, y - 10, sz + 20, sz + 20, 32, { elev: 1.1 });
          ctx.save(); ctx.beginPath(); ctx.roundRect(x, y, sz, sz, 22); ctx.clip();
          ctx.fillStyle = '#E9E5DB'; ctx.fillRect(x, y, sz, sz);
          if (img && t >= m.genFrom) {
            const px = Math.max(1, Math.round(80 * Math.pow(1 - q, 2.2)));
            if (px <= 1) cover(ctx, img, x, y, sz, sz);
            else { const n = Math.ceil(sz / px), oc = new OffscreenCanvas(n, n); cover(oc.getContext('2d'), img, 0, 0, n, n); ctx.imageSmoothingEnabled = false; ctx.drawImage(oc, x, y, n * px, n * px); ctx.imageSmoothingEnabled = true; }
            if (!CNOISE) { CNOISE = new OffscreenCanvas(256, 256); const g = CNOISE.getContext('2d'), d = g.createImageData(256, 256); for (let i = 0; i < d.data.length; i += 4) { const v = hash(i * .37) * 255; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; } g.putImageData(d, 0, 0); }
            const na = (1 - q) * .5;
            if (na > .01) { ctx.globalAlpha = na; ctx.globalCompositeOperation = 'overlay'; const f = Math.floor(t * 30), ox = (f * 97) % 256, oy = (f * 61) % 256; for (let yy = y - oy; yy < y + sz; yy += 256) for (let xx = x - ox; xx < x + sz; xx += 256) ctx.drawImage(CNOISE, xx, yy); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; }
            const fl = t >= m.sharpAt ? Math.exp(-(t - m.sharpAt) * 5) : 0;
            if (fl > .01) { ctx.fillStyle = `rgba(255,255,255,${fl * .7})`; ctx.fillRect(x, y, sz, sz); }
          }
          ctx.restore();
          const gp = vis(t, m.at + .1, m.sharpAt + .15, 14, 14);
          if (gp > .002) chip(ctx, x + 24, y + sz - 54, `${m.label || 'Dessin'} · ${Math.round(q * 100)} %`, { align: 'left', size: 34, h: 70, padX: 26, alpha: gp, elev: .5 });
        });
        else {
          alpha(ctx, Math.min(1, p * 1.4), () => LOGO.claude(ctx, X + 56, it.y + fs * .45, 20, C.ink));
          it.ws.forEach((w, k) => {
            const q = S(t - m.at - (m.offs?.[k] ?? k * .18), 22);
            if (q > .002) alpha(ctx, Math.min(1, q * 1.3), () => text(ctx, w.w, X + tx + w.x, it.y + fs * .8 + w.li * lh + (1 - q) * 10, { size: fs, weight: 500, ls, color: C.ink }));
          });
        }
      }
      ctx.restore();
    }));
  },
};

// ---- scatter: benchmark chart (e.g. intelligence vs cost). Axes grow in, points land one by one, then a
// vertical bracket (dy) and a horizontal bracket (dx) measure the gap between a reference point and a challenger.
const scatter = {
  draw(R, s, t) {
    const { ctx } = R, P = s.plot || {}, px0 = P.x0 ?? 170, px1 = P.x1 ?? 960, py0 = P.y0 ?? 420, py1 = py0 + (P.h ?? 680);
    const [xa, xb] = s.xRange, [ya, yb] = s.yRange;
    const lx = v => s.xLog ? Math.log(v) : v;   // xLog: log-scale cost axis, like Artificial Analysis
    const X = v => px0 + (lx(v) - lx(xa)) / (lx(xb) - lx(xa)) * (px1 - px0), Y = v => py1 - (v - ya) / (yb - ya) * (py1 - py0);
    const col = c => c === 'blue' ? C.blue : c === 'ink' ? C.ink : C.ink3;
    env(ctx, s, t, pin => {
      if (s.header) rise(ctx, S(t - s.header.at, 12), 40, () => text(ctx, s.header.text, W / 2, 240, { size: 64, weight: 800, ls: -1.8, align: 'center' }));
      if (s.sub) rise(ctx, S(t - s.sub.at, 12), 30, () => text(ctx, s.sub.text, W / 2, 300, { size: 34, weight: 600, color: C.ink2, align: 'center' }));
      // axes + grid
      const g = E.out(seg(t, s.from + .05, s.from + .6)), ga = S(t - s.from - .15, 12);
      alpha(ctx, ga, () => {
        (s.yTicks || []).forEach(v => {
          ctx.fillStyle = 'rgba(40,30,10,.07)'; ctx.fillRect(px0, Y(v) - 1, (px1 - px0) * g, 2);
          text(ctx, String(v), px0 - 22, midBase(Y(v), 34), { size: 34, weight: 600, color: C.ink3, align: 'right' });
        });
        (s.xTicks || []).forEach(v => text(ctx, (s.xPrefix || '') + v + (s.xSuffix || ''), X(v), py1 + 54, { size: 34, weight: 600, color: C.ink3, align: 'center' }));
        if (s.yLabel) text(ctx, s.yLabel, px0 - 80, py0 - 34, { size: 34, weight: 700, color: C.ink2 });
        if (s.xLabel) text(ctx, s.xLabel, px1, py1 + 118, { size: 34, weight: 700, color: C.ink2, align: 'right' });
      });
      ctx.save(); ctx.strokeStyle = C.ink; ctx.lineWidth = 3; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(px0, py1); ctx.lineTo(px0, lerp(py1, py0 - 10, g)); ctx.moveTo(px0, py1); ctx.lineTo(lerp(px0, px1 + 10, g), py1); ctx.stroke(); ctx.restore();
      // brackets (behind the points)
      const pts = s.points, ref = pts[s.ref ?? 0], vs = pts[s.vs ?? 1];
      const rx = X(ref.x), ry = Y(ref.y), vx = X(vs.x), vy = Y(vs.y);
      if (s.dyAt != null) {
        const bx = Math.max(rx, vx) + 50, p0 = E.out(seg(t, s.dyAt, s.dyAt + .45)), p1 = E.out(seg(t, s.dyAt + .15, s.dyAt + .6));
        ctx.save(); ctx.setLineDash([10, 9]); ctx.strokeStyle = 'rgba(37,142,255,.6)'; ctx.lineWidth = 2.5;
        if (p0 > 0) { ctx.beginPath(); ctx.moveTo(rx + 20, ry); ctx.lineTo(lerp(rx + 20, bx + 16, p0), ry); ctx.stroke(); }
        ctx.setLineDash([]); ctx.strokeStyle = C.ink; ctx.lineWidth = 3; ctx.lineCap = 'round';
        for (const yy of [ry, vy]) if (p1 > 0) { ctx.beginPath(); ctx.moveTo(bx - 14, yy); ctx.lineTo(bx - 14 + 28 * p1, yy); ctx.stroke(); }
        const my = (ry + vy) / 2, hh = (vy - ry) / 2 * p1;
        if (p1 > 0) { ctx.beginPath(); ctx.moveTo(bx, my - hh); ctx.lineTo(bx, my + hh); ctx.stroke(); }
        ctx.restore();
        if (s.dyChip) { const p = S(t - s.dyChip.at, 13); if (p > .002) rise(ctx, p, 20, () => chip(ctx, bx + 26, my, s.dyChip.text, { align: 'left', size: 36, h: 72, padX: 24 })); }
      }
      if (s.dxAt != null) {
        const by = Math.max(ry, vy) + 90, p1 = E.out(seg(t, s.dxAt, s.dxAt + .5)), x1 = Math.min(rx, vx), x2 = Math.max(rx, vx);
        ctx.save(); ctx.strokeStyle = C.ink; ctx.lineWidth = 3; ctx.lineCap = 'round';
        for (const xx of [x1, x2]) { ctx.beginPath(); ctx.moveTo(xx, by - 16); ctx.lineTo(xx, lerp(by - 16, by + 16, p1)); ctx.stroke(); }
        const mx = (x1 + x2) / 2, hw = (x2 - x1) / 2 * p1;
        if (p1 > 0) { ctx.beginPath(); ctx.moveTo(mx - hw, by); ctx.lineTo(mx + hw, by); ctx.stroke(); }
        ctx.restore();
        if (s.dxChip) { const p = S(t - s.dxChip.at, 13); if (p > .002) rise(ctx, p, 20, () => chip(ctx, mx, by + 62, s.dxChip.text, { size: 36, h: 72, padX: 24 })); }
      }
      // arrows (behind the points): a jump from one model to another, with a fixed-size delta card
      (s.arrows || []).forEach(ar => {
        const A = pts[ar.pair[0]], B = pts[ar.pair[1]], ax = X(A.x), ay = Y(A.y), bx = X(B.x), by = Y(B.y);
        const d = Math.hypot(bx - ax, by - ay), ux = (bx - ax) / d, uy = (by - ay) / d, p = E.out(seg(t, ar.at, ar.at + .55));
        if (p > .002) {
          const x0 = ax + ux * 30, y0 = ay + uy * 30, L = (d - 62) * p, ex = x0 + ux * L, ey = y0 + uy * L;
          ctx.save(); ctx.strokeStyle = C.blue; ctx.fillStyle = C.blue; ctx.lineWidth = 7; ctx.lineCap = 'round'; ctx.lineJoin = 'round';
          ctx.beginPath(); ctx.moveTo(x0, y0); ctx.lineTo(ex - ux * 14, ey - uy * 14); ctx.stroke();
          const hs = 30 * Math.min(1, p * 1.6);
          ctx.beginPath(); ctx.moveTo(ex, ey); ctx.lineTo(ex - ux * hs - uy * hs * .55, ey - uy * hs + ux * hs * .55); ctx.lineTo(ex - ux * hs + uy * hs * .55, ey - uy * hs - ux * hs * .55); ctx.closePath(); ctx.fill();
          ctx.restore();
        }
        if (!ar.card) return;
        const c = ar.card, pc = S(t - c.at, 13); if (pc <= .002) return;
        const cw = c.w || 210, ch = c.h || 128, cx = (ax + bx) / 2 + (c.dx || 0), cy = (ay + by) / 2 + (c.dy || 0), left = c.align === 'right' ? cx - cw : cx;
        rise(ctx, pc, 20, () => {
          shadow(ctx, left, cy - ch / 2, cw, ch, 22, 24, .12, 6);
          ctx.beginPath(); ctx.roundRect(left, cy - ch / 2, cw, ch, 22); ctx.fillStyle = C.sheet; ctx.fill(); ctx.strokeStyle = C.blue; ctx.lineWidth = 3; ctx.stroke();
          text(ctx, c.text, left + cw / 2, cy - 10, { size: 40, weight: 800, ls: -1, color: C.blue, align: 'center' });
          if (c.sub) { const ps = S(t - c.sub.at, 13); if (ps > .002) rise(ctx, ps, 10, () => text(ctx, c.sub.text, left + cw / 2, cy + 40, { size: 34, weight: 700, color: C.ink2, align: 'center' })); }
        });
      });
      // points + labels (a point without label is a small grey context dot)
      pts.forEach(pt => {
        const p = S(t - pt.at, 13); if (p <= .002) return;
        if (!pt.label) { alpha(ctx, Math.min(1, p * 1.4) * .6, () => { ctx.beginPath(); ctx.arc(X(pt.x), Y(pt.y), 11 * (.4 + .6 * p), 0, TAU); ctx.fillStyle = C.ink3; ctx.fill(); }); return; }
        const x = X(pt.x), y = Y(pt.y), big = pt.color !== 'gray', r = (big ? 17 : 13) * (.4 + .6 * p), c = col(pt.color);
        alpha(ctx, Math.min(1, p * 1.4), () => {
          ctx.beginPath(); ctx.arc(x, y, r + 5, 0, TAU); ctx.fillStyle = C.sheet; ctx.fill();
          ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fillStyle = c; ctx.fill();
        });
        const left = pt.side === 'left', tx = x + (left ? -34 : 34) + (pt.dx || 0), ty = y + (pt.dy || 0), al = left ? 'right' : 'left', ns = big ? 44 : 38;
        rise(ctx, S(t - pt.at - .08, 13), 16, () => {
          text(ctx, pt.label, tx, ty + (pt.sub ? -4 : ns * .36), { size: ns, weight: 800, ls: -.8, color: pt.color === 'blue' ? C.blue : big ? C.ink : C.ink2, align: al, halo: 10 });
          if (pt.sub) text(ctx, pt.sub, tx, ty + 42, { size: 34, weight: 600, color: C.ink2, align: al, halo: 10 });
        });
      });
      if (s.ringAt != null) {
        const p = S(t - s.ringAt, 12);
        alpha(ctx, p, () => { ctx.beginPath(); ctx.arc(rx, ry, 30 + 12 * (1 - p), 0, TAU); ctx.strokeStyle = C.blue; ctx.lineWidth = 4.5; ctx.stroke(); });
      }
    });
  },
};

const chipScene = {
  draw(R, s, t) {
    const { ctx } = R;
    env(ctx, s, t, pin => rise(ctx, pin, 30, () => chip(ctx, W / 2, s.y, s.text, { size: s.size || 44, h: (s.size || 44) * 2, fill: s.blue ? C.blue : undefined, color: s.blue ? C.white : C.ink, border: !s.blue })));
  },
};

const cta = {
  // avatar: 'assets/images/mascot-avatar.jpg' replaces the face cropped from the camera (faceless styles)
  needs(s, t) { return s.avatar && t >= s.from - 1.5 && t <= (s.to ?? 1e9) + 1 ? ['/p/' + s.avatar] : []; },
  draw(R, s, t) {
    const { ctx } = R, w = 840, h = 196, x = W / 2 - w / 2 - 30, y = s.y - h / 2;
    env(ctx, s, t, pin => rise(ctx, pin, 90, () => {
      sheet(ctx, x, y, w, h, 48, { elev: 1.8 });
      const ax = x + 38 + 62, ay = y + h / 2;
      ctx.save(); ctx.beginPath(); ctx.arc(ax, ay, 62, 0, TAU); ctx.clip();
      const e = R.spec.cam?.eyes || [600, 400], av = s.avatar && R.img('/p/' + s.avatar);
      if (av) ctx.drawImage(av, ax - 62, ay - 62, 124, 124);
      else if (R.cam && !s.avatar) ctx.drawImage(R.cam, e[0] - 250, e[1] - 210, 500, 500, ax - 62, ay - 62, 124, 124); ctx.restore();
      ctx.beginPath(); ctx.arc(ax, ay, 62, 0, TAU); ctx.strokeStyle = 'rgba(20,22,27,.08)'; ctx.lineWidth = 2; ctx.stroke();
      // a long name or sub shrinks to stay clear of the button (short legacy texts keep 48 / 36)
      const room = w - 34 - (measure(ctx, s.button, 38, 700) + 64) - 190 - 14, fit = (str, size, wt, min) => Math.max(min, Math.min(size, size * room / Math.max(1, measure(ctx, str, size, wt))));
      text(ctx, s.name, x + 190, y + 86, { size: fit(s.name, 48, 800, 34), weight: 800, ls: -.8 });
      text(ctx, s.sub, x + 190, y + 138, { size: fit(s.sub, 36, 600, 26), weight: 600, color: C.ink2 });
      const d = S(t - s.clickAt, 16), pr = press(t, s.clickAt, .2);
      const w1 = measure(ctx, s.button, 38, 700) + 64, w2 = measure(ctx, s.done, 38, 700) + 64 + 40, bw = lerp(w1, w2, d), bx = x + w - 34 - bw, bh = 86;
      ctx.save(); const bcx = bx + bw / 2; ctx.translate(bcx, ay); ctx.scale(1 - .05 * pr, 1 - .05 * pr); ctx.translate(-bcx, -ay);
      ctx.beginPath(); ctx.roundRect(bx, ay - bh / 2, bw, bh, bh / 2); ctx.fillStyle = mix(C.blue, '#EDEAE2', d); ctx.fill();
      alpha(ctx, 1 - d, () => text(ctx, s.button, bcx, midBase(ay, 38), { size: 38, weight: 700, color: C.white, align: 'center' }));
      alpha(ctx, d, () => { checkIcon(ctx, bx + 32 + 14, ay, 26, C.ink, E.out(seg(t, s.clickAt + .1, s.clickAt + .45)), 4.5); text(ctx, s.done, bx + 32 + 40, midBase(ay, 38), { size: 38, weight: 700, color: C.ink }); });
      ctx.restore();
      const keys = [[s.from, [W + 60, y + h + 260]], [s.clickAt - .6, [bx + bw * .55, ay + 12]]];
      const [px, py] = track(t, keys, 9);
      cursor(ctx, px, py, { alpha: S(t - s.from - .15, 10), press: pr });
    }));
  },
};

// ---- switch: two app tiles with a toggle between them (Codex <-> Claude). sideKeys [[t, 0 | 1]]: 0 = left active.
// headerKeys [[t, text]] cross-fade above; chips [{text, at, side}] stack under their tile and dim with it.
const LOGO = {
  claude(ctx, cx, cy, r, col) {   // starburst
    ctx.save(); ctx.strokeStyle = col; ctx.lineCap = 'round'; ctx.lineWidth = r * .2;
    for (let i = 0; i < 11; i++) {
      const a = i * TAU / 11 - Math.PI / 2 + .12, l = r * (.62 + .38 * ((i * 7) % 5) / 4);
      ctx.beginPath(); ctx.moveTo(cx + Math.cos(a) * r * .14, cy + Math.sin(a) * r * .14); ctx.lineTo(cx + Math.cos(a) * l, cy + Math.sin(a) * l); ctx.stroke();
    }
    ctx.restore();
  },
  codex(ctx, cx, cy, r, col) { text(ctx, '>_', cx, midBase(cy, r * 1.1) - r * .06, { size: r * 1.1, weight: 800, align: 'center', color: col, fam: 'JetBrains Mono' }); },
};
function crossText(ctx, keys, t, x, y, o, pre = 0) {
  const { cur, prev, at } = labelAt(keys, t + pre); if (cur == null) return;
  const p = S(t - at + (prev == null ? pre : 0), 13);   // pre: the first header is already on screen at frame 1
  if (prev != null && p < 1) alpha(ctx, 1 - p, () => text(ctx, prev, x, y - 30 * p, o));
  alpha(ctx, Math.min(1, p * 1.35), () => text(ctx, cur, x, y + 30 * (1 - p), o));
}
const switchScene = {
  draw(R, s, t) {
    const { ctx } = R, y = s.y ?? 420, size = 250, tw = 200, th = 104, gap = 60, x0 = W / 2 - (size * 2 + tw + gap * 2) / 2;
    const xs = [x0, x0 + size + gap * 2 + tw], k = clamp(track(t, s.sideKeys, s.w || 13)), cy = y + size / 2;
    env(ctx, s, t, pin => {
      if (s.headerKeys) crossText(ctx, s.headerKeys, t, W / 2, y - 80, { size: 64, weight: 800, ls: -1.5, align: 'center' }, s.pre || 0);
      rise(ctx, pin, 50, () => {
        s.tiles.forEach((it, i) => {
          const act = i ? k : 1 - k, x = xs[i];
          sheet(ctx, x, y, size, size, 58, { elev: .5 + .7 * act });
          if (act > .01) alpha(ctx, act, () => { ctx.beginPath(); ctx.roundRect(x - 9, y - 9, size + 18, size + 18, 66); ctx.strokeStyle = C.blue; ctx.lineWidth = 6; ctx.stroke(); });
          const col = mix(C.ink3, C.ink, act);
          if (isImgLogo(it.logo)) alpha(ctx, .55 + .45 * act, () => logoImg(R, ctx, it.logo, x + 45, y + 45, size - 90, 40, { gray: 1 - act }));
          else if (LOGO[it.logo]) LOGO[it.logo](ctx, x + size / 2, cy, 78, col);
          else text(ctx, it.glyph, x + size / 2, midBase(cy, 110), { size: 110, weight: 800, ls: -3, align: 'center', color: col });
          text(ctx, it.label, x + size / 2, y + size + 70, { size: 46, weight: 800, ls: -.8, align: 'center', color: mix(C.ink3, C.ink, act) });
        });
        // toggle: paper track, blue knob slides to the active side
        const tx = x0 + size + gap, ty = cy - th / 2;
        sheet(ctx, tx, ty, tw, th, th / 2, { elev: .35 });
        ctx.beginPath(); ctx.roundRect(tx + 6, ty + 6, tw - 12, th - 12, (th - 12) / 2); ctx.fillStyle = 'rgba(40,30,10,.05)'; ctx.fill();
        const kr = th / 2 - 12, kx = lerp(tx + th / 2, tx + tw - th / 2, k);
        shadow(ctx, kx - kr, cy - kr, kr * 2, kr * 2, kr, 14, .18, 4);
        ctx.beginPath(); ctx.arc(kx, cy, kr, 0, TAU); ctx.fillStyle = C.blue; ctx.fill();
      });
      const n = [0, 0];
      for (const c of s.chips || []) {
        const p = S(t - c.at, 13), i = c.side ? 1 : 0, j = n[i]++; if (p <= .002) continue;
        const act = i ? k : 1 - k, cw = measure(ctx, c.text, 38, 700, -.3) + 56, cx = clamp(xs[i] + size / 2, 60 + cw / 2, W - 60 - cw / 2);
        rise(ctx, p, 22, () => chip(ctx, cx, y + size + 160 + j * 96, c.text, { size: 38, h: 78, padX: 28, fill: c.blue ? C.blue : undefined, color: c.blue ? C.white : C.ink, border: !c.blue, alpha: .4 + .6 * act }));
      }
    });
  },
};

// ---- tree: a project folder in mono. lines [{text: '├── CLAUDE.md', at, link: {text: 'AGENTS.md', at}}]
// Tree glyphs render in ink3, the name in ink, the symlink arrow + target in blue.
const tree = {
  draw(R, s, t) {
    const { ctx } = R, [x, y, w] = s.rect || [70, 380, 940], size = s.size || 42, lh = size * 1.7, pad = 54;
    const h = s.lines.length * lh + pad * 2 - (lh - size);
    env(ctx, s, t, pin => rise(ctx, pin, 60, () => {
      sheet(ctx, x, y, w, h, 36, { elev: 1.1 });
      const cw = measure(ctx, 'M', size, 500, 0, 'JetBrains Mono');
      s.lines.forEach((ln, i) => {
        const p = S(t - ln.at, 14); if (p <= .002) return;
        const m = ln.text.match(/^([│├└─\s]*)(.*)$/), pre = m[1], name = m[2], by = y + pad + size * .8 + i * lh;
        rise(ctx, p, 18, () => {
          const tx = x + pad;
          if (pre) text(ctx, pre, tx, by, { size, weight: 500, color: C.ink3, fam: 'JetBrains Mono' });
          text(ctx, name, tx + pre.length * cw, by, { size, weight: name.endsWith('/') ? 800 : 700, color: C.ink, fam: 'JetBrains Mono' });
          if (ln.link) {
            const q = S(t - ln.link.at, 14), lx = tx + (pre.length + name.length + 1) * cw;
            if (q > .002) rise(ctx, q, 0, () => text(ctx, '→ ' + ln.link.text, lx, by, { size, weight: 700, color: C.blue, fam: 'JetBrains Mono' }), -24);
          }
        }, 0);
      });
    }));
  },
};

// ---- snap: a finger-snap burst (over layer). {from: snap time, origin: [x, y] canvas px, r: 1}
const snap = {
  draw(R, s, t) {
    const { ctx } = R, [ox, oy] = s.origin || [W / 2, 700], k = s.r || 1, u = t - s.from;
    if (u < 0 || u > .7) return;
    const e = E.out(seg(u, 0, .45)), a = 1 - seg(u, .12, .55);
    ctx.save(); ctx.lineCap = 'round';
    for (let i = 0; i < 9; i++) {
      const an = i * TAU / 9 + .35 + (i % 2) * .12, r1 = (34 + 150 * e) * k, r2 = (60 + (i % 2 ? 190 : 250) * e) * k;
      const x1 = ox + Math.cos(an) * r1, y1 = oy + Math.sin(an) * r1, x2 = ox + Math.cos(an) * r2, y2 = oy + Math.sin(an) * r2;
      ctx.globalAlpha = a; ctx.strokeStyle = 'rgba(20,16,8,.25)'; ctx.lineWidth = 14; ctx.beginPath(); ctx.moveTo(x1, y1 + 3); ctx.lineTo(x2, y2 + 3); ctx.stroke();
      ctx.strokeStyle = i % 3 ? C.sheet : C.blue; ctx.lineWidth = 10; ctx.beginPath(); ctx.moveTo(x1, y1); ctx.lineTo(x2, y2); ctx.stroke();
    }
    ctx.globalAlpha = a * .9; ctx.strokeStyle = C.sheet; ctx.lineWidth = 5 * (1 - e) + 1.5; ctx.beginPath(); ctx.arc(ox, oy, (30 + 120 * e) * k, 0, TAU); ctx.stroke();
    ctx.restore();
  },
};

// eighth note, drawn (fonts may not carry the glyph)
function note(ctx, x, y, k) {
  ctx.save(); ctx.translate(x, y); ctx.scale(k, k); ctx.fillStyle = C.blue; ctx.strokeStyle = C.blue; ctx.lineCap = 'round';
  ctx.beginPath(); ctx.ellipse(-8, 18, 17, 12, -.4, 0, TAU); ctx.fill();
  ctx.lineWidth = 6; ctx.beginPath(); ctx.moveTo(7, 14); ctx.lineTo(7, -38); ctx.quadraticCurveTo(22, -26, 30, -12); ctx.stroke();
  ctx.restore();
}

// ---- xylo: a paper xylophone. bars rise in, a mallet strikes them on the sung notes.
// {y, notes: ['E', 'G', 'A', 'C'], midi: [76, 79, 81, 84], hitKeys: [[at, barIndex]], restAt}
const xylo = {
  draw(R, s, t) {
    const { ctx } = R, n = s.notes.length, bw = 170, gap = 34, x0 = W / 2 - (n * bw + (n - 1) * gap) / 2, cy = (s.y ?? 420) + 290;
    const hs = s.notes.map((_, i) => 560 - i * 60), hits = s.hitKeys || [];
    env(ctx, s, t, pin => {
      // rails
      rise(ctx, pin, 40, () => [-150, 150].forEach(dy => { ctx.beginPath(); ctx.roundRect(x0 - 50, cy + dy - 11, n * bw + (n - 1) * gap + 100, 22, 11); ctx.fillStyle = C.dim; ctx.fill(); }));
      s.notes.forEach((nt, i) => {
        const p = S(t - s.from - .1 - i * .08, 12); if (p <= .002) return;
        const x = x0 + i * (bw + gap), h = hs[i];
        let glow = 0; for (const [at, j] of hits) if (j === i && t >= at) glow = Math.max(glow, Math.exp(-(t - at) * 3.2));
        const dip = hits.reduce((m, [at, j]) => j === i ? Math.max(m, press(t, at, .16)) : m, 0);
        rise(ctx, p, 70, () => {
          sheet(ctx, x, cy - h / 2 + 8 * dip, bw, h, 26, { elev: 1.1 - .6 * dip, fill: glow > .01 ? mix(C.sheet, C.blue, glow) : undefined });
          [-150, 150].forEach(dy => { ctx.beginPath(); ctx.arc(x + bw / 2, cy + dy + 8 * dip, 9, 0, TAU); ctx.fillStyle = glow > .4 ? 'rgba(255,255,255,.7)' : C.ink3; ctx.fill(); });
          text(ctx, nt, x + bw / 2, midBase(cy + 8 * dip, 64), { size: 64, weight: 800, align: 'center', color: mix(C.ink2, C.white, glow) });
        });
        for (const [at, j] of hits) if (j === i && t >= at && t < at + 1.2) {   // a note floats up from the bar
          const u = (t - at) / 1.2, nx = x + bw / 2 + 50 * Math.sin(u * 3 + i), ny = cy - h / 2 - 40 - 200 * E.out(u);
          alpha(ctx, (1 - u) * Math.min(1, u * 8), () => note(ctx, nx, ny, 1.1));
        }
      });
      // mallet: springs to the next bar just before each hit, taps down on it
      if (hits.length) {
        const bx = i => x0 + i * (bw + gap) + bw / 2, top = i => cy - hs[i] / 2;
        const keys = [[s.from, [W + 200, cy - 420]], ...hits.map(([at, j]) => [at - .22, [bx(j), top(j) - 120], 16]), [s.restAt ?? hits.at(-1)[0] + .6, [W + 200, cy - 420], 8]];
        const [mx, my] = track(t, keys, 14), hit = hits.reduce((m, [at]) => Math.max(m, press(t, at - .08, .2)), 0);
        const hx = mx, hy = my + 100 * hit, a = vis(t, s.from + .2, (s.restAt ?? hits.at(-1)[0] + .6) + .2, 10, 8);
        alpha(ctx, a, () => {
          ctx.save(); ctx.lineCap = 'round';
          ctx.strokeStyle = 'rgba(40,28,10,.18)'; ctx.lineWidth = 16; ctx.beginPath(); ctx.moveTo(hx + 20, hy + 10); ctx.lineTo(hx + 250, hy - 250); ctx.stroke();
          ctx.strokeStyle = C.ink2; ctx.lineWidth = 14; ctx.beginPath(); ctx.moveTo(hx, hy); ctx.lineTo(hx + 230, hy - 260); ctx.stroke();
          shadow(ctx, hx - 38, hy - 38, 76, 76, 38, 12, .2, 6);
          ctx.beginPath(); ctx.arc(hx, hy, 38, 0, TAU); ctx.fillStyle = C.ink; ctx.fill();
          ctx.beginPath(); ctx.arc(hx - 11, hy - 12, 11, 0, TAU); ctx.fillStyle = 'rgba(255,255,255,.22)'; ctx.fill();
          ctx.restore();
        });
      }
    });
  },
};

// ---- sfxtrack: an audio editor lane per sound, a playhead sweeps and lights each clip as it passes.
// {y, header: {text, at}, tag: {text, at}, rows: [{label, at, clips: [[x0, x1]] (0..1 of the lane), sound}], playFrom, playTo}
const sfxtrack = {
  draw(R, s, t) {
    const { ctx } = R, x = 60, w = 960, y = s.y ?? 330, rh = 150, lx = x + 300, lw = w - 300 - 40, h = s.rows.length * rh + 60;
    const ph = seg(t, s.playFrom, s.playTo), phx = lx + lw * ph;
    env(ctx, s, t, pin => {
      if (s.header) rise(ctx, S(t - s.header.at, 12), 40, () => text(ctx, s.header.text, x + 10, y - 56, { size: 64, weight: 800, ls: -1.5 }));
      if (s.tag) { const p = S(t - s.tag.at, 13); if (p > .002) rise(ctx, p, 22, () => chip(ctx, x + w, y - 80, s.tag.text, { align: 'right', size: 38, h: 76, fill: C.blue, color: C.white, border: false })); }
      rise(ctx, pin, 70, () => {
        sheet(ctx, x, y, w, h, 36, { elev: 1.2 });
        s.rows.forEach((r, i) => {
          const ry = y + 30 + i * rh, p = S(t - r.at, 13); if (p <= .002) return;
          rise(ctx, p, 20, () => {
            if (i) { ctx.fillStyle = C.line; ctx.fillRect(x + 30, ry, w - 60, 1.5); }
            text(ctx, r.label, x + 40, midBase(ry + rh / 2, 42), { size: 42, weight: 700, ls: -.6 });
            ctx.beginPath(); ctx.roundRect(lx, ry + 28, lw, rh - 56, 18); ctx.fillStyle = 'rgba(40,30,10,.04)'; ctx.fill();
            r.clips.forEach(([a, b], k) => {
              const cx = lx + lw * a, cw = Math.max(18, lw * (b - a)), cy = ry + 36, chh = rh - 72;
              const lit = ph > a ? Math.exp(-Math.max(0, (t - s.playFrom) - (s.playTo - s.playFrom) * b) * 4) * (ph < 1 || t < s.playTo + .8 ? 1 : 0) : 0;
              const on = ph > a && ph <= b + .02 ? 1 : lit;
              ctx.beginPath(); ctx.roundRect(cx, cy, cw, chh, 12); ctx.fillStyle = mix(C.tint, C.blue, on); ctx.fill();
              ctx.strokeStyle = 'rgba(37,142,255,.5)'; ctx.lineWidth = 2; ctx.stroke();
              ctx.fillStyle = on > .5 ? 'rgba(255,255,255,.9)' : 'rgba(37,142,255,.75)';
              const nb = Math.max(1, Math.floor((cw - 16) / 12));
              for (let q = 0; q < nb; q++) { const hh = (chh - 24) * (.25 + .75 * Math.abs(Math.sin(q * 1.7 + i * 3 + k))) * (r.sound === 'snap' ? Math.exp(-q * .5) : 1); ctx.fillRect(cx + 10 + q * 12, cy + chh / 2 - hh / 2, 6, hh); }
            });
          });
        });
        if (t > s.playFrom - .3 && t < s.playTo + .6) alpha(ctx, vis(t, s.playFrom - .3, s.playTo + .2, 14, 10), () => {
          ctx.fillStyle = C.blue; ctx.fillRect(phx - 2.5, y + 18, 5, h - 36);
          ctx.beginPath(); ctx.moveTo(phx - 16, y + 6); ctx.lineTo(phx + 16, y + 6); ctx.lineTo(phx, y + 26); ctx.closePath(); ctx.fill();
        });
      });
    });
  },
};

// ---- popover: a macOS alert that lands over the camera and follows where the speaker points.
// {keys: [[t, [x, y]]] (top-left), w: 780, icon: 'claude', title, message: {text, from, to}, buttons: ['Annuler', 'OK'], clickAt}
const popover = {
  prep(s, R) {
    if (s._p) return s._p;
    const { ctx } = R, w = s.w || 780, fs = 40, lh = 54, lines = wrap(ctx, s.message.text, w - 120, fs, 500);
    const toks = typing(s.message.text, R.tl.words, s.message.from, s.message.to);
    const h = 60 + 110 + 36 + 60 + lines.length * lh + 40 + 96 + 44;
    return (s._p = { w, h, fs, lh, lines, toks });
  },
  draw(R, s, t) {
    const { ctx } = R, P = popover.prep(s, R), { w, h, fs, lh, lines, toks } = P;
    const [x, y] = track(t, s.keys, 9), pin = S(t - s.from, 13), out = s.to != null ? leave(t - s.to) : 0;
    const a = Math.min(1, pin * 1.4) * (1 - out); if (a <= .002) return;
    ctx.save(); ctx.globalAlpha *= a;
    const sc = (.9 + .1 * pin) * (1 - .06 * out), cx = x + w / 2, cy = y + h / 2;
    ctx.translate(cx, cy); ctx.scale(sc, sc); ctx.translate(-cx, -cy - 30 * (1 - pin));
    sheet(ctx, x, y, w, h, 44, { elev: 2 });
    const ic = 110, ix = x + w / 2 - ic / 2, iy = y + 60;
    ctx.beginPath(); ctx.roundRect(ix, iy, ic, ic, 30); ctx.fillStyle = C.blue; ctx.fill();
    LOGO.claude(ctx, ix + ic / 2, iy + ic / 2, 38, C.white);
    text(ctx, s.title, x + w / 2, iy + ic + 36 + 44, { size: 46, weight: 800, ls: -.8, align: 'center' });
    let n = 0; toks.forEach((k, i) => { const d = Math.min(.26, Math.max(.08, k.end - k.start)); n += t >= k.start ? (i ? 1 : 0) + Math.round(k.tok.length * clamp((t - k.start) / d)) : 0; });
    let acc = 0, cxr = x + w / 2, cyr = iy + ic + 36 + 60 + fs;
    lines.forEach((l, i) => {
      const v = clamp(n - acc, 0, l.length); acc += l.length + 1; if (v <= 0) return;
      const yy = iy + ic + 36 + 60 + fs + 10 + i * lh, full = measure(ctx, l, fs, 500), str = l.slice(0, v);
      text(ctx, str, x + w / 2 - full / 2, yy, { size: fs, weight: 500, color: C.ink2 }); cxr = x + w / 2 - full / 2 + measure(ctx, str, fs, 500); cyr = yy;
    });
    if (t < s.message.to + .2 && t > s.message.from - .3) alpha(ctx, .5 + .5 * Math.round((Math.sin(t * 12) + 1) / 2), () => { ctx.fillStyle = C.blue; ctx.fillRect(cxr + 3, cyr - fs * .8, 3.5, fs * .98); });
    const by = y + h - 44 - 96, bs = s.buttons || ['Annuler', 'OK'], gw = (w - 60 * 2 - 24) / 2, pr = press(t, s.clickAt, .2);
    bs.forEach((b, i) => {
      const bx = x + 60 + i * (gw + 24), last = i === bs.length - 1;
      ctx.save(); if (last && pr) { ctx.translate(bx + gw / 2, by + 48); ctx.scale(1 - .05 * pr, 1 - .05 * pr); ctx.translate(-(bx + gw / 2), -(by + 48)); }
      ctx.beginPath(); ctx.roundRect(bx, by, gw, 96, 30); ctx.fillStyle = last ? (pr ? C.blue2 : C.blue) : '#ECE8DF'; ctx.fill();
      text(ctx, b, bx + gw / 2, midBase(by + 48, 40), { size: 40, weight: 700, align: 'center', color: last ? C.white : C.ink });
      ctx.restore();
    });
    ctx.restore();
    const okx = x + 60 + (bs.length - 1) * (gw + 24) + gw * .55, oky = by + 58;
    const [px, py] = track(t, [[s.from, [W + 80, y + h + 300]], [s.clickAt - .7, [okx, oky]]], 9);
    cursor(ctx, px, py, { alpha: vis(t, s.clickAt - 1.1, s.clickAt + .4, 10, 12) * (1 - out), press: pr });
  },
};

// ---- pause: the video stops. A paper play/pause badge with a blue ring that fills over the pause, then morphs to
// play and leaves. {from, to, keys: [[t, [x, y, r]]]}. Use 'p+X' times.
const pauseScene = {
  draw(R, s, t) {
    const { ctx } = R, [x, y, r] = track(t, s.keys || [[s.from, [W / 2, 960, 130]]], 11);
    const pin = S(t - s.from, 16), out = leave(t - s.to - .15), a = Math.min(1, pin * 1.5) * (1 - out); if (a <= .002) return;
    const play = S(t - s.to + .45, 16), ring = E.io(seg(t, s.from + .2, s.to - .45));
    ctx.save(); ctx.globalAlpha *= a; ctx.translate(x, y); const sc = (.85 + .15 * pin) * (1 + .12 * out); ctx.scale(sc, sc);
    shadow(ctx, -r, -r, r * 2, r * 2, r, 30, .28, 12);
    ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fillStyle = sheetFill(); ctx.fill();
    ctx.beginPath(); ctx.arc(0, 0, r - 14, 0, TAU); ctx.strokeStyle = 'rgba(40,30,10,.07)'; ctx.lineWidth = 12; ctx.stroke();
    if (ring > 0) { ctx.beginPath(); ctx.arc(0, 0, r - 14, -Math.PI / 2, -Math.PI / 2 + TAU * ring); ctx.strokeStyle = C.blue; ctx.lineCap = 'round'; ctx.lineWidth = 12; ctx.stroke(); }
    // pause bars morph into the play triangle
    const bw = r * .2, bh = r * .78, gx = r * .17;
    ctx.fillStyle = C.ink; ctx.beginPath();
    const L = [[-gx - bw, -bh / 2], [-gx, -bh / 2], [-gx, bh / 2], [-gx - bw, bh / 2]], Rr = [[gx, -bh / 2], [gx + bw, -bh / 2], [gx + bw, bh / 2], [gx, bh / 2]];
    const T1 = [[-r * .28, -bh / 2], [r * .08, -bh * .26], [r * .08, bh * .26], [-r * .28, bh / 2]], T2 = [[r * .08, -bh * .26], [r * .42, 0], [r * .42, 0], [r * .08, bh * .26]];
    [[L, T1], [Rr, T2]].forEach(([A, B]) => { A.forEach(([ax, ay], i) => { const px = lerp(ax, B[i][0], play), py = lerp(ay, B[i][1], play); i ? ctx.lineTo(px, py) : ctx.moveTo(px, py); }); ctx.closePath(); });
    ctx.fill();
    ctx.restore();
  },
};

// ---- pipeline: who did what, one row per tool, landing on the narrator's words. {y, header: {text, at, logo}, rows: [{glyph | logo, title, sub, at, blue}]}
const pipeline = {
  draw(R, s, t) {
    const { ctx } = R, x = 60, w = 960, y = s.y ?? 190, rh = 132, hh = 150, h = hh + s.rows.length * rh + 30;
    const talking = R.tl.words.some(wd => wd.narrator && t >= wd.start - .03 && t <= wd.end + .05) ? 1 : 0;
    env(ctx, s, t, pin => rise(ctx, pin, 80, () => {
      sheet(ctx, x, y, w, h, 40, { elev: 1.5 });
      const hy = y + hh / 2 + 6, hp = S(t - s.header.at, 13);
      alpha(ctx, Math.min(1, hp * 1.4), () => {
        if (isImgLogo(s.header.logo)) logoImg(R, ctx, s.header.logo, x + 40, hy - 45, 90, 24);
        else { ctx.beginPath(); ctx.roundRect(x + 40, hy - 45, 90, 90, 26); ctx.fillStyle = C.blue; ctx.fill(); }
        if (isImgLogo(s.header.logo)) {}
        else if (s.header.glyph) text(ctx, s.header.glyph, x + 85, midBase(hy, 44), { size: 44, weight: 800, align: 'center', color: C.white });
        else LOGO.claude(ctx, x + 85, hy, 30, C.white);
        text(ctx, s.header.text, x + 158, midBase(hy, 60), { size: 60, weight: 800, ls: -1.4 });
        // live voice meter: the narrator is talking
        for (let i = 0; i < 9; i++) {
          const v = talking ? .25 + .75 * Math.abs(Math.sin(t * (11 + i * 1.7) + i * 2.1)) * (.6 + .4 * Math.sin(t * 5 + i)) : .12;
          const bh = 12 + 58 * v; ctx.beginPath(); ctx.roundRect(x + w - 60 - (9 - i) * 22, hy - bh / 2, 12, bh, 6); ctx.fillStyle = C.blue; ctx.fill();
        }
      });
      ctx.fillStyle = C.line; ctx.fillRect(x + 36, y + hh, w - 72, 1.5);
      s.rows.forEach((r, i) => {
        const ry = y + hh + 14 + i * rh, cy = ry + rh / 2, p = S(t - r.at, 13); if (p <= .002) return;
        rise(ctx, p, 30, () => {
          const tile = 92, tx = x + 40;
          if (isImgLogo(r.logo)) logoImg(R, ctx, r.logo, tx, cy - tile / 2, tile, 24);
          else { ctx.beginPath(); ctx.roundRect(tx, cy - tile / 2, tile, tile, 26); ctx.fillStyle = r.blue ? C.blue : C.tint; ctx.fill(); }
          if (isImgLogo(r.logo)) {}
          else if (r.logo && LOGO[r.logo]) LOGO[r.logo](ctx, tx + tile / 2, cy, 30, r.blue ? C.white : C.blue);
          else text(ctx, r.glyph, tx + tile / 2, midBase(cy, 44), { size: 44, weight: 800, align: 'center', color: r.blue ? C.white : C.blue, fam: r.mono ? 'JetBrains Mono' : undefined });
          text(ctx, r.title, tx + tile + 30, cy - 6, { size: 46, weight: 800, ls: -.8, color: r.blue ? C.blue : C.ink });
          text(ctx, r.sub, tx + tile + 30, cy + 40, { size: 36, weight: 600, color: C.ink2 });
          const cp = S(t - r.at - .25, 14);
          if (cp > .002) alpha(ctx, cp, () => { const kx = x + w - 80, kr = 30; ctx.beginPath(); ctx.arc(kx, cy, kr, 0, TAU); ctx.fillStyle = r.blue ? C.blue : C.tint; ctx.fill(); checkIcon(ctx, kx, cy, 30, r.blue ? C.white : C.blue, E.out(seg(t, r.at + .3, r.at + .7)), 5); });
        });
      });
    }));
  },
};

// ---- comment: a comment composer as the CTA (over layer). {y, placeholder, typed, clickAt, typeFrom, typeTo, button}
const comment = {
  draw(R, s, t) {
    const { ctx } = R, w = 920, h = 200, x = W / 2 - w / 2, y = s.y - h / 2;
    env(ctx, s, t, pin => rise(ctx, pin, 90, () => {
      sheet(ctx, x, y, w, h, 48, { elev: 1.8 });
      const ax = x + 40 + 52, ay = y + h / 2;
      ctx.save(); ctx.beginPath(); ctx.arc(ax, ay, 52, 0, TAU); ctx.clip();
      const e = R.spec.cam?.eyes || [600, 400];
      if (R.cam) ctx.drawImage(R.cam, e[0] - 250, e[1] - 210, 500, 500, ax - 52, ay - 52, 104, 104); ctx.restore();
      const fx = x + 176, fw = w - 176 - 40 - 170, focus = S(t - s.clickAt, 16);
      const n = Math.round((s.typed || '').length * clamp((t - s.typeFrom) / (s.typeTo - s.typeFrom)));
      const str = (s.typed || '').slice(0, Math.max(0, n));
      if (str) text(ctx, str, fx, midBase(ay, 42), { size: 42, weight: 600, color: C.ink });
      else text(ctx, s.placeholder, fx, midBase(ay, 40), { size: 40, weight: 500, color: C.ink3 });
      ctx.fillStyle = mix('#E3DED3', '#258EFF', focus); ctx.fillRect(fx, ay + 44, fw * (.3 + .7 * focus) + 0, 3);
      if (focus > .1 && Math.sin(t * 11) > -.2) { const cx = fx + (str ? measure(ctx, str, 42, 600) + 4 : 0); ctx.fillStyle = C.blue; ctx.fillRect(cx, ay - 30, 3.5, 44); }
      const ready = str.length === (s.typed || '').length && str ? S(t - s.typeTo, 14) : 0, bw = 150, bx = x + w - 40 - bw;
      ctx.beginPath(); ctx.roundRect(bx, ay - 42, bw, 84, 42); ctx.fillStyle = mix('#ECE8DF', C.blue, ready); ctx.fill();
      text(ctx, s.button || 'Publier', bx + bw / 2, midBase(ay, 34), { size: 34, weight: 700, align: 'center', color: mix(C.ink3, C.white, ready) });
      const [px, py] = track(t, [[s.from, [W + 60, y + h + 260]], [s.clickAt - .6, [fx + 200, ay + 10]], [s.typeTo + .1, [bx + bw * .6, ay + 12]]], 9);
      cursor(ctx, px, py, { alpha: S(t - s.from - .15, 10), press: Math.max(press(t, s.clickAt, .2), s.sendAt ? press(t, s.sendAt, .2) : 0) });
    }));
  },
};

// ---- X post rebuilt natively. A desktop screenshot of a long post puts the body at ~25 px on a 960 card; this
// redraws it as a light paper sheet with a 40 px body. text: '**bold**' spans; marks: [{at, text, dur}] highlight
// the first occurrence of `text` (across line breaks) when it is spoken. h auto-fits unless rect[3] is given.
function richLayout(ctx, str, maxW, size) {
  const words = []; let cur = null, bold = false, plain = '';
  for (let i = 0; i < str.length; i++) {
    if (str.startsWith('**', i)) { bold = !bold; i++; continue; }
    const ch = str[i];
    if (ch === ' ') { cur = null; plain += ' '; continue; }
    if (!cur) { cur = { runs: [], s: plain.length }; words.push(cur); }
    const r = cur.runs.at(-1); if (r && r.bold === bold) r.t += ch; else cur.runs.push({ t: ch, bold });
    plain += ch; cur.e = plain.length;
  }
  const sp = measure(ctx, ' ', size, 500);
  let x = 0, line = 0;
  for (const w of words) {
    w.runs.forEach(r => { r.w = measure(ctx, r.t, size, r.bold ? 700 : 500); });
    w.w = w.runs.reduce((a, r) => a + r.w, 0);
    if (x > 0 && x + w.w > maxW) { x = 0; line++; }
    w.x = x; w.line = line; x += w.w + sp;
  }
  return { words, plain, lines: words.length ? line + 1 : 0 };
}
function markSegs(L, str) {   // [{line, x0, x1}] covering `str` in reading order
  const a = L.plain.indexOf(str); if (a < 0) return [];
  const b = a + str.length, segs = [];
  for (const w of L.words) if (w.e > a && w.s < b) {
    const g = segs.at(-1);
    if (g && g.line === w.line) g.x1 = w.x + w.w; else segs.push({ line: w.line, x0: w.x, x1: w.x + w.w });
  }
  return segs;
}
function xLogo(ctx, cx, cy, s, color) {
  ctx.save(); ctx.fillStyle = color; ctx.strokeStyle = color; ctx.lineCap = 'butt';
  ctx.beginPath(); ctx.moveTo(cx - s * .5, cy - s * .5); ctx.lineTo(cx - s * .2, cy - s * .5); ctx.lineTo(cx + s * .5, cy + s * .5); ctx.lineTo(cx + s * .2, cy + s * .5); ctx.closePath(); ctx.fill();
  ctx.lineWidth = s * .09; ctx.beginPath(); ctx.moveTo(cx + s * .44, cy - s * .5); ctx.lineTo(cx - s * .44, cy + s * .5); ctx.stroke(); ctx.restore();
}
function verified(ctx, cx, cy, r) {   // scalloped blue badge + white check
  ctx.save(); ctx.beginPath();
  for (let k = 0; k <= 48; k++) { const a = k / 48 * TAU, rr = r * (1 + .09 * Math.cos(a * 8)); ctx.lineTo(cx + Math.cos(a) * rr, cy + Math.sin(a) * rr); }
  ctx.fillStyle = C.blue; ctx.fill(); ctx.restore();
  checkIcon(ctx, cx, cy, r * 1.05, C.white, 1, r * .24);
}
// media: the post's clip (a `media` id) played from `offset`; mediaKeys [[at, offset, id?]] jump-cut inside it (or to
// another media id) on the spoken word, so one long launch film shows its best shots. mediaAr = h/w (default 9/16).
function tweetMedia(s, t) {
  if (s.mediaKeys) { const k = s.mediaKeys.filter(q => t >= q[0]).at(-1) || s.mediaKeys[0]; return [k[2] || s.media, Math.max(0, k[1] + t - Math.max(k[0], s.from))]; }
  return s.media ? [s.media, clipTime(t, s.from, s.offset)] : null;
}
const tweet = {
  needs(s, t) {
    if (t < s.from - (s.pre || 0) - .3 || t > (s.to ?? 1e9) + .7) return [];
    const m = tweetMedia(s, t); return [...(s.avatar ? [[s.avatar, 0]] : []), ...(m ? [m] : [])];
  },
  prep(s, R) {
    if (s._p) return s._p;
    const { ctx } = R, [x, y, w, hh] = s.rect, size = s.size || 40, lh = Math.round(size * 1.34), pad = 44;
    const L = richLayout(ctx, s.text, w - pad * 2, size), top = y + 40 + 88 + 66;
    const mh = s.media || s.mediaKeys ? Math.round((w - pad * 2) * (s.mediaAr || 9 / 16)) : 0, M = mh ? mh + 34 : 0;
    const h = hh ?? (top - y) + (L.lines - 1) * lh + M + (s.footer ? 140 : 54);
    return (s._p = { x, y, w, h, size, lh, pad, L, top, mh, M, marks: (s.marks || []).map(m => ({ ...m, segs: markSegs(L, m.text) })) });
  },
  hand(s, R) {   // the media rect at rest, for a board item that morphs out of it (screen morph: true)
    const P = tweet.prep(s, R); return P.mh ? [P.x + P.pad, P.top + (P.L.lines - 1) * P.lh + 34, P.w - P.pad * 2, P.mh] : null;
  },
  draw(R, s, t) {
    const { ctx } = R, P = tweet.prep(s, R), { x, y, w, h, size, lh, pad, L, top, mh, M } = P;
    env(ctx, s, t, pin => rise(ctx, pin, 70, () => {
      sheet(ctx, x, y, w, h, 34, { elev: 1.2 });
      if (s.label) cardLabel(ctx, x + 12, y + 12, s.label, s.dot === 'blue' ? C.blue : s.dot === 'gray' ? C.ink3 : null);
      // header
      const ax = x + pad, ay = y + 40, img = s.avatar ? R.frame(s.avatar, 0) : null;
      if (s.initial) {   // YouTube-style letter avatar
        ctx.beginPath(); ctx.arc(ax + 44, ay + 44, 44, 0, TAU); ctx.fillStyle = C.ink2; ctx.fill();
        text(ctx, s.initial, ax + 44, midBase(ay + 44, 44), { size: 44, weight: 700, align: 'center', color: C.white });
      } else { ctx.save(); ctx.beginPath(); ctx.arc(ax + 44, ay + 44, 44, 0, TAU); ctx.clip(); cover(ctx, img, ax, ay, 88, 88); ctx.restore(); }
      const nx = ax + 88 + 22;
      text(ctx, s.name, nx, ay + 38, { size: 40, weight: 800, ls: -.6 });
      if (s.verified) verified(ctx, nx + measure(ctx, s.name, 40, 800, -.6) + 30, ay + 24, 17);
      text(ctx, s.handle, nx, ay + 82, { size: 34, weight: 500, color: C.ink3 });
      if (isImgLogo(s.logo)) logoImg(R, ctx, s.logo, x + w - pad - 64, ay - 2, 64, 14); else xLogo(ctx, x + w - pad - 20, ay + 26, 36, C.ink);
      // highlighter under the words, sweeping line by line
      for (const m of P.marks) {
        const tot = m.segs.reduce((a, g) => a + g.x1 - g.x0, 0); let left = tot * E.cubic(seg(t, m.at, m.at + (m.dur ?? .7)));
        if (left <= .5) continue;
        ctx.save(); ctx.fillStyle = 'rgba(37,142,255,.24)';
        for (const g of m.segs) { if (left <= 0) break; const gw = Math.min(left, g.x1 - g.x0); left -= g.x1 - g.x0;
          ctx.beginPath(); ctx.roundRect(x + pad + g.x0 - 6, top + g.line * lh - size * .86, gw + 12, size * 1.18, 8); ctx.fill(); }
        ctx.restore();
      }
      // read: {from, to} = read-along: each word goes from ink3 to ink on the spoken word it maps to
      const rd = s.read ? (P.toks ||= typing(L.words.map(wd => wd.runs.map(r => r.t).join('')).join(' '), R.tl.words, s.read.from, s.read.to)) : null;
      L.words.forEach((wd, i) => { let wx = x + pad + wd.x; const color = rd ? mix(C.ink3, C.ink, S(t - rd[i].start + .04, 22)) : C.ink;
        for (const r of wd.runs) { text(ctx, r.t, wx, top + wd.line * lh, { size, weight: r.bold ? 700 : 500, color }); wx += r.w; } });
      if (mh && !(s._handTo != null && t >= s._handTo)) {   // the post's own video / image, playing inside the card like on X (until a morph takes it)
        const my = top + (L.lines - 1) * lh + 34, m = tweetMedia(s, t), img = m ? R.frame(m[0], m[1]) : null;
        cover(ctx, img, x + pad, my, w - pad * 2, mh, 22);
        ctx.save(); ctx.beginPath(); ctx.roundRect(x + pad, my, w - pad * 2, mh, 22); ctx.strokeStyle = 'rgba(20,22,27,.1)'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.restore();
      }
      if (s.footer) {
        const fy = top + (L.lines - 1) * lh + M + 26 + 30;
        ctx.fillStyle = C.line; ctx.fillRect(x + pad, fy - 30, w - pad * 2, 2);
        let fx = x + pad;
        for (const [str, strong] of s.footer.split('**').map((q, k) => [q, k % 2 === 1])) { text(ctx, str, fx, fy + 36, { size: 34, weight: strong ? 700 : 500, color: strong ? C.ink : C.ink3 }); fx += measure(ctx, str, 34, strong ? 700 : 500); }
      }
      if (s.photo) {   // photo: a camera flash washing over the card as it lands (the shutter sound is in cues.js)
        const f = t - (s.from - (s.pre || 0));
        if (f > 0 && f < .5) { ctx.save(); ctx.beginPath(); ctx.roundRect(x, y, w, h, 34); ctx.fillStyle = `rgba(255,255,255,${(Math.pow(1 - f / .5, 2) * .9).toFixed(3)})`; ctx.fill(); ctx.restore(); }
      }
    }));
  },
};

// ---- article: a press source rebuilt natively (crisp at any size, unlike a page screenshot). Outlet row (real logo +
// name + date), headline, optional pulled quote with a blue rule and attribution. Height follows the text.
// { rect: [x, y, w], center: true, logo: 'assets/logos/cnbc.png', outlet: 'CNBC', date: '29 sept. 2026', kicker: 'Tech',
//   headline, headSize: 54, hlMark: { at, dur },            // highlighter sweeping the whole headline when it is said
//   headMarks: [{ at, text, dur }],                          // or only these words of the headline, each when it is said
//   quote, quoteSize: 38, by: 'Arthur Mensch, CEO de Mistral', marks: [{ at, text, dur }], read: { from, to } }
const H_ = H;
const article = {
  prep(s, R) {
    if (s._p) return s._p;
    const { ctx } = R, [x, y, w] = s.rect, pad = 48, hs = s.headSize || 54, hlh = Math.round(hs * 1.16), qs = s.quoteSize || 38, qlh = Math.round(qs * 1.38);
    const H = wrap(ctx, s.headline || '', w - pad * 2, hs, 800, -1.2), htop = y + pad + 64 + 34 + hs * .82;
    const Q = s.quote ? richLayout(ctx, s.quote, w - pad * 2 - 34, qs) : null, qtop = htop + (H.length - 1) * hlh + 46 + 30 + qs * .82;
    const h = Q ? qtop - y + (Q.lines - 1) * qlh + (s.by ? 84 : 30) + pad - 10 : htop - y + (H.length - 1) * hlh + pad;
    const dy = s.center ? Math.round((H_ - h) / 2) - y : 0;   // center: true centres the card on the stage height
    return (s._p = { x, y: y + dy, w, h, pad, hs, hlh, qs, qlh, H, htop: htop + dy, Q, qtop: qtop + dy, marks: Q ? (s.marks || []).map(m => ({ ...m, segs: markSegs(Q, m.text) })) : [] });
  },
  draw(R, s, t) {
    const { ctx } = R, P = article.prep(s, R), { x, y, w, h, pad, hs, hlh, qs, qlh, H, htop, Q, qtop } = P;
    env(ctx, s, t, pin => rise(ctx, pin, 70, () => {
      sheet(ctx, x, y, w, h, 30, { elev: 1.2 });
      // outlet row: logo, name, date (right), kicker chip
      let lx = x + pad;
      if (isImgLogo(s.logo)) { logoImg(R, ctx, s.logo, lx, y + pad, 64, 14); lx += 64 + 20; }
      text(ctx, s.outlet || '', lx, midBase(y + pad + 32, 36), { size: 36, weight: 800, ls: -.4 });
      if (s.kicker) { const kx = lx + measure(ctx, s.outlet || '', 36, 800, -.4) + 22, kw = measure(ctx, s.kicker, 26, 700) + 28;
        ctx.save(); ctx.beginPath(); ctx.roundRect(kx, y + pad + 15, kw, 36, 18); ctx.fillStyle = C.tint; ctx.fill(); ctx.restore();
        text(ctx, s.kicker, kx + 14, midBase(y + pad + 33, 26), { size: 26, weight: 700, color: C.blue }); }
      if (s.date) text(ctx, s.date, x + w - pad, midBase(y + pad + 32, 30), { size: 30, weight: 500, color: C.ink3, align: 'right' });
      ctx.fillStyle = C.line; ctx.fillRect(x + pad, y + pad + 64 + 16, w - pad * 2, 2);
      // headline, with an optional highlighter sweep over all its lines
      if (s.hlMark) {
        const ws = H.map(l => measure(ctx, l, hs, 800, -1.2)), tot = ws.reduce((a, b) => a + b, 0);
        let left = tot * E.cubic(seg(t, s.hlMark.at, s.hlMark.at + (s.hlMark.dur ?? .9)));
        ctx.save(); ctx.fillStyle = 'rgba(37,142,255,.22)';
        H.forEach((l, i) => { if (left <= .5) return; const gw = Math.min(left, ws[i]); left -= ws[i];
          ctx.beginPath(); ctx.roundRect(x + pad - 8, htop + i * hlh - hs * .84, gw + 16, hs * 1.12, 10); ctx.fill(); });
        ctx.restore();
      }
      for (const m of s.headMarks || []) {   // a phrase of the headline, swept across the wrapped lines it spans
        const all = H.join(' '), i0 = all.indexOf(m.text);
        if (i0 < 0) continue;
        const segs = []; let c0 = 0;
        H.forEach((l, i) => { const a = Math.max(i0, c0), b = Math.min(i0 + m.text.length, c0 + l.length);
          if (b > a) { const x0 = measure(ctx, l.slice(0, a - c0), hs, 800, -1.2); segs.push([i, x0, measure(ctx, l.slice(0, b - c0), hs, 800, -1.2) - x0]); }
          c0 += l.length + 1; });
        let left = segs.reduce((a, g) => a + g[2], 0) * E.cubic(seg(t, m.at, m.at + (m.dur ?? .8)));
        if (left <= .5) continue;
        ctx.save(); ctx.fillStyle = 'rgba(37,142,255,.24)';
        for (const [i, x0, gw0] of segs) { if (left <= 0) break; const gw = Math.min(left, gw0); left -= gw0;
          ctx.beginPath(); ctx.roundRect(x + pad + x0 - 8, htop + i * hlh - hs * .84, gw + 16, hs * 1.12, 10); ctx.fill(); }
        ctx.restore();
      }
      H.forEach((l, i) => text(ctx, l, x + pad, htop + i * hlh, { size: hs, weight: 800, ls: -1.2 }));
      if (!Q) return;
      // pulled quote: blue rule, highlighter marks, optional read-along, attribution
      const qx = x + pad + 34;
      ctx.fillStyle = C.blue; ctx.beginPath(); ctx.roundRect(x + pad, qtop - qs * .9, 6, (Q.lines - 1) * qlh + qs * 1.2, 3); ctx.fill();
      for (const m of P.marks) {
        const tot = m.segs.reduce((a, g) => a + g.x1 - g.x0, 0); let left = tot * E.cubic(seg(t, m.at, m.at + (m.dur ?? .7)));
        if (left <= .5) continue;
        ctx.save(); ctx.fillStyle = 'rgba(37,142,255,.24)';
        for (const g of m.segs) { if (left <= 0) break; const gw = Math.min(left, g.x1 - g.x0); left -= g.x1 - g.x0;
          ctx.beginPath(); ctx.roundRect(qx + g.x0 - 6, qtop + g.line * qlh - qs * .86, gw + 12, qs * 1.18, 8); ctx.fill(); }
        ctx.restore();
      }
      const rd = s.read ? (P.toks ||= typing(Q.words.map(wd => wd.runs.map(r => r.t).join('')).join(' '), R.tl.words, s.read.from, s.read.to)) : null;
      Q.words.forEach((wd, i) => { let wx = qx + wd.x; const color = rd ? mix(C.ink3, C.ink, S(t - rd[i].start + .04, 22)) : C.ink;
        for (const r of wd.runs) { text(ctx, r.t, wx, qtop + wd.line * qlh, { size: qs, weight: r.bold ? 700 : 500, color }); wx += r.w; } });
      if (s.by) text(ctx, s.by, qx, qtop + (Q.lines - 1) * qlh + 64, { size: 30, weight: 600, color: C.ink3 });
    }));
  },
};

// ---- columns: vertical cost columns rebuilt from a bar chart (Artificial Analysis "Cost per Intelligence Index Task").
// groups: [{cols: [{name, sub, value, text, at, blue}], ghost: {at, over: 0, of: 1, chip: {text, at}}}] side by side on one
// baseline; value on top of each column, name + sub under it. ghost draws the taller column `of` as a dashed outline over
// the cheaper column `over`, with a ratio chip above it ("5.7x"). {base: 1080, y0: 470 (top of the tallest), cx: 520}
const columns = {
  draw(R, s, t) {
    const { ctx } = R, base = s.base ?? 1080, top = s.y0 ?? 470, cw = s.colW ?? 170, gi = s.gapIn ?? 30, go = s.gapOut ?? 90;
    const max = s.max ?? Math.max(...s.groups.flatMap(g => g.cols.map(c => c.value))), H = v => (base - top) * v / max;
    const gw = g => g.cols.length * cw + (g.cols.length - 1) * gi, total = s.groups.reduce((a, g) => a + gw(g), 0) + go * (s.groups.length - 1);
    const x0 = (s.cx ?? W / 2) - total / 2;
    env(ctx, s, t, () => {
      if (s.header) rise(ctx, S(t - s.header.at, 12), 40, () => text(ctx, s.header.text, W / 2, 240, { size: 64, weight: 800, ls: -1.8, align: 'center' }));
      if (s.sub) rise(ctx, S(t - s.sub.at, 12), 30, () => text(ctx, s.sub.text, W / 2, 300, { size: 34, weight: 600, color: C.ink2, align: 'center' }));
      const g0 = E.out(seg(t, s.from + .05, s.from + .6));
      alpha(ctx, S(t - s.from - .1, 12), () => {   // dotted grid, like the source chart
        ctx.save(); ctx.setLineDash([3, 9]); ctx.strokeStyle = 'rgba(40,30,10,.18)'; ctx.lineWidth = 2;
        for (let k = 1; k <= 4; k++) { const yy = base - (base - top) * k / 4; ctx.beginPath(); ctx.moveTo(x0 - 30, yy); ctx.lineTo(lerp(x0 - 30, x0 + total + 30, g0), yy); ctx.stroke(); }
        ctx.restore();
      });
      ctx.save(); ctx.strokeStyle = C.ink; ctx.lineWidth = 3; ctx.lineCap = 'round';
      ctx.beginPath(); ctx.moveTo(x0 - 30, base); ctx.lineTo(lerp(x0 - 30, x0 + total + 30, g0), base); ctx.stroke(); ctx.restore();
      let gx = x0;
      for (const g of s.groups) {
        const cx = i => gx + i * (cw + gi);
        if (g.ghost) {   // the expensive column's height, drawn over the cheap one
          const q = g.ghost, gh = H(g.cols[q.of ?? 1].value), p = E.out(seg(t, q.at, q.at + .55)), X = cx(q.over ?? 0);
          alpha(ctx, Math.min(1, p * 2), () => {
            ctx.beginPath(); ctx.roundRect(X, base - gh * p, cw, gh * p, [16, 16, 0, 0]); ctx.fillStyle = 'rgba(37,142,255,.08)'; ctx.fill();
            ctx.setLineDash([10, 9]); ctx.strokeStyle = 'rgba(37,142,255,.6)'; ctx.lineWidth = 2.5; ctx.stroke(); ctx.setLineDash([]);
          });
          if (q.chip) { const pc = S(t - q.chip.at, 13); if (pc > .002) rise(ctx, pc, 20, () => chip(ctx, X + cw / 2, base - gh - 56, q.chip.text, { size: 40, h: 80, padX: 26, fill: C.blue, color: C.white, border: false })); }
        }
        g.cols.forEach((c, i) => {
          const X = cx(i), p = S(t - c.at, 12), gr = S(t - c.at - .05, 7), h = Math.max(8, H(c.value) * gr), col = c.blue ? C.blue : C.ink3;
          if (p <= .002) return;
          alpha(ctx, Math.min(1, p * 1.4), () => { ctx.beginPath(); ctx.roundRect(X, base - h, cw, h, [16, 16, 0, 0]); ctx.fillStyle = col; ctx.fill(); });
          rise(ctx, S(t - c.at - .15, 13), 16, () => text(ctx, c.text, X + cw / 2, base - h - 22, { size: 46, weight: 800, ls: -1, align: 'center', color: c.blue ? C.blue : C.ink, halo: 10 }));
          rise(ctx, p, 20, () => {
            text(ctx, c.name, X + cw / 2, base + 62, { size: 42, weight: 800, ls: -.8, align: 'center', color: c.blue ? C.ink : C.ink2 });
            if (c.sub) text(ctx, c.sub, X + cw / 2, base + 108, { size: 36, weight: 600, align: 'center', color: C.ink3 });
          });
        });
        gx += gw(g) + go;
      }
    });
  },
};

// ---- recap: numbered list on one sheet ("les 9 changements"). {rect: [x, y, w], header: {text, count, at}, rh: 98,
// rows: [{title, sub, at}]}. Rows land in a quick cascade; the number sits in a blue disc.
const recap = {
  draw(R, s, t) {
    const { ctx } = R, [x, y, w] = s.rect, rh = s.rh ?? 98, head = 118, pad = 40, h = head + s.rows.length * rh + 18;
    env(ctx, s, t, pin => rise(ctx, pin, 70, () => {
      sheet(ctx, x, y, w, h, 36, { elev: 1.3 });
      if (s.header) {
        text(ctx, s.header.text, x + pad, y + 78, { size: 52, weight: 800, ls: -1.2 });
        if (s.header.count) text(ctx, s.header.count, x + w - pad, y + 76, { size: 40, weight: 700, color: C.blue, align: 'right' });
        ctx.fillStyle = C.line; ctx.fillRect(x + pad, y + head - 2, w - pad * 2, 2);
      }
      s.rows.forEach((r, i) => {
        const cy = y + head + i * rh + rh / 2, p = S(t - r.at, 13); if (p <= .002) return;
        rise(ctx, p, 24, () => {
          ctx.beginPath(); ctx.arc(x + pad + 30, cy, 30, 0, TAU); ctx.fillStyle = C.blue; ctx.fill();
          text(ctx, String(i + 1), x + pad + 30, midBase(cy, 34), { size: 34, weight: 800, align: 'center', color: C.white });
          text(ctx, r.title, x + pad + 84, midBase(cy, 44), { size: 44, weight: 800, ls: -.8 });
          if (r.sub) text(ctx, r.sub, x + w - pad, midBase(cy, 36), { size: 36, weight: 600, color: C.ink2, align: 'right' });
          if (i < s.rows.length - 1) { ctx.fillStyle = 'rgba(40,30,10,.06)'; ctx.fillRect(x + pad + 84, cy + rh / 2 - 1, w - pad * 2 - 84, 1.5); }
        });
      });
    }));
  },
};

// ---- usage meters (rebuilt settings popup, e.g. Claude "Plan usage limits"): rows of label + sub + % + bar.
// rows: [{label, sub, value, fill: {value, at, sub}, mark: {at, to}}]. fill animates the bar (and % text); mark tints the row.
const usage = {
  draw(R, s, t) {
    const { ctx } = R, [x, y, w] = s.rect, pad = 46, rh = 168, head = s.title ? 96 : 30, h = head + s.rows.length * rh + 24;
    env(ctx, s, t, pin => rise(ctx, pin, 70, () => {
      sheet(ctx, x, y, w, h, 34, { elev: 1.2 });
      if (s.title) {
        const lx = s.logo ? x + pad + 56 + 18 : x + pad; if (s.logo) logoImg(R, ctx, s.logo, x + pad, y + 22, 56);
        text(ctx, s.title, lx, y + 70, { size: 36, weight: 600, color: C.ink2 }); ctx.fillStyle = C.line; ctx.fillRect(x + pad, y + head - 2, w - pad * 2, 2);
      }
      s.rows.forEach((r, i) => {
        const ry = y + head + i * rh, mk = r.mark ? S(t - r.mark.at, 12) * (1 - (r.mark.to != null ? S(t - r.mark.to, 12) : 0)) : 0;
        if (mk > .002) alpha(ctx, mk, () => { ctx.beginPath(); ctx.roundRect(x + 18, ry + 12, w - 36, rh - 16, 24); ctx.fillStyle = 'rgba(37,142,255,.08)'; ctx.fill(); ctx.strokeStyle = C.blue; ctx.lineWidth = 4; ctx.stroke(); });
        const f = r.fill ? S(t - r.fill.at, 5) : 0, v = lerp(r.value, r.fill?.value ?? r.value, f) * S(t - s.from + (s.pre || 0) - .15 - i * .08, 7), full = v > .995;
        text(ctx, r.label, x + pad, ry + 66, { size: 44, weight: 700, ls: -.5 });
        text(ctx, Math.round(v * 100) + '%', x + w - pad, ry + 66, { size: 42, weight: 700, align: 'right', color: full ? C.ink : C.ink2 });
        const subB = r.fill?.sub ? S(t - r.fill.at - .5, 12) : 0;
        if (subB < .998 && r.sub) text(ctx, r.sub, x + pad, ry + 114, { size: 34, weight: 500, color: C.ink3, alpha: 1 - subB });
        if (subB > .002) text(ctx, r.fill.sub, x + pad, ry + 114, { size: 34, weight: 700, color: C.ink, alpha: subB });
        const by = ry + 134, bw = w - pad * 2;
        ctx.beginPath(); ctx.roundRect(x + pad, by, bw, 16, 8); ctx.fillStyle = 'rgba(40,30,10,.07)'; ctx.fill();
        if (v > .001) { ctx.beginPath(); ctx.roundRect(x + pad, by, Math.max(16, bw * v), 16, 8); ctx.fillStyle = full ? C.ink : C.blue; ctx.fill(); }
      });
    }));
  },
};


// ---------------------------------------------------------------- motion-design film (full paper, seam 1920)
// A sequence of beats ("md*" scenes) played while the video is paused. Each beat has a step header (blue disc with a
// number or logo, title, sub), a faint giant numeral behind it and a 5-step progress rail on top. Beats slide in from
// the right and leave to the left, so back-to-back beats read as one continuous camera move.
function slide(ctx, s, t, fn) {
  const pin = S(t - s.from, 10), out = s.to != null ? S(t - s.to, 10) : 0;
  const a = Math.min(1, pin * 1.3) * (1 - out); if (a <= .002) return;
  ctx.save(); ctx.globalAlpha *= a; ctx.translate(W * .6 * (1 - pin) - W * .6 * out, 0); fn(pin); ctx.restore();
}
function stepHead(ctx, s, t, R) {
  const st = s.step; if (!st) return;
  const y = st.y ?? 430, r = 66, p = S(t - s.from - .05, 12), img = isImgLogo(st.logo);   // image logo = real app icon after the title, the disc keeps the number
  if (st.n != null && (!st.logo || img)) alpha(ctx, .05 * p, () => text(ctx, String(st.n), W - 20, 1560, { size: 900, weight: 800, ls: -40, align: 'right' }));
  if (st.of) {   // progress rail: done steps blue, the current one fills over the beat
    const n = st.of, gap = 14, x0 = 120, sw = (W - 330 - gap * (n - 1)) / n;   // right end leaves room for the pause badge
    for (let i = 0; i < n; i++) {
      const f = i < st.n - 1 ? 1 : i === st.n - 1 ? E.out(seg(t, s.from, s.to ?? s.from + 3)) : 0;
      ctx.beginPath(); ctx.roundRect(x0 + i * (sw + gap), 290, sw, 12, 6); ctx.fillStyle = C.dim; ctx.fill();
      if (f > .001) { ctx.beginPath(); ctx.roundRect(x0 + i * (sw + gap), 290, sw * f, 12, 6); ctx.fillStyle = C.blue; ctx.fill(); }
    }
  }
  ctx.save(); ctx.translate(120, y); const sc = .7 + .3 * p; ctx.scale(sc, sc); ctx.globalAlpha *= Math.min(1, p * 1.4);
  shadow(ctx, -r, -r, r * 2, r * 2, r, 18, .18, 6);
  ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.fillStyle = C.blue; ctx.fill();
  if (st.logo && LOGO[st.logo]) LOGO[st.logo](ctx, 0, 0, 34, C.white);
  else text(ctx, String(st.n), 0, midBase(0, 64), { size: 64, weight: 800, align: 'center', color: C.white });
  ctx.restore();
  rise(ctx, S(t - s.from - .12, 12), 30, () => {
    text(ctx, st.title, 218, midBase(y - 24, 80), { size: 80, weight: 800, ls: -2.4 });
    if (img && R) { const ix = 218 + measure(ctx, st.title, 80, 800, -2.4) + 26; shadow(ctx, ix, y - 68, 88, 88, 20, 14, .16, 5); logoImg(R, ctx, st.logo, ix, y - 68, 88, 20); }
  });
  if (st.sub) rise(ctx, S(t - s.from - .22, 12), 30, () => text(ctx, st.sub, 220, midBase(y + 50, 44), { size: 44, weight: 600, color: C.ink2 }));
}
// a rubber stamp that lands (scale 1.35 -> 1, no overshoot) at a slight angle
function stamp(ctx, x, y, str, p, o = {}) {
  if (p <= .002) return;
  const size = o.size || 60, w = measure(ctx, str, size, 800, -1) + 70, h = size + 50;
  ctx.save(); ctx.globalAlpha *= Math.min(1, p * 1.6); ctx.translate(x, y); ctx.rotate(o.rot ?? -.07); const k = 1 + .35 * (1 - p); ctx.scale(k, k);
  ctx.beginPath(); ctx.roundRect(-w / 2, -h / 2, w, h, 22); ctx.fillStyle = o.fill || 'rgba(37,142,255,.08)'; ctx.fill();
  ctx.lineWidth = 7; ctx.strokeStyle = C.blue; ctx.stroke();
  text(ctx, str, 0, midBase(0, size), { size, weight: 800, ls: -1, align: 'center', color: C.blue });
  ctx.restore();
}
const fmtT = x => { const m = Math.floor(x / 60), s = x - m * 60; return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`; };

// ---- mdGrid: a slowly drifting dot grid on the paper for the whole film. {from, to}
const mdGrid = {
  draw(R, s, t) {
    const { ctx } = R, a = vis(t, s.from, s.to ?? 1e9, 8, 12) * .5; if (a <= .002) return;
    const g = 60, oy = -((t - s.from) * 14) % g;
    ctx.save(); ctx.globalAlpha *= a; ctx.fillStyle = 'rgba(40,30,10,.13)';
    for (let y = oy; y < 1940; y += g) for (let x = 30; x < W; x += g) { ctx.beginPath(); ctx.arc(x, y, 2.6, 0, TAU); ctx.fill(); }
    ctx.restore();
  },
};

// ---- mdIntro: the narrator introduces itself. Big logo tile on a slow sunburst, title, then a sub line whose words
// land on the narrator's words. {y, title, sub: {text, at, to, emph}}
const mdIntro = {
  draw(R, s, t) {
    const { ctx } = R, y = s.y ?? 640, u = t - s.from;
    slide(ctx, s, t, pin => {
      // sunburst
      alpha(ctx, S(u, 6) * .9, () => {
        ctx.save(); ctx.translate(W / 2, y); ctx.rotate(u * .12);
        for (let i = 0; i < 24; i++) { ctx.rotate(TAU / 24); ctx.beginPath(); ctx.moveTo(0, 0); ctx.arc(0, 0, 1300, -.055, .055); ctx.closePath(); ctx.fillStyle = i % 2 ? 'rgba(37,142,255,.05)' : 'rgba(40,30,10,.025)'; ctx.fill(); }
        ctx.restore();
      });
      // expanding rings on entry
      for (let k = 0; k < 3; k++) { const e = seg(u, .05 + k * .14, .95 + k * .14); if (e > 0 && e < 1) alpha(ctx, (1 - e) * .7, () => { ctx.beginPath(); ctx.arc(W / 2, y, 150 + 420 * E.out(e), 0, TAU); ctx.strokeStyle = C.blue; ctx.lineWidth = 6 * (1 - e) + 1; ctx.stroke(); }); }
      const p = S(u, 11), sz = 320 * (.7 + .3 * p);
      alpha(ctx, Math.min(1, p * 1.5), () => {
        ctx.save(); ctx.translate(W / 2, y); ctx.rotate(-.35 * (1 - p));
        shadow(ctx, -sz / 2, -sz / 2, sz, sz, sz * .27, 40, .28, 16);
        ctx.beginPath(); ctx.roundRect(-sz / 2, -sz / 2, sz, sz, sz * .27); ctx.fillStyle = C.blue; ctx.fill();
        LOGO.claude(ctx, 0, 0, sz * .32, C.white); ctx.restore();
      });
      const words = s.title.split(' '), size = 150, ls = -5, sp = measure(ctx, ' ', size, 800, ls), ws = words.map(w => measure(ctx, w, size, 800, ls));
      let x = W / 2 - (ws.reduce((a, b) => a + b, 0) + sp * (words.length - 1)) / 2;
      words.forEach((w, i) => { const q = S(u - .15 - i * .1, 13), wx = x; x += ws[i] + sp; rise(ctx, q, 60, () => text(ctx, w, wx, y + 370, { size, weight: 800, ls })); });
      if (s.sub) {
        const toks = typing(s.sub.text, R.tl.words.some(w => w.narrator) ? R.tl.words.filter(w => w.narrator) : R.tl.words, s.sub.at, s.sub.to ?? s.sub.at + 1.5), fs = 64;
        const lines = wrap(ctx, s.sub.text, 900, fs, 700); let k = 0;
        lines.forEach((ln, li) => {
          const lw = ln.split(' '), lws = lw.map(w => measure(ctx, w, fs, 700)), lsp = measure(ctx, ' ', fs, 700);
          let lx = W / 2 - (lws.reduce((a, b) => a + b, 0) + lsp * (lw.length - 1)) / 2;
          lw.forEach((w, i) => {
            const tk = toks[k++], q = tk ? S(t - tk.start + .04, 18) : 1, wx = lx; lx += lws[i] + lsp;
            const em = s.sub.emph && w.replace(/[.,]/g, '') === s.sub.emph;
            rise(ctx, q, 26, () => text(ctx, w, wx, y + 520 + li * 84, { size: fs, weight: 700, color: em ? C.blue : C.ink2 }));
          });
        });
      }
    });
  },
};

// ---- overlay: a full-frame transparent clip (a media with alpha: true, e.g. an app UI animated in HTML and captured with
// omitBackground) drawn straight over the frame, under the captions. With layer: 'over' it sits on top of the full-screen
// camera (seam 0), e.g. the Instagram Reels UI over the creator's face for a comment CTA. Keep it inside a full-screen
// stretch: a window move draws the camera card over the 'over' layer. {media, from, to, offset, fade (s, 0 = cut),
// rect: [x, y, w, h] (default the whole layer: 0, 0, W, H; a 1920x1080 clip on a youtube 'over'/'top' layer = [0, 0, 1920, 1080])}
const overlay = {
  needs(s, t) { return t >= s.from - .1 && t <= (s.to ?? 1e9) + .1 ? [[s.media, clipTime(t, s.from, s.offset || 0)]] : []; },
  draw(R, s, t) {
    const to = s.to ?? 1e9; if (t < s.from || t > to) return;
    const img = R.frame(s.media, clipTime(t, s.from, s.offset || 0)); if (!img) return;
    const f = s.fade || 0, a = f ? Math.min(1, (t - s.from) / f, (to - t) / f) : 1;
    const [x, y, w, h] = s.rect || [0, 0, W, H], m = R.media?.(s.media), c = m?.crop;   // crop: only the clip's visible box is stored
    const kx = c ? w / m.w : 0, ky = c ? h / m.h : 0;
    alpha(R.ctx, a, () => c ? R.ctx.drawImage(img, x + c[0] * kx, y + c[1] * ky, c[2] * kx, c[3] * ky) : R.ctx.drawImage(img, x, y, w, h));
  },
};

// ---- mdRec: step 1, the raw take. The card plays the source, a REC pill blinks, the timecode runs, then a stamp.
// {step, media, y, clock (seconds shown at the end), stamp: {text, at}}
const mdRec = {
  needs(s, t) { return t >= s.from - .3 && t <= (s.to ?? 1e9) + .7 ? [[s.media, clipTime(t, s.from, s.offset || 0)]] : []; },
  draw(R, s, t) {
    const { ctx } = R, w = 960, h = 540, x = W / 2 - w / 2, y = s.y ?? 600;
    slide(ctx, s, t, () => {
      stepHead(ctx, s, t, R);
      const img = R.frame(s.media, clipTime(t, s.from, s.offset || 0));
      rise(ctx, S(t - s.from - .1, 11), 60, () => {
        card(R, x, y, w, h, img);
        const blink = Math.sin((t - s.from) * 6) > -.3 ? 1 : .25;
        ctx.beginPath(); ctx.roundRect(x + 28, y + 28, 168, 64, 32); ctx.fillStyle = 'rgba(20,22,27,.62)'; ctx.fill();
        alpha(ctx, blink, () => { ctx.beginPath(); ctx.arc(x + 62, y + 60, 13, 0, TAU); ctx.fillStyle = C.blue; ctx.fill(); });
        text(ctx, 'REC', x + 88, midBase(y + 60, 36), { size: 36, weight: 800, color: C.white });
        const secs = (s.clock || 55) * E.io(seg(t, s.from + .2, s.to ?? s.from + 2.5)), tc = fmtT(secs);
        const tw = measure(ctx, tc, 36, 600, 0, 'JetBrains Mono') + 44;
        ctx.beginPath(); ctx.roundRect(x + w - 28 - tw, y + h - 28 - 64, tw, 64, 32); ctx.fillStyle = 'rgba(20,22,27,.62)'; ctx.fill();
        text(ctx, tc, x + w - 28 - tw / 2, midBase(y + h - 28 - 32, 36), { size: 36, weight: 600, align: 'center', color: C.white, fam: 'JetBrains Mono' });
      });
      if (s.stamp) stamp(ctx, W / 2, y + h + 260, s.stamp.text, S(t - s.stamp.at, 16), { size: 88 });
    });
  },
};

// ---- mdWave: step 2, transcription. A waveform, a playhead that sweeps it, and each word it passes drops into a list
// with its timestamp. {step, y, words: [[text, seconds]], sweepFrom, sweepTo, markAt (decimals turn blue)}
const mdWave = {
  draw(R, s, t) {
    const { ctx } = R, x = 60, w = 960, y = s.y ?? 600, h = 300, n = 64, bw = (w - 80) / n;
    const ph = E.io(seg(t, s.sweepFrom, s.sweepTo)), phx = x + 40 + (w - 80) * ph, mk = s.markAt != null ? S(t - s.markAt, 12) : 0;
    slide(ctx, s, t, () => {
      stepHead(ctx, s, t, R);
      rise(ctx, S(t - s.from - .1, 11), 60, () => {
        sheet(ctx, x, y, w, h, 36, { elev: 1.2 });
        for (let i = 0; i < n; i++) {
          const v = .15 + .85 * Math.pow(noise1(i * .55 + 3), 1.4) * (.55 + .45 * Math.abs(Math.sin(i * .9))), bh = (h - 70) * v, bx = x + 40 + i * bw;
          const on = bx < phx; ctx.beginPath(); ctx.roundRect(bx + 2, y + h / 2 - bh / 2, bw - 5, bh, (bw - 5) / 2); ctx.fillStyle = on ? C.blue : C.dim; ctx.fill();
        }
        if (t > s.sweepFrom - .2) { ctx.fillStyle = C.ink; ctx.fillRect(phx - 2.5, y + 14, 5, h - 28); ctx.beginPath(); ctx.arc(phx, y + 14, 11, 0, TAU); ctx.fill(); }
      });
      const L = s.words.length;
      s.words.forEach(([wd, sec], i) => {
        const f = (i + .5) / L, at = s.sweepFrom + (s.sweepTo - s.sweepFrom) * f * .92, p = S(t - at, 13); if (p <= .002) return;
        const ry = y + h + 100 + i * 116, fx = x + 40 + (w - 80) * f;
        ctx.save(); ctx.globalAlpha *= Math.min(1, p * 1.4); ctx.translate((fx - 200) * (1 - p) * .35, -(ry - y - h / 2) * (1 - p));
        const tc = fmtT(sec), whole = tc.slice(0, 6), dec = tc.slice(6);
        text(ctx, whole, 100, midBase(ry, 52), { size: 52, weight: 600, color: C.ink2, fam: 'JetBrains Mono' });
        const dx = 100 + measure(ctx, whole, 52, 600, 0, 'JetBrains Mono');
        if (mk > .002) { ctx.beginPath(); ctx.roundRect(dx - 6, ry - 38, measure(ctx, dec, 52, 600, 0, 'JetBrains Mono') * mk + 12, 76, 12); ctx.fillStyle = 'rgba(37,142,255,.16)'; ctx.fill(); }
        text(ctx, dec, dx, midBase(ry, 52), { size: 52, weight: 700, color: mix(C.ink2, C.blue, mk), fam: 'JetBrains Mono' });
        text(ctx, wd, 520, midBase(ry, 66), { size: 66, weight: 800, ls: -1.5 });
        ctx.restore();
      });
    });
  },
};

// ---- mdVision: step 3, person segmentation. A camera frame; a scan line sweeps down and everything above it becomes
// transparent (checkerboard) with the speaker outlined in blue; then a flip-book counter. {step, frameAt, y,
// scanFrom, scanTo, flipAt, frames: [a, b] (counter range), w: 940 (card width)}
let VIS = null;
const mdVision = {
  needs(s, t, U) { return t >= s.from - .3 && t <= (s.to ?? 1e9) + .7 && U ? [U.cam(s.frameAt), U.cut(s.frameAt)] : []; },
  draw(R, s, t) {
    const { ctx } = R, w = s.w ?? 940, h = Math.round(w * 1080 / 1200), x = W / 2 - w / 2, y = s.y ?? 600;
    const cam = R.img(R.U.cam(s.frameAt)), cut = R.img(R.U.cut(s.frameAt));
    const sc = E.io(seg(t, s.scanFrom, s.scanTo)), ly = y + h * sc, fl = s.flipAt != null ? S(t - s.flipAt, 12) : 0;
    slide(ctx, s, t, () => {
      stepHead(ctx, s, t, R);
      rise(ctx, S(t - s.from - .1, 11), 60, () => {
        for (let k = 3; k >= 1; k--) alpha(ctx, fl, () => { ctx.save(); ctx.translate(x + w / 2, y + h / 2); ctx.rotate(k * .045 * fl); ctx.translate(-(x + w / 2) + k * 22 * fl, -(y + h / 2) + k * 14 * fl); sheet(ctx, x - 12, y - 12, w + 24, h + 24, 30, { elev: .6 }); ctx.restore(); });
        sheet(ctx, x - 12, y - 12, w + 24, h + 24, 30, { elev: 1.3 });
        ctx.save(); ctx.beginPath(); ctx.roundRect(x, y, w, h, 20); ctx.clip();
        if (cam) ctx.drawImage(cam, x, y, w, h);
        if (sc > .001 && cut) {
          ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, ly - y); ctx.clip();
          const q = 40; for (let yy = y; yy < ly; yy += q) for (let xx = x; xx < x + w; xx += q) { ctx.fillStyle = ((xx - x) / q + (yy - y) / q) % 2 ? C.sheet : '#E9E5DB'; ctx.fillRect(xx, yy, q, q); }
          if (!VIS) VIS = new OffscreenCanvas(cut.width, cut.height);
          const v = VIS.getContext('2d'); v.globalCompositeOperation = 'source-over'; v.clearRect(0, 0, VIS.width, VIS.height); v.drawImage(cut, 0, 0);
          v.globalCompositeOperation = 'source-in'; v.fillStyle = C.blue; v.fillRect(0, 0, VIS.width, VIS.height);
          for (let k = 0; k < 12; k++) { const an = k * TAU / 12; ctx.drawImage(VIS, x + Math.cos(an) * 6, y + Math.sin(an) * 6, w, h); }
          ctx.drawImage(cut, x, y, w, h);
          ctx.restore();
        }
        ctx.restore();
        if (t > s.scanFrom - .1 && sc < .999) {
          ctx.save(); ctx.shadowColor = 'rgba(37,142,255,.8)'; ctx.shadowBlur = 24; ctx.fillStyle = C.blue; ctx.fillRect(x - 24, ly - 3, w + 48, 6); ctx.restore();
          const lab = Math.round(sc * 100) + ' %', lw = measure(ctx, lab, 36, 700, 0, 'JetBrains Mono') + 40;
          ctx.beginPath(); ctx.roundRect(x + w + 24 - lw, ly - 70, lw, 56, 28); ctx.fillStyle = C.blue; ctx.fill();
          text(ctx, lab, x + w + 24 - lw / 2, midBase(ly - 42, 36), { size: 36, weight: 700, align: 'center', color: C.white, fam: 'JetBrains Mono' });
        }
      });
      if (s.flipAt != null && fl > .002) {
        const [a, b] = s.frames || [1, 1471], n = Math.round(lerp(a, b, E.out(seg(t, s.flipAt, (s.to ?? s.flipAt + 1.2) - .1))));
        const str = `Image ${String(n).padStart(4, '0')}`;
        rise(ctx, fl, 30, () => chip(ctx, W / 2, y + h + 130, str, { size: 50, h: 104, padX: 40, fill: C.ink, color: C.white, border: false }));
      }
    });
  },
};

// ---- mdDiffuse: step 4, image generation. A prompt types itself, then the picture resolves from big noisy pixels
// to sharp. {step, src, y, prompt: {text, from, to}, genFrom, sharpAt}
let NOISE = null;
const mdDiffuse = {
  needs(s, t) { return t >= s.from - .3 && t <= (s.to ?? 1e9) + .7 ? ['/p/' + s.src] : []; },
  draw(R, s, t) {
    const { ctx } = R, x = 60, w = 960, y = s.y ?? 600, ih = 720, iy = y + 160, img = R.img('/p/' + s.src);
    const q = E.io(seg(t, s.genFrom, s.sharpAt)), started = t >= s.genFrom;
    slide(ctx, s, t, () => {
      stepHead(ctx, s, t, R);
      rise(ctx, S(t - s.from - .1, 11), 50, () => {
        sheet(ctx, x, y, w, 110, 55, { elev: 1.1 });
        const n = Math.round(s.prompt.text.length * clamp((t - s.prompt.from) / (s.prompt.to - s.prompt.from))), str = s.prompt.text.slice(0, Math.max(0, n));
        text(ctx, str || 'Décris une image…', x + 44, midBase(y + 55, 40), { size: 40, weight: 600, color: str ? C.ink : C.ink3 });
        if (n < s.prompt.text.length && t > s.prompt.from - .2 && Math.sin(t * 11) > -.2) { ctx.fillStyle = C.blue; ctx.fillRect(x + 48 + measure(ctx, str, 40, 600), y + 30, 3.5, 50); }
        const go = S(t - s.prompt.to, 14); ctx.beginPath(); ctx.arc(x + w - 55, y + 55, 36, 0, TAU); ctx.fillStyle = mix(C.dim, C.blue, go); ctx.fill();
        ctx.save(); ctx.strokeStyle = C.white; ctx.lineWidth = 6; ctx.lineCap = 'round'; ctx.lineJoin = 'round'; ctx.beginPath(); ctx.moveTo(x + w - 55, y + 72); ctx.lineTo(x + w - 55, y + 38); ctx.moveTo(x + w - 70, y + 52); ctx.lineTo(x + w - 55, y + 38); ctx.lineTo(x + w - 40, y + 52); ctx.stroke(); ctx.restore();
      });
      rise(ctx, S(t - s.genFrom + .3, 11), 60, () => {
        sheet(ctx, x - 12, iy - 12, w + 24, ih + 24, 30, { elev: 1.3 });
        ctx.save(); ctx.beginPath(); ctx.roundRect(x, iy, w, ih, 20); ctx.clip();
        ctx.fillStyle = '#E9E5DB'; ctx.fillRect(x, iy, w, ih);
        if (img && started) {
          const px = Math.max(1, Math.round(120 * Math.pow(1 - q, 2.2)));
          if (px <= 1) cover(ctx, img, x, iy, w, ih);
          else {
            const sw = Math.ceil(w / px), shh = Math.ceil(ih / px), oc = new OffscreenCanvas(sw, shh), o = oc.getContext('2d');
            cover(o, img, 0, 0, sw, shh); ctx.imageSmoothingEnabled = false; ctx.drawImage(oc, x, iy, sw * px, shh * px); ctx.imageSmoothingEnabled = true;
          }
          if (!NOISE) { NOISE = new OffscreenCanvas(256, 256); const g = NOISE.getContext('2d'), d = g.createImageData(256, 256); for (let i = 0; i < d.data.length; i += 4) { const v = Math.random() * 255; d.data[i] = d.data[i + 1] = d.data[i + 2] = v; d.data[i + 3] = 255; } g.putImageData(d, 0, 0); }
          const na = (1 - q) * .55; if (na > .01) { ctx.globalAlpha = na; ctx.globalCompositeOperation = 'overlay'; const f = Math.floor(t * 30), ox = (f * 97) % 256, oy = (f * 61) % 256; for (let yy = iy - oy; yy < iy + ih; yy += 256) for (let xx = x - ox; xx < x + w; xx += 256) ctx.drawImage(NOISE, xx, yy); ctx.globalAlpha = 1; ctx.globalCompositeOperation = 'source-over'; }
          const fl = t >= s.sharpAt ? Math.exp(-(t - s.sharpAt) * 5) : 0; if (fl > .01) { ctx.fillStyle = `rgba(255,255,255,${fl * .7})`; ctx.fillRect(x, iy, w, ih); }
        }
        ctx.restore();
        const by = iy + ih + 80, bw = w - 260;
        ctx.beginPath(); ctx.roundRect(x, by - 8, bw, 16, 8); ctx.fillStyle = 'rgba(40,30,10,.08)'; ctx.fill();
        if (q > .001) { ctx.beginPath(); ctx.roundRect(x, by - 8, Math.max(16, bw * q), 16, 8); ctx.fillStyle = C.blue; ctx.fill(); }
        text(ctx, Math.round(q * 100) + ' %', x + w, midBase(by, 56), { size: 56, weight: 800, align: 'right', color: q > .999 ? C.blue : C.ink, fam: 'JetBrains Mono' });
      });
    });
  },
};

// ---- mdCode: step 5, music and sound effects written as code. Lines type themselves; each finished line fires its
// effect (notes float up, the equaliser jumps). {step, y, file, lines: [{text, at, dur}], eq: false hides the equaliser}
const mdCode = {
  draw(R, s, t) {
    const { ctx } = R, x = 60, w = 960, y = s.y ?? 600, lh = 100, top = 110, h = top + s.lines.length * lh + 50, fs = 46;
    slide(ctx, s, t, () => {
      stepHead(ctx, s, t, R);
      rise(ctx, S(t - s.from - .1, 11), 60, () => {
        sheet(ctx, x, y, w, h, 36, { elev: 1.3 });
        [0, 1, 2].forEach(i => { ctx.beginPath(); ctx.arc(x + 50 + i * 36, y + 52, 11, 0, TAU); ctx.fillStyle = C.dim; ctx.fill(); });
        text(ctx, s.file || 'musique.js', x + w / 2, midBase(y + 52, 34), { size: 34, weight: 600, align: 'center', color: C.ink2, fam: 'JetBrains Mono' });
        ctx.fillStyle = C.line; ctx.fillRect(x, y + 96, w, 2);
        s.lines.forEach((ln, i) => {
          const ly = y + top + 20 + i * lh, d = ln.dur ?? ln.text.length * .03, n = Math.round(ln.text.length * clamp((t - ln.at) / d));
          const done = t >= ln.at + d, act = t >= ln.at && (i === s.lines.length - 1 || t < s.lines[i + 1].at);
          if (act) { ctx.fillStyle = 'rgba(37,142,255,.07)'; ctx.fillRect(x + 4, ly - lh / 2 + 4, w - 8, lh - 8); }
          text(ctx, String(i + 1), x + 70, midBase(ly, 34), { size: 34, weight: 500, align: 'right', color: C.ink3, fam: 'JetBrains Mono' });
          if (n <= 0) return;
          const str = ln.text.slice(0, n); let cx = x + 110;
          for (const m of str.matchAll(/('[^']*'?|\d[\d.]*|[A-Za-z_]+|[^A-Za-z_\d']+)/g)) {
            const tk = m[0], col = /^'/.test(tk) || /^\d/.test(tk) ? C.blue : /^(const|await)$/.test(tk) ? C.blue2 : /^[A-Za-z_]/.test(tk) ? C.ink : C.ink3;
            text(ctx, tk, cx, midBase(ly, fs), { size: fs, weight: /^[A-Za-z_]/.test(tk) ? 600 : 500, color: col, fam: 'JetBrains Mono' }); cx += measure(ctx, tk, fs, /^[A-Za-z_]/.test(tk) ? 600 : 500, 0, 'JetBrains Mono');
          }
          if (!done && Math.sin(t * 12) > -.2) { ctx.fillStyle = C.blue; ctx.fillRect(cx + 2, ly - 26, 3.5, 50); }
          if (done && s.notes !== false) for (let k = 0; k < 3; k++) {   // the line "plays": notes float up from its end
            const u = (t - ln.at - d - k * .12) / 1.1; if (u <= 0 || u >= 1) continue;
            alpha(ctx, (1 - u) * Math.min(1, u * 8), () => note(ctx, cx + 40 + k * 46 + 20 * Math.sin(u * 4 + k), ly - 10 - 170 * E.out(u), .9));
          }
        });
      });
      // equaliser under the editor, driven by the lines that already "play"
      const live = s.lines.filter(l => t >= l.at + (l.dur ?? l.text.length * .03)).length / s.lines.length;
      const kick = s.lines.reduce((m, l) => { const e = t - l.at - (l.dur ?? l.text.length * .03); return e >= 0 ? Math.max(m, Math.exp(-e * 5)) : m; }, 0);
      const ey = y + h + 200, nb = 30, bw = w / nb;
      if (s.eq !== false) alpha(ctx, S(t - s.from - .3, 10), () => {
        for (let i = 0; i < nb; i++) {
          const v = .08 + (.25 + .75 * live) * Math.abs(Math.sin(t * (5 + i * .37) + i * 1.3)) * (.5 + .5 * Math.sin(t * 2.1 + i * .5)) * (.6 + .4 * kick);
          const bh = 14 + 230 * v; ctx.beginPath(); ctx.roundRect(x + i * bw + 5, ey - bh / 2, bw - 10, bh, (bw - 10) / 2); ctx.fillStyle = i % 5 === 0 ? C.blue : mix(C.dim, C.blue, live * .6); ctx.fill();
        }
      });
    });
  },
};

// ---- mdAssemble: step 6, the edit. Clips fly in from everywhere and snap onto their tracks, a playhead runs the
// cut, a stamp lands. {step, y, tracks: [{label, clips: [[a, b]], cam: true}], flyFrom, stagger, playFrom, playTo, stamp: {text, at}}
const mdAssemble = {
  draw(R, s, t) {
    const { ctx } = R, x = 60, w = 960, y = s.y ?? 600, rh = 150, lx = x + 240, lw = w - 240 - 36, h = s.tracks.length * rh + 40;
    const ph = E.io(seg(t, s.playFrom, s.playTo)), phx = lx + lw * ph;
    slide(ctx, s, t, () => {
      stepHead(ctx, s, t, R);
      rise(ctx, S(t - s.from - .05, 11), 50, () => {
        sheet(ctx, x, y, w, h, 36, { elev: 1.2 });
        s.tracks.forEach((tr, i) => {
          const ry = y + 20 + i * rh;
          if (i) { ctx.fillStyle = C.line; ctx.fillRect(x + 30, ry, w - 60, 1.5); }
          text(ctx, tr.label, x + 36, midBase(ry + rh / 2, 42), { size: 42, weight: 700, ls: -.5 });
        });
      });
      let k = 0;
      s.tracks.forEach((tr, i) => tr.clips.forEach(([a, b], j) => {
        const idx = k++, at = s.flyFrom + idx * (s.stagger ?? .075), p = S(t - at, 11); if (p <= .002) return;
        const r = hash(idx * 7.3 + 1), r2 = hash(idx * 3.1 + 5), cx = lx + lw * a, cw = Math.max(26, lw * (b - a) - 6), cy = y + 20 + i * rh + 18, ch = rh - 36;
        const dx = (r - .5) * 1400, dy = (r2 < .5 ? -1 : 1) * (500 + 400 * r2), rot = (r - .5) * .9;
        ctx.save(); ctx.globalAlpha *= Math.min(1, p * 1.5); ctx.translate(cx + cw / 2 + dx * (1 - p), cy + ch / 2 + dy * (1 - p)); ctx.rotate(rot * (1 - p));
        const on = ph > a && ph < b + .01 ? 1 : 0;
        if (tr.cam && R.cam) { ctx.save(); ctx.beginPath(); ctx.roundRect(-cw / 2, -ch / 2, cw, ch, 12); ctx.clip(); cover(ctx, R.cam, -cw / 2, -ch / 2, cw, ch, 0, [.5, .35]); ctx.restore(); ctx.beginPath(); ctx.roundRect(-cw / 2, -ch / 2, cw, ch, 12); ctx.strokeStyle = on ? C.blue : 'rgba(20,22,27,.12)'; ctx.lineWidth = on ? 5 : 2; ctx.stroke(); }
        else if (tr.text) {
          ctx.beginPath(); ctx.roundRect(-cw / 2, -ch / 2, cw, ch, 12); ctx.fillStyle = on ? C.blue : C.sheet; ctx.fill(); ctx.strokeStyle = on ? C.blue : C.line; ctx.lineWidth = 2; ctx.stroke();
          text(ctx, 'Aa', -cw / 2 + 16, midBase(0, 38), { size: 38, weight: 800, color: on ? C.white : C.ink });
        }
        else {
          ctx.beginPath(); ctx.roundRect(-cw / 2, -ch / 2, cw, ch, 12); ctx.fillStyle = on || tr.blue ? C.blue : C.tint; ctx.fill();
          ctx.fillStyle = on || tr.blue ? 'rgba(255,255,255,.85)' : 'rgba(37,142,255,.7)';
          const nb = Math.max(1, Math.floor((cw - 14) / 11)); for (let q = 0; q < nb; q++) { const hh = (ch - 22) * (.2 + .8 * Math.abs(Math.sin(q * 1.3 + i * 2 + j))); ctx.fillRect(-cw / 2 + 8 + q * 11, -hh / 2, 5, hh); }
        }
        ctx.restore();
      }));
      if (t > s.playFrom - .2) alpha(ctx, vis(t, s.playFrom - .2, 1e9, 14), () => {
        ctx.fillStyle = C.ink; ctx.fillRect(phx - 2.5, y + 6, 5, h - 12);
        ctx.beginPath(); ctx.moveTo(phx - 16, y - 8); ctx.lineTo(phx + 16, y - 8); ctx.lineTo(phx, y + 14); ctx.closePath(); ctx.fill();
      });
      if (s.stamp) stamp(ctx, W / 2, y + h + 190, s.stamp.text, S(t - s.stamp.at, 16), { size: 70, rot: -.05 });
    });
  },
};


// a mini 9:16 short (paper top with a card in variant k, the live camera below, a caption pill at capAt of the height).
// Used by mdStills and mdRender.
function miniShort(R, ctx, x, y, w, h, k, o = {}) {
  ctx.save(); ctx.beginPath(); ctx.roundRect(x, y, w, h, o.r ?? 14); ctx.clip();
  ctx.fillStyle = C.paper; ctx.fillRect(x, y, w, h);
  const sh = h * .5; if (R.cam) cover(ctx, R.cam, x, y + sh, w, h - sh, 0, [.5, .3]);
  const cx = x + w * .1, cw = w * .8, cy = y + sh * .2, ch = sh * .64, v = ((k % 4) + 4) % 4;
  ctx.fillStyle = C.sheet; ctx.beginPath(); ctx.roundRect(cx, cy, cw, ch, w * .05); ctx.fill();
  ctx.strokeStyle = 'rgba(60,45,20,.1)'; ctx.lineWidth = 1.5; ctx.stroke();
  if (v === 0) text(ctx, '92', cx + cw / 2, midBase(cy + ch / 2, w * .3), { size: w * .3, weight: 800, align: 'center', color: C.blue, ls: -2 });
  else if (v === 1) [.85, .55, .3].forEach((f, i) => { ctx.beginPath(); ctx.roundRect(cx + cw * .12, cy + ch * (.22 + i * .24), cw * .76 * f, ch * .14, ch * .07); ctx.fillStyle = i ? C.dim : C.blue; ctx.fill(); });
  else if (v === 2) { ctx.beginPath(); ctx.arc(cx + cw * .22, cy + ch * .32, cw * .09, 0, TAU); ctx.fillStyle = C.blue; ctx.fill(); [.6, .78, .45].forEach((f, i) => { ctx.beginPath(); ctx.roundRect(cx + cw * (i ? .12 : .38), cy + ch * (.25 + i * .24), cw * f * (i ? 1 : .8), ch * .1, ch * .05); ctx.fillStyle = C.dim; ctx.fill(); }); }
  else { ctx.beginPath(); ctx.arc(cx + cw / 2, cy + ch / 2, ch * .3, 0, TAU); ctx.fillStyle = C.blue; ctx.fill(); checkIcon(ctx, cx + cw / 2, cy + ch / 2, ch * .3, C.white); }
  const pw = w * .62, ph = h * .055, py = y + h * (o.capAt ?? .6);
  ctx.beginPath(); ctx.roundRect(x + w / 2 - pw / 2, py - ph / 2, pw, ph, ph / 2); ctx.fillStyle = C.white; ctx.fill();
  ctx.beginPath(); ctx.roundRect(x + w / 2 - pw / 2 + ph * .4, py - ph * .17, pw * .42, ph * .34, ph * .17); ctx.fillStyle = C.ink; ctx.fill();
  ctx.beginPath(); ctx.roundRect(x + w / 2 - pw / 2 + ph * .4 + pw * .46, py - ph * .17, pw * .3, ph * .34, ph * .17); ctx.fillStyle = C.blue; ctx.fill();
  ctx.restore();
}

// ---- mdCut: the tightening. A waveform with its silences; they get marked, close up, the speed stamp lands and a
// big clock runs down. {step, y, markAt, closeAt, speedAt, speed: '×1.15', factor: 1.15, clock: {start: 60, stop: 40, at, endAt}}
const CUTSEG = [[9, 0], [4, 1], [7, 0], [5, 1], [10, 0], [3, 1], [8, 0], [6, 1], [9, 0]];   // [bars, is silence]
const mdCut = {
  draw(R, s, t) {
    const { ctx } = R, x = 60, w = 960, y = s.y ?? 600, h = 300;
    const mk = s.markAt != null ? S(t - s.markAt, 12) : 0, cl = s.closeAt != null ? E.io(seg(t, s.closeAt, s.closeAt + .55)) : 0;
    const sp = s.speedAt != null ? E.io(seg(t, s.speedAt, s.speedAt + .5)) : 0, k = 1 - (1 - 1 / (s.factor || 1.15)) * sp;
    const total = CUTSEG.reduce((a, [n]) => a + n, 0), kept = CUTSEG.reduce((a, [n, g]) => a + (g ? 0 : n), 0), bw = (w - 80) / total;
    const span = (total - (total - kept) * cl) * bw * k;
    slide(ctx, s, t, () => {
      stepHead(ctx, s, t, R);
      rise(ctx, S(t - s.from - .1, 11), 60, () => {
        sheet(ctx, x, y, w, h, 36, { elev: 1.2 });
        let bx = x + w / 2 - span / 2, bi = 0;
        for (const [nb, gap] of CUTSEG) {
          const ww = bw * k * (gap ? 1 - cl : 1);
          if (gap && ww > .4) {
            alpha(ctx, mk * (1 - cl), () => {
              ctx.beginPath(); ctx.roundRect(bx + 2, y + 34, nb * ww - 4, h - 68, 14); ctx.fillStyle = 'rgba(37,142,255,.12)'; ctx.fill();
              ctx.setLineDash([12, 9]); ctx.strokeStyle = C.blue; ctx.lineWidth = 3; ctx.stroke(); ctx.setLineDash([]);
            });
            alpha(ctx, 1 - cl, () => { for (let i = 0; i < nb; i++) { ctx.beginPath(); ctx.roundRect(bx + i * ww + 2, y + h / 2 - 6, Math.max(1, ww - 5), 12, 6); ctx.fillStyle = C.dim; ctx.fill(); } });
          } else if (!gap) for (let i = 0; i < nb; i++) {
            const v = .2 + .8 * Math.pow(noise1((bi + i) * .55 + 3), 1.3) * (.55 + .45 * Math.abs(Math.sin((bi + i) * .9))), bh = (h - 80) * v;
            ctx.beginPath(); ctx.roundRect(bx + i * ww + 2, y + h / 2 - bh / 2, ww - 5, bh, (ww - 5) / 2); ctx.fillStyle = mix(C.ink2, C.blue, cl); ctx.fill();
          }
          bx += nb * ww; bi += nb;
        }
      });
      if (s.speedAt != null) stamp(ctx, W / 2, y + h + 120, s.speed || '×1.15', S(t - s.speedAt, 16), { size: 76 });
      if (s.clock) {
        const c = s.clock, q = E.io(seg(t, c.at, c.endAt)), v = Math.round(lerp(c.start, c.stop, q)), str = `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
        rise(ctx, S(t - c.at + .35, 12), 40, () => text(ctx, str, W / 2, midBase(y + h + 350, 210), { size: 210, weight: 800, align: 'center', ls: -6, fam: 'JetBrains Mono', color: q >= .999 ? C.blue : C.ink }));
      }
    });
  },
};

// ---- mdStills: the self-review. A contact sheet of stills drops in, a loupe scans it, one still gets flagged (its
// caption covers the card), then the caption slides into place and the flag turns into a check.
// {step, y, enterAt, scanFrom, flagAt, flag (index 0..7), fixAt}
const mdStills = {
  draw(R, s, t) {
    const { ctx } = R, cols = 4, gap = 24, x0 = 60, tw = (960 - gap * (cols - 1)) / cols, th = tw * 16 / 9, y0 = s.y ?? 560;
    const fi = s.flag ?? 5, fl = s.flagAt != null ? S(t - s.flagAt, 14) : 0, fx = s.fixAt != null ? S(t - s.fixAt, 11) : 0;
    const ctr = i => [x0 + (i % cols) * (tw + gap) + tw / 2, y0 + Math.floor(i / cols) * (th + gap) + th / 2];
    slide(ctx, s, t, () => {
      stepHead(ctx, s, t, R);
      for (let i = 0; i < 8; i++) {
        const [cx, cy] = ctr(i), x = cx - tw / 2, y = cy - th / 2, p = S(t - (s.enterAt ?? s.from + .1) - i * .06, 12); if (p <= .002) continue;
        rise(ctx, p, 50, () => {
          const isF = i === fi;
          sheet(ctx, x - 6, y - 6, tw + 12, th + 12, 18, { elev: .9 });
          miniShort(R, ctx, x, y, tw, th, i, { capAt: isF ? lerp(.36, .62, E.io(fx)) : .62 });
          if (!isF) alpha(ctx, fl * .5 * (1 - fx), () => { ctx.beginPath(); ctx.roundRect(x - 6, y - 6, tw + 12, th + 12, 18); ctx.fillStyle = C.paper; ctx.fill(); });
          if (isF && fl > .002) {
            ctx.beginPath(); ctx.roundRect(x - 14, y - 14, tw + 28, th + 28, 24); ctx.strokeStyle = C.blue; ctx.lineWidth = 7 * fl; ctx.stroke();
            ctx.save(); ctx.translate(x + tw - 2, y + 2); const kk = .6 + .4 * fl; ctx.scale(kk, kk);
            ctx.beginPath(); ctx.arc(0, 0, 40, 0, TAU); ctx.fillStyle = C.blue; ctx.fill();
            alpha(ctx, 1 - fx, () => text(ctx, '!', 0, midBase(0, 54), { size: 54, weight: 800, align: 'center', color: C.white }));
            if (fx > .002) checkIcon(ctx, 0, 0, 40, C.white, fx);
            ctx.restore();
          }
        });
      }
      // the loupe: snakes over the sheet and stops on the flagged still, magnifying what is under it
      if (s.scanFrom != null) {
        const order = [0, 1, 2, 3, 7, 6, 5, 4], path = order.slice(0, order.indexOf(fi) + 1).map(ctr);
        path[path.length - 1] = [path.at(-1)[0], path.at(-1)[1] - th * .14];   // parks on the flagged caption, over the card it covers
        const end = s.flagAt ?? s.scanFrom + 1.5, q = E.io(seg(t, s.scanFrom, end)) * (path.length - 1), j = Math.min(path.length - 2, Math.floor(q)), f = q - j;
        const [lx, ly] = path.length > 1 ? [lerp(path[j][0], path[j + 1][0], f), lerp(path[j][1], path[j + 1][1], f)] : path[0];
        const a = S(t - s.scanFrom + .25, 12) * (1 - S(t - (s.fixAt ?? end + 1) - .5, 10));
        alpha(ctx, a, () => {
          const r = 96, z = 1.7, sr = r / z, m = ctx.getTransform();
          ctx.save(); ctx.beginPath(); ctx.arc(lx, ly, r, 0, TAU); ctx.clip();
          ctx.drawImage(ctx.canvas, m.a * (lx - sr) + m.e, m.d * (ly - sr) + m.f, 2 * sr * m.a, 2 * sr * m.d, lx - r, ly - r, 2 * r, 2 * r);
          ctx.restore();
          ctx.lineCap = 'round'; ctx.strokeStyle = C.ink;
          ctx.lineWidth = 24; ctx.beginPath(); ctx.moveTo(lx + r * .78, ly + r * .78); ctx.lineTo(lx + r * 1.45, ly + r * 1.45); ctx.stroke();
          ctx.lineWidth = 11; ctx.beginPath(); ctx.arc(lx, ly, r, 0, TAU); ctx.stroke();
          ctx.lineWidth = 6; ctx.strokeStyle = 'rgba(255,255,255,.7)'; ctx.beginPath(); ctx.arc(lx, ly, r - 22, -2.6, -1.9); ctx.stroke();
        });
      }
    });
  },
};

// ---- mdRender: the render. A browser window renders the short frame by frame (preview, counter, progress), then
// two bars compare the video length with the render time. {step, y, total, renderFrom, renderTo, url,
// bars: [{label, value, frac, at, blue}]}
const mdRender = {
  draw(R, s, t) {
    const { ctx } = R, x = 60, w = 960, y = s.y ?? 600, h = 520, tot = s.total || 2760;
    const q = E.io(seg(t, s.renderFrom, s.renderTo)), n = Math.round(tot * q), done = q >= .999;
    slide(ctx, s, t, () => {
      stepHead(ctx, s, t, R);
      rise(ctx, S(t - s.from - .1, 11), 60, () => {
        sheet(ctx, x, y, w, h, 30, { elev: 1.3 });
        [0, 1, 2].forEach(i => { ctx.beginPath(); ctx.arc(x + 46 + i * 34, y + 44, 10, 0, TAU); ctx.fillStyle = C.dim; ctx.fill(); });
        ctx.beginPath(); ctx.roundRect(x + 170, y + 20, w - 210, 48, 24); ctx.fillStyle = 'rgba(40,30,10,.06)'; ctx.fill();
        text(ctx, s.url || 'localhost:3000/render', x + 200, midBase(y + 44, 28), { size: 28, weight: 500, color: C.ink2, fam: 'JetBrains Mono' });
        ctx.fillStyle = C.line; ctx.fillRect(x, y + 88, w, 2);
        const pw = 232, ph = pw * 16 / 9, px = x + 46, py = y + 88 + (h - 88 - ph) / 2;
        miniShort(R, ctx, px, py, pw, ph, Math.floor(n / 45), { r: 12 });
        const rx = px + pw + 60, bwid = x + w - 50 - rx;
        text(ctx, 'Image', rx, midBase(y + 170, 42), { size: 42, weight: 600, color: C.ink2 });
        text(ctx, String(n).padStart(4, '0'), rx, midBase(y + 275, 124), { size: 124, weight: 800, ls: -4, fam: 'JetBrains Mono', color: done ? C.blue : C.ink });
        text(ctx, '/ ' + tot, rx + 6, midBase(y + 368, 44), { size: 44, weight: 600, color: C.ink3, fam: 'JetBrains Mono' });
        ctx.beginPath(); ctx.roundRect(rx, y + 432, bwid, 18, 9); ctx.fillStyle = 'rgba(40,30,10,.08)'; ctx.fill();
        if (q > .001) { ctx.beginPath(); ctx.roundRect(rx, y + 432, Math.max(18, bwid * q), 18, 9); ctx.fillStyle = C.blue; ctx.fill(); }
      });
      (s.bars || []).forEach((b, i) => {
        const p = S(t - b.at, 11), by = y + h + 105 + i * 118, bx = x + 210, full = w - 210 - 190; if (p <= .002) return;
        rise(ctx, Math.min(1, p * 1.5), 24, () => {
          text(ctx, b.label, x, midBase(by, 50), { size: 50, weight: 800, ls: -1 });
          const bl = Math.max(56, full * b.frac * E.out(p));
          ctx.beginPath(); ctx.roundRect(bx, by - 30, bl, 60, 30); ctx.fillStyle = b.blue ? C.blue : C.ink; ctx.fill();
          text(ctx, b.value, bx + bl + 24, midBase(by, 56), { size: 56, weight: 800, fam: 'JetBrains Mono', color: b.blue ? C.blue : C.ink });
        });
      });
    });
  },
};


// ---- race: two models, same prompt, side by side. Each panel = a paper sheet with a header bar (logo, name, live
// cost counter + elapsed time) over its generation playing. Counters run from 0 to the real cost between countFrom
// and each panel's own finish (scaled to its real duration, so the faster model stops first and gets a check).
// winnerAt: the cheaper panel gets the blue ring, its price turns blue, and `chip` lands centred below.
// {header?: {text, at}, footer?: {text, at, logo}, countFrom, countTo, winnerAt, chip?: {text, at}, stack?: bool,
//  panels: [{name, logo: 'claude'|'codex'|'openai', media, offset, cost, costSuffix, time (s), ar}]}
LOGO.openai = (ctx, cx, cy, r, col) => {   // six interlocking petals, drawn as rotated rounded strokes
  ctx.save(); ctx.strokeStyle = col; ctx.lineWidth = r * .17; ctx.lineJoin = 'round';
  for (let i = 0; i < 6; i++) { ctx.save(); ctx.translate(cx, cy); ctx.rotate(i * TAU / 6); ctx.beginPath(); ctx.roundRect(-r * .2, -r * .92, r * .4, r * .9, r * .2); ctx.stroke(); ctx.restore(); }
  ctx.restore();
};
export const money = (v, suffix = '') => '$' + (v >= 100 ? v.toFixed(0) : v.toFixed(2)) + suffix;
export const clock = sec => { sec = Math.round(sec); const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s_ = sec % 60; return h ? `${h}h ${String(m).padStart(2, '0')}m` : m ? `${m}m ${String(s_).padStart(2, '0')}s` : `${s_}s`; };
export function raceTiming(s) {   // per-panel finish time: the slowest one ends at countTo
  const maxT = Math.max(...s.panels.map(p => p.time || 1));
  return s.panels.map(p => s.countFrom + (s.countTo - s.countFrom) * Math.max(.35, (p.time || maxT) / maxT));
}
export function raceLayout(s, H_) {
  const n = s.panels.length, top = s.header ? 150 : 44, bottom = (s.footer ? 70 : 30) + (s.chip ? 110 : 0), gap = 30, m = 44;
  const stack = s.stack ?? H_ > W * 1.2;
  if (stack) { const ph = (H_ - top - bottom - gap * (n - 1)) / n; return s.panels.map((_, i) => [m, top + i * (ph + gap), W - 2 * m, ph]); }
  const pw = (W - 2 * m - gap * (n - 1)) / n, hb = Math.round(clamp(pw * .1, 72, 104)), ph = Math.min(H_ - top - bottom, hb + pw * (s.panels[0].ar || .625));
  const y0 = s.chip ? top + 6 : top + (H_ - top - bottom - ph) / 2;   // keep room under the panels for the verdict chip
  return s.panels.map((_, i) => [m + i * (pw + gap), y0, pw, ph]);
}
// Grid mode (`cols: n`): n models side by side, one row per reasoning level (3 models x 2 efforts on a square).
// `columns: [{name, logo}]` heads each column once (without it each panel shows its logo + name in its bar, time on the clip); a panel = clip on top, elapsed time + live cost in a bar under it,
// `effort` pinned on the clip, `note` ('3 tries') pinned top right, `failed: {title, sub}` replaces the clip.
// The cheapest working panel wins. {cols, columns, ar, header?, footer?, countFrom, countTo, winnerAt, chip?, panels}
export function raceGridLayout(s, H_) {
  const n = s.panels.length, cols = s.cols, rows = Math.ceil(n / cols), m = 30, gap = 18, bar = 62;
  const top = (s.header ? 132 : 30) + (s.columns ? 66 : 0), bottom = (s.footer ? 66 : 24) + (s.chip ? 104 : 0);
  const pw = (W - 2 * m - gap * (cols - 1)) / cols, ph = 10 + (pw - 20) * (s.ar || .75) + bar;
  const off = Math.max(0, (H_ - top - bottom - rows * ph - (rows - 1) * gap) / 2), y0 = top + off;   // header, heads and grid move as one block
  return { bar, off, boxes: s.panels.map((_, i) => [m + (i % cols) * (pw + gap), y0 + Math.floor(i / cols) * (ph + gap), pw, ph]) };
}
function raceGrid(R, s, t) {
  const { ctx } = R, H_ = H, ends = raceTiming(s), { bar, off, boxes } = raceGridLayout(s, H_);
  const ok = s.panels.map((p, i) => p.failed ? Infinity : p.cost), win = s.winner ?? ok.indexOf(Math.min(...ok));
  env(ctx, s, t, () => {
    if (s.header) { const p = S(t - s.header.at + (s.pre || 0), 13); rise(ctx, p, 24, () => text(ctx, s.header.text, W / 2, 88 + off * .6, { size: 52, weight: 800, ls: -1.3, align: 'center', depth: s.header.depth })); }
    (s.columns || []).forEach((c, j) => {
      const [x, y, w] = boxes[j], p = S(t - s.from + (s.pre || 0) - j * .08, 12), cy = y - 40, ns = 34, lg = 40;
      rise(ctx, p, 30, () => {
        const tw = measure(ctx, c.name, ns, 800, -.8), x0 = x + w / 2 - (tw + lg + 12) / 2;
        if (isImgLogo(c.logo)) logoImg(R, ctx, c.logo, x0, cy - lg / 2, lg, 8); else if (LOGO[c.logo]) LOGO[c.logo](ctx, x0 + lg / 2, cy, lg / 2, C.ink);
        text(ctx, c.name, x0 + lg + 12, midBase(cy, ns), { size: ns, weight: 800, ls: -.8 });
      });
    });
    s.panels.forEach((pn, i) => {
      const [x, y, w, h] = boxes[i], p = S(t - s.from + (s.pre || 0) - .15 - i * .06, 12), mh = h - bar - 10;
      rise(ctx, p, 50, () => {
        const wp = s.winnerAt != null && i === win ? S(t - s.winnerAt, 12) : 0;
        sheet(ctx, x, y, w, h, 22, { elev: 1.1 });
        if (pn.failed) {
          ctx.save(); ctx.beginPath(); ctx.roundRect(x + 10, y + 10, w - 20, mh, 14); ctx.fillStyle = 'rgba(40,30,10,.05)'; ctx.fill(); ctx.clip();
          ctx.strokeStyle = 'rgba(40,30,10,.07)'; ctx.lineWidth = 2;
          for (let k = -mh; k < w; k += 22) { ctx.beginPath(); ctx.moveTo(x + 10 + k, y + 10 + mh); ctx.lineTo(x + 10 + k + mh, y + 10); ctx.stroke(); }
          ctx.restore();
          const cx = x + w / 2, cy = y + 10 + mh / 2;
          text(ctx, pn.failed.title, cx, midBase(cy - (pn.failed.sub ? 18 : 0), 34), { size: 34, weight: 800, ls: -.8, align: 'center', color: C.ink2 });
          if (pn.failed.sub) text(ctx, pn.failed.sub, cx, midBase(cy + 26, 24), { size: 24, weight: 600, align: 'center', color: C.ink3 });
        } else {
          cover(ctx, R.frame(pn.media, clipTime(t, s.from, pn.offset || 0)), x + 10, y + 10, w - 20, mh, 14, pn.focus);
          ctx.save(); ctx.beginPath(); ctx.roundRect(x + 10, y + 10, w - 20, mh, 14); ctx.strokeStyle = 'rgba(20,22,27,.08)'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.restore();
        }
        if (pn.effort) chip(ctx, x + 22, y + 40, pn.effort, { size: 22, h: 40, padX: 14, weight: 800, align: 'left', fill: C.ink, color: C.white, border: false, elev: .6 });
        if (pn.note) chip(ctx, x + w - 22, y + mh - 20, pn.note, { size: 22, h: 40, padX: 14, weight: 800, align: 'right', fill: C.white, color: C.ink, border: false, elev: .6 });
        // bar: elapsed time left (check when done), live cost right. No column heads: logo + name left, time on the clip
        const k = E.cubic(seg(t, s.countFrom, ends[i])), done = t >= ends[i], cy = y + h - bar / 2 - 4, cs = 40, ts = 28;
        text(ctx, money(pn.cost * k, done ? (pn.costSuffix || '') : ''), x + w - 22, midBase(cy, cs), { size: cs, weight: 800, ls: -1, align: 'right', color: mix(C.ink, C.blue, wp) });
        if (!s.columns) {
          const lg = 36;
          if (isImgLogo(pn.logo)) logoImg(R, ctx, pn.logo, x + 22, cy - lg / 2, lg, 8); else if (LOGO[pn.logo]) LOGO[pn.logo](ctx, x + 22 + lg / 2, cy, lg / 2, C.ink);
          text(ctx, pn.name, x + 22 + lg + 12, midBase(cy, 32), { size: 32, weight: 800, ls: -.8 });
          if (pn.time) chip(ctx, x + w - 22, y + 40, clock(pn.time * k), { size: 22, h: 40, padX: 14, weight: 800, align: 'right', fill: C.white, color: C.ink, border: false, elev: .6 });
        } else if (pn.time) {
          const dp = E.out(seg(t, ends[i], ends[i] + .35)), cw = done && !pn.failed ? ts * 1.05 : 0;
          if (cw) checkIcon(ctx, x + 22 + ts * .45, cy, ts * .9, C.ink2, dp);
          text(ctx, clock(pn.time * k), x + 22 + cw, midBase(cy, ts), { size: ts, weight: 600, color: C.ink3 });
        }
        if (wp > .002) alpha(ctx, wp, () => { ctx.beginPath(); ctx.roundRect(x - 7 - 5 * (1 - wp), y - 7 - 5 * (1 - wp), w + 14 + 10 * (1 - wp), h + 14 + 10 * (1 - wp), 28); ctx.strokeStyle = C.blue; ctx.lineWidth = 5; ctx.stroke(); });
      });
    });
    if (s.chip) {
      const p = S(t - s.chip.at, 13), yb = Math.max(...boxes.map(q => q[1] + q[3]));
      if (p > .002) rise(ctx, p, 20, () => chip(ctx, W / 2, s.chip.y ?? Math.min(H_ - 120, yb + 62), s.chip.text, { size: 38, h: 80, fill: C.blue, color: C.white, border: false }));
    }
    if (s.footer) {
      const p = S(t - s.footer.at + (s.pre || 0), 13);
      rise(ctx, p, 16, () => text(ctx, s.footer.text, W / 2, midBase(H_ - 40, 28), { size: 28, weight: 700, ls: -.4, align: 'center', color: C.ink2 }));
    }
  });
}
const race = {
  needs(s, t) { return t >= s.from - .3 && t <= (s.to ?? 1e9) + .7 ? s.panels.filter(p => p.media).map(p => [p.media, clipTime(t, s.from, p.offset || 0)]) : []; },
  draw(R, s, t) {
    if (s.cols) return raceGrid(R, s, t);
    const { ctx } = R, H_ = H, ends = raceTiming(s), boxes = raceLayout(s, H_);
    const costs = s.panels.map(p => p.cost), win = costs.indexOf(Math.min(...costs));
    env(ctx, s, t, pin => {
      if (s.header) { const p = S(t - s.header.at + (s.pre || 0), 13); rise(ctx, p, 24, () => text(ctx, s.header.text, W / 2, 104, { size: 58, weight: 800, ls: -1.4, align: 'center' })); }
      s.panels.forEach((pn, i) => {
        const [x, y, w, h] = boxes[i], hb = Math.round(clamp(w * .1, 72, 104)), p = S(t - s.from + (s.pre || 0) - i * .08, 12);
        rise(ctx, p, 60, () => {
          const wp = s.winnerAt != null && i === win ? S(t - s.winnerAt, 12) : 0;
          sheet(ctx, x, y, w, h, 26, { elev: 1.1 });
          cover(ctx, R.frame(pn.media, clipTime(t, s.from, pn.offset || 0)), x + 10, y + hb, w - 20, h - hb - 10, 18);
          ctx.save(); ctx.beginPath(); ctx.roundRect(x + 10, y + hb, w - 20, h - hb - 10, 18); ctx.strokeStyle = 'rgba(20,22,27,.08)'; ctx.lineWidth = 1.5; ctx.stroke(); ctx.restore();
          // header bar: logo + name left, elapsed time + live cost right
          const cy = y + hb / 2 + 2, ns = Math.round(clamp(w * .05, 34, 50)), cs = Math.round(ns * 1.22), lr = ns * .52;
          if (LOGO[pn.logo]) LOGO[pn.logo](ctx, x + 26 + lr, cy, lr, C.ink);
          text(ctx, pn.name, x + 26 + lr * 2 + 16, midBase(cy, ns), { size: ns, weight: 800, ls: -1 });
          const k = E.cubic(seg(t, s.countFrom, ends[i])), done = t >= ends[i], dp = S(t - ends[i], 14);
          const cost = money(pn.cost * k, done ? (pn.costSuffix || '') : ''), cw = measure(ctx, money(pn.cost, pn.costSuffix || ''), cs, 800, -1);
          text(ctx, cost, x + w - 26, midBase(cy, cs), { size: cs, weight: 800, ls: -1, align: 'right', color: mix(C.ink, C.blue, wp) });
          if (pn.time) {
            const ts = Math.round(ns * .76), tx = x + w - 26 - cw - 22;
            text(ctx, clock(pn.time * k), tx, midBase(cy, ts), { size: ts, weight: 600, align: 'right', color: C.ink3 });
            if (dp > .002) checkIcon(ctx, tx - measure(ctx, clock(pn.time), ts, 600) - ts * .7, cy, ts * .9, C.ink2, E.out(seg(t, ends[i], ends[i] + .35)));
          }
          // reasoning effort, pinned on the media so it is never missed
          if (pn.effort) { const es = Math.round(clamp(w * .036, 26, 34)); chip(ctx, x + 26, y + hb + 18 + es, pn.effort, { size: es, weight: 800, align: 'left', fill: C.ink, color: C.white, border: false, elev: .6 }); }
          if (wp > .002) alpha(ctx, wp, () => { ctx.beginPath(); ctx.roundRect(x - 8 - 6 * (1 - wp), y - 8 - 6 * (1 - wp), w + 16 + 12 * (1 - wp), h + 16 + 12 * (1 - wp), 32); ctx.strokeStyle = C.blue; ctx.lineWidth = 5; ctx.stroke(); });
        });
      });
      if (s.chip) {
        const p = S(t - s.chip.at, 13), b = boxes.at(-1), yb = Math.max(...boxes.map(q => q[1] + q[3]));
        const cy = s.chip.y ?? (s.stack ?? H_ > W * 1.2 ? b[1] + b[3] / 2 : Math.min(H_ - 70, yb + 66));
        if (p > .002) rise(ctx, p, 20, () => chip(ctx, W / 2, cy, s.chip.text, { size: 44, h: 88, fill: C.blue, color: C.white, border: false }));
      }
      if (s.footer) {
        const p = S(t - s.footer.at + (s.pre || 0), 13);
        rise(ctx, p, 16, () => {
          const fs_ = 34, tw = measure(ctx, s.footer.text, fs_, 700, -.5), lg = s.footer.logo && LOGO[s.footer.logo] ? 58 : 0, x0 = W / 2 - (tw + lg) / 2;
          if (lg) LOGO[s.footer.logo](ctx, x0 + 22, H_ - 46, 20, C.ink2);
          text(ctx, s.footer.text, x0 + lg, midBase(H_ - 46, fs_), { size: fs_, weight: 700, ls: -.5, color: C.ink2 });
        });
      }
    });
  },
};

// ---- bill: a compact ranked bill for up to ~7 runs (logo, model, effort + time, cost bar). The `blue` row is the pick,
// a `failed` row shows a dashed empty bar and its `note`. {title?: {text, at}, y?, rowH?, footer?: {text, at}, chip?: {text, at, y},
//  rows: [{logo, name, sub, value (0..1), label, at, blue?, failed?, note?}]}
// lift: each row on a lifted paper card, embossed title, bars with a soft shadow (the default paper style: never flat).
const bill = {
  draw(R, s, t) {
    const { ctx } = R, rh = s.rowH || 112, y0 = s.y ?? 210, lx = 44, bx = 506, bw = W - bx - (s.lift ? 210 : 170), bh = 44;
    env(ctx, s, t, () => {
      if (s.title) rise(ctx, S(t - s.title.at, 13), 24, () => text(ctx, s.title.text, W / 2, 112, { size: 54, weight: 800, ls: -1.4, align: 'center', depth: s.lift ? 1 : undefined }));
      s.rows.forEach((r, i) => {
        const p = S(t - r.at, 12), cy = y0 + i * rh + rh / 2;
        rise(ctx, p, 30, () => {
          if (s.lift) sheet(ctx, lx - 20, cy - rh / 2 + 10, W - 2 * lx + 40, rh - 20, 26, { elev: .8 });
          if (r.blue) { ctx.beginPath(); ctx.roundRect(lx - 16, cy - rh / 2 + 8, W - 2 * lx + 32, rh - 16, 24); ctx.fillStyle = 'rgba(37,142,255,.08)'; ctx.fill(); }
          if (isImgLogo(r.logo)) logoImg(R, ctx, r.logo, lx, cy - 24, 48, 10); else if (LOGO[r.logo]) LOGO[r.logo](ctx, lx + 24, cy, 24, C.ink);
          text(ctx, r.name, lx + 66, midBase(cy - 16, 32), { size: 32, weight: 800, ls: -.8, color: r.failed ? C.ink3 : C.ink });
          text(ctx, r.sub, lx + 66, midBase(cy + 22, 24), { size: 24, weight: 600, color: C.ink3 });
          ctx.beginPath(); ctx.roundRect(bx, cy - bh / 2, bw, bh, bh / 2); ctx.fillStyle = 'rgba(40,30,10,.05)'; ctx.fill();
          const g = S(t - r.at - .08, 6.5), L = Math.max(bh, bw * r.value * g);
          if (r.failed) { ctx.save(); ctx.setLineDash([8, 8]); ctx.strokeStyle = C.ink3; ctx.lineWidth = 2.5; ctx.beginPath(); ctx.roundRect(bx, cy - bh / 2, L, bh, bh / 2); ctx.stroke(); ctx.restore(); }
          else if (g > .002) {
            if (s.lift) shadow(ctx, bx, cy - bh / 2, L, bh, bh / 2, 12, .22, 5);
            ctx.beginPath(); ctx.roundRect(bx, cy - bh / 2, L, bh, bh / 2); ctx.fillStyle = r.blue ? C.blue : C.ink; ctx.fill();
          }
          text(ctx, r.label, bx + L + 18, midBase(cy, 34), { size: 34, weight: 800, fam: 'JetBrains Mono', color: r.blue ? C.blue : r.failed ? C.ink3 : C.ink });
          if (r.note) chip(ctx, bx + 14, cy, r.note, { size: 20, h: 34, padX: 12, weight: 800, align: 'left', fill: C.white, color: C.ink2, border: false, elev: .4 });
        });
      });
      if (s.chip) { const p = S(t - s.chip.at, 13); if (p > .002) rise(ctx, p, 20, () => chip(ctx, W / 2, s.chip.y ?? H - 120, s.chip.text, { size: 38, h: 80, fill: C.blue, color: C.white, border: false })); }
      if (s.footer) rise(ctx, S(t - s.footer.at, 13), 16, () => text(ctx, s.footer.text, W / 2, midBase(H - 40, 28), { size: 28, weight: 700, ls: -.4, align: 'center', color: C.ink2 }));
    });
  },
};

export const SCENES = { race, bill, stat, bars, columns, recap, tiles, title, chat, convo, scatter, chip: chipScene, cta, switch: switchScene, tree, snap, xylo, sfxtrack, popover, pause: pauseScene, pipeline, comment, tweet, article, usage, mdGrid, mdIntro, mdRec, mdWave, mdVision, overlay, mdDiffuse, mdCode, mdAssemble, mdCut, mdStills, mdRender, ...STORY, ...LIFE, ...META, ...FACE, ...MASTER, ...CRASH, ...CLEAN };
// A scene with a push (or a board's own `zooms`) draws into a zoom layer, so its slow push-in moves as one image (kit zoomLayer)
const zoomWrapped = new WeakSet();
for (const sc of Object.values(SCENES)) if (sc?.draw && !zoomWrapped.has(sc)) {
  const draw = sc.draw; zoomWrapped.add(sc);
  sc.draw = (R, s, t) => (sc.zooms ? sc.zooms(R, s) : s.push) ? zoomLayer(R, R2 => draw(R2, s, t)) : draw(R, s, t);
}

// Choreography between back-to-back scenes of one layer, resolved once at load (times are short seconds):
//   gate: a scene starting within .35 s of the previous scene's exit enters .16 s after that exit (the old beat is ~60%
//   gone), so two beats never crossfade in place. A board item with morph: true (a screen) instead grows out of the
//   previous scene's media rect (its `hand`, e.g. a tweet's image) from that exit on: a shared-element move.
export function linkScenes(list) {
  for (const s of list) {
    const start = s.from - (s.pre || 0);
    const prev = list.filter(o => o !== s && o.layer === s.layer && o.to != null && o.to <= start + .05 && o.to >= start - .35).sort((a, b) => b.to - a.to)[0];
    if (!prev) continue;
    if (s.gate !== false) s._gate = prev.to + (prev.hard ? 0 : .16);   // a hard cut leaves in one frame: nothing to wait for
    for (const it of s.items || []) if (it.morph && SCENES[prev.type]?.hand) {
      it._morph = { at: prev.to, rect: R => SCENES[prev.type].hand(prev, R) || [it.x - (it.w || 900) / 2, it.y - (it.h || 620) / 2, it.w || 900, it.h || 620] };
      prev._handTo = prev.to;
    }
  }
  return list;
}
