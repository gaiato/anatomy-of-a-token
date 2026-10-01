/* Model pack: Qwen3.8-Flash-Next, served with the MiaAI-Lab single-Spark recipe.
 *
 * Everything structural (layers, heads, experts, PLE shapes) already comes from the probe. A pack adds
 * what no config file says: why the recipe makes the choices it does, and what was measured.
 * Sources: 'pack' = the recipe's README/CHANGELOG (github.com/MiaAI-Lab/Qwen3.8-Flash-Next-Single-DGX-Spark, 7d0712d);
 *          'measured' = benchmarked on the lab's GX10 (2026-09-30). Notes with hw: 'gb10' only show on that hardware. */

const ABLIT = /ablit|uncensored/i;

export default {
  id: 'qwen38-flash-next',
  match: p => /flash[_-]?next/i.test(`${p.model?.family} ${p.model?.id} ${p.model?.repo}`),
  name: p => 'Qwen3.8-Flash-Next' + (ABLIT.test(`${p.model?.id} ${p.model?.repo}`) ? ' (abliterated)' : ''),
  credit: 'Recipe notes: MiaAI-Lab single-Spark recipe @ 7d0712d. Measurements: the lab’s GX10, 2026-09-30.',

  // The recipe keeps the PLE table out of the GPU budget: memory-mapped from NVMe into the page cache.
  pleOffloaded: true,
  // Measured: 14.6 GiB of KV for 903,591 tokens, including the indexer's compressed keys (Mia: "~17 KB per token").
  kvBytesPerToken: [17349, 'measured'],

  layerMarks: p => ABLIT.test(`${p.model?.id} ${p.model?.repo}`)
    ? [{ layers: p.model.layer_types.map((t, i) => (t === 'attention' && i >= 14 ? i : -1)).filter(i => i >= 0), label: 'o_proj edited (abliterated)' }]
    : [],

  notes: {
    api: {
      t3: [['The reasoning parser moves everything between <think> and </think> into a separate “reasoning” field, so a chat client can show the thinking apart from the answer. Tool calls are parsed out of the model’s own XML-like output into OpenAI-style tool_calls.', 'pack']],
    },
    tokenize: {
      t3: [['Images join the sequence here too: a 27-layer vision tower turns each 32 × 32-pixel area into one token as wide as a text token (16-pixel patches, merged 2 × 2).', 'config']],
    },
    schedule: {
      t3: [['Chunked prefill lets a long prompt be processed alongside other users’ decode steps instead of stalling them. It still costs them: a 64k-token prompt arriving makes concurrent streams stutter about once per chunk.', 'pack'],
        ['disable_eagle_block_drop keeps one more KV block of shared history in the prefix cache, so a follow-up turn re-reads less.', 'pack']],
    },
    embed: {
      t3: [['Hyper-connections replace the single residual line of a classic transformer: each layer reads a learned mix of the parallel streams and writes its output back with learned weights. That is why the scene shows several rails threading the stack.', 'config']],
    },
    ple: {
      t2: [['The recipe keeps the table as a file on NVMe, memory-mapped, so its hot rows live in the CPU’s page cache. For every token the CPU looks up the rows and hands them to the GPU.', 'pack']],
      t3: [['GB10 has no CUDA stream memory operations, so the recipe swaps vLLM’s offload semaphore for a host-side handshake: the GPU posts a request, the CPU copies the rows into a pinned staging buffer and bumps a sequence number, and the GPU continues.', 'pack'],
        ['MADV_RANDOM stops the kernel from reading 64 KiB around every 90-byte row: about 24 × less disk read per token, roughly 57 KiB per decoded token.', 'pack'],
        ['Before the 2026-09-24 fix, multi-token steps (prefill chunks and MTP verification) shipped stale rows. Fixing it moved NLL from 1.397 to 1.344.', 'pack']],
    },
    linear: {
      t3: [['The recipe stores the recurrent state in BF16 although the config asks for FP32: +8.5% throughput at 8 streams, with long-context needle retrieval unchanged at 15/15.', 'pack']],
    },
    attention: {
      t3: [['The KV cache is FP8 to fit about 1.7 × more tokens. The recipe’s kernel casts FP8 tiles to BF16 and applies the scale after the dot product; before that fix the tile width was halved, a large part of the old setup’s slower steps.', 'pack'],
        ['FP8 keys slightly perturb which blocks the indexer selects. The launcher warns that a long-reasoning benchmark fell from 6/6 to 2/6 in the reference implementation, which matters for very long agent sessions.', 'pack']],
    },
    ffn: {
      t3: [['NVFP4 stores each expert weight in 4 bits with one FP8 scale per 16 values, about 4.5 bits per weight. Blackwell tensor cores multiply that format natively.', 'pack']],
    },
    head: {
      t3: [['Reading this matrix costs about 1.2 GiB per pass in BF16, and it runs once per verified position. That is why the MTP drafter carries its own trimmed copy.', 'pack']],
    },
    sample: {
      t3: [['Greedy decoding here is not bit-reproducible by default: the sparse-attention top-k and the MoE sum arrive in atomic order, so two runs can split on a near-tie. The recipe’s opt-in determinism knobs fix it at −3.4% prefill.', 'pack']],
    },
    spec: {
      t3: [['The drafter reads its own LM head once per draft. The recipe trims that head to the 47,172 most common English and code tokens, which cuts each read from 1.18 to 0.22 GiB. On the GX10 that is about 11 ms of a ~60 ms step, and the largest single reason the upgrade was +50%.', 'pack'],
        ['Acceptance depends on the text, not the checkpoint: stock and abliterated weights measured the same. In the recipe’s sweep, k = 3 won at every concurrency; k = 6 helps only code-heavy traffic.', 'pack']],
      facts: [['Draft vocabulary', '47,172 of 248,320 tokens', 'pack']],
    },
    decode: {
      t3: [['Measured on this box (sparkDash protocol, temperature 0): 49.2 tok/s for one stream, 81.7 at two and 127.2 at four. Batching is nearly free until the expert reads stop overlapping.', 'measured', 'gb10']],
    },
    memory: {
      t3: [['A watchdog stops the container if available memory stays under 6 GiB for five samples, and the launcher refuses to start with less than about 98 GiB free. The 28 GiB host reserve was raised from 26 after 13 driver memory errors at boot; it now boots with none.', 'measured', 'gb10']],
    },
  },
};
