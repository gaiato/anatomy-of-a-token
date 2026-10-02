#!/usr/bin/env node
/* Render a shot list to video, frame by frame.
 *
 *   node record/render.mjs record/shots/launch.json --out launch.mp4
 *   node record/render.mjs SHOT --stills 3,12.5,30 --out-dir stills/        (PNG frames at those seconds)
 *   node record/render.mjs SHOT --out preview.mp4 --from 10 --to 20 --scale .5 --fps 30   (quick look)
 *   node record/render.mjs SHOT --out launch.mp4 --chapters-only                           (just launch.chapters.json)
 *
 * Needs Node 22+, Chrome (CHROME=path, default google-chrome) and, for video, ffmpeg (FFMPEG=path).
 * The page runs on virtual time (record/runtime.js), so frames are exact even with software WebGL;
 * --gpu drops the SwiftShader flags when the machine has a real GPU. Prints progress to stderr. */
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { join, extname, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf('--' + k); return i >= 0 ? args[i + 1] : d; };
const flag = k => args.includes('--' + k);
const shotPath = args.find(a => a.endsWith('.json'));
if (!shotPath) { console.error('usage: render.mjs SHOT.json [--out FILE.mp4] [--stills s,s --out-dir DIR] [--from s] [--to s] [--fps n] [--scale k] [--gpu]'); process.exit(2); }
const shot = JSON.parse(readFileSync(shotPath, 'utf8'));
const [vw, vh] = (shot.viewport || '1280x720').split('x').map(Number);   // CSS pixels the page lays out in
const scale = +(opt('scale', shot.scale ?? 1.5));                        // device pixels per CSS pixel: 1.5 → 1920×1080
const fps = +(opt('fps', shot.fps ?? 60)); shot.fps = fps;
const from = +opt('from', 0), to = Math.min(+opt('to', shot.duration), shot.duration);
const stills = opt('stills') ? opt('stills').split(',').map(Number).sort((a, b) => a - b) : null;
const out = opt('out', stills ? null : 'out.mp4'), outDir = opt('out-dir', 'stills');
const webDir = resolve(here, '..', 'web');
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ── Static server for web/ ── */
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
const server = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname); if (p.endsWith('/')) p += 'index.html';
  const f = join(webDir, p);
  if (!f.startsWith(webDir) || !existsSync(f) || !statSync(f).isFile()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'content-type': MIME[extname(f)] || 'application/octet-stream', 'cache-control': 'no-store' }); res.end(readFileSync(f));
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/?demo&record${shot.query ? '&' + shot.query : ''}`;

/* ── Chrome over the DevTools protocol ── */
const port = 9300 + Math.floor(Math.random() * 600);
const prof = mkdtempSync(join(homedir(), '.cdp-rec-'));   // not /tmp: some hosts give Chrome a private /tmp
const gl = flag('gpu') ? ['--enable-gpu', '--ignore-gpu-blocklist', '--force_high_performance_gpu'] : ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'];
const chrome = spawn(process.env.CHROME || 'google-chrome', ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, ...gl,
  `--window-size=${vw},${vh}`, '--no-first-run', '--hide-scrollbars', '--mute-audio', '--force-color-profile=srgb', 'about:blank'], { stdio: 'ignore' });
let ws; const pend = new Map(); let id = 0;
for (let i = 0; i < 80 && !ws; i++) { try { const l = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json(); const p = l.find(x => x.type === 'page'); if (p) ws = new WebSocket(p.webSocketDebuggerUrl); } catch { } if (!ws) await sleep(250); }
if (!ws) { console.error('chrome did not start'); process.exit(1); }
await new Promise(r => ws.onopen = r);
ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); }
  if (d.method === 'Runtime.exceptionThrown') console.error('page exception:', d.params.exceptionDetails.exception?.description || d.params.exceptionDetails.text);
  if (d.method === 'Runtime.consoleAPICalled' && d.params.type === 'error') console.error('page error:', d.params.args.map(a => a.value ?? a.description).join(' ')); };
const send = (method, params = {}) => new Promise(r => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
const ev = async expr => { const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description || 'evaluate failed'); return r.result?.result?.value; };
function cleanup() { try { ws.close(); } catch { } chrome.kill(); server.close(); try { rmSync(prof, { recursive: true, force: true }); } catch { } }

await send('Runtime.enable'); await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: vw, height: vh, deviceScaleFactor: scale, mobile: false });
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'no-preference' }, { name: 'prefers-color-scheme', value: 'dark' }] });
await send('Page.addScriptToEvaluateOnNewDocument', { source: readFileSync(join(here, 'runtime.js'), 'utf8') });
await send('Page.navigate', { url });

/* Load: network and module loading run on real time; page timers and frames advance only as we tick. */
let ok = false;
for (let i = 0; i < 600 && !ok; i++) { await sleep(100); try { ok = await ev('window.__rec && (__rec.tick(50), __rec.ready())'); } catch { } }
if (!ok) { console.error('page never became ready'); cleanup(); process.exit(1); }
console.error('webgl: ' + await ev(`(() => { const g = document.createElement('canvas').getContext('webgl2'); const x = g && g.getExtension('WEBGL_debug_renderer_info'); return x ? g.getParameter(x.UNMASKED_RENDERER_WEBGL) : 'unknown'; })()`));   // says whether a GPU or SwiftShader draws the frames
await ev('for (let i = 0; i < 90; i++) __rec.tick(1000 / 60)');   // 1.5 s of real frames: the loading veil and the sky's fade-in finish
const { frames } = await ev(`__rec.start(${JSON.stringify(shot)})`);
const chapters = await ev('__rec.chapters()');
if (out || flag('chapters-only')) {   // FILE.chapters.json beside the video: what a viewer lists as chapters
  const cf = (out || shotPath).replace(/\.(mp4|json)$/, '') + '.chapters.json';
  writeFileSync(cf, JSON.stringify({ shot: shot.name, duration: shot.duration, fps, size: [Math.round(vw * scale), Math.round(vh * scale)], chapters }, null, 1));
  console.log(`wrote ${cf}`);
}
if (flag('chapters-only')) { cleanup(); process.exit(0); }
const shotOpts = { format: 'jpeg', quality: +(opt('quality', 94)), optimizeForSpeed: false };

if (from > 0) { process.stderr.write(`seeking to ${from}s… `); await ev(`__rec.seek(${from})`); process.stderr.write('done\n'); }
const first = Math.round(from * fps), last = Math.round(to * fps);

let ff = null;
if (out) {
  const ffArgs = ['-hide_banner', '-loglevel', 'error', '-y', '-f', 'image2pipe', '-framerate', String(fps), '-c:v', 'mjpeg', '-i', '-'];
  if (shot.music && !flag('silent')) ffArgs.push('-i', resolve(dirname(shotPath), shot.music), '-filter_complex', `[1:a]afade=t=in:d=1,afade=t=out:st=${Math.max(0, to - from - 2.5)}:d=2.5,volume=${shot.musicVolume ?? .8}[a]`, '-map', '0:v', '-map', '[a]', '-c:a', 'aac', '-b:a', '192k', '-shortest');
  ffArgs.push('-c:v', 'libx264', '-preset', opt('preset', 'slow'), '-crf', opt('crf', '16'), '-pix_fmt', 'yuv420p', '-profile:v', 'high', '-movflags', '+faststart', out);
  ff = spawn(process.env.FFMPEG || 'ffmpeg', ffArgs, { stdio: ['pipe', 'inherit', 'inherit'] });
}
if (stills) mkdirSync(outDir, { recursive: true });

const tStart = Date.now(); let si = 0;
for (let f = first; f < last; f++) {
  const local = await ev('__rec.frame()');
  const want = ff || (stills && si < stills.length && local + 1 / fps > stills[si]);
  if (!want) continue;
  const r = await send('Page.captureScreenshot', ff ? shotOpts : { format: 'png' });
  const buf = Buffer.from(r.result.data, 'base64');
  if (ff) { if (!ff.stdin.write(buf)) await new Promise(r => ff.stdin.once('drain', r)); }
  while (stills && si < stills.length && local + 1 / fps > stills[si]) { writeFileSync(join(outDir, `t${String(stills[si]).replace('.', '_')}.png`), buf); si++; }
  if (stills && si >= stills.length && !ff) break;
  if ((f - first) % fps === 0) { const done = f - first + 1, el = (Date.now() - tStart) / 1000; process.stderr.write(`\r${(f / fps).toFixed(1)}s / ${to}s  ·  ${(done / el).toFixed(2)} frames/s  ·  ~${Math.round((last - f) * el / done)}s left   `); }
}
process.stderr.write('\n');
if (ff) { ff.stdin.end(); await new Promise(r => ff.on('close', r)); console.log(`wrote ${out} (${(statSync(out).size / 1e6).toFixed(1)} MB, ${((last - first) / fps).toFixed(1)} s at ${fps} fps, ${Math.round(vw * scale)}×${Math.round(vh * scale)})`); }
if (stills) console.log(`wrote ${si} still(s) to ${outDir}`);
cleanup();
