// live.js — vLLM Prometheus metrics + lab status JSON -> live rates for the 3D viz page.
// First version built by a local agent with 8 unit tests; HTTP-status check and variable draft depth added on review.
// Browser ES module, no dependencies. Metric names contain digits (e2e_...); label values
// may contain dots, commas and brackets inside quotes; lines starting with '#' are comments.
const r3 = v => (Number.isFinite(v) ? Number(v.toFixed(3)) : null);

// Index of the '}' that closes the label block opened at `from`, honouring quotes.
function closeBrace(line, from) {
  let q = false;
  for (let i = from; i < line.length; i++) {
    const c = line[i];
    if (c === '"') q = !q;
    else if (c === '}' && !q) return i;
  }
  return -1;
}

function parseLabels(s) {
  const out = {};
  let i = 0;
  while (i < s.length) {
    while (i < s.length && (s[i] === ',' || s[i] === ' ' || s[i] === '\t')) i++;
    if (i >= s.length) break;
    const eq = s.indexOf('=', i);
    if (eq === -1) break;
    const key = s.slice(i, eq).trim();
    i = eq + 1;
    if (s[i] === '"') {
      i++;
      let v = '';
      while (i < s.length && s[i] !== '"') {
        if (s[i] === '\\' && i + 1 < s.length) { v += s[i + 1]; i += 2; } else { v += s[i]; i++; }
      }
      i++;
      out[key] = v;
    } else {
      let j = i;
      while (j < s.length && s[j] !== ',') j++;
      out[key] = s.slice(i, j).trim();
      i = j;
    }
  }
  return out;
}

// Parse an exposition text into Map<metricName, Array<{labels, value}>>.
export function parsePrometheus(text) {
  const map = new Map();
  if (typeof text !== 'string') return map;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (!line || line[0] === '#') continue;
    let name, labelStr, valStr;
    const o = line.indexOf('{');
    if (o === -1) {
      const sp = line.search(/\s/);
      if (sp === -1) continue;
      name = line.slice(0, sp);
      valStr = line.slice(sp + 1);
    } else {
      const c = closeBrace(line, o + 1);
      if (c === -1) continue;
      name = line.slice(0, o);
      labelStr = line.slice(o + 1, c);
      valStr = line.slice(c + 1);
    }
    const value = Number(valStr.trim().split(/\s+/)[0]);
    if (!Number.isFinite(value)) continue;
    const sample = { labels: labelStr ? parseLabels(labelStr) : {}, value };
    const arr = map.get(name);
    if (arr) arr.push(sample); else map.set(name, [sample]);
  }
  return map;
}

// Sum every series of `name` whose labels match all of labelFilter. 0 when nothing matches.
export function sumMetric(map, name, labelFilter = {}) {
  const arr = map && map.get(name);
  if (!arr) return 0;
  const keys = Object.keys(labelFilter);
  let total = 0;
  for (const s of arr) {
    let hit = true;
    for (const k of keys) {
      if (String(s.labels[k]) !== String(labelFilter[k])) { hit = false; break; }
    }
    if (hit) total += s.value;
  }
  return total;
}

