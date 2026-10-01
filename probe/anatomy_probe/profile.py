"""Build the model profile: one normalised JSON document that the page builds its whole scene from.

Every number carries where it came from (`sources`), so the page can tag each fact:
  config   the checkpoint's own config.json (or GGUF metadata)
  weights  counted from the tensor headers of the files on disk
  engine   reported by the running server (/v1/models, /metrics, /props)
  hw       read from this machine (nvidia-smi, /proc)
  calc     derived here from the above: an estimate, not a measurement
"""
import glob
import json
import os
import re
import time

from . import weights as W

SCHEMA = 1


# ── finding the checkpoint on disk ──
def find_model_dir(root, served, search=(), model_map=None):
    """The directory (or .gguf file) the server loaded. Tries, in order: an explicit map, the path the
    server reports, the Hugging Face cache by repo id, then <search dir>/<basename>."""
    model_map = model_map or {}
    for key in (served, root):
        if key in model_map and os.path.exists(model_map[key]):
            return _snapshot(model_map[key])
    cands = []
    if root and os.path.isabs(root):
        cands.append(root)
    hf = os.environ.get("HF_HUB_CACHE") or os.path.join(os.environ.get("HF_HOME", os.path.expanduser("~/.cache/huggingface")), "hub")
    if root and "/" in root and not os.path.isabs(root):
        cands.append(os.path.join(hf, "models--" + root.replace("/", "--")))
    for d in search:
        for name in {os.path.basename(str(root or "").rstrip("/")), served}:
            if name:
                cands.append(os.path.join(d, name))
    for c in cands:
        if os.path.exists(c):
            return _snapshot(c)
    return None


def _snapshot(p):
    """An HF cache repo dir holds snapshots/<rev>/; pick the newest that has a config."""
    if os.path.isdir(os.path.join(p, "snapshots")):
        snaps = [s for s in glob.glob(os.path.join(p, "snapshots", "*")) if os.path.exists(os.path.join(s, "config.json"))]
        if snaps:
            return max(snaps, key=os.path.getmtime)
    return p


# ── Prometheus, minimal ──
_LINE = re.compile(r'^([a-zA-Z_:][\w:]*)(\{(.*)\})?\s+(\S+)')
_LBL = re.compile(r'(\w+)="((?:[^"\\]|\\.)*)"')


def parse_prom(text):
    out = {}
    for line in (text or "").splitlines():
        if not line or line[0] == "#":
            continue
        m = _LINE.match(line)
        if not m:
            continue
        try:
            v = float(m.group(4))
        except ValueError:
            continue
        out.setdefault(m.group(1), []).append((dict(_LBL.findall(m.group(3) or "")), v))
    return out


# ── the normaliser ──
def _txt(cfg):
    """Multimodal checkpoints nest the language model under text_config / llm_config."""
    for k in ("text_config", "llm_config", "language_config", "thinker_config"):
        if isinstance(cfg.get(k), dict) and cfg[k].get("num_hidden_layers"):
            return {**{x: y for x, y in cfg.items() if not isinstance(y, dict)}, **cfg[k]}
    return cfg


def _first(c, *keys, default=None):
    for k in keys:
        if c.get(k) is not None:
            return c[k]
    return default


def _layer_types(c, n):
    lt = c.get("layer_types")
    if isinstance(lt, list) and len(lt) == n:
        norm = {"full_attention": "attention", "attention": "attention", "global": "attention", "linear_attention": "linear",
                "sliding_attention": "sliding", "sliding_window": "sliding", "local": "sliding", "mamba": "ssm", "ssm": "ssm",
                "mamba2": "ssm", "conv": "ssm", "recurrent": "ssm"}
        return [norm.get(str(t).lower(), "attention") for t in lt], "config"
    if c.get("hybrid_override_pattern"):   # Nemotron-H: M = mamba, * = attention, - = MLP-only
        pat = c["hybrid_override_pattern"]
        return ["ssm" if ch == "M" else "attention" for ch in pat][:n], "config"
    sw = c.get("sliding_window")
    pattern = _first(c, "sliding_window_pattern", "sliding_window_pattern_size")
    if sw and pattern:   # Gemma 2/3: N-1 sliding layers then one global
        return ["attention" if (i + 1) % int(pattern) == 0 else "sliding" for i in range(n)], "config"
    if sw and c.get("use_sliding_window"):
        mwl = c.get("max_window_layers", n)
        return ["sliding" if i >= mwl else "attention" for i in range(n)], "config"
    if c.get("ssm") or c.get("state_size") and not c.get("num_attention_heads"):
        return ["ssm"] * n, "config"
    return ["attention"] * n, "config"


