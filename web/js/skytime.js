/* The corner note that says where the station is, and the time slider it opens: the next 24 hours of orbit, so you can
 * pick the view. The strip under the slider shows whether the ground below is in daylight, and marks the passes
 * over the places in config.sky.places ({ name, points: [[lat, lon], …], km }). */
import { $, esc, clamp } from './util.js';

const SPAN = 24 * 60;                       // minutes on the slider
const R = 6371, hav = (a, b) => {           // great-circle km
  const r = Math.PI / 180, dl = (b[0] - a[0]) * r, dn = (b[1] - a[1]) * r;
  const h = Math.sin(dl / 2) ** 2 + Math.cos(a[0] * r) * Math.cos(b[0] * r) * Math.sin(dn / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
};
const deg = (v, p, n) => `${Math.abs(v).toFixed(1)}°${v >= 0 ? p : n}`;
const hm = m => m < 60 ? `${Math.round(m)} min` : `${Math.floor(m / 60)} h${Math.round(m % 60) ? ' ' + Math.round(m % 60) + ' min' : ''}`;
const clockTime = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const dayTime = t => { const d = new Date(t), same = d.toDateString() === new Date().toDateString(); return (same ? '' : d.toLocaleDateString([], { weekday: 'short' }) + ' ') + clockTime(t); };

export function skyTime(sky, cfg = {}) {
  const info = $('sky-info'), pop = $('sky-time'), range = $('st-range'), strip = $('st-strip');
  const places = (cfg.places || []).filter(p => p?.points?.length);
  let track = [], passes = [], at = 0;

  info.title = 'The background is the view from the International Space Station: its orbit from CelesTrak elements, Earth turning beneath it, the Sun, the Moon and 9,096 stars from the Yale Bright Star Catalogue, precessed to today. Imagery: NASA Blue Marble, Black Marble and Deep Star Maps. Click to choose a time in the next 24 hours.';
  function note() {
    const o = sky.info(); if (o.lat == null) return;
    const stale = !o.live && o.age > 3 ? ` · elements ${Math.round(o.age)} days old` : '';
    const when = at ? ` · in ${hm(at)}` : '';
    info.innerHTML = `<b>ISS</b>${when} · ${deg(o.lat, 'N', 'S')} ${deg(o.lon, 'E', 'W')} · ${Math.round(o.alt)} km · ${o.sunlit ? 'sunlit' : 'in Earth’s shadow'}${stale}`;
    info.hidden = false; info.classList.toggle('ahead', !!at);
    if (!pop.hidden) $('st-when').textContent = at ? `${dayTime(sky.clock() + sky.offset)} · in ${hm(at)}` : 'Now · live';
  }

  /* The strip: daylight below as a band (brighter as the Sun climbs), passes as ticks, hours along the bottom. */
  function build() {
    track = sky.track(SPAN * 6e4, 6e4);
    passes = [];
    for (const pl of places) {
      let run = null;
      track.forEach((s, i) => {
        const near = pl.points.some(p => hav([s.lat, s.lon], p) < (pl.km || 350));
        if (near && !run) run = { name: pl.name, i0: i };
        if (!near && run) { passes.push({ ...run, i1: i - 1 }); run = null; }
      });
      if (run) passes.push({ ...run, i1: track.length - 1 });
    }
    passes.forEach(p => { p.mid = Math.round((p.i0 + p.i1) / 2); p.day = track[p.mid].sunEl > 0; });
    passes.sort((a, b) => a.i0 - b.i0);
    draw(); list();
  }
  function draw() {
    const css = getComputedStyle(document.documentElement), tok = (n, f) => css.getPropertyValue(n).trim() || f;
    const dpr = Math.min(devicePixelRatio || 1, 2), w = strip.clientWidth, h = strip.clientHeight;
    strip.width = w * dpr; strip.height = h * dpr;
    const g = strip.getContext('2d'); g.scale(dpr, dpr); g.clearRect(0, 0, w, h);
    const band = { y: 10, h: h - 26 }, x = i => i / SPAN * w;
    g.fillStyle = tok('--panel-3', '#1d2230'); g.beginPath(); g.roundRect(0, band.y, w, band.h, 5); g.fill();
    g.save(); g.beginPath(); g.roundRect(0, band.y, w, band.h, 5); g.clip();
    track.forEach((s, i) => { if (s.sunEl <= -6) return;
      const k = clamp((s.sunEl + 6) / 50, 0, 1);
      g.fillStyle = s.sunEl < 0 ? `rgba(255,150,80,${.25 + .3 * k})` : `rgba(110,180,255,${.3 + .6 * k})`;
      g.fillRect(x(i), band.y, Math.max(1, w / SPAN) + .5, band.h); });
    g.restore();
    g.fillStyle = tok('--accent-ink', '#7fb1f0');
    for (const p of passes) { const cx = x(p.mid); g.beginPath(); g.moveTo(cx - 4, 1); g.lineTo(cx + 4, 1); g.lineTo(cx, 8); g.fill(); g.fillRect(x(p.i0), band.y + band.h - 3, Math.max(2, x(p.i1) - x(p.i0)), 3); }
    g.fillStyle = tok('--ink-4', '#465a66'); g.font = '10px Inter, system-ui, sans-serif'; g.textBaseline = 'bottom';
    const t1 = track[0]?.t ?? Date.now();
    for (let m = 60 - new Date(t1).getMinutes(); m < SPAN; m += 60) {
      const t = t1 + m * 6e4, hr = new Date(t).getHours(), cx = x(m);
      g.fillRect(cx, band.y + band.h, 1, hr % 6 ? 2 : 4);
      if (hr % 6 === 0 && cx > 14 && cx < w - 14) { g.textAlign = 'center'; g.fillText(clockTime(t), cx, h); }
    }
  }
  function list() {
    const el = $('st-passes');
    if (!places.length) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = passes.length
      ? `<span class="k">${esc(places.map(p => p.name).join(', '))}</span>` + passes.map(p => `<button class="btn sm" data-m="${p.mid}" title="${esc(p.name)}: ${hm(p.i1 - p.i0 + 1)} overhead, ground in ${p.day ? 'daylight' : 'darkness'}">${p.day ? '☀' : '☾'} ${esc(dayTime(track[p.mid].t))}</button>`).join('')
      : `<span class="k">No pass near ${esc(places.map(p => p.name).join(', '))} in the next 24 hours.</span>`;
  }
  function set(m) { at = clamp(Math.round(m), 0, SPAN); range.value = at; sky.offset = at * 6e4; $('st-live').disabled = !at; note(); }

  function open(on = pop.hidden) { pop.hidden = !on; info.setAttribute('aria-expanded', on); if (on) { build(); note(); } }
  info.addEventListener('click', () => open());
  $('st-x').addEventListener('click', () => open(false));
  range.addEventListener('input', () => set(+range.value));
  $('st-live').addEventListener('click', () => set(0));
  $('st-passes').addEventListener('click', e => { const b = e.target.closest('button[data-m]'); if (b) set(+b.dataset.m); });
  addEventListener('keydown', e => { if (e.key === 'Escape' && !pop.hidden) open(false); });
  addEventListener('resize', () => { if (!pop.hidden) draw(); });
  setInterval(() => { note(); if (!pop.hidden && track[0] && sky.clock() - track[0].t > 5 * 6e4) build(); }, 1000);
  sky.whenReady.then(note);
  return { set, open };
}
