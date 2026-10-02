/* Hardware packs: what the page knows about a machine beyond what the probe can read.
 * A pack matches on the probed hardware and adds a chassis badge, published specs and notes.
 * The fallback covers any NVIDIA GPU by name, with memory bandwidth from public spec sheets. */

const GB10 = {
  id: 'gb10',
  match: hw => (hw.gpus || []).some(g => /GB10/i.test(g.name)),
  title: hw => hw.name || 'NVIDIA GB10 system',
  badge: hw => /gx10/i.test(hw.name || '') ? 'ASCENT  GX10' : /spark/i.test(hw.name || '') ? 'DGX  SPARK' : 'GB10',
  kicker: 'One NVIDIA GB10 Grace Blackwell superchip in a 150 mm box',
  bandwidth: 273e9,
  facts: [
    ['Superchip', 'NVIDIA GB10 (Grace CPU + Blackwell GPU)', 'spec'],
    ['CPU', '20 Arm cores (10 × Cortex-X925 + 10 × Cortex-A725)', 'spec'],
    ['Memory', '128 GB LPDDR5x, unified, ~273 GB/s', 'spec'],
    ['GPU ↔ CPU', 'NVLink-C2C, coherent', 'spec'],
  ],
  t1: 'The CPU and GPU sit in one package and share a single pool of memory. There is no separate graphics memory: the model, its cache and the operating system all live in the same 128 GB.',
  t2: [
    'Because memory is shared, a model too big for most graphics cards fits here, and the GPU can read data straight out of memory the CPU manages. The cost is that the GPU and the operating system compete for the same pool, so the server reserves part of it for the host.',
  ],
  t3: [
    'Generating text is limited by memory bandwidth, not arithmetic: each decode step streams the active weights out of LPDDR5x at about 273 GB/s. Every byte that does not have to be read is time saved, which is why 4-bit weights and speculative decoding pay off so directly on this box.',
    'Grace and Blackwell are joined by NVLink-C2C and see the same memory coherently, so a CPU worker can stage data in pinned host memory that the GPU then reads directly, with no copy across PCIe.',
  ],
};

/* Published memory bandwidth, bytes/s. Used only for the "memory-bound ceiling" estimate. */
const BW = [
  [/H200/i, 4.8e12], [/H100.*(SXM|HBM3)/i, 3.35e12], [/H100/i, 2.0e12], [/B200/i, 8e12], [/A100.*80/i, 2.04e12], [/A100/i, 1.56e12],
  [/L40S?/i, 864e9], [/A6000/i, 768e9], [/RTX 6000 Ada/i, 960e9], [/RTX PRO 6000/i, 1.79e12],
  [/5090/, 1.79e12], [/5080/, 960e9], [/4090/, 1.01e12], [/4080/, 717e9], [/3090/, 936e9], [/3080/, 760e9],
  [/2080 Ti/i, 616e9], [/2070 SUPER/i, 448e9], [/2070/, 448e9], [/T4\b/, 320e9], [/Thor/i, 273e9], [/Orin/i, 205e9],
];

const GENERIC = {
  id: 'generic',
  match: () => true,
  title: hw => hw.name || hw.gpus?.[0]?.name || hw.hostname || 'This machine',
  badge: hw => (hw.gpus?.[0]?.name || (hw.unified ? 'GPU SERVER' : 'CPU SERVER')).replace(/^NVIDIA\s+/i, '').toUpperCase().slice(0, 18),
  kicker: hw => hw.gpus?.length ? `${hw.gpus.length > 1 ? hw.gpus.length + ' × ' : ''}${hw.gpus[0].name}` : 'The machine serving the model',
  bandwidth: hw => { const n = hw.gpus?.[0]?.name || ''; for (const [rx, b] of BW) if (rx.test(n)) return b; return null; },
  facts: () => [],
  t1: hw => hw.unified
    ? 'The CPU and GPU share one pool of memory, so the model, its cache and the operating system all live in the same RAM.'
    : !hw.gpus?.length
    ? 'No GPU was found here, so the CPU does all of the arithmetic, and the weights and the cache live in ordinary system RAM. It works the same way, only slower.'
    : 'The model’s weights and its cache live in the GPU’s own memory. The CPU runs the server process and the tokenizer.',
  t2: [], t3: [],
};

export const HARDWARE_PACKS = [GB10, GENERIC];
export function hardwarePack(hw) { return HARDWARE_PACKS.find(p => p.match(hw || {})) || GENERIC; }
export const val = (v, hw) => typeof v === 'function' ? v(hw) : v;