def _ffn_types(c, n, has_moe):
    if not has_moe:
        return ["dense"] * n
    k = _first(c, "first_k_dense_replace", default=0) or 0
    only = set(c.get("mlp_only_layers") or [])
    step = c.get("decoder_sparse_step") or 1
    return ["dense" if i < k or i in only or (i + 1) % step else "moe" for i in range(n)]


def _quant(cfg, wsum):
    """Formats by part, from the checkpoint's quantization config, else from tensor dtypes."""
    q = cfg.get("quantization_config") or {}
    method = q.get("quant_method") or q.get("quant_algo")
    formats = {}

    def fmt(wt):
        bits, typ, gs = wt.get("num_bits"), wt.get("type"), wt.get("group_size")
        if typ == "float" and bits == 4:
            return "NVFP4" if gs == 16 else "MXFP4" if gs == 32 else "FP4"
        if typ == "float" and bits == 8:
            return "MXFP8" if gs == 32 else "FP8"
        if bits:
            return f"INT{bits}" + (f" g{gs}" if gs else "")
        return None

    for g in (q.get("config_groups") or {}).values():
        f = fmt(g.get("weights") or {})
        for t in g.get("targets") or []:
            if f:
                formats.setdefault(W.part_of(t), f)
    if not formats and method in ("fp8", "FP8"):
        bs = q.get("weight_block_size")
        formats["*"] = "FP8" + (f" block {bs[0]}×{bs[1]}" if bs else "")
    if not formats and method in ("gptq", "awq", "autoround"):
        formats["*"] = f"INT{q.get('bits', 4)} g{q.get('group_size', 128)} ({method.upper()})"
    # fill the gaps from what the bytes actually are
    names = {"BF16": "BF16", "F16": "FP16", "F32": "FP32", "F8_E4M3": "FP8", "U8": "4-bit packed", "I32": "INT4 packed"}
    for part, p in (wsum or {}).get("parts", {}).items():
        if part in formats or "*" in formats or not p["dtypes"]:
            continue
        dom = max(p["dtypes"].items(), key=lambda x: x[1])[0]
        formats[part] = names.get(dom, dom)
    return {"method": method, "by_part": formats}


def _dtype_bytes(dt):
    dt = str(dt or "").lower()
    if "fp8" in dt or "e4m3" in dt or "e5m2" in dt or dt == "int8":
        return 1
    if "fp4" in dt or "nvfp4" in dt:
        return 0.5
    if "32" in dt:
        return 4
    return 2


