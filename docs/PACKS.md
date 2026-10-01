# Packs

The probe tells the page what a model **is**. Packs add what someone **knows** about it: why it is built that way, how a serving recipe runs it, what was measured. Packs never change structure; if a pack and the profile disagree, the profile wins.

## Model packs (`web/js/packs/<id>.js`)

```js
export default {
  id: 'my-model',
  match: profile => /my-model/i.test(profile.model.family + ' ' + profile.model.id),   // only applies to this model
  name: profile => 'My Model 7B',                    // display name (optional)
  credit: 'Notes from … ; measured on …',            // shown at the Under-the-hood depth
  pleOffloaded: false,                               // model-specific memory facts (optional)
  kvBytesPerToken: [17349, 'measured'],              // override the KV estimate with a measurement (optional)
  layerMarks: p => [{ layers: [14, 18], label: 'edited in this fine-tune' }],   // highlight layers (optional)
  notes: {
    // step id → extra paragraphs. Each entry: [text, source, onlyOnHardware?]
    attention: { t2: [['…', 'pack']], t3: [['…', 'measured', 'gb10']], facts: [['Key', 'value', 'pack']] },
  },
};
```

Register it in `MODEL_PACKS` in `web/js/model.js`.

**Step ids:** `hw`, `memory`, `prompt`, `api`, `tokenize`, `schedule`, `embed`, `ple`, `stack`, `linear`, `attention`, `ffn`, `head`, `sample`, `spec`, `decode`, `stream`, `stop`.

**Sources:** `pack` (your notes, with sources named in `credit`), `measured` (benchmarked by you), `config`, `weights`, `engine`, `trace`, `hw`, `calc`, `spec`, `general`. The page shows the source beside every note, so be honest about it: a claim you read in a README is `pack`, not `measured`.

**Rules for notes:** each must be true for every checkpoint the `match` accepts. Anything true only on certain hardware gets the third element (`'gb10'`) so it disappears elsewhere. Write the Technical depth for a curious engineer and Under the hood for a practitioner; the Overview depth is generic and not extended by packs.

## Hardware packs (`web/js/packs/hardware.js`)

```js
{ id: 'gb10', match: hw => hw.gpus.some(g => /GB10/.test(g.name)),
  title: hw => hw.name, badge: hw => 'ASCENT  GX10', kicker: '…',
  bandwidth: 273e9,            // bytes/s: used for the "memory-bound ceiling" estimate
  facts: [['Memory', '128 GB LPDDR5x', 'spec']], t1: '…', t2: ['…'], t3: ['…'] }
```

Packs are tried in order; the generic fallback covers any NVIDIA GPU, with bandwidths for common cards.
