/* The walkthrough: every step a request goes through, told at three depths.
 *   t1  Overview        plain language, but nothing that is not true
 *   t2  Technical       the shapes, the real numbers, how the parts connect
 *   t3  Under the hood  formulas, formats, engine and recipe details
 * Every step is a template over M (the served model, from the probe) and T (one real request). A step whose
 * feature the model lacks is skipped. Pack notes (model- or hardware-specific) are appended at their tier. */
import { int, count, bytes, pct, ms, showTok } from './util.js';

const q = t => `“${showTok(t)}”`;
const join = a => a.filter(Boolean);
const plural = (n, one, many = one + 's') => `${int(n)} ${n === 1 ? one : many}`;

/* Describe the layer pattern: "3 Gated DeltaNet + 1 full attention, repeated 12 times". */
export function layerPattern(M) {
  const t = M.types, n = t.length; const name = { attention: M.has.sparse ? 'sparse attention' : 'full attention', linear: M.lin?.kind === 'gated_deltanet' ? 'Gated DeltaNet' : 'linear attention', sliding: 'sliding-window', ssm: 'Mamba' };
  for (let p = 1; p <= Math.min(12, n); p++) {
    if (n % p || !t.every((x, i) => x === t[i % p])) continue;
    if (p === 1) return { short: `${n} ${name[t[0]]} layers`, unit: [t[0]], reps: n };
    const runs = []; for (const x of t.slice(0, p)) { if (runs.length && runs[runs.length - 1][0] === x) runs[runs.length - 1][1]++; else runs.push([x, 1]); }
    return { short: runs.map(([x, c]) => `${c} ${name[x]}`).join(' + ') + `, ×${n / p}`, unit: t.slice(0, p), reps: n / p, runs, name };
  }
  const c = {}; t.forEach(x => c[x] = (c[x] || 0) + 1);
  return { short: Object.entries(c).map(([x, k]) => `${k} ${name[x]}`).join(' + '), unit: null, reps: 1, name };
}
const counts = M => { const c = {}; M.types.forEach(x => c[x] = (c[x] || 0) + 1); return c; };

export const MIXNAME = M => ({ attention: M.has.sparse ? 'sparse attention' : 'attention', linear: M.lin?.kind === 'gated_deltanet' ? 'Gated DeltaNet' : 'linear attention', sliding: 'sliding-window attention', ssm: 'Mamba (state-space)' });

/* Short titles for the 3D labels: [title, kicker]. */
export function stationTitles(M) {
  const lp = layerPattern(M);
  return {
    api: ['API server', 'The request arrives'], tokenizer: ['Tokenizer', `${int(M.vocab)}-token vocabulary`],
    scheduler: ['Scheduler', M.slots ? `${M.slots} sequences per step` : 'Continuous batching'], embed: ['Token embedding', `${int(M.hidden)} numbers per token`],
    ple: ['PLE n-gram memory', M.params?.ple ? `${count(M.params.ple)} phrase parameters` : 'Phrase memory'],
    stack: [`${M.L} layers`, lp.short], head: ['LM head', `${int(M.hidden)} → ${int(M.vocab)} scores`], sample: ['Sampling', 'One token is chosen'],
    mtp: ['Speculative decoding', M.spec ? `${M.spec.k} drafts per step` : ''], stream: ['Streaming', 'Text back to you'],
  };
}

export const PHASES = ['The machine', 'Your request', 'Reading the prompt', 'Writing the reply'];

