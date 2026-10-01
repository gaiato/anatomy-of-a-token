/* Where the page gets its facts: the probe beside the model server, or a saved snapshot (demo mode).
 * Configure with window.ANATOMY = { api: 'api/', snapshot: 'data/snapshot/' } before main.js loads. */
const CFG = Object.assign({ api: 'api/', snapshot: 'data/snapshot/', maxTokens: 32 }, window.ANATOMY || {});
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
      var reason = p.error;
    } catch (e) { reason = e.message; }
  }
  const p = await getJSON(CFG.snapshot + 'profile.json');
  return { profile: p, demo: true, reason: force ? 'demo requested' : reason };
}

export async function loadSnapshotTraces() {
  try { return await getJSON(CFG.snapshot + 'traces.json'); } catch { return []; }
}

export async function runTrace(prompt) {
  return getJSON(CFG.api + 'trace', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ prompt, max_tokens: CFG.maxTokens, temperature: 0 }) }, 120000);
}

export async function status() { return getJSON(CFG.api + 'status', {}, 4000); }
