/* Record-mode runtime, injected before any page script by record/render.mjs.
 *
 * It replaces the page's clock: performance.now, Date.now, requestAnimationFrame, setTimeout and setInterval
 * all run on virtual time, and CSS animations and transitions are paused and set to that time each frame.
 * Nothing moves until the driver calls __rec.frame(), so every frame is exact however slowly the machine
 * renders it. It also runs the shot list (camera moves, walkthrough steps, captions, title cards) and draws
 * the captions as an overlay in the page's own type. */
(() => {
  const real = { dnow: Date.now };
  const epoch = real.dnow();
  let t = 0;                                   // virtual ms since the page started
  let raf = new Map(), rafId = 0;
  const timers = new Map(); let timerId = 1;

  performance.now = () => t;
  Date.now = () => epoch + t;
  window.requestAnimationFrame = cb => { raf.set(++rafId, cb); return rafId; };
  window.cancelAnimationFrame = id => { raf.delete(id); };
  window.setTimeout = (fn, ms = 0, ...a) => { const id = timerId++; if (typeof fn === 'function') timers.set(id, { at: t + Math.max(0, +ms || 0), fn, a }); return id; };
  window.setInterval = (fn, ms = 0, ...a) => { const id = timerId++; const iv = Math.max(1, +ms || 0); if (typeof fn === 'function') timers.set(id, { at: t + iv, fn, a, iv }); return id; };
  window.clearTimeout = window.clearInterval = id => { timers.delete(id); };

  const started = new WeakMap();
  function syncCSS() {
    for (const a of document.getAnimations()) {
      if (!started.has(a)) { started.set(a, t - (a.currentTime || 0)); a.pause(); }
      const ct = t - started.get(a), end = a.effect?.getComputedTiming().endTime;
      if (Number.isFinite(end) && ct >= end) { try { a.finish(); } catch { a.currentTime = end; } }
      else a.currentTime = ct;
    }
  }
  function run(fn, args) { try { fn(...args); } catch (e) { console.error(e); } }
  function tick(dt) {
    const end = t + dt;
    for (;;) {   // timers in time order, including ones scheduled by timers
      let next = null;
      for (const [id, x] of timers) if (x.at <= end && (!next || x.at < next[1].at)) next = [id, x];
      if (!next) break;
      const [id, x] = next; t = Math.max(t, x.at);
      if (x.iv) x.at += x.iv; else timers.delete(id);
      run(x.fn, x.a);
    }
    t = end;
    syncCSS();
    const q = raf; raf = new Map();
    for (const cb of q.values()) run(cb, [t]);
  }

  /* ── Overlay: captions and title cards (rec-* class names: the page's theme already styles .card) ── */
  let ov = null;
  function overlay() {
    if (ov) return ov;
    const st = document.createElement('style');
    st.textContent = `
      #rec-ov{position:fixed;inset:0;z-index:40;pointer-events:none;font-family:Inter,system-ui,sans-serif;color:#f4f2ff}
      #rec-ov .rec-scrim{position:absolute;inset:0;background:radial-gradient(ellipse at 50% 50%,rgba(6,7,16,.55),rgba(6,7,16,.88));opacity:0}
      #rec-ov .rec-card{position:absolute;inset:0;display:grid;place-content:center;justify-items:center;text-align:center;gap:14px;opacity:0;padding:0 8%}
      #rec-ov .rec-card h1{margin:0;font-size:68px;font-weight:700;letter-spacing:-.025em;line-height:1.02;text-shadow:0 4px 40px rgba(155,124,240,.45)}
      #rec-ov .rec-card p{margin:0;font-size:24px;font-weight:500;color:#c9c3e6;max-width:900px;line-height:1.35}
      #rec-ov .rec-card .url{font-family:'JetBrains Mono',monospace;font-size:21px;color:#b9a6ff;font-weight:500;margin-top:10px;letter-spacing:-.01em}
      #rec-ov .rec-cap{position:absolute;left:44px;bottom:46px;max-width:var(--capw,720px);opacity:0}
      #rec-ov .rec-cap b{display:block;font-size:34px;font-weight:700;letter-spacing:-.018em;line-height:1.12;text-shadow:0 2px 18px rgba(0,0,0,.85),0 0 2px rgba(0,0,0,.9)}
      #rec-ov .rec-cap span{display:block;margin-top:10px;font-size:18px;font-weight:500;color:#cfc9ea;line-height:1.35;text-shadow:0 1px 12px rgba(0,0,0,.9)}
      #rec-ov .rec-cap span:empty{display:none}
      #rec-ov .rec-cap::before{content:"";position:absolute;left:-18px;top:6px;bottom:6px;width:4px;border-radius:4px;background:var(--capc,#9b7cf0)}`;
    document.head.appendChild(st);
    ov = document.createElement('div'); ov.id = 'rec-ov';
    ov.innerHTML = '<div class="rec-scrim"></div><div class="rec-card"><h1></h1><p></p><div class="url"></div></div><div class="rec-cap"><b></b><span></span></div>';
    document.body.appendChild(ov);
    return ov;
  }
  const fadeIn = .45, fadeOut = .45;
  function env(local, at, dur) {   // 0..1 opacity for something shown from `at` for `dur` seconds
    const k = local - at; if (k < 0 || k > dur) return 0;
    return Math.min(1, k / fadeIn, (dur - k) / fadeOut);
  }

  /* ── Shot list ── */
  const v3 = a => { const THREE = window.__viz.S.camera.position.constructor; return new THREE(...a); };
  let shot = null, t0 = 0, fired = new Set(), orbits = [];
  function fill(s) {   // "{{expr}}" → the value of expr over the page's real data: M (model), T (trace), int, pct
    if (!s) return '';
    const V = window.__viz, M = V.M, T = V.T;
    const int = n => Math.round(n).toLocaleString('en-US'), pct = (p, d = 0) => (p * 100).toFixed(d) + '%';
    const q = x => '“' + String(x).replace(/\n/g, '⏎').trim() + '”';
    return s.replace(/\{\{(.+?)\}\}/g, (_, e) => { try { return String(Function('M', 'T', 'int', 'pct', 'q', `return (${e});`)(M, T, int, pct, q)); } catch (err) { console.error('template', e, err); return '?'; } });
  }
  function fire(ev) {
    const V = window.__viz, S = V.S;
    if (ev.question) V.useSnapshot(ev.question);
    if (ev.tier) V.setTier(ev.tier);
    if (ev.step) V.step(ev.step);
    if (ev.overview != null) V.overview({ dur: ev.overview });
    if (ev.view) { const v = S.viewFor(ev.view), k = ev.back ?? 1;   // back > 1 pulls the camera out along its line of sight
      S.flyTo(k === 1 ? v : { target: v.target, pos: v.target.clone().add(v.pos.clone().sub(v.target).multiplyScalar(k)) }, ev.dur ?? 1.8); }
    if (ev.cam) S.flyTo({ pos: v3(ev.cam.pos), target: v3(ev.cam.target) }, ev.dur ?? 1.8);
    if (ev.orbit) orbits.push({ at: ev.at, deg: ev.orbit.deg, dur: ev.orbit.dur, done: 0 });
    if (ev.answer != null) S.setAnswer(ev.answer);
    if (ev.hide) for (const sel of [].concat(ev.hide)) document.querySelectorAll(sel).forEach(el => { el.style.visibility = 'hidden'; });
    if (ev.show) for (const sel of [].concat(ev.show)) document.querySelectorAll(sel).forEach(el => { el.style.visibility = ''; });
    if (ev.js) Function(ev.js)();
  }
  function applyOverlay(local) {
    const o = overlay();
    let cap = null, card = null;
    for (const ev of shot.timeline) {
      if (ev.caption && local >= ev.at && local <= ev.at + ev.caption.dur) cap = ev;
      if (ev.card && local >= ev.at && local <= ev.at + ev.card.dur) card = ev;
    }
    const capEl = o.querySelector('.rec-cap'), cardEl = o.querySelector('.rec-card'), scrim = o.querySelector('.rec-scrim');
    if (cap) {
      if (capEl.dataset.at !== String(cap.at)) { capEl.dataset.at = cap.at; capEl.querySelector('b').textContent = fill(cap.caption.text); capEl.querySelector('span').textContent = fill(cap.caption.sub); capEl.style.setProperty('--capc', cap.caption.color || '#9b7cf0'); }
      const a = env(local, cap.at, cap.caption.dur); capEl.style.opacity = a; capEl.style.transform = `translateY(${(1 - a) * 10}px)`;
    } else capEl.style.opacity = 0;
    if (card) {
      if (cardEl.dataset.at !== String(card.at)) { cardEl.dataset.at = card.at; cardEl.querySelector('h1').textContent = fill(card.card.title); cardEl.querySelector('p').textContent = fill(card.card.sub); cardEl.querySelector('.url').textContent = fill(card.card.url); }
      const a = env(local, card.at, card.card.dur); cardEl.style.opacity = a; cardEl.style.transform = `scale(${.985 + .015 * a})`; scrim.style.opacity = a * (card.card.scrim ?? 1);
    } else { cardEl.style.opacity = 0; scrim.style.opacity = 0; }
  }
  function applyOrbits(local, dt) {
    const S = window.__viz.S, cam = S.camera, tg = S.controls.target;
    for (const o of orbits) {
      if (local < o.at || o.done >= 1) continue;
      const k = Math.min(1, (local - o.at) / o.dur), d = (k - o.done) * o.deg * Math.PI / 180; o.done = k;
      const x = cam.position.x - tg.x, z = cam.position.z - tg.z, c = Math.cos(d), s = Math.sin(d);
      cam.position.x = tg.x + x * c - z * s; cam.position.z = tg.z + x * s + z * c;
    }
  }

  window.__rec = {
    get t() { return t; },
    tick,
    ready: () => !!(window.__viz && document.getElementById('loading')?.classList.contains('gone') && document.fonts.status === 'loaded' && (!window.__viz.S.sky || window.__viz.S.sky.ready)),
    start(s) {
      shot = s; t0 = t; fired = new Set(); orbits = [];
      if (s.capWidth) overlay().style.setProperty('--capw', s.capWidth + 'px');
      shot.timeline.sort((a, b) => a.at - b.at);
      return { duration: s.duration, frames: Math.ceil(s.duration * s.fps) };
    },
    frame() {   // fire due events, advance one frame, draw overlay; the driver screenshots afterwards
      const dt = 1000 / shot.fps, local = (t - t0) / 1000;
      shot.timeline.forEach((ev, i) => { if (!fired.has(i) && ev.at <= local) { fired.add(i); fire(ev); } });
      applyOrbits(local, dt / 1000);
      applyOverlay(local);
      tick(dt);
      return local;
    },
    chapters() {   // the captions and cards with their text filled in, for a viewer's chapter list
      return shot.timeline.filter(ev => ev.caption || ev.card).map(ev => { const c = ev.caption || ev.card;
        return { at: ev.at, kind: ev.caption ? 'caption' : 'card', text: fill(c.text || c.title), sub: fill(c.sub), url: fill(c.url) || undefined }; });
    },
    seek(sec) { while ((t - t0) / 1000 < sec - 1e-6) this.frame(); },
  };
})();
