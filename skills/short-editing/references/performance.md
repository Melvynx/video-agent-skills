# Engine performance

Benchmarked 2026-10-02 on an M4 Max (10 P + 4 E cores, 36 GB) with a 91.9 s 1080x1920 short (2757 frames), matted on every frame (the old popout; prepare now mattes only the cutout spans, so the matte rows are worst cases). Every step is niced to 15 by `short.mjs`, so it yields to anything the creator is doing.

| Step | Before | Now | What changed |
|---|---|---|---|
| prepare: cam frames | 8.2 s | 6 s | software HEVC decode on all cores (`-threads 0`); VideoToolbox copy-back is slower here |
| prepare: matte, cold | 743 s | 66 to 86 s | mask-only output, CPU resize, 3 parallel workers |
| prepare: matte after a `cut` change | 743 s | 27 to 37 s | raw Vision masks cached by cam JPG content: only about 15% of frames are new |
| render | 324 s with `--eco` (37 fps without) | 18 s (150+ fps) | WebCodecs H.264 inside Chrome, 2 parallel workers |
| audio | 3 s | 3 s | |
| final | 12 s | 5 s | one QC pass (video decode + loudness on audio only) |
| **whole pipeline, cold** | **about 18 min** | **92 s** | |
| typical iteration (spec change, no new matte) | about 6 min | about 30 s | |

### 2026-10-21: render, audio and final, encoder-bound

Same M4 Max, 5 real shorts of 30 to 37 s (1080x1920, 30 fps), A/B runs interleaved, medians, `--fresh`. The machine sat at a load of 13 to 40 (photoanalysisd), so absolute times are pessimistic and only the A/B differences count.

| Measure | Engine of 2026-10-20 | Now | What changed |
|---|---|---|---|
| render, encode wall summed over the 5 shorts | 24.5 s | 16.0 s | 2 s work units with steals, cropped overlays and repeated-frame aliases, CDP Chrome, hidden canvas |
| Chrome boot per worker | 0.9 s | 0.6 s | `chrome.mjs`: Chrome on its DevTools pipe, no Playwright |
| audio | 0.6 to 0.7 s | 0.5 to 0.6 s | the bed decodes only the stretch it uses, no reverb pass when nothing is sent to it |
| final | 1.6 s | 1.3 s | no decode (done per unit in render), decode, poster and mux in parallel otherwise |
| **`all` (render + audio + final), 36 s short** | **6.4 s** | **4.5 s** | audio mixed beside the render in its own process |

On one 36 s short (1081 frames) the render alone takes 4.2 s, 255 fps (8.5x realtime). Each frame costs 2.9 ms of images, 0.6 ms of drawing and 2.1 ms of encode, and the two hardware encode engines are the limit. Quality against the previous engine on the same spec: 53.3 dB PSNR on average, 44.6 dB at the worst frame (encoder noise, invisible). Hiding the canvas changes no pixel (180/180 identical frame hashes). The overlay crop changes at most 1 level out of 255, on less than 0.82 % of the pixels.

## Render: WebCodecs in the page

- **Chunks and units.** The video is cut into 10 s cache chunks (300 frames, on absolute frame numbers). The chunks to encode are split into 2 s work units, and each unit opens on an IDR, so the keyframes are the same as with one encoder per chunk.
- **Workers.** Each worker is its own headless Chrome (`chrome.mjs`; Playwright is only the fallback). It takes a contiguous run of units, and a worker that runs out steals half of the longest run left. With whole 10 s chunks, one worker used to wait on the other's last chunk.
- **Page side.** `lib/encode.js` `installEncoder` gives `encodeStart(fps, rate)`, `encodeUnit(a, b, sink)` and `encodeEnd()`. They draw each frame on the hidden canvas (not composited, since nobody looks at it), wrap it in a `VideoFrame` and encode it with the hardware `VideoEncoder` (H.264 High, Annex B, `latencyMode: 'quality'`, at most 3 frames in the encode queue).
- **Sink and decode check.** Bytes are POSTed in 2 MB batches to the local server (`/sink/<unit>`). Each unit is decoded on the CPU as soon as it is in, while the hardware encoder works on the next ones. A chunk is written to `.cache/render/<W>x<H>@<fps>/<hash>.h264` (`.part`, then renamed) once all its units decoded. The render then stamps the output's size and mtime in `.cache/render/qc.json`, and `final` skips its own full decode when the stamp matches (`decode ok (checked in render)`).
- **Chunk cache.** The hash covers:
  - the engine code, the style, `timeline.json`, `frames.json`, the output settings, and every spec field that is not windowed;
  - the scenes, actors and B-roll that can draw in the chunk (from `from - pre - 2` to `to + 2`);
  - the layout and zoom keys from 6 s before the chunk, since the spring has settled by then;
  - the size and mtime of every image or video file those items name.

  A fix to one card re-encodes only its 1 to 3 chunks, and an unchanged render only concatenates (1 s). A `cut` change moves every frame after it, so most chunks re-encode. `--fresh` ignores the cache. A full-length render deletes the chunks it did not use, which keeps the cache about one video in size. Measured on a 65 s youtube test: 9 s cold, 6 s after one title change (3 of 7 chunks), 1 s unchanged. Cached plus re-encoded output against a fresh render: 56.8 dB PSNR. On a 9 min 10 s youtube edit (16,505 frames): 54 s cold at about 300 fps, 5 s unchanged (56/56 chunks cached). The stream there is 2.2 GB, so the join writes chunk by chunk (one Node buffer stops at 2 GB).
