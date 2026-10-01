"""Talk to the inference server: vLLM or llama.cpp, both OpenAI-compatible.

Only what the page needs: which model is served, its Prometheus metrics, the chat-templated
token IDs of a prompt, and a short streamed completion with top-k log-probabilities.
"""
import json
import math
import time
import urllib.error
import urllib.request

from . import tokens


class EngineError(Exception):
    pass


def _req(url, body=None, timeout=10, headers=None):
    data = None if body is None else json.dumps(body).encode()
    h = {"content-type": "application/json"} if body is not None else {}
    h.update(headers or {})
    return urllib.request.Request(url, data=data, headers=h, method="POST" if body is not None else "GET")


class Engine:
    def __init__(self, base_url, api_key=None):
        self.base = base_url.rstrip("/")
        if self.base.endswith("/v1"):
            self.base = self.base[:-3]
        self.headers = {"authorization": f"Bearer {api_key}"} if api_key else {}
        self._kind = None
        self._kind_at = 0

    # ── plumbing ──
    def get_json(self, path, timeout=5):
        with urllib.request.urlopen(_req(self.base + path, headers=self.headers), timeout=timeout) as r:
            return json.loads(r.read())

    def get_text(self, path, timeout=5):
        with urllib.request.urlopen(_req(self.base + path, headers=self.headers), timeout=timeout) as r:
            return r.read().decode("utf-8", "replace")

    def post_json(self, path, body, timeout=30):
        try:
            with urllib.request.urlopen(_req(self.base + path, body, headers=self.headers), timeout=timeout) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            raise EngineError(f"{path}: HTTP {e.code} {e.read()[:300]!r}") from None

    # ── identity ──
    def kind(self):
        """'vllm', 'llamacpp' or 'openai' (anything else that speaks /v1). Cached for a minute."""
        if self._kind and time.time() - self._kind_at < 60:
            return self._kind
        k = "openai"
        try:
            v = self.get_json("/version", 3)
            if "version" in v:
                k = "vllm"
        except Exception:
            try:
                p = self.get_json("/props", 3)
                if "default_generation_settings" in p or "total_slots" in p:
                    k = "llamacpp"
            except Exception:
                pass
        self._kind, self._kind_at = k, time.time()
        return k

    def version(self):
        try:
            if self.kind() == "vllm":
                return self.get_json("/version", 3).get("version")
            if self.kind() == "llamacpp":
                p = self.get_json("/props", 3)
                return p.get("build_info") or p.get("version")
        except Exception:
            return None

    def model(self):
        """The first served model: {id, root, max_model_len}. Raises EngineError when nothing answers."""
        try:
            d = self.get_json("/v1/models", 5)
        except Exception as e:
            raise EngineError(f"no model answering at {self.base}: {e}") from None
        if not d.get("data"):
            raise EngineError("server lists no models")
        m = d["data"][0]
        return {"id": m["id"], "root": m.get("root") or m["id"], "max_model_len": m.get("max_model_len")}

    def props(self):
        """llama.cpp's /props (model path, context, slots); {} elsewhere."""
        if self.kind() != "llamacpp":
            return {}
        try:
            return self.get_json("/props", 3)
        except Exception:
            return {}

    def metrics(self):
        return self.get_text("/metrics", 5)

    # ── a traced request ──
    def tokenize_chat(self, model, messages, think):
        """Token IDs and readable pieces of the chat-templated prompt, exactly as the model sees it."""
        k = self.kind()
        if k == "vllm":
            d = self.post_json("/tokenize", {"model": model, "messages": messages, "add_generation_prompt": True,
                                             "return_token_strs": True, "chat_template_kwargs": {"enable_thinking": think}})
            return tokens.pieces(d["tokens"], d.get("token_strs") or [], d.get("special_ids"))
        if k == "llamacpp":
            t = self.post_json("/apply-template", {"messages": messages, "chat_template_kwargs": {"enable_thinking": think}})
            d = self.post_json("/tokenize", {"content": t["prompt"], "add_special": True, "parse_special": True, "with_pieces": True})
            toks = d["tokens"]
            ids = [x["id"] if isinstance(x, dict) else x for x in toks]
            strs = [x.get("piece") if isinstance(x, dict) else None for x in toks]
            return tokens.pieces(ids, strs)
        return None   # a plain OpenAI-compatible server has no tokenizer endpoint

    def count_raw(self, model, text):
        """How many tokens the text alone takes, without the chat template's role markers."""
        try:
            if self.kind() == "vllm":
                return self.post_json("/tokenize", {"model": model, "prompt": text, "add_special_tokens": False})["count"]
            if self.kind() == "llamacpp":
                return len(self.post_json("/tokenize", {"content": text, "add_special": False})["tokens"])
        except (EngineError, KeyError):
            return None
        return None

    def stream_chat(self, model, messages, think, max_tokens, temperature, top_k=5, timeout=120):
        """Stream one completion. Each SSE chunk is one engine step; its tokens arrive together.

        Returns {steps: [{t_ms, tokens: [{text, p, top: [[text, p], ...]}]}], ttft_ms, total_ms, finish, usage}."""
        body = {"model": model, "messages": messages, "max_tokens": max_tokens, "temperature": temperature,
                "logprobs": True, "top_logprobs": top_k, "stream": True, "stream_options": {"include_usage": True},
                "chat_template_kwargs": {"enable_thinking": think}}
        t0 = time.monotonic()
        steps, finish, usage = [], None, None
        try:
            resp = urllib.request.urlopen(_req(self.base + "/v1/chat/completions", body, headers=self.headers), timeout=timeout)
        except urllib.error.HTTPError as e:
            raise EngineError(f"chat: HTTP {e.code} {e.read()[:300]!r}") from None
        with resp:
            for raw in resp:
                line = raw.decode("utf-8", "replace").strip()
                if not line.startswith("data:"):
                    continue
                payload = line[5:].strip()
                if payload == "[DONE]":
                    break
                try:
                    ev = json.loads(payload)
                except ValueError:
                    continue
                if ev.get("usage"):
                    usage = ev["usage"]
                for ch in ev.get("choices") or []:
                    finish = ch.get("finish_reason") or finish
                    lp = (ch.get("logprobs") or {}).get("content") or []
                    if not lp:
                        continue
                    toks = [{"text": tokens.from_bytes(x.get("bytes"), x.get("token")), "p": _p(x.get("logprob")),
                             "top": [[tokens.from_bytes(y.get("bytes"), y.get("token")), _p(y.get("logprob"))] for y in x.get("top_logprobs") or []]}
                            for x in lp]
                    steps.append({"t_ms": round((time.monotonic() - t0) * 1000, 1), "tokens": toks})
        total = round((time.monotonic() - t0) * 1000, 1)
        return {"steps": steps, "ttft_ms": steps[0]["t_ms"] if steps else None, "total_ms": total, "finish": finish, "usage": usage}


def _p(logprob):
    if logprob is None:
        return None
    try:
        return round(math.exp(max(-80.0, float(logprob))), 5)
    except (TypeError, ValueError):
        return None
