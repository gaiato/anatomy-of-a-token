/* Small shared helpers: escaping, number formatting, source tags. */
export const $ = id => document.getElementById(id);
export const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
export const lerp = (a, b, t) => a + (b - a) * t;
export const ease = t => t < .5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
export const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
/** The step panel sits beside the scene (desktop, or a phone held sideways) rather than under it. Matches the landscape rule in anatomy.css. */
export const sidePanel = () => innerWidth > 900 || (innerWidth > innerHeight && innerHeight <= 520);
export const panelWidth = () => innerWidth > 900 ? 456 : sidePanel() ? Math.min(400, innerWidth * .5) + 8 : 1;

export const GiB = 1073741824;
export const int = n => n == null ? '–' : Math.round(n).toLocaleString('en-US');
/** 180.0 B · 6.6 B · 640 M · 12 K */
export function count(n, d = 1) {
  if (n == null || !isFinite(n)) return '–';
  const a = Math.abs(n);
  if (a >= 1e12) return (n / 1e12).toFixed(d) + ' T';
  if (a >= 1e9) return (n / 1e9).toFixed(d) + ' B';
  if (a >= 1e6) return (n / 1e6).toFixed(a >= 1e8 ? 0 : d) + ' M';
  if (a >= 1e3) return (n / 1e3).toFixed(a >= 1e5 ? 0 : d) + ' K';
  return String(Math.round(n));
}
/** 98.5 GiB · 12.0 KiB · 640 MiB */
export function bytes(n, d = 1) {
  if (n == null || !isFinite(n)) return '–';
  const u = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let i = 0, v = n;
  while (Math.abs(v) >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? Math.round(v) : v.toFixed(v >= 100 ? 0 : d)) + ' ' + u[i];
}
export const pct = (p, d = 1) => p == null ? '–' : (p * 100).toFixed(p < .01 && p > 0 ? 2 : d) + '%';
export const ms = v => v == null ? '–' : v >= 1000 ? (v / 1000).toFixed(2) + ' s' : Math.round(v) + ' ms';

/** How a token is shown: spaces as ·, newlines as ⏎, so nothing invisible hides in a chip. */
export const showTok = t => String(t ?? '').replace(/\n/g, '⏎').replace(/\t/g, '⇥').replace(/^ /, '·').replace(/ $/, '·') || '∅';

/* Where a fact came from. The page shows one of these beside every number. */
export const SRC = {
  config: ['config.json', 'The checkpoint’s own configuration file'],
  weights: ['tensor headers', 'Counted from the tensor headers of the files on disk'],
  engine: ['server', 'Reported by the running server: /v1/models, /metrics or its launch flags'],
  trace: ['your request', 'Measured on the request you just ran'],
  hw: ['this machine', 'Read from this machine: nvidia-smi, /proc'],
  calc: ['estimate', 'Derived here from the numbers above: an estimate, not a measurement'],
  spec: ['platform spec', 'Published hardware specification'],
  pack: ['notes', 'Hand-written notes for this model; see the pack for its sources'],
  measured: ['measured here', 'Benchmarked on this machine by its owner'],
  general: ['how LLMs work', 'True of transformer language models in general'],
};
export const tag = s => { const [l, t] = SRC[s] || [s, s]; return `<span class="src ${esc(s)}" title="${esc(t)}">${esc(l)}</span>`; };
