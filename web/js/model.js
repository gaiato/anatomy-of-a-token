/* The view model: profile (from the probe) + matching packs + the current trace → every number the page shows.
 * Nothing here is specific to one model. If a value is missing, it is null and the page leaves that fact out. */
import { GiB } from './util.js';
import flashNext from './packs/qwen38-flash-next.js';
import { hardwarePack, val } from './packs/hardware.js';

export const MODEL_PACKS = [flashNext];

export function viewModel(profile) {
  const m = profile.model || {}, rt = profile.runtime || {}, hw = profile.hardware || {};
  const L = m.layers || 0, types = m.layer_types || Array(L).fill('attention');
  const pack = MODEL_PACKS.find(p => p.match(profile)) || null;
  const hwp = hardwarePack(hw);
  const launch = rt.launch || {}, kv = rt.kv || {};
  const moe = m.ffn?.moe || null;
  const parts = m.weights?.parts || {};
  const P = k => parts[k]?.params || 0, B = k => parts[k]?.bytes || 0;
  const spec = rt.spec && rt.spec.k ? rt.spec : null;

  const M = {
    profile, pack, hwp,
    id: m.id || rt.served_name || 'model', name: pack?.name?.(profile) || m.name || m.id || rt.served_name || 'this model',
    repo: m.repo || rt.repo, family: m.family, arch: m.arch,
    engine: { kind: rt.engine || 'openai', label: { vllm: 'vLLM', llamacpp: 'llama.cpp' }[rt.engine] || 'an OpenAI-compatible server', version: rt.version },
    L, types, ffnTypes: m.ffn_types || Array(L).fill(moe ? 'moe' : 'dense'),
    vocab: m.vocab, hidden: m.hidden, context: rt.max_model_len || m.context, act: m.act,
    att: m.attention || {}, lin: m.linear, moe, denseDim: m.ffn?.dense_dim,
    extras: m.extras || {}, vision: m.vision, quant: m.quant?.by_part || {}, quantMethod: m.quant?.method,
    spec, slots: launch.max_seqs ?? rt.slots ?? null, chunk: launch.batch_tokens ?? null,
    kv: { dtype: kv.dtype || launch.kv_dtype || null, tokens: kv.tokens ?? null, block: kv.block_size ?? null, prefix: kv.prefix_caching ?? null, gmu: kv.gmu ?? launch.gmu ?? null },
    parsers: { reasoning: launch.reasoning_parser, tools: launch.tool_parser },
    hw: { ...hw, title: val(hwp.title, hw), badge: val(hwp.badge, hw), kicker: val(hwp.kicker, hw), bandwidth: val(hwp.bandwidth, hw) },
    weights: m.weights || null, est: m.estimates || {},
  };
  M.idx = { attn: [], linear: [], sliding: [], ssm: [] };
  types.forEach((t, i) => (M.idx[t === 'attention' ? 'attn' : t] || (M.idx[t] = [])).push(i));
  M.firstOf = t => types.indexOf(t);
  M.has = {
    moe: !!moe, linear: !!(M.lin && M.idx.linear.length), ssm: M.idx.ssm.length > 0, sliding: M.idx.sliding.length > 0,
    sparse: !!M.att.sparse, ple: !!M.extras.ple, hyper: !!M.extras.hyper, mtp: !!spec, vision: !!M.vision, weights: !!m.weights,
    mla: M.att.kind === 'mla',
  };
  M.mixers = [...new Set(types)];   // 'attention' | 'linear' | 'sliding' | 'ssm'
  M.streams = M.extras.hyper?.streams || 1;
  M.pleLayers = M.extras.ple?.layers || [];
  M.marks = pack?.layerMarks?.(profile) || [];

  // ── parameters and bytes ──
  if (m.weights) {
    const textParams = m.weights.total_params - P('vision');
    const expFrac = moe?.experts && moe?.top_k ? moe.top_k / moe.experts : 1;
    M.params = {
      total: m.weights.total_params, text: textParams, active: M.est.active_params_per_token,
      experts: P('experts'), embed: P('embed'), head: P('head') || (M.vocab && M.hidden ? M.vocab * M.hidden : null),
      ple: P('ple'), mtp: P('mtp'), vision: P('vision'),
      mixer: P('attention') + P('linear_attn'),
    };
    // bytes one decode step must read: every non-expert weight it uses, plus top_k/E of the experts
    M.activeBytes = m.weights.total_bytes - B('vision') - B('ple') - B('embed') - B('mtp') - B('experts') * (1 - expFrac);
  } else {
    M.params = { head: M.vocab && M.hidden ? M.vocab * M.hidden : null, embed: M.vocab && M.hidden ? M.vocab * M.hidden : null };
  }
  M.bwCeiling = M.hw.bandwidth && M.activeBytes ? M.hw.bandwidth / M.activeBytes : null;   // steps/s if bandwidth were the only limit

  // ── KV cache ──
  const kvp = pack?.kvBytesPerToken;
  M.kvPerToken = kvp ? kvp[0] : M.est.kv_bytes_per_token ?? null;
  M.kvPerTokenSrc = kvp ? kvp[1] : 'calc';
  M.stateBytes = M.est.linear_state_bytes_per_seq ?? null;

  M.memory = memoryMap(M, pack);
  return M;
}