function firstLabel(map, name, key) {
  const arr = map && map.get(name);
  if (!arr) return null;
  for (const s of arr) {
    const v = s.labels[key];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return null;
}

function modelOf(map) {
  if (!map) return null;
  const names = ['vllm:generation_tokens_total', 'vllm:num_requests_running', 'vllm:prompt_tokens_total'];
  for (const n of names) { const v = firstLabel(map, n, 'model_name'); if (v) return v; }
  for (const arr of map.values()) for (const s of arr) if (s.labels.model_name) return s.labels.model_name;
  return null;
}

function d(map, name, filter) { return map ? sumMetric(map, name, filter || {}) : null; }
function delta(a, b) {
  return a === null || b === null || !Number.isFinite(a) || !Number.isFinite(b) ? null : b - a;
}
function div(num, den) {
  const ok = num !== null && den !== null && Number.isFinite(num) && Number.isFinite(den) && den !== 0;
  return ok ? num / den : null;
}

// Fold two parsed snapshots plus the status JSON into the numbers the viz draws.
export function computeState(prevMap, curMap, dtSeconds, status, positions = 3) {
  const n = Number(dtSeconds);
  const dt = Number.isFinite(n) && n > 0 ? n : null;
  const pos = k => ({ position: String(k) });
  const genD = delta(d(prevMap, 'vllm:generation_tokens_total'), d(curMap, 'vllm:generation_tokens_total'));
  const promptD = delta(d(prevMap, 'vllm:prompt_tokens_total'), d(curMap, 'vllm:prompt_tokens_total'));
  const cachedD = delta(d(prevMap, 'vllm:prompt_tokens_cached_total'), d(curMap, 'vllm:prompt_tokens_cached_total'));
  const stepCountD = delta(d(prevMap, 'vllm:inter_token_latency_seconds_count'), d(curMap, 'vllm:inter_token_latency_seconds_count'));
  const stepSumD = delta(d(prevMap, 'vllm:inter_token_latency_seconds_sum'), d(curMap, 'vllm:inter_token_latency_seconds_sum'));
  const ttftCountD = delta(d(prevMap, 'vllm:time_to_first_token_seconds_count'), d(curMap, 'vllm:time_to_first_token_seconds_count'));
  const ttftSumD = delta(d(prevMap, 'vllm:time_to_first_token_seconds_sum'), d(curMap, 'vllm:time_to_first_token_seconds_sum'));
  const draftsD = delta(d(prevMap, 'vllm:spec_decode_num_drafts_total'), d(curMap, 'vllm:spec_decode_num_drafts_total'));
  const acceptedD = delta(d(prevMap, 'vllm:spec_decode_num_accepted_tokens_total'), d(curMap, 'vllm:spec_decode_num_accepted_tokens_total'));
  const preD = delta(d(prevMap, 'vllm:num_preemptions_total'), d(curMap, 'vllm:num_preemptions_total'));
  const tps = div(acceptedD, draftsD);
  const host = status ? status.host : null;
  const gpu = host && host.gpu ? { util: host.gpu.util_pct, powerW: host.gpu.power_w, tempC: host.gpu.temp_c } : null;
  const gib = 1073741824;
  return {
    model: modelOf(curMap) || null,
    running: d(curMap, 'vllm:num_requests_running'),
    waiting: d(curMap, 'vllm:num_requests_waiting'),
    kvUsage: d(curMap, 'vllm:kv_cache_usage_perc'),
    genTokPerSec: r3(div(genD, dt)),
    promptTokPerSec: r3(div(promptD, dt)),
    cachedFrac: r3(div(cachedD, promptD)),
    steps: r3(stepCountD),
    stepMs: r3(div(1000 * stepSumD, stepCountD)),
    ttftMs: r3(div(1000 * ttftSumD, ttftCountD)),
    acceptance: Array.from({ length: positions }, (_, k) => k).map(k => r3(div(delta(
      d(prevMap, 'vllm:spec_decode_num_accepted_tokens_per_pos_total', pos(k)),
      d(curMap, 'vllm:spec_decode_num_accepted_tokens_per_pos_total', pos(k)),
    ), draftsD))),
    tokensPerStep: tps === null ? null : r3(1 + tps),
    preemptions: r3(preD),
    gpu,
    memUsedGiB: host && host.mem ? r3(host.mem.used / gib) : null,
    memTotalGiB: host && host.mem ? r3(host.mem.total / gib) : null,
    phase: status && status.phase !== undefined ? status.phase : null,
    active: status && status.active !== undefined ? status.active : null,
  };
}

async function readBody(res) {
  if (res === null || res === undefined) return null;
  if (typeof res === 'string') return res;
  if (typeof res.text === 'function') return await res.text();
  if (typeof res.json === 'function') return await res.json();
  if (typeof res.body === 'string') return res.body;
  return res.body !== undefined ? res.body : null;
}

// Poll metrics + status, derive state, hand it to callbacks. Never throws out of the timer.
export class LiveFeed {
  constructor(opts = {}) {
    this.metricsUrl = opts.metricsUrl || '/viz/api/metrics';
    this.statusUrl = opts.statusUrl || '/viz/api/status';
    this.positions = Number.isFinite(opts.positions) ? opts.positions : 3;   // speculative draft depth k of the served model
    this.intervalMs = Number.isFinite(opts.intervalMs) && opts.intervalMs > 0 ? opts.intervalMs : 1000;
    this.fetch = typeof opts.fetchImpl === 'function' ? opts.fetchImpl : (...a) => globalThis.fetch(...a);   // unbound: browsers throw 'Illegal invocation' for this.fetch()
    this.callbacks = [];
    this.prevMap = null;
    this.prevTs = null;
    this.timer = null;
    this.busy = false;
  }
  onUpdate(cb) { if (typeof cb === 'function') this.callbacks.push(cb); }
  start() {
    if (this.timer !== null) return;
    this.poll();
    this.timer = setInterval(() => { this.poll(); }, this.intervalMs);
  }
  stop() { if (this.timer !== null) { clearInterval(this.timer); this.timer = null; } }
  async poll() {
    if (this.busy) return;
    this.busy = true;
    const ts = Date.now() / 1000;
    try {
      const res = await this.fetch(this.metricsUrl);
      if (res && res.ok === false) { this.emit({ ok: false, ts, error: `metrics HTTP ${res.status}` }); return; }   // 502 = no model answering
      const text = await readBody(res);
      if (typeof text !== 'string') { this.emit({ ok: false, ts, error: 'no metrics body' }); return; }
      const curMap = parsePrometheus(text);
      let status = null;
      try {
        const sText = await readBody(await this.fetch(this.statusUrl));
        if (typeof sText === 'string') status = JSON.parse(sText);
        else if (sText && typeof sText === 'object') status = sText;
      } catch (e) { status = null; }
      const dt = this.prevTs === null ? null : ts - this.prevTs;
      const state = computeState(this.prevMap, curMap, dt, status, this.positions);
      this.prevMap = curMap;
      this.prevTs = ts;
      this.emit({ ok: true, ts, state });
    } catch (err) {
      this.emit({ ok: false, ts, error: (err && err.message) || String(err) });
    } finally {
      this.busy = false;
    }
  }
  emit(payload) {
    for (const cb of this.callbacks) { try { cb(payload); } catch (e) { /* keep ticking */ } }
  }
}
