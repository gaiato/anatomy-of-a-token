"""Read the serving engine's launch flags from its process command line (same host or container with --pid=host).

Only an allowlist of scheduling and precision flags is kept; keys, paths and anything else are dropped.
"""
import json
import os

VLLM = {"--max-num-seqs": ("max_seqs", int), "--max-num-batched-tokens": ("batch_tokens", int), "--gpu-memory-utilization": ("gmu", float),
        "--kv-cache-dtype": ("kv_dtype", str), "--mamba-ssm-cache-dtype": ("state_dtype", str), "--tensor-parallel-size": ("tp", int),
        "--max-model-len": ("max_len", int), "--quantization": ("quantization", str), "--reasoning-parser": ("reasoning_parser", str),
        "--tool-call-parser": ("tool_parser", str), "--speculative-config": ("spec", json.loads), "--enable-chunked-prefill": ("chunked_prefill", bool),
        "--enable-prefix-caching": ("prefix_caching", bool), "--block-size": ("block_size", int)}
LLAMA = {"-c": ("max_len", int), "--ctx-size": ("max_len", int), "-np": ("max_seqs", int), "--parallel": ("max_seqs", int),
         "-b": ("batch_tokens", int), "--batch-size": ("batch_tokens", int), "-ngl": ("gpu_layers", int), "--n-gpu-layers": ("gpu_layers", int),
         "-fa": ("flash_attn", str), "--flash-attn": ("flash_attn", str), "--draft-max": ("draft_max", int), "-ctk": ("kv_dtype", str),
         "--cache-type-k": ("kv_dtype", str), "--jinja": ("jinja", bool)}
SPEC_KEEP = ("method", "num_speculative_tokens", "model")


def _procs():
    for pid in os.listdir("/proc"):
        if pid.isdigit():
            try:
                with open(f"/proc/{pid}/cmdline", "rb") as f:
                    yield [a.decode("utf-8", "replace") for a in f.read().split(b"\0") if a]
            except OSError:
                continue


def flags(port):
    """{engine, ...allowlisted flags} for the vllm or llama-server process serving `port`, or {}."""
    for argv in _procs():
        joined = " ".join(argv[:4])
        if "vllm" in joined and "serve" in argv:
            table, kind = VLLM, "vllm"
        elif any(os.path.basename(a).startswith("llama-server") for a in argv[:2]):
            table, kind = LLAMA, "llamacpp"
        else:
            continue
        p = _port(argv)
        if p is not None and port is not None and p != port:
            continue
        out = {"engine": kind}
        i = 0
        while i < len(argv):
            a, val = argv[i], None
            if "=" in a and a.startswith("--"):
                a, val = a.split("=", 1)
            if a in table:
                key, conv = table[a]
                if conv is bool:
                    out[key] = True
                else:
                    if val is None and i + 1 < len(argv):
                        i += 1
                        val = argv[i]
                    try:
                        out[key] = conv(val)
                    except (TypeError, ValueError):
                        pass
            i += 1
        if isinstance(out.get("spec"), dict):
            out["spec"] = {k: v for k, v in out["spec"].items() if k in SPEC_KEEP}
        return out
    return {}


def _port(argv):
    for i, a in enumerate(argv):
        if a in ("--port",) and i + 1 < len(argv):
            try:
                return int(argv[i + 1])
            except ValueError:
                return None
        if a.startswith("--port="):
            try:
                return int(a.split("=", 1)[1])
            except ValueError:
                return None
    return None
