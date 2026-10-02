"""anatomy-probe: serve the profile API, or write profiles and traces to disk.

  python3 -m anatomy_probe serve    --engine http://127.0.0.1:8000 [--port 1239]
  python3 -m anatomy_probe profile  --config path/to/config.json [--weights DIR|FILE.gguf]   (offline, no server)
  python3 -m anatomy_probe snapshot --engine URL --out DIR [--prompt TEXT]...                 (demo-mode data)
"""
import argparse
import json
import os
import sys

from . import profile, server, weights

DEFAULT_PROMPTS = ["Why does ice float on water?"]


def _common(p):
    p.add_argument("--engine", action="append", help="OpenAI-compatible server (vLLM or llama.cpp); repeat for fallbacks, tried in order (default http://127.0.0.1:8000)")
    p.add_argument("--api-key", default=os.environ.get("ANATOMY_API_KEY"), help="key for the engine; prefer the ANATOMY_API_KEY environment variable, which stays out of ps")
    p.add_argument("--search", action="append", default=[], help="directory that holds model folders (repeatable)")
    p.add_argument("--model-map", action="append", default=[], metavar="NAME=PATH", help="served name or repo id -> checkpoint path")
    p.add_argument("--hardware-name", default=os.environ.get("ANATOMY_HARDWARE_NAME"), help="what to call this machine, e.g. 'ASUS Ascent GX10'")
    p.add_argument("--max-new-tokens", type=int, default=48)


def _probe(a):
    mm = dict(x.split("=", 1) for x in a.model_map)
    engines = a.engine or os.environ.get("ANATOMY_ENGINE", "http://127.0.0.1:8000").split(",")
    return server.Probe(engines, a.api_key, a.search, mm, a.hardware_name, a.max_new_tokens)


def main(argv=None):
    ap = argparse.ArgumentParser(prog="anatomy_probe", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    s = sub.add_parser("serve")
    _common(s)
    s.add_argument("--bind", default="0.0.0.0")
    s.add_argument("--port", type=int, default=1239)
    s.add_argument("--allow-origin", help="CORS origin for the page, when it is not served from the same origin")
    s.add_argument("--web", help="also serve the page from this directory (the repo's web/), so one process is all you need")
    o = sub.add_parser("profile")
    o.add_argument("--config", required=True)
    o.add_argument("--weights", help="checkpoint directory (safetensors) or .gguf file")
    n = sub.add_parser("snapshot")
    _common(n)
    n.add_argument("--out", required=True)
    n.add_argument("--prompt", action="append")
    n.add_argument("--max-tokens", type=int, default=32)
    a = ap.parse_args(argv)

    if a.cmd == "serve":
        server.serve(_probe(a), a.bind, a.port, a.allow_origin, a.web)
    elif a.cmd == "profile":
        if a.config.endswith(".gguf"):
            meta, wsum = weights.read_gguf(a.config)
            cfg, src = weights.gguf_to_config(meta), "gguf"
        else:
            cfg = json.load(open(a.config))
            wsum, src = (weights.scan_safetensors(a.weights), "safetensors") if a.weights else (None, None)
        json.dump(profile.build(cfg, wsum, src), sys.stdout, indent=1)
        print()
    elif a.cmd == "snapshot":
        p = _probe(a)
        os.makedirs(a.out, exist_ok=True)
        prof = json.loads(json.dumps(p.profile()))
        prof.get("hardware", {}).pop("hostname", None)   # snapshots are meant to be shared
        with open(os.path.join(a.out, "profile.json"), "w") as f:
            json.dump(prof, f, indent=1)
        traces = []
        for q in a.prompt or DEFAULT_PROMPTS:
            p._last_trace.clear()
            code, t = p.trace({"prompt": q, "max_tokens": a.max_tokens}, "snapshot")
            if code != 200:
                sys.exit(f"trace failed: {t}")
            traces.append(t)
        with open(os.path.join(a.out, "traces.json"), "w") as f:
            json.dump(traces, f, indent=1, ensure_ascii=False)
        print(f"wrote profile.json and {len(traces)} trace(s) to {a.out}")


if __name__ == "__main__":
    main()
