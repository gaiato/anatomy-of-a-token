# The model profile (`GET /api/profile`, schema 1)

One JSON document describes the served model. The page builds everything from it; missing fields are `null` and the facts that need them are left out.

```jsonc
{
  "schema": 1,
  "generated": "2026-10-01T17:40:00Z",
  "model": {
    "id": "served name", "repo": "org/checkpoint", "name": "display name", "family": "model_type", "arch": "Architecture",
    "vocab": 248320, "hidden": 2560, "layers": 48, "context": 262144, "tied_embeddings": false, "act": "silu",
    "layer_types": ["linear", "linear", "linear", "attention", ...],   // attention | sliding | linear | ssm, one per layer
    "ffn_types": ["moe", ...],                                          // moe | dense, one per layer
    "attention": { "kind": "gqa|mha|mqa|mla", "heads": 24, "kv_heads": 2, "head_dim": 256, "rope_theta": 1e7, "rope_partial": 0.25,
                   "sliding_window": null, "sparse": { "heads": 4, "head_dim": 128, "budget": 2048, "compress": 4 }, "output_gate": "sigmoid" },
    "linear": { "kind": "gated_deltanet|mamba|linear", "key_heads": 16, "value_heads": 48, "key_dim": 128, "value_dim": 128, "conv": 4 },
    "ffn": { "dense_dim": 12288, "moe": { "experts": 512, "top_k": 10, "shared": 1, "expert_dim": 640 } },
    "extras": { "ple": { "layers": [1], "ngram": 3, "heads": 8 }, "hyper": { "streams": 4 }, "mtp": { "layers": 1 } },
    "vision": { "depth": 27, "hidden": 1152, "patch": 16, "merge": 2 },
    "weights": { "total_params": 179999981459, "total_bytes": 105798973864, "source": "safetensors",
                 "parts": { "experts": { "params": 120795955200, "bytes": 67948314624, "dtypes": { "U8": 0 } }, ... } },
    "quant": { "method": "modelopt", "by_part": { "experts": "NVFP4", "attention": "MXFP8" } },
    "estimates": { "kv_bytes_per_token": 12288, "linear_state_bytes_per_seq": 56623104, "active_params_per_token": 6638455680 }
  },
  "runtime": {
    "engine": "vllm|llamacpp|openai", "version": "…", "served_name": "…", "max_model_len": 262144,
    "launch": { "max_seqs": 4, "batch_tokens": 2048, "gmu": 0.769, "kv_dtype": "fp8", "spec": { "method": "mtp", "num_speculative_tokens": 3 } },
    "kv": { "dtype": "fp8", "block_size": 8, "tokens": 929952, "gmu": 0.769, "prefix_caching": true },
    "spec": { "method": "mtp", "k": 3 }
  },
  "hardware": { "name": "ASUS Ascent GX10", "gpus": [{ "name": "NVIDIA GB10", "mem_total_bytes": null, "unified": true }],
                "cpu": { "models": ["Cortex-X925", "Cortex-A725"], "cores": 20 }, "mem_total_bytes": 130596118528, "unified": true },
  "sources": { "model": "config", "weights": "weights", "kv": "engine", "spec": "engine", "estimates": "calc" }
}
```

**Parts** (from tensor names): `embed`, `head`, `attention`, `linear_attn`, `experts`, `shared_expert`, `router`, `ffn`, `norm`, `hyper`, `ple`, `mtp`, `vision`, `other`. Packed 4-bit weights (a `U8` tensor with block scales beside it) count two parameters per byte; scales and zero-points are bytes but not parameters.

**Estimates** are labelled `calc` on the page. KV bytes per token = attention layers × 2 × KV heads × head dim × bytes per element (1 for FP8). Active parameters = everything the text model uses per token, with the routed experts scaled by top-k / experts.

## A trace (`POST /api/trace`)

Request `{"prompt": "…", "max_tokens": 32, "temperature": 0, "think": false}`. Response:

```jsonc
{ "model": "…", "engine": "vllm", "params": { "temperature": 0, "max_tokens": 32, "think": false },
  "prompt": { "text": "…", "raw_count": 7, "tokens": [{ "id": 248045, "text": "<|im_start|>", "special": true }, ...] },
  "answer": { "ttft_ms": 188.5, "total_ms": 869.3, "finish": "length",
              "steps": [{ "t_ms": 299.0, "tokens": [{ "text": " Logical", "p": 0.668, "top": [[" Logical", 0.668], [" Step", 0.24]] }, ...] }] } }
```

Each streamed chunk is one engine step, so with speculative decoding a step with *n* tokens means *n − 1* drafts were accepted and one token was the model’s own.
