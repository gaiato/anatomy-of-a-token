"""The probe's HTTP API. Read-only except /api/trace, which runs one short, capped completion.

  GET  /api/profile   the served model, normalised (rebuilt when the served model changes)
  GET  /api/status    {phase, active, host: {gpu, mem}}: live machine readings
  GET  /api/metrics   the engine's Prometheus text, passed through
  POST /api/trace     {prompt, think?, max_tokens?, temperature?} -> real tokens, steps and top-k probabilities
  GET  /healthz

Prompts and replies are never logged or stored: they exist only for the length of the request.
"""
import hashlib
import json
import os
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

import urllib.parse
from urllib.parse import urlparse

from . import hardware, launch, profile, weights
from .engine import Engine, EngineError


class Probe:
    def __init__(self, engine_url, api_key=None, search=(), model_map=None, hardware_name=None,
                 max_new_tokens=48, max_prompt_chars=2000, cache_dir=None):
        urls = [engine_url] if isinstance(engine_url, str) else list(engine_url)
        self.engines = [Engine(u, api_key) for u in urls]   # tried in order: the first that lists a model is the one we describe
        self.engine = self.engines[0]
        self.search, self.model_map = list(search), dict(model_map or {})
        self.hw_name, self.max_new, self.max_prompt = hardware_name, max_new_tokens, max_prompt_chars
        self.cache_dir = cache_dir or os.path.expanduser("~/.cache/anatomy-probe")
        self._prof, self._prof_key, self._prof_lock = None, None, threading.Lock()
        self._served, self._served_at = None, 0
        self._trace_lock = threading.Lock()
        self._last_trace = {}
        self._hw = None

    # ── profile ──
    def served(self):
        if self._served is None or time.time() - self._served_at > 5:
            err = None
            for e in self.engines:
                try:
                    self._served, self._served_at, self.engine = e.model(), time.time(), e
                    break
                except EngineError as x:
                    err = x
            else:
                self._served = None
                raise err
        return self._served

    def hardware(self):
        if self._hw is None:
            self._hw = hardware.static(self.hw_name)
        return self._hw

    def profile(self):
        m = self.served()
        key = (self.engine.base, m["id"], m["root"])
        with self._prof_lock:
            if self._prof and self._prof_key == key:
                return self._prof
            self._prof = self._build(m)
            self._prof_key = key
            return self._prof

    def _build(self, m):
        kind = self.engine.kind()
        props = self.engine.props()
        root = props.get("model_path") or m["root"]
        path = profile.find_model_dir(root, m["id"], self.search, self.model_map)
        cfg, wsum, wsrc = None, None, None
        if path and os.path.isfile(path) and path.endswith(".gguf"):
            meta, wsum = weights.read_gguf(path)
            cfg, wsrc = weights.gguf_to_config(meta), "gguf"
        elif path and os.path.isdir(path):
            with open(os.path.join(path, "config.json")) as f:
                cfg = json.load(f)
            wsum, wsrc = self._cached_scan(path), "safetensors"
        try:
            metrics = self.engine.metrics()
        except Exception:
            metrics = None
        info = {"engine": kind, "version": self.engine.version(), "served_name": m["id"], "repo": m["root"],
                "max_model_len": m.get("max_model_len") or (props.get("default_generation_settings") or {}).get("n_ctx")}
        if props.get("total_slots"):
            info["slots"] = props["total_slots"]
        try:
            fl = launch.flags(urlparse(self.engine.base).port)
        except Exception:
            fl = {}
        if fl:
            info["launch"] = fl
        if not cfg:
            return {"schema": profile.SCHEMA, "error": f"checkpoint not found on this host for {m['root']!r}; pass --model-map or --search",
                    "runtime": info, "hardware": self.hardware()}
        p = profile.build(cfg, wsum, wsrc, metrics, info, self.hardware())
        p["model"]["id"], p["model"]["repo"], p["model"]["path_kind"] = m["id"], m["root"], wsrc
        p["model"]["name"] = os.path.basename(m["root"].rstrip("/")) if "/snapshots/" in str(path) or not path else os.path.basename(str(path).rstrip("/"))
        return p

    def _cached_scan(self, d):
        idx = os.path.join(d, "model.safetensors.index.json")
        stamp = os.path.getmtime(idx) if os.path.exists(idx) else os.path.getmtime(d)
        key = os.path.join(self.cache_dir, hashlib.sha1(f"{weights.SCAN_VERSION}|{os.path.realpath(d)}|{stamp}".encode()).hexdigest()[:16] + ".json")
        try:
            with open(key) as f:
                return json.load(f)
        except (OSError, ValueError):
            pass
        s = weights.scan_safetensors(d)
        try:
            os.makedirs(self.cache_dir, exist_ok=True)
            with open(key, "w") as f:
                json.dump(s, f)
        except OSError:
            pass
        return s

    # ── status ──
    def status(self):
        out = {"ts": time.time(), "host": hardware.live()}
        try:
            m = self.served()
            out.update(phase="serving", active=m["id"])
        except EngineError as e:
            out.update(phase="down", active=None, error=str(e))
        return out

    # ── trace ──
    def trace(self, body, client):
        prompt = str(body.get("prompt") or "").strip()
        if not prompt:
            return 400, {"error": "empty prompt"}
        if len(prompt) > self.max_prompt:
            return 400, {"error": f"prompt longer than {self.max_prompt} characters"}
        now = time.time()
        if now - self._last_trace.get(client, 0) < 2:
            return 429, {"error": "one trace every 2 seconds"}
        if not self._trace_lock.acquire(blocking=False):
            return 429, {"error": "another trace is running"}
        try:
            self._last_trace[client] = now
            think = bool(body.get("think", False))
            max_new = max(1, min(int(body.get("max_tokens") or 24), self.max_new))
            temp = max(0.0, min(float(body.get("temperature") or 0), 2.0))
            m = self.served()
            msgs = [{"role": "user", "content": prompt}]
            toks = self.engine.tokenize_chat(m["id"], msgs, think)
            raw = self.engine.count_raw(m["id"], prompt)
            ans = self.engine.stream_chat(m["id"], msgs, think, max_new, temp)
            return 200, {"model": m["id"], "engine": self.engine.kind(), "ts": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                         "params": {"temperature": temp, "max_tokens": max_new, "think": think},
                         "prompt": {"text": prompt, "tokens": toks, "raw_count": raw}, "answer": ans}
        except EngineError as e:
            return 502, {"error": str(e)}
        finally:
            self._trace_lock.release()


