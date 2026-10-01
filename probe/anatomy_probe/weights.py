"""Read a checkpoint's tensor directory without loading a single weight.

safetensors: each shard starts with an 8-byte length and a JSON header of {name: {dtype, shape, data_offsets}}.
GGUF: a binary header of metadata key/values, then one record per tensor (name, dims, type, offset).
Either way we learn every tensor's name, shape and byte size, which is enough to say how many
parameters each part of the model has and how much memory it takes.
"""
import json
import os
import re
import struct

SCAN_VERSION = 2   # bump when PARTS changes: cached scans are keyed on it

# ── which part of the model a tensor belongs to (HF and GGUF names) ──
PARTS = [
    ("vision", r"(^|\.)(visual|vision_tower|vision_model|vit|mm_projector|multi_modal_projector)\.|^v\.|^mm\."),
    ("mtp", r"(^|\.)mtp\.|nextn|^blk\.\d+\.nextn"),
    ("ple", r"ple|ngram"),
    ("hyper", r"hyper_connection|\.hc_|^hc\."),
    ("embed", r"embed_tokens|wte\.|tok_embeddings|^token_embd\.|word_embeddings"),
    ("head", r"(^|\.)lm_head\.|^output\.weight|^output\.(scales|biases)"),
    ("router", r"\.mlp\.gate\.(weight|e_score)|\.router\.|ffn_gate_inp|\.block_sparse_moe\.gate\.|exp_probs_b"),
    ("shared_expert", r"shared_expert|shexp|shared_mlp"),
    ("experts", r"\.experts\.|_exps\.|\.experts$|block_sparse_moe\.experts"),
    ("linear_attn", r"linear_attn|ssm|mamba|\.mixer\.|time_mix|delta"),
    ("attention", r"self_attn|\.attn|attention\.|attn_(q|k|v|o|output|qkv)|indexer"),
    ("ffn", r"\.mlp\.|feed_forward|ffn_(gate|up|down)"),
    ("norm", r"norm|ln_"),
]
_PARTS = [(n, re.compile(p)) for n, p in PARTS]
_OVERHEAD = re.compile(r"(_scale(_2)?|_scale_inv|\.scales|\.qzeros|\.g_idx|input_scale|amax|\.zeros|_zero_point)$")


def part_of(name):
    for n, rx in _PARTS:
        if rx.search(name):
            return n
    return "other"


# ── safetensors ──
_ST_BYTES = {"F64": 8, "F32": 4, "BF16": 2, "F16": 2, "F8_E4M3": 1, "F8_E5M2": 1, "F8_E8M0": 1, "I64": 8, "I32": 4,
             "I16": 2, "I8": 1, "U8": 1, "BOOL": 1, "F4": 0.5, "F6_E2M3": 0.75, "F6_E3M2": 0.75}


def _st_header(path):
    with open(path, "rb") as f:
        n = struct.unpack("<Q", f.read(8))[0]
        if n > 512 * 1024 * 1024:
            raise ValueError(f"{path}: implausible header size {n}")
        return json.loads(f.read(n))


def scan_safetensors(model_dir):
    """{parts, total_bytes, total_params, dtypes, shards, tensors} for a directory of .safetensors shards."""
    shards = sorted(f for f in os.listdir(model_dir) if f.endswith(".safetensors"))
    idx = os.path.join(model_dir, "model.safetensors.index.json")
    if os.path.exists(idx):   # only the shards the index names: some repos ship side files (scales, calibration)
        with open(idx) as f:
            named = set(json.load(f).get("weight_map", {}).values())
        if named:
            shards = sorted(s for s in shards if s in named)
    tensors = {}
    for s in shards:
        h = _st_header(os.path.join(model_dir, s))
        for name, t in h.items():
            if name == "__metadata__":
                continue
            a, b = t["data_offsets"]
            tensors[name] = (t["dtype"], t["shape"], b - a)
    return _summarise(tensors, packed_factor=_packed_factor(tensors), shards=len(shards))


