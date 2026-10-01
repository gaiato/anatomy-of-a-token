# Recording videos of the walkthrough

`record/` turns the page into a video, frame by frame. There is no screen capture and no editing
software: a **shot list** (JSON) says what happens when, and `render.mjs` plays it in headless
Chrome on virtual time and pipes every frame into ffmpeg. Each frame is exact, so software WebGL
(SwiftShader) on a server with no GPU gives the same smooth 60 fps as a fast machine, only slower.

```bash
node record/render.mjs record/shots/launch.json --out launch.mp4                       # 1920×1080, 60 fps
node record/render.mjs record/shots/launch.json --stills 7,15,24 --out-dir stills/      # PNG frames to check
node record/render.mjs record/shots/launch.json --out quick.mp4 --scale 1 --fps 30 --preset veryfast --from 10 --to 25
```

Needs Node 22+, Chrome (`CHROME=…`, default `google-chrome`) and ffmpeg with libx264
(`FFMPEG=…`). No root needed for ffmpeg: `pip install imageio-ffmpeg` ships a static build.
The video always shows the **demo snapshot** in `web/data/snapshot/`, never a live server, so
renders repeat exactly.

## Shot lists

```json
{ "viewport": "1280x720", "scale": 1.5, "fps": 60, "duration": 56, "capWidth": 700,
  "timeline": [ { "at": 0, "view": "exterior", "dur": 0 }, { "at": 4.6, "overview": 2.8 }, … ] }
```

`viewport` is the CSS size the page lays out in; `scale` multiplies it into output pixels
(1280×720 × 1.5 = 1920×1080, which keeps the type large on a phone). Events, each with `at` in seconds:

| Event | Does |
|---|---|
| `"question": "…"` | switch to that saved question from the snapshot |
| `"step": "tokenize"` | open a walkthrough step (ids: `__viz.steps()`); also flies the camera there |
| `"tier": 1` | depth of the panel text (1 Overview, 2 Technical, 3 Under the hood) |
| `"overview": 2.5` | close the panel and fly to the overview in 2.5 s |
| `"view": "stack", "dur": 2, "back": 1.6` | fly to a station's view; `back` > 1 pulls the camera out |
| `"cam": {"pos": [x,y,z], "target": [x,y,z]}, "dur": 2` | fly to an exact camera |
| `"orbit": {"deg": 20, "dur": 5}` | turn the camera around its target |
| `"caption": {"text", "sub", "dur", "color"}` | lower-left caption |
| `"card": {"title", "sub", "url", "dur", "scrim"}` | full-screen title card |
| `"hide"` / `"show": [".journey"]` | hide or show page elements |
| `"js": "…"` | anything else, with `window.__viz` (page) and `__viz.S` (scene) |

Caption and card text may hold `{{expr}}`, evaluated over the real data: `M` (the model view, e.g.
`M.L`, `M.moe.experts`, `M.vocab`), `T` (the trace: `T.n`, `T.nOut`, `T.steps.length`, `T.out[0]`),
and helpers `int`, `pct(p, digits)`, `q` (quotes a token). Prefer these to typed numbers: a new
snapshot then keeps every caption true.

## Rules learned the hard way

- **fps ≥ 20.** The scene caps a frame's time step at 50 ms, so below 20 fps it runs slow.
- **Check stills before a full render.** `--stills` at the moments that matter; `--from` seeks
  (it still renders the frames before, without screenshots).
- **Captions carry the story.** X and most feeds autoplay muted, and the panel text is too small on
  a phone; keep captions under about 50 characters and on screen for at least 3 s.
- **Timing:** step changes take about 1.8 s to fly; start the caption 0.4–0.6 s after the step.
- Chrome on Ubuntu 24.04 servers needs an AppArmor userns profile to keep its sandbox
  (`/etc/apparmor.d/chrome-for-testing`); never render with `--no-sandbox`.

## Files

| | |
|---|---|
| `runtime.js` | injected before the page loads: virtual clock (performance.now, Date.now, requestAnimationFrame, timers, CSS animations), the shot-list runner, the caption overlay |
| `render.mjs` | serves `web/`, drives Chrome over the DevTools protocol, writes video or stills |
| `shots/launch.json` | the 56 s launch video |
| `shots/social.json` | the 1280×640 social preview (`docs/social-preview.png`) |