/* The floor of the scene: the machine's memory, carved into what the model uses. Every region says its source. */
function memoryMap(M, pack) {
  const hw = M.hw, w = M.weights, parts = w?.parts || {};
  const B = k => parts[k]?.bytes || 0;
  const gpuTotal = hw.unified ? hw.mem_total_bytes : hw.gpus?.[0]?.mem_total_bytes;
  if (!w || !gpuTotal) return null;
  const budget = M.kv.gmu ? gpuTotal * M.kv.gmu : null;
  const pleOff = M.has.ple && pack?.pleOffloaded;
  const gpuWeights = w.total_bytes - (pleOff ? B('ple') : 0) - B('mtp');
  const kvBytes = M.kv.tokens && M.kvPerToken ? M.kv.tokens * M.kvPerToken : null;
  const R = [];
  R.push({ id: 'weights', band: 'gpu', bytes: gpuWeights, color: '#3987e5', src: 'weights', label: 'Model weights',
    note: `Every tensor the GPU keeps resident while serving${M.quantMethod ? `, in the checkpoint’s ${Object.values(M.quant).filter((v, i, a) => a.indexOf(v) === i).slice(0, 3).join(' / ')} formats` : ''}.` });
  if (kvBytes) R.push({ id: 'kv', band: 'gpu', bytes: kvBytes, color: '#d9a326', src: M.kvPerTokenSrc === 'calc' ? 'calc' : M.kvPerTokenSrc,
    label: `KV cache · ${Math.round(M.kv.tokens).toLocaleString('en-US')} tokens`, note: `Room the server set aside for the keys and values of ${M.idx.attn.length + M.idx.sliding.length} attention layers, about ${(M.kvPerToken / 1024).toFixed(1)} KiB per token.` });
  if (B('mtp')) R.push({ id: 'mtp', band: 'gpu', bytes: B('mtp'), color: '#c084fc', src: 'weights', label: 'Draft (MTP) layer', note: 'The speculative-decoding drafter’s own weights.' });
  if (budget) {
    const used = R.reduce((a, r) => a + r.bytes, 0);
    if (budget > used) R.push({ id: 'act', band: 'gpu', bytes: budget - used, color: '#64748b', src: 'calc', label: 'Activations · graphs · workspace', note: `The rest of the ${(budget / GiB).toFixed(1)} GiB GPU budget (${Math.round(M.kv.gmu * 100)}% of memory): CUDA graph pools, recurrent state, scratch space.` });
  }
  if (pleOff) R.push({ id: 'ple', band: 'host', bytes: B('ple'), color: '#199e70', src: 'weights', label: 'PLE n-gram table (page cache)', note: 'Memory-mapped from disk; rows stay in the page cache while they are hot.' });
  const hostTotal = hw.unified ? hw.mem_total_bytes - (budget || R.reduce((a, r) => a + (r.band === 'gpu' ? r.bytes : 0), 0)) : hw.mem_total_bytes;
  const hostUsed = R.filter(r => r.band === 'host').reduce((a, r) => a + r.bytes, 0);
  if (hostTotal && hostTotal > hostUsed) R.push({ id: 'host', band: 'host', bytes: hostTotal - hostUsed, color: '#3a4152', src: 'calc', label: hw.unified ? 'Operating system and everything else' : 'System RAM', note: hw.unified ? 'What the host keeps for itself, once the GPU budget is set aside.' : 'CPU memory: the server process, tokenizer and operating system.' });
  return { unified: !!hw.unified, total: hw.unified ? hw.mem_total_bytes : gpuTotal + (hw.mem_total_bytes || 0), gpuTotal, budget, regions: R };
}

/* ── The trace: one real request, from the probe or a snapshot ── */
export function traceModel(t, M) {
  if (!t) return null;
  const toks = t.prompt?.tokens || [];
  const steps = (t.answer?.steps || []).map(s => ({ ...s, n: s.tokens.length }));
  const out = steps.flatMap((s, si) => s.tokens.map((k, j) => ({ ...k, step: si, inStep: j })));
  const k = M.spec?.k || 0;
  const decode = steps.slice(1);
  const acc = k ? Array.from({ length: k }, (_, j) => decode.length ? decode.filter(s => s.n - 1 > j).length / decode.length : null) : [];
  const ttft = t.answer?.ttft_ms ?? null, total = t.answer?.total_ms ?? null;
  const stepMs = decode.length && ttft != null ? (steps[steps.length - 1].t_ms - ttft) / decode.length : null;
  const stopTok = out.length && /^<\|.*\|>$|^<\/s>$|<end_of_turn>|<\|eot_id\|>/.test(out[out.length - 1].text) ? out[out.length - 1].text : null;
  return {
    raw: t, text: t.prompt?.text || '', tokens: toks, n: toks.length, rawCount: t.prompt?.raw_count ?? null,
    special: toks.filter(x => x.special).length, steps, out, nOut: out.length, ttft, total, stepMs,
    perStep: decode.length ? decode.reduce((a, s) => a + s.n, 0) / decode.length : null, acc,
    reply: out.filter(x => !stopTok || x !== out[out.length - 1]).map(x => x.text).join(''),
    finish: t.answer?.finish, stopTok, params: t.params || {}, model: t.model, when: t.ts,
    kvBlocks: M.kv.block ? Math.ceil((toks.length + out.length) / M.kv.block) : null,
  };
}