def _packed_factor(tensors):
    """Packed integer weights hold several values per element: NVFP4/MXFP4 two per byte, GPTQ/AWQ eight per int32."""
    def factor(name, dtype, shape):
        if dtype == "U8":
            base = name[: -len(".weight")] if name.endswith(".weight") else name
            for sfx in (".weight_scale", ".scales", ".weight_scale_inv"):
                sc = tensors.get(base + sfx)
                if sc and sc[1] and shape:
                    return 2   # 4-bit floats packed two to a byte, with block scales beside them
            return 1
        if dtype == "I32" and (name.endswith(".qweight") or name.endswith(".weight_packed")):
            return 8
        return 1
    return factor


def _summarise(tensors, packed_factor=None, shards=None, type_names=None):
    parts, dtypes, total_b, total_p = {}, {}, 0, 0
    layers = set()
    for name, (dtype, shape, nbytes) in tensors.items():
        part = part_of(name)
        m = re.search(r"(?:layers|blk|h|block)\.(\d+)\.", name)
        if m:
            layers.add(int(m.group(1)))
        p = parts.setdefault(part, {"params": 0, "bytes": 0, "dtypes": {}})
        p["bytes"] += nbytes
        total_b += nbytes
        dt = type_names(dtype) if type_names else dtype
        p["dtypes"][dt] = p["dtypes"].get(dt, 0) + nbytes
        dtypes[dt] = dtypes.get(dt, 0) + nbytes
        if _OVERHEAD.search(name):
            continue
        n = 1
        for d in shape:
            n *= d
        n *= packed_factor(name, dtype, shape) if packed_factor else 1
        p["params"] += n
        total_p += n
    return {"parts": parts, "total_bytes": total_b, "total_params": total_p, "dtypes": dtypes,
            "shards": shards, "tensors": len(tensors), "layer_indices": len(layers)}


# ── GGUF ──
GGML_TYPES = {0: "F32", 1: "F16", 2: "Q4_0", 3: "Q4_1", 6: "Q5_0", 7: "Q5_1", 8: "Q8_0", 9: "Q8_1", 10: "Q2_K", 11: "Q3_K",
              12: "Q4_K", 13: "Q5_K", 14: "Q6_K", 15: "Q8_K", 16: "IQ2_XXS", 17: "IQ2_XS", 18: "IQ3_XXS", 19: "IQ1_S",
              20: "IQ4_NL", 21: "IQ3_S", 22: "IQ2_S", 23: "IQ4_XS", 24: "I8", 25: "I16", 26: "I32", 27: "I64", 28: "F64",
              29: "IQ1_M", 30: "BF16", 34: "TQ1_0", 35: "TQ2_0", 39: "MXFP4"}
_KV_FMT = {0: "<B", 1: "<b", 2: "<H", 3: "<h", 4: "<I", 5: "<i", 6: "<f", 7: "<?", 10: "<Q", 11: "<q", 12: "<d"}


class _R:
    def __init__(self, f):
        self.f = f

    def n(self, fmt):
        s = struct.calcsize(fmt)
        return struct.unpack(fmt, self.f.read(s))[0]

    def s(self):
        return self.f.read(self.n("<Q")).decode("utf-8", "replace")

    def val(self, t, keep=4096):
        if t in _KV_FMT:
            return self.n(_KV_FMT[t])
        if t == 8:
            return self.s()
        if t == 9:
            it, cnt = self.n("<I"), self.n("<Q")
            if cnt > keep:   # e.g. the 150k-entry vocabulary: skip it, remember its length
                if it in _KV_FMT:
                    self.f.seek(cnt * struct.calcsize(_KV_FMT[it]), 1)
                else:
                    for _ in range(cnt):
                        self.val(it)
                return {"_len": cnt}
            return [self.val(it) for _ in range(cnt)]
        raise ValueError(f"unknown GGUF value type {t}")


