/* Where the page gets its facts: the probe beside the model server, or a saved snapshot (demo mode).
 * Configure with window.ANATOMY = { api: 'api/', snapshot: 'data/snapshot/' } before main.js loads. */
const CFG = Object.assign({ api: 'api/', snapshot: 'data/snapshot/', maxTokens: 32, sky: {} }, window.ANATOMY || {});
{ const q = new URLSearchParams(location.search), at = Date.parse(q.get('skyat') || ''), warp = +q.get('skywarp');
  if (/^(0|off|false)$/.test(q.get('sky') || '')) CFG.sky = null;                     // ?sky=0: the plain dark background
  else if (CFG.sky) CFG.sky = { ...CFG.sky, ...(isFinite(at) ? { at } : {}), ...(warp > 0 ? { warp } : {}) }; }   // ?skyat=ISO time, ?skywarp=60: preview another moment, faster
if (CFG.sky && new URLSearchParams(location.search).has('record')) CFG.sky = { ...CFG.sky, orbit: null };   // recordings use the bundled orbit: same sky every render, no network
{ const s = new URLSearchParams(location.search).get('snapshot'); if (s && /^[\w-]+$/.test(s)) CFG.snapshot = `data/${s}/`; }   // ?snapshot=<folder under data/>: another saved model
export const config = CFG;

async function getJSON(url, opts = {}, timeout = 6000) {
  const ac = new AbortController(); const t = setTimeout(() => ac.abort(), timeout);
  try {
    const r = await fetch(url, { ...opts, signal: ac.signal, cache: 'no-store' });
    const body = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(body.error || `HTTP ${r.status}`), { status: r.status });
    return body;
  } finally { clearTimeout(t); }
}

/** {profile, demo, reason}. Demo when the probe is unreachable or cannot find the checkpoint. */
export async function loadProfile() {
  const force = new URLSearchParams(location.search).has('demo');
  if (!force) {
    try {
      const p = await getJSON(CFG.api + 'profile', {}, 15000);   // first call after a model switch scans tensor headers
      if (!p.error && p.model) return { profile: p, demo: false };
      var why = p.error;
    } catch (e) { why = e; }
    if (why) console.info('anatomy: no live profile:', why.message || why);
    var reason = typeof why === 'string' ? 'The probe could not find the model’s files (start it with --search or --model-map)'
      : why?.status === 502 ? 'The probe is running but no model server answered'
      : why?.status && why.status !== 404 ? `The probe answered HTTP ${why.status}` : 'No probe answered';
  }
  const p = await getJSON(CFG.snapshot + 'profile.json');
  return { profile: p, demo: true, reason: force ? 'Demo mode was asked for' : reason };
}

export async function loadSnapshotTraces() {
  try { return await getJSON(CFG.snapshot + 'traces.json'); } catch { return []; }
}

export async function runTrace(prompt) {
  return getJSON(CFG.api + 'trace', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, max_tokens: CFG.maxTokens, temperature: 0 }) }, 120000);
}

export async function status() { return getJSON(CFG.api + 'status', {}, 4000); }