- The segments start on IDR frames with in-band SPS/PPS, so they concatenate byte for byte. The ffmpeg mux starts before the encode and gets each chunk on its stdin, in order, as soon as it is there (cached or just encoded), so no joined `.h264` is written and most of the parsing overlaps the encode. It stream-copies into `<out>.part` (renamed when done) with:
  - `setts=ts=N/(fps*TB)`: Chrome's SPS timing breaks the raw timestamps.
  - `h264_metadata` writing bt709 limited range.
  - `-video_track_timescale`.
- **Media frames (prepare).** An alpha media that is only ever an overlay (`overlayOnly`) is cropped at extraction to the box where it is visible (`alphaBox`), so each frame loads and draws far fewer pixels. Identical consecutive frames (a still screen recording) get an alias in `frames.json` (`alias`): the page loads one image instead of every copy.
- This removes the old per-frame cost: about 12.7 ms of JPEG encode, base64 over CDP, and ffmpeg decode plus re-encode.
- Quality is better too. Against lossless `framePNG` references it scores 38 to 40 dB PSNR, against 35 to 36 dB for the old JPEG path.
- Workers, full length:

  | Workers | 1 | 2 | 4 | 6 | 8 |
  |---|---|---|---|---|---|
  | Time | 28 s | 18 s | 17 s | 18 s | 20 s |

  Default is 2: 4 workers only save 1 s for double the load. Rechecked on 2026-10-21 with the current engine (render-only medians on 2 shorts): 3 workers are 10 % slower (3.61 s to 3.98 s, 4.02 s to 4.45 s), and a deeper encode queue (8 instead of 3) is 6 to 8 % slower. `latencyMode: 'realtime'` was slower too. The M4 Max has two hardware encode engines, and two workers keep both busy.
- `--eco` adds background QoS (efficiency cores only). It is about 8x slower (149 s with 2 workers, 188 s with 1). Use it only when the user is doing something heavy at the same time.
- `--jpeg` forces the old path (JPEG over CDP, then `h264_videotoolbox`). It is also the automatic fallback when `VideoEncoder` is missing.
- `VideoEncoder` only exists in a secure context, which is why the page is served from `http://127.0.0.1`. It is undefined on `about:blank`.

## Matte: Apple Vision, cached

- `matte.swift` is compiled once with `swiftc -O` into `~/Library/Caches/short-editing/matte-<source hash>`, and recompiled automatically when the source changes. The interpreted `swift matte.swift` ran at about the same speed per frame, but it paid startup on every call.
- Cost per frame:

  | Step | Cost |
  |---|---|
  | Vision `.accurate` | 34 ms. Its 2016x1512 mask is the floor, about 30 fps per machine. |
  | Old Core Image upscale, blur and RGBA PNG write | 46 ms, more than Vision itself |
  | Now: vImage resize, vDSP EMA, 5x5 convolution, gray+alpha PNG through ImageIO | about 5 to 10 ms |

- Output is a mask only, `frames/matte/%05d.png` (gray+alpha, 15 MB per 200 frames against 133 MB for RGBA cutouts). The runtime builds the cutout bitmap in `load()`: the mask is drawn with `copy`, then the cam JPG with `source-in` on an OffscreenCanvas. `cutURL` stays virtual, so scenes do not change.
- Parallel workers: 1 gives 19 fps, 2 give 25, 3 give 28, and 6 give 28. The Neural Engine saturates, so the default is 3 (`--matte-workers n`). The contiguous slices are balanced by cost: a cached frame costs about 1, a Vision frame about 7. Each slice primes its EMA on the 8 frames before it, so the slices join without a seam.
- The cache is `frames/.matte-cache`: raw Vision masks keyed by the cam JPG's md5.
  - It is keyed on the frame alone. At 1.15x speed, a cut shifts which source frames neighbour each other, so a multi-frame key hit only a third of frames, against 85% now.
  - The EMA and blur pass always reruns over the whole range. It is cheap.
  - The cache is pruned to the current cut.
- `MATTE_QUALITY=balanced` halves Vision time (512x384 mask) with coarser hair edges. Keep `.accurate` for delivery.

## Rules learned

- Measure before optimizing. The hardware decoder, the obvious pick, was the slowest option for both cam extraction and the QC decode. The matte bottleneck was the Core Image write, not Vision.
- Never decode the video twice. A loudness pass uses `-vn` or rides the decode check as a second output.
- Background QoS (`taskpolicy -b`) costs 5x to 9x. Being niced is enough to stay out of the user's way.