def read_gguf(path):
    """(metadata dict, tensor summary). Multi-part GGUFs (-00001-of-0000N) are read across all parts."""
    paths = [path]
    m = re.search(r"-(\d{5})-of-(\d{5})\.gguf$", path)
    if m:
        n = int(m.group(2))
        paths = [re.sub(r"-\d{5}-of-", f"-{i:05d}-of-", path) for i in range(1, n + 1)]
    meta, tensors = {}, {}
    for p in paths:
        with open(p, "rb") as f:
            r = _R(f)
            if f.read(4) != b"GGUF":
                raise ValueError(f"{p}: not a GGUF file")
            r.n("<I")
            nt, nkv = r.n("<Q"), r.n("<Q")
            for _ in range(nkv):
                k = r.s()
                meta.setdefault(k, r.val(r.n("<I")))
            infos = []
            for _ in range(nt):
                name = r.s()
                dims = [r.n("<Q") for _ in range(r.n("<I"))]
                infos.append((name, dims, r.n("<I"), r.n("<Q")))
            align = meta.get("general.alignment", 32)
            data0 = (f.tell() + align - 1) // align * align
            end = os.path.getsize(p) - data0
            infos.sort(key=lambda x: x[3])
            for j, (name, dims, t, off) in enumerate(infos):
                nxt = infos[j + 1][3] if j + 1 < len(infos) else end
                tensors[name] = (t, dims, nxt - off)
    summary = _summarise(tensors, type_names=lambda t: GGML_TYPES.get(t, f"type{t}"), shards=len(paths))
    return meta, summary


def gguf_to_config(meta):
    """Map GGUF metadata onto the Hugging Face config keys profile.py understands."""
    a = meta.get("general.architecture", "")
    g = lambda k, d=None: meta.get(f"{a}.{k}", d)
    vocab = meta.get("tokenizer.ggml.tokens")
    cfg = {
        "model_type": a, "architectures": [a],
        "num_hidden_layers": g("block_count"), "hidden_size": g("embedding_length"),
        "intermediate_size": g("feed_forward_length"), "num_attention_heads": g("attention.head_count"),
        "num_key_value_heads": g("attention.head_count_kv"), "head_dim": g("attention.key_length"),
        "max_position_embeddings": g("context_length"), "rope_theta": g("rope.freq_base"),
        "vocab_size": g("vocab_size") or (vocab.get("_len") if isinstance(vocab, dict) else len(vocab or []) or None),
        "num_experts": g("expert_count"), "num_experts_per_tok": g("expert_used_count"),
        "moe_intermediate_size": g("expert_feed_forward_length"), "n_shared_experts": g("expert_shared_count"),
        "sliding_window": g("attention.sliding_window"), "rms_norm_eps": g("attention.layer_norm_rms_epsilon"),
        "first_k_dense_replace": g("leading_dense_block_count"), "kv_lora_rank": g("attention.kv_lora_rank"),
        "q_lora_rank": g("attention.q_lora_rank"), "num_nextn_predict_layers": g("nextn_predict_layers"),
    }
    fai = g("full_attention_interval")
    if fai and cfg["num_hidden_layers"]:
        cfg["layer_types"] = ["full_attention" if (i + 1) % fai == 0 else "linear_attention" for i in range(cfg["num_hidden_layers"])]
    if isinstance(g("attention.head_count_kv"), list):   # per-layer KV heads: 0 marks a recurrent layer
        cfg["num_key_value_heads"] = max(g("attention.head_count_kv"))
        cfg["layer_types"] = ["full_attention" if h else "linear_attention" for h in g("attention.head_count_kv")]
    if g("ssm.state_size"):
        cfg["ssm"] = {"state_size": g("ssm.state_size"), "conv_kernel": g("ssm.conv_kernel"), "inner_size": g("ssm.inner_size"),
                      "group_count": g("ssm.group_count"), "time_step_rank": g("ssm.time_step_rank")}
    cfg["_gguf"] = {"name": meta.get("general.name"), "file_type": meta.get("general.file_type"),
                    "quantized_by": meta.get("general.quantized_by"), "size_label": meta.get("general.size_label")}
    return {k: v for k, v in cfg.items() if v is not None}