def build(cfg, wsum=None, wsource=None, metrics_text=None, engine_info=None, hardware=None, pack_hint=None):
    src = {}
    c = _txt(cfg)
    n = int(_first(c, "num_hidden_layers", "n_layer", "num_layers"))
    hidden = int(_first(c, "hidden_size", "d_model", "n_embd"))
    lt, src["layer_types"] = _layer_types(c, n)
    experts = _first(c, "num_experts", "n_routed_experts", "num_local_experts", "moe_num_experts")
    has_moe = bool(experts and experts > 1)
    heads = _first(c, "num_attention_heads", "n_head")
    kvh = _first(c, "num_key_value_heads", "num_kv_heads", default=heads)
    hd = _first(c, "head_dim", default=(hidden // heads) if heads else None)
    rope = c.get("rope_parameters") or c.get("rope_scaling") or {}
    kind = "mla" if c.get("kv_lora_rank") else ("mha" if kvh == heads else "mqa" if kvh == 1 else "gqa")
    sparse = None
    if c.get("indexer_budget") or c.get("index_topk"):
        sparse = {"heads": _first(c, "indexer_n_heads", "index_n_heads"), "head_dim": _first(c, "indexer_head_dim", "index_head_dim"),
                  "budget": _first(c, "indexer_budget", "index_topk"), "compress": c.get("indexer_compress_ratio")}
    attention = {"kind": kind, "heads": heads, "kv_heads": kvh, "head_dim": hd,
                 "rope_theta": _first(c, "rope_theta", default=rope.get("rope_theta")),
                 "rope_partial": _first(c, "partial_rotary_factor", default=rope.get("partial_rotary_factor")),
                 "sliding_window": c.get("sliding_window") if "sliding" in lt else None, "sparse": sparse,
                 "output_gate": c.get("output_gate_type") or (True if c.get("attn_output_gate") else None),
                 "kv_lora_rank": c.get("kv_lora_rank"), "q_lora_rank": c.get("q_lora_rank")}
    linear = None
    if "linear" in lt:
        linear = {"kind": "gated_deltanet" if c.get("linear_value_head_dim") else "linear",
                  "key_heads": c.get("linear_num_key_heads"), "value_heads": c.get("linear_num_value_heads"),
                  "key_dim": c.get("linear_key_head_dim"), "value_dim": c.get("linear_value_head_dim"), "conv": c.get("linear_conv_kernel_dim")}
    if "ssm" in lt:
        s = c.get("ssm") or {}
        linear = {"kind": "mamba", "state_size": _first(c, "state_size", "ssm_state_size", "mamba_d_state", default=s.get("state_size")),
                  "heads": _first(c, "mamba_num_heads", "ssm_num_heads", default=s.get("time_step_rank")),
                  "conv": _first(c, "conv_kernel", "mamba_d_conv", default=s.get("conv_kernel"))}
    moe = None
    if has_moe:
        shared_n = _first(c, "n_shared_experts", "num_shared_experts", default=1 if c.get("shared_expert_intermediate_size") else 0)
        moe = {"experts": experts, "top_k": _first(c, "num_experts_per_tok", "moe_topk", "top_k", "moe_k"), "shared": shared_n,
               "expert_dim": _first(c, "moe_intermediate_size", "expert_intermediate_size"),
               "shared_dim": c.get("shared_expert_intermediate_size")}
    ffn_t = _ffn_types(c, n, has_moe)
    extras = {}
    if c.get("ple_layer_ids"):
        extras["ple"] = {"layers": [i - 1 for i in c["ple_layer_ids"]], "ngram": c.get("ngram_size"), "heads": c.get("heads_per_ngram"),
                         "dim": c.get("ple_embed_dim"), "dtype": c.get("ple_embedding_dtype")}
    if c.get("hc_count"):
        extras["hyper"] = {"streams": c["hc_count"], "lowrank": c.get("hc_lowrank")}
    mtp_n = _first(c, "mtp_num_hidden_layers", "num_nextn_predict_layers", "num_mtp_layers")
    if mtp_n:
        extras["mtp"] = {"layers": mtp_n}
    vis = cfg.get("vision_config")
    vision = {"depth": _first(vis, "depth", "num_hidden_layers"), "hidden": vis.get("hidden_size"), "patch": vis.get("patch_size"),
              "merge": vis.get("spatial_merge_size"), "out": vis.get("out_hidden_size")} if isinstance(vis, dict) else None
    vocab = _first(c, "vocab_size", "padded_vocab_size")
    model = {
        "family": cfg.get("model_type") or c.get("model_type"), "arch": (cfg.get("architectures") or [None])[0],
        "vocab": vocab, "hidden": hidden, "layers": n, "context": _first(c, "max_position_embeddings", "max_seq_len", "seq_length"),
        "tied_embeddings": bool(_first(cfg, "tie_word_embeddings", default=c.get("tie_word_embeddings", False))),
        "act": _first(c, "hidden_act", "activation_function"), "norm_eps": c.get("rms_norm_eps"),
        "layer_types": lt, "ffn_types": ffn_t, "attention": attention, "linear": linear,
        "ffn": {"dense_dim": c.get("intermediate_size"), "moe": moe}, "extras": extras, "vision": vision,
    }
    if cfg.get("_gguf"):
        model["gguf"] = cfg["_gguf"]
    src["model"] = "config"
    if wsum:
        model["weights"] = {**wsum, "source": wsource}
        src["weights"] = "weights"
    model["quant"] = _quant(cfg, wsum)

    runtime = dict(engine_info or {})
    m = parse_prom(metrics_text) if metrics_text else {}
    cci = (m.get("vllm:cache_config_info") or [({}, 0)])[0][0]
    if cci:
        num = lambda k: float(cci[k]) if cci.get(k) not in (None, "None", "") else None
        runtime["kv"] = {"dtype": cci.get("cache_dtype"), "block_size": num("block_size"), "tokens": num("kv_cache_size_tokens"),
                         "gpu_blocks": num("num_gpu_blocks"), "gmu": num("gpu_memory_utilization"),
                         "prefix_caching": cci.get("enable_prefix_caching") == "True", "max_concurrency": num("kv_cache_max_concurrency"),
                         "state_dtype": cci.get("mamba_ssm_cache_dtype")}
        src["kv"] = "engine"
    pos = {l.get("position") for l, _ in m.get("vllm:spec_decode_num_accepted_tokens_per_pos_total", [])}
    ls = (runtime.get("launch") or {}).get("spec") or {}
    if pos or ls.get("num_speculative_tokens"):
        runtime["spec"] = {"method": ls.get("method") or ("mtp" if "mtp" in extras else "draft"), "k": ls.get("num_speculative_tokens") or len(pos)}
        src["spec"] = "engine"
    if (runtime.get("launch") or {}).get("draft_max"):
        runtime["spec"] = {"method": "draft", "k": runtime["launch"]["draft_max"]}
        src["spec"] = "engine"
    model["estimates"] = _estimates(model, runtime)
    src["estimates"] = "calc"
    return {"schema": SCHEMA, "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "model": model,
            "runtime": runtime, "hardware": hardware or {}, "sources": src, "pack_hint": pack_hint}


def _estimates(model, runtime):
    """Numbers the page needs that nobody reports directly. All are labelled `calc`."""
    e = {}
    lt, a = model["layer_types"], model["attention"]
    n_attn = sum(1 for t in lt if t in ("attention", "sliding"))
    kvd = ((runtime.get("kv") or {}).get("dtype")) or "bf16"
    b = _dtype_bytes(kvd if kvd != "auto" else "bf16")
    if a.get("kind") == "mla" and a.get("kv_lora_rank"):
        per_layer = (a["kv_lora_rank"] + 64) * b
    elif a.get("kv_heads") and a.get("head_dim"):
        per_layer = 2 * a["kv_heads"] * a["head_dim"] * b
    else:
        per_layer = None
    if per_layer:
        e["kv_bytes_per_token"] = int(per_layer * n_attn)
    li = model.get("linear")
    if li and li.get("kind") == "gated_deltanet" and li.get("value_heads"):
        sd = _dtype_bytes((runtime.get("kv") or {}).get("state_dtype") or "bf16")
        e["linear_state_bytes_per_seq"] = int(sum(1 for t in lt if t == "linear") * li["value_heads"] * li["key_dim"] * li["value_dim"] * sd)
    w = model.get("weights")
    if w:
        parts = w["parts"]
        P = lambda k: parts.get(k, {}).get("params", 0)
        moe = model["ffn"].get("moe")
        active = w["total_params"] - P("vision") - P("mtp") - P("ple") - P("embed")
        if moe and moe.get("experts") and moe.get("top_k"):
            active -= P("experts") * (1 - moe["top_k"] / moe["experts"])
        e["active_params_per_token"] = int(active)
        e["params_text"] = int(w["total_params"] - P("vision"))
    return e