export function steps(M, ctx) {
  const T = ctx.trace, S = [];
  const add = s => { if (s.when === undefined || s.when) S.push(s); };
  const hw = M.hw, hwp = M.hwp, w = M.weights, P = M.params || {};
  const firstTok = T?.out[0], top0 = firstTok?.top?.[0];
  const temp = T?.params?.temperature ?? 0;
  const kvdt = M.kv.dtype && M.kv.dtype !== 'auto' ? M.kv.dtype.toUpperCase() : 'BF16';
  const cnt = counts(M), mixN = MIXNAME(M), lp = layerPattern(M);
  const nAttn = (cnt.attention || 0) + (cnt.sliding || 0);
  const think = T?.tokens.some(t => /^<think>$/.test(t.text));
  const conf = T ? T.out.filter(x => (x.top?.[0]?.[1] ?? 0) > .9).length : 0;
  const unsure = T ? T.out.filter(x => (x.top?.[0]?.[1] ?? 1) < .5).length : 0;

  add({ id: 'hw', phase: 0, station: 'hw', beat: 'intro', widget: null,
    title: `Where it runs`, kicker: hw.title,
    t1: `Everything in this walkthrough happens inside one machine: ${hw.title}. It runs ${M.engine.label}, a server program that keeps ${M.name} loaded and answers requests over the network. ${typeof hwp.t1 === 'function' ? hwp.t1(hw) : hwp.t1}`,
    t2: join([...(hwp.t2 || []),
      w && `The model has ${count(P.total)} parameters, the numbers it learned in training, stored in ${bytes(w.total_bytes)} of files. Nothing in it changes while it answers you: the same weights serve every request.`]),
    t3: join([...(hwp.t3 || []),
      M.bwCeiling && `For this model, one step must read about ${bytes(M.activeBytes)} of weights. At ${(hw.bandwidth / 1e9).toFixed(0)} GB/s that alone limits a single conversation to about ${M.bwCeiling.toFixed(0)} steps per second, before any arithmetic.`]),
    facts: join([hw.gpus?.[0] && ['GPU', hw.gpus.map(g => g.name).join(', '), 'hw'], hw.mem_total_bytes && ['Memory visible to Linux', bytes(hw.mem_total_bytes) + (hw.unified ? ' (shared with the GPU)' : ''), 'hw'],
      hw.cpu && ['CPU', `${hw.cpu.cores} cores · ${[...new Set(hw.cpu.models)].join(' + ')}`, 'hw'], ...(hwp.facts?.length ? hwp.facts : []),
      ['Engine', `${M.engine.label}${M.engine.version ? ' ' + M.engine.version : ''}`, 'engine'], ['Serving', M.id, 'engine'], w && ['Parameters', `${count(P.total)} (${bytes(w.total_bytes)})`, 'weights']]) });

  const mem = M.memory, kvR = mem?.regions.find(r => r.id === 'kv'), wR = mem?.regions.find(r => r.id === 'weights');
  add({ id: 'memory', phase: 0, station: 'memory', beat: 'memory', widget: 'memory', when: !!mem,
    title: 'The model, resident in memory', kicker: 'The floor of this scene, to scale',
    t1: `Before any request arrives, the model is already loaded. Its weights, ${bytes(wR?.bytes)}, sit in ${mem?.unified ? 'the shared memory pool' : 'the GPU’s memory'} and stay there for as long as the server runs. The floor under the scene is that memory, drawn to scale.`,
    t2: join([kvR && `The server also sets aside room for the KV cache: the working memory each conversation builds up as it goes. Here that is about ${bytes(kvR.bytes)}, enough for ${int(M.kv.tokens)} tokens across all conversations at once.`,
      mem?.budget && `The server was told to use ${Math.round(M.kv.gmu * 100)}% of ${mem.unified ? 'memory' : 'GPU memory'} (${bytes(mem.budget)}). Everything else it needs, it must fit inside that budget.`]),
    t3: join([w && `Why the weights are so large: ${count(P.total)} parameters at an average of ${(w.total_bytes * 8 / P.total).toFixed(1)} bits each. By part: ${Object.entries(M.quant).filter(([k]) => ['experts', 'attention', 'linear_attn', 'ffn', 'embed', 'head', '*'].includes(k)).map(([k, v]) => `${{ experts: 'experts', attention: 'attention', linear_attn: 'linear attention', ffn: 'feed-forward', embed: 'embedding', head: 'LM head', '*': 'all weights' }[k]} ${v}`).join(', ')}.`,
      M.kvPerToken && M.kvPerTokenSrc === 'calc' && `Each cached token costs ${int(M.kvPerToken)} bytes: ${nAttn} attention layers × 2 (key and value) × ${M.att.kv_heads} KV heads × ${M.att.head_dim} dimensions × ${kvdt === 'FP8' ? 1 : 2} byte${kvdt === 'FP8' ? '' : 's'} (${kvdt}).`,
      M.kvPerToken && M.kvPerTokenSrc !== 'calc' && `Each cached token costs about ${bytes(M.kvPerToken)}, measured on this machine.`]) });

  add({ id: 'prompt', phase: 1, station: 'api', beat: 'prompt', widget: 'prompt',
    title: 'Your question', kicker: ctx.demo ? 'Saved requests (demo mode)' : `Runs on ${M.name}, live`,
    t1: ctx.demo ? `This copy of the page is running on saved data: real requests captured from ${M.name} on ${(T?.when || '').slice(0, 10) || 'an earlier date'}. Pick one, and every step that follows will show what happened to it.`
      : `Type a question, or pick one below. It runs on ${M.name} right now, and every step that follows shows what happened to it inside the machine.`,
    t2: [`The page asks the server for three things: the exact tokens your question becomes, a short reply (up to ${ctx.maxTokens} tokens), and, for every token of the reply, the model’s five most likely choices. It also times each chunk as it streams back.`],
    t3: [`Settings: temperature ${temp}${temp === 0 ? ' (always the most likely token)' : ''}, thinking ${think ? 'on' : 'off'}. The probe calls ${M.engine.kind === 'vllm' ? 'vLLM’s /tokenize with the chat template applied, then /v1/chat/completions with logprobs and top_logprobs = 5, streamed' : M.engine.kind === 'llamacpp' ? 'llama.cpp’s /apply-template and /tokenize, then /v1/chat/completions with logprobs, streamed' : '/v1/chat/completions with logprobs, streamed'}. Nothing is stored: your question and the reply exist only for the length of the request.`] });

  add({ id: 'api', phase: 1, station: 'api', beat: 'request', widget: null,
    title: 'The request arrives', kicker: 'POST /v1/chat/completions',
    t1: `Your question travels to the server as a small web request. The server wraps it in the model’s chat template, markers that say who is speaking, and hands it to the engine.`,
    t2: join([`The request is a POST to /v1/chat/completions, the OpenAI-style API that most tools speak. ${M.engine.label} answers by streaming the reply back as server-sent events, a few tokens per message, over the same connection.`,
      (M.parsers.reasoning || M.parsers.tools) && `${M.parsers.reasoning ? `A reasoning parser (${M.parsers.reasoning}) separates the model’s thinking from its answer. ` : ''}${M.parsers.tools ? `A tool parser (${M.parsers.tools}) turns tool calls in the model’s output into structured JSON.` : ''}`]),
    t3: join([T?.ttft != null && `The clock for time to first token starts here. For your request it read ${ms(T.ttft)}, measured at the probe beside the server, so network time to your browser is not included.`]),
    facts: join([['Served name', M.id, 'engine'], M.repo && M.repo !== M.id && ['Checkpoint', M.repo, 'engine'], M.context && ['Context window', `${int(M.context)} tokens`, 'engine']]) });

  add({ id: 'tokenize', phase: 1, station: 'tokenizer', beat: 'tokenize', widget: 'tokens', needsTrace: true,
    title: T ? `Text becomes ${T.n} tokens` : 'Text becomes tokens', kicker: `${int(M.vocab)}-token vocabulary`,
    t1: `The model never sees letters. A tokenizer cuts the text into pieces from a fixed vocabulary of ${int(M.vocab)} and replaces each piece with its number. ${T ? `Your question became ${T.n} tokens.` : ''}`,
    t2: join([T?.rawCount != null && `Only ${T.rawCount} of them are your words. The other ${T.n - T.rawCount} come from the chat template: markers for who is speaking${think === false && T.tokens.some(t => t.text === '</think>') ? ', plus an empty thinking block because thinking is switched off' : ''}.`,
      T && `Common words are a single token; rare words, names and numbers split into several. Your question averaged ${(T.text.length / (T.rawCount || T.n)).toFixed(1)} characters per token.`]),
    t3: join([`A leading space belongs to the token, so “ water” and “water” are different entries. Each piece is a run of bytes merged from the pairs that were most frequent in the tokenizer’s training text (byte-pair encoding), so any input, in any language or emoji, can be written down.`,
      M.context && T && `The context window is ${int(M.context)} tokens. This question used ${(T.n / M.context * 100).toFixed(3)}% of it.`]),
    facts: join([['Vocabulary', `${int(M.vocab)} tokens`, 'config'], T && ['This prompt', `${T.n} tokens${T.rawCount != null ? ` (${T.rawCount} are your words)` : ''}`, 'trace']]) });

  add({ id: 'schedule', phase: 1, station: 'scheduler', beat: 'schedule', widget: null,
    title: 'A seat in the batch', kicker: 'Continuous batching',
    t1: `The engine works in steps, many times a second. A scheduler decides which requests take part in each step. Yours got one of ${M.slots ? M.slots : 'several'} seats and a few pages of cache memory to keep its work in.`,
    t2: join([M.slots && `Up to ${M.slots} conversations run together in every step; a ${M.slots + 1 === 2 ? 'second' : 'next'} one would wait in a queue.`,
      M.chunk && `Prompt tokens are processed in chunks of up to ${int(M.chunk)} per step, so a long prompt can share steps with other people’s replies instead of blocking them.`,
      M.kv.block && T && `Cache memory is handed out in blocks of ${M.kv.block} tokens. Your ${T.n} prompt tokens and ${T.nOut} reply tokens need ${T.kvBlocks} blocks.`]),
    t3: join([`Requests join and leave between steps rather than waiting for a whole batch to finish (continuous batching), so the GPU is never idle while anyone is waiting.`,
      M.kv.prefix && `Prefix caching is on: when a request starts with the same tokens as an earlier one (a shared system prompt, or the history of a conversation), the cached keys and values are reused instead of computed again.`]),
    facts: join([M.slots && ['Sequences per step', String(M.slots), 'engine'], M.chunk && ['Prefill chunk', `${int(M.chunk)} tokens`, 'engine'], M.kv.block && ['KV block', `${M.kv.block} tokens`, 'engine'], M.kv.tokens && ['KV capacity', `${int(M.kv.tokens)} tokens`, 'engine']]) });

  add({ id: 'embed', phase: 2, station: 'embed', beat: 'embed', widget: null,
    title: 'Tokens become vectors', kicker: `${int(M.hidden)} numbers per token`,
    t1: `Each token number picks one row of a big table: a list of ${int(M.hidden)} numbers that stands for that token. From here on the model works only with these lists of numbers, called hidden states.`,
    t2: join([`The table is ${int(M.vocab)} rows × ${int(M.hidden)} columns: ${count(M.vocab * M.hidden)} parameters. ${T ? `All ${T.n} prompt tokens` : 'All prompt tokens'} are looked up at once and enter the layers together. That is prefill, and it is why reading a prompt is far faster per token than writing a reply.`,
      M.has.hyper && `This model then copies each vector into ${M.streams} parallel streams (hyper-connections) that travel through every layer side by side.`]),
    t3: join([`Word order is not added here. The attention layers rotate their queries and keys by position (RoPE${M.att.rope_partial ? `, on ${Math.round(M.att.rope_partial * 100)}% of each head’s dimensions` : ''}${M.att.rope_theta ? `, θ = ${int(M.att.rope_theta)}` : ''}), so position enters as an angle, not as an extra vector.`,
      `The input and output tables are ${M.profile.model?.tied_embeddings ? 'tied: the same matrix reads tokens in and scores them out' : 'separate: reading a token in and predicting one out use different matrices'}.`]),
    facts: join([['Table', `${int(M.vocab)} × ${int(M.hidden)} ≈ ${count(M.vocab * M.hidden)}`, 'config'], M.has.hyper && ['Residual streams', `${M.streams} hyper-connections${M.extras.hyper.lowrank ? ` (low-rank ${M.extras.hyper.lowrank})` : ''}`, 'config']]) });

  const ple = M.extras.ple;
  add({ id: 'ple', phase: 2, station: 'ple', beat: 'ple', widget: null, when: M.has.ple,
    title: 'Phrase memory', kicker: 'Per-layer n-gram embeddings (PLE)',
    t1: `Besides the normal token table, this model has a second, much larger memory keyed on short phrases: the last ${ple?.ngram === 3 ? 'two and three' : `up to ${ple?.ngram}`} tokens. Each token fetches a few rows from it and feeds them into layer ${(ple?.layers || []).map(i => i + 1).join(', ')}.`,
    t2: join([P.ple && `The table holds ${count(P.ple)} parameters${M.weights?.parts?.ple ? ` (${bytes(M.weights.parts.ple.bytes)})` : ''}, more than all the attention layers together.`,
      ple?.heads && `For every token, ${ple.heads} heads per n-gram order each look up one hashed row: ${ple.heads * Math.max(1, (ple.ngram || 2) - 1)} rows per token.`]),
    t3: [], facts: join([P.ple && ['Parameters', count(P.ple), 'weights'], ple?.heads && ['Rows per token', `${ple.heads * Math.max(1, (ple.ngram || 2) - 1)} (n = 2…${ple.ngram} × ${ple.heads} heads)`, 'config'], ['Injected at', `layer ${(ple?.layers || []).map(i => i + 1).join(', ')}`, 'config'], ple?.dtype && ['Precision', ple.dtype.toUpperCase(), 'config']]) });

  add({ id: 'stack', phase: 2, station: 'stack', beat: 'stack', widget: 'layers',
    title: `Through ${M.L} layers`, kicker: lp.short,
    t1: `Now the real work. The vectors pass through ${M.L} layers in order. Each layer lets every token gather information from the tokens before it, then transforms each token on its own. By the last layer, the vector of the final token holds what the model needs to predict the next one.`,
    t2: join([M.mixers.length > 1 ? `This model mixes layer types: ${Object.entries(cnt).map(([t, c]) => `${c} ${mixN[t]}`).join(' and ')}${lp.unit ? `, in a repeating pattern of ${lp.runs.map(([t, c]) => `${c} ${mixN[t]}`).join(' then ')}` : ''}.` : `All ${M.L} layers are the same kind: ${mixN[M.types[0]]}.`,
      `Every layer ends in ${M.has.moe ? `a mixture-of-experts block (${M.moe.experts} experts)` : `a feed-forward block (${int(M.denseDim)} wide)`}. Between parts, a residual connection adds each result back onto the vector, so a layer refines what is there instead of replacing it.`,
      T && `All ${T.n} prompt tokens move through the stack together, and the attention layers save each token’s keys and values in the KV cache on the way.`]),
    t3: join([(M.has.linear || M.has.ssm) && `Why mix: attention gets more expensive as the context grows, because every new token compares itself with all earlier ones. A ${mixN[M.has.linear ? 'linear' : 'ssm']} layer costs the same per token at any length. Mixing keeps long-range recall (the attention layers) without paying for it in every layer.`,
      M.stateBytes && `The recurrent state is ${bytes(M.stateBytes)} per conversation and never grows. The KV cache, about ${bytes(M.kvPerToken)} per token, exists only for the ${nAttn} attention layers.`,
      !M.has.linear && !M.has.ssm && M.kvPerToken && `The KV cache costs about ${bytes(M.kvPerToken)} per token across all ${nAttn} attention layers, so a ${int(M.context)}-token conversation would need ${bytes(M.kvPerToken * M.context)}.`,
      ...M.marks.map(m => `Marked layers (${m.layers.map(i => i + 1).join(', ')}): ${m.label}.`)]),
    facts: join([['Layers', lp.short, 'config'], P.text && ['Parameters (text)', count(P.text), 'weights'], P.active && ['Active per token', `≈ ${count(P.active)}`, 'calc']]) });

  const li = M.lin;
  add({ id: 'linear', phase: 2, station: 'linear', beat: 'linear', widget: 'layers', when: M.has.linear || M.has.ssm,
    title: `Inside a ${mixN[M.has.linear ? 'linear' : 'ssm']} layer`, kicker: 'A fixed-size memory, updated token by token',
    t1: `Instead of keeping every earlier token, this layer keeps a memory of fixed size and updates it with each new token. A little of the old information fades; the new is written in. It costs the same at the millionth token as at the tenth.`,
    t2: li?.kind === 'gated_deltanet' ? [`Each of ${li.value_heads} heads keeps a ${li.key_dim} × ${li.value_dim} matrix as its state. For each token the layer computes a key, a value and two gates. It fades the old state, then writes the new association with the delta rule, which corrects what the state would have predicted for that key instead of simply adding to it.`, `Reading is one matrix-vector product: the token’s query asks the state “what was stored for something like me?”`]
      : [`Each head carries a compressed state${li?.state_size ? ` of size ${li.state_size}` : ''} forward from token to token. The update depends on the input (a selective state-space model), so the layer can decide what to keep and what to forget.`],
    t3: join([li?.kind === 'gated_deltanet' ? `Update: S ← α·S + β·(v − S·k)·kᵀ; output o = S·q, then a gate and the output projection. α is a learned forget gate and β the write strength.${li.conv ? ` A short causal convolution (kernel ${li.conv}) over q, k and v runs first.` : ''}` : `h ← Ā·h + B̄·x, y = C·h, with Ā, B̄ and C computed from the input at every step.`,
      M.stateBytes && `State per conversation: ${M.idx.linear.length} layers × ${li.value_heads} heads × ${li.key_dim} × ${li.value_dim} ≈ ${bytes(M.stateBytes)}.`]),
    facts: join([li?.value_heads && ['Heads', `${li.key_heads} key · ${li.value_heads} value, ${li.key_dim}-dim`, 'config'], li?.conv && ['Short conv', `kernel ${li.conv}`, 'config'], M.stateBytes && ['State per conversation', bytes(M.stateBytes), 'calc']]) });

  const A = M.att, sp = A.sparse;
  add({ id: 'attention', phase: 2, station: 'attn', beat: 'attn', widget: 'layers', when: nAttn > 0,
    title: sp ? 'Inside a sparse-attention layer' : M.has.sliding && !cnt.attention ? 'Inside a sliding-window layer' : 'Inside an attention layer',
    kicker: sp ? `An indexer picks ${int(sp.budget)} positions` : `${A.heads} query heads, ${A.kv_heads} KV heads`,
    t1: `Attention lets each token look back at earlier tokens and pull in what matters. Each token makes a query (“what am I looking for?”). Every earlier token offers a key (“what I contain”) and a value (“what I will pass on”). Queries are matched against keys, and the best-matching values are blended in.`,
    t2: join([A.kind === 'mla' ? `${A.heads} query heads read a compressed, shared latent version of the keys and values (multi-head latent attention, rank ${A.kv_lora_rank}), which keeps the KV cache very small.`
        : A.kv_heads < A.heads ? `${A.heads} query heads share ${A.kv_heads} key/value head${A.kv_heads > 1 ? 's' : ''} (grouped-query attention), which makes the KV cache ${A.heads / A.kv_heads}× smaller than giving every head its own.` : `${A.heads} heads, each with its own keys and values (multi-head attention).`,
      sp && `It does not compare against every earlier position. A small indexer (${sp.heads} heads × ${sp.head_dim}) scores a ${sp.compress}×-compressed copy of the keys and keeps the ${int(sp.budget)} most relevant positions; full attention runs only over those.`,
      M.has.sliding && `Sliding-window layers only look at the last ${int(A.sliding_window)} tokens; the full-attention layers between them can reach anything.`,
      `Keys and values are saved in the KV cache as they are made, so no earlier token is ever processed twice.`]),
    t3: join([`Each head computes softmax(q·kᵀ / √${A.head_dim}) · v. Position comes from rotating q and k (RoPE${A.rope_partial ? ` on ${Math.round(A.rope_partial * 100)}% of each ${A.head_dim}-dim head` : ''}).${A.output_gate ? ' A sigmoid gate on the output decides how much of the result to let through.' : ''}`,
      `The KV cache stores keys and values in ${kvdt}.`]),
    facts: join([['Query / KV heads', `${A.heads} / ${A.kind === 'mla' ? 'latent' : A.kv_heads} (${(A.kind || '').toUpperCase()}), ${A.head_dim}-dim`, 'config'], sp && ['Indexer', `${sp.heads} heads × ${sp.head_dim}, compress ${sp.compress}×, budget ${int(sp.budget)}`, 'config'],
      A.rope_theta && ['RoPE', `θ = ${int(A.rope_theta)}${A.rope_partial ? `, ${Math.round(A.rope_partial * 100)}% of dims` : ''}`, 'config'], M.kvPerToken && ['KV per token', bytes(M.kvPerToken), M.kvPerTokenSrc], M.quant.attention && ['Weights', M.quant.attention, 'config']]) });

  const E = M.moe;
  add({ id: 'ffn', phase: 2, station: 'ffn', beat: 'ffn', widget: null,
    title: E ? `${E.top_k} of ${E.experts} experts` : 'The feed-forward block', kicker: E ? 'Mixture of experts' : `${int(M.denseDim)} hidden units`,
    t1: E ? `After gathering context, each token is transformed on its own. Rather than one big network, this layer has ${E.experts} small ones, called experts. A router picks the ${E.top_k} best suited to this token and only those run${E.shared ? `, plus ${E.shared === 1 ? 'one shared expert' : E.shared + ' shared experts'} that always run${E.shared === 1 ? 's' : ''}` : ''}.`
      : `After gathering context, each token passes through a feed-forward network on its own: it widens the vector to ${int(M.denseDim)} numbers, applies a non-linearity, and narrows it back to ${int(M.hidden)}. Much of what the model “knows” is stored in these weights.`,
    t2: E ? join([`Each expert is a small network (${int(M.hidden)} → ${int(E.expert_dim)} → ${int(M.hidden)}). ${P.experts ? `The experts hold ${count(P.experts)} of the model’s ${count(P.total)} parameters, but a token touches only ${E.top_k} of ${E.experts} (${(E.top_k / E.experts * 100).toFixed(1)}%) of them.` : ''}`,
        P.active && `That is the whole trick behind a huge model that still runs fast: about ${count(P.active)} parameters are active for each token.`])
      : [`Three matrices per layer (${int(M.hidden)} × ${int(M.denseDim)} each): about ${count(3 * M.hidden * M.denseDim * M.L)} parameters across all layers, most of the model.`],
    t3: join([E ? `Nobody assigns topics to experts; the specialisation emerges in training, and is often about kinds of tokens (punctuation, code, numbers) as much as subjects.` : null,
      E && M.slots > 1 && `With ${M.slots} conversations in one step, up to ${M.slots * E.top_k} different experts per layer may be needed, so batching costs more weight reads than one stream, but far less than ${M.slots}×.`,
      M.act === 'silu' && `The block is a SwiGLU: out = W_down · (SiLU(W_gate·x) ⊙ (W_up·x)).`, (M.quant.experts || M.quant.ffn) && `Stored as ${M.quant.experts || M.quant.ffn}.`]),
    facts: join([E && ['Experts', `${E.experts} routed (top-${E.top_k})${E.shared ? ` + ${E.shared} shared` : ''}`, 'config'], E && ['Expert size', `${int(M.hidden)} → ${int(E.expert_dim)} → ${int(M.hidden)}`, 'config'], P.experts && ['In experts', count(P.experts), 'weights'], !E && ['Width', int(M.denseDim), 'config']]) });

  const top5sum = (firstTok?.top || []).reduce((a, x) => a + (x[1] || 0), 0);
  add({ id: 'head', phase: 2, station: 'head', beat: 'head', widget: 'probs', needsTrace: true, probsAt: 0,
    title: `${int(M.vocab)} scores`, kicker: 'The LM head',
    t1: `After the last layer, only the final token’s vector matters. It is turned into a score for every token in the vocabulary, and the scores into probabilities.${top0 ? ` For your question, the most likely first token was ${q(top0[0])} at ${pct(top0[1])}.` : ''}`,
    t2: join([`A final normalisation, then one big matrix (${int(M.hidden)} × ${int(M.vocab)}, ${count(P.head)} parameters) produces the scores, called logits. Softmax turns them into probabilities that add up to 1.`,
      firstTok && `The bars show the real top five. The other ${int(M.vocab - 5)} tokens share the remaining ${pct(Math.max(0, 1 - top5sum))}.`]),
    t3: join([T && `Prefill computed hidden states for all ${T.n} prompt positions, but only the last one goes through the LM head. The others were needed only to fill the KV cache${M.has.linear ? ' and the recurrent states' : ''}.`]),
    facts: join([['Matrix', `${int(M.hidden)} × ${int(M.vocab)} ≈ ${count(P.head)}`, 'config'], top0 && ['Top choice', `${q(top0[0])} ${pct(top0[1])}`, 'trace']]) });

  add({ id: 'sample', phase: 2, station: 'sample', beat: 'sample', widget: 'probs', needsTrace: true, probsAt: 0,
    title: 'Picking the first token', kicker: temp === 0 ? 'Temperature 0: the most likely token' : `Temperature ${temp}`,
    t1: firstTok ? `${temp === 0 ? `At temperature 0 the engine takes the most likely token: ${q(firstTok.text)}.` : `At temperature ${temp} the engine draws at random from the probabilities; this time it drew ${q(firstTok.text)}.`} That first token was ready ${ms(T.ttft)} after the request arrived.` : 'One token is chosen from the probabilities.',
    t2: join([`Temperature reshapes the distribution before the draw: below 1 it sharpens toward the top choice, above 1 it flattens it. Top-p keeps only the smallest set of tokens whose probabilities add up to p.`,
      T && `How sure was the model across your reply? ${conf} of ${T.nOut} tokens had a top choice above 90%, and ${unsure} were below 50%. Step through them with the arrows.`]),
    t3: join([T && `The time to first token (${ms(T.ttft)}) is the whole of prefill: tokenizing, scheduling, and running all ${T.n} prompt tokens through ${M.L} layers, plus one pass of the LM head.`]),
    facts: join([T && ['Time to first token', ms(T.ttft), 'trace'], T && ['Temperature', String(temp), 'trace']]) });

  const k = M.spec?.k;
  add({ id: 'spec', phase: 3, station: 'mtp', beat: 'spec', widget: 'steps', needsTrace: true, when: !!M.spec,
    title: `Guess ${k} ahead, check at once`, kicker: M.spec?.method === 'mtp' ? 'Speculative decoding with the model’s own drafter' : 'Speculative decoding',
    t1: `Writing one token per step wastes the GPU: every step reads all the active weights to produce a single token. So a small drafter guesses the next ${k} tokens cheaply, and the main model checks all of them in one step, keeping every guess up to the first wrong one.`,
    t2: join([T && T.steps.length > 1 && `From your reply: ${T.steps.length - 1} checking steps produced ${T.nOut - 1} tokens, ${T.perStep.toFixed(2)} per step. ${T.acc.map((p, j) => `Draft ${j + 1} was accepted ${pct(p, 0)} of the time`).join('; ')}.`,
      `The text is the same as the model would have written alone with the same settings; it only arrives sooner. Predictable text (code, a standard explanation) is guessed well; open-ended writing less so.`]),
    t3: join([`A checking step always adds one token beyond the accepted drafts: the model’s own choice at the first position where it disagreed (or after the last draft). So a step yields between 1 and ${k + 1} tokens; the red orb is the first rejected draft, and anything after it is thrown away unread.`,
      M.spec?.method === 'mtp' && `The drafter here is the model’s own multi-token-prediction layer${M.extras.mtp ? ` (${plural(M.extras.mtp.layers, 'layer')}${P.mtp ? `, ${count(P.mtp)} parameters` : ''})` : ''}, trained alongside it to predict tokens further ahead.`]),
    facts: join([['Draft depth', `k = ${k}`, 'engine'], T?.perStep && ['Tokens per step', T.perStep.toFixed(2), 'trace'], ...(T?.acc || []).map((p, j) => ['Accepted, draft ' + (j + 1), pct(p, 0), 'trace'])]) });

  add({ id: 'decode', phase: 3, station: 'stack', beat: 'decode', widget: 'steps', needsTrace: true,
    title: 'The decode loop', kicker: T?.stepMs ? `${ms(T.stepMs)} per step` : 'One step at a time',
    t1: `From here the model writes step by step. Each step pushes only the newest token${M.spec ? 's' : ''} through the ${M.L} layers. The prompt is never read again: what the model took from it lives on in the KV cache${M.has.linear || M.has.ssm ? ' and the recurrent states' : ''}.`,
    t2: join([T?.stepMs && `Your reply took ${T.steps.length} steps over ${ms(T.total - T.ttft)}: about ${ms(T.stepMs)} per step, or ${(T.perStep * 1000 / T.stepMs).toFixed(1)} tokens per second.`,
      M.kvPerToken && `Every new token adds about ${bytes(M.kvPerToken)} to this conversation’s KV cache.`]),
    t3: join([M.activeBytes && `Decode is limited by memory, not maths. Each step reads about ${bytes(M.activeBytes)} of weights${M.hw.bandwidth ? `; at ${(M.hw.bandwidth / 1e9).toFixed(0)} GB/s that alone takes ${(M.activeBytes / M.hw.bandwidth * 1000).toFixed(1)} ms` : ''}. Putting several conversations into one step shares those reads, which is why total throughput rises with more users while each user’s speed barely drops.`]),
    facts: join([T?.stepMs && ['Step time', ms(T.stepMs), 'trace'], T && ['Steps', String(T.steps.length), 'trace'], M.activeBytes && ['Weights read per step', `≈ ${bytes(M.activeBytes)}`, 'calc']]) });

  add({ id: 'stream', phase: 3, station: 'stream', beat: 'stream', widget: 'reply', needsTrace: true,
    title: 'Streaming back', kicker: 'IDs become text again',
    t1: `Each step’s tokens are turned back into text and sent to you straight away. That is why replies appear in small bursts rather than letter by letter.`,
    t2: join([T && `Your reply arrived in ${T.steps.length} chunks, one per engine step; the shading below shows where each chunk ended.`, `Turning IDs back into text is the tokenizer in reverse: each ID becomes its bytes, and the bytes become characters. A piece that ends halfway through a character is held back until the rest arrives.`]),
    t3: [`Server-sent events: each chunk is one “data: {…}” line carrying the new text. Here the stream also carried log-probabilities, which is how this page knows the top five for every token without asking the model twice.`] });

  add({ id: 'stop', phase: 3, station: 'stream', beat: 'stop', widget: 'summary', needsTrace: true,
    title: T?.finish === 'length' ? 'Cut short' : 'Stopping', kicker: 'Your request in numbers',
    t1: T?.finish === 'length' ? `This reply was cut off after ${T.nOut} tokens, because the page asks for only a short sample. In a normal chat the model keeps going until it produces its end-of-turn token.`
      : T?.stopTok ? `The model ended its reply by producing a special end-of-turn token, ${q(T.stopTok)}. Nothing forced it: it predicted that the answer was complete.` : 'The reply ended.',
    t2: join([T && `${T.n} prompt tokens in, ${T.nOut} tokens out, in ${T.steps.length} engine steps. First token after ${ms(T.ttft)}; finished after ${ms(T.total)}.`]),
    t3: join([`The seat and its cache blocks are freed for the next request.`, M.kv.prefix && `The cached prompt blocks stay available for reuse until memory is needed, so asking a follow-up in the same conversation skips most of prefill.`]) });

  // Pack notes, filtered by hardware.
  const notes = M.pack?.notes || {};
  for (const s of S) {
    const n = notes[s.id]; if (!n) continue;
    const ok = x => !x[2] || x[2] === M.hwp.id;
    s.t2 = [...s.t2, ...(n.t2 || []).filter(ok).map(x => ({ text: x[0], src: x[1] }))];
    s.t3 = [...s.t3, ...(n.t3 || []).filter(ok).map(x => ({ text: x[0], src: x[1] }))];
    s.facts = [...(s.facts || []), ...(n.facts || [])];
  }
  return S;
}

export const STATION_STEP = { hw: 'hw', memory: 'memory', api: 'api', tokenizer: 'tokenize', scheduler: 'schedule', embed: 'embed', ple: 'ple', stack: 'stack', linear: 'linear', attn: 'attention', ffn: 'ffn', head: 'head', sample: 'sample', mtp: 'spec', stream: 'stream' };