MIME = {".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json",
        ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon", ".woff2": "font/woff2", ".txt": "text/plain", ".md": "text/plain"}


def make_handler(probe, allow_origin=None, web_root=None):
    web_root = os.path.realpath(web_root) if web_root else None

    class H(BaseHTTPRequestHandler):
        server_version = "anatomy-probe"

        def log_message(self, *a):   # no access log: paths are harmless, but keep the box quiet
            pass

        def _send(self, code, body, ctype="application/json"):
            data = body if isinstance(body, bytes) else (json.dumps(body).encode() if ctype == "application/json" else body.encode())
            self.send_response(code)
            self.send_header("content-type", ctype + ("; charset=utf-8" if "json" in ctype or "text" in ctype else ""))
            self.send_header("cache-control", "no-store")
            self.send_header("content-length", str(len(data)))
            if allow_origin:
                self.send_header("access-control-allow-origin", allow_origin)
                self.send_header("access-control-allow-headers", "content-type")
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self):
            self._send(204, b"", "text/plain")

        def _static(self, p):
            rel = urllib.parse.unquote(p).lstrip("/") or "index.html"
            if rel.endswith("/"):
                rel += "index.html"
            full = os.path.realpath(os.path.join(web_root, rel))
            if not full.startswith(web_root + os.sep) or not os.path.isfile(full):
                return self._send(404, {"error": "not found"})
            with open(full, "rb") as f:
                data = f.read()
            self.send_response(200)
            self.send_header("content-type", MIME.get(os.path.splitext(full)[1], "application/octet-stream"))
            self.send_header("cache-control", "no-cache")
            self.send_header("content-length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            p = self.path.split("?", 1)[0]
            if web_root and not p.startswith("/api/") and p != "/healthz":
                return self._static(p)
            try:
                if p == "/healthz":
                    return self._send(200, {"ok": True})
                if p == "/api/profile":
                    return self._send(200, probe.profile())
                if p == "/api/status":
                    return self._send(200, probe.status())
                if p == "/api/metrics":
                    probe.served()
                    return self._send(200, probe.engine.metrics(), "text/plain")
            except EngineError as e:
                return self._send(502, {"error": str(e)})
            except Exception as e:   # a broken checkpoint dir should not take the probe down
                return self._send(500, {"error": f"{type(e).__name__}: {e}"})
            self._send(404, {"error": "not found"})

        def do_POST(self):
            if self.path.split("?", 1)[0] != "/api/trace":
                return self._send(404, {"error": "not found"})
            n = int(self.headers.get("content-length") or 0)
            if n > 16384:
                return self._send(413, {"error": "body too large"})
            try:
                body = json.loads(self.rfile.read(n) or b"{}")
            except ValueError:
                return self._send(400, {"error": "bad JSON"})
            client = self.headers.get("x-real-ip") or self.client_address[0]
            try:
                code, out = probe.trace(body, client)
            except Exception as e:
                code, out = 500, {"error": f"{type(e).__name__}: {e}"}
            self._send(code, out)
    return H


def serve(probe, bind="0.0.0.0", port=1239, allow_origin=None, web_root=None):
    httpd = ThreadingHTTPServer((bind, port), make_handler(probe, allow_origin, web_root))
    httpd.daemon_threads = True
    print(f"anatomy-probe on {bind}:{port} -> {', '.join(e.base for e in probe.engines)}" + (f", serving {web_root}" if web_root else ""), flush=True)
    httpd.serve_forever()
