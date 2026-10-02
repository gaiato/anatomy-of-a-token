"""Unit tests for the probe: python3 -m unittest discover -s probe/tests (from the repo root)."""
import json
import os
import struct
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from anatomy_probe import launch, profile, tokens, weights  # noqa: E402

FIX = os.path.join(os.path.dirname(__file__), "fixtures")
def load(n):
    with open(os.path.join(FIX, n)) as f:
        return json.load(f)


class Tokens(unittest.TestCase):
    def test_bytelevel(self):
        p = tokens.pieces([1, 2, 3, 4], ["<|im_start|>", "Ġwater", "Ċ", "?"])
        self.assertEqual([x["text"] for x in p], ["<|im_start|>", " water", "\n", "?"])
        self.assertEqual([x["special"] for x in p], [True, False, False, False])

    def test_sentencepiece(self):
        p = tokens.pieces([1, 2, 3], ["<s>", "▁water", "<0x0A>"])
        self.assertEqual([x["text"] for x in p], ["<s>", " water", "\n"])

    def test_from_bytes(self):
        self.assertEqual(tokens.from_bytes([32, 119], "x"), " w")
        self.assertEqual(tokens.from_bytes(None, "abc"), "abc")


class Profiles(unittest.TestCase):
    def test_flash_next_hybrid_moe(self):
        p = profile.build(load("flash-next-config.json"))
        m = p["model"]
        self.assertEqual(m["layers"], 48)
        self.assertEqual(m["layer_types"].count("attention"), 12)
        self.assertEqual(m["layer_types"][:4], ["linear", "linear", "linear", "attention"])
        self.assertEqual(m["ffn"]["moe"]["experts"], 512)
        self.assertEqual(m["ffn"]["moe"]["top_k"], 10)
        self.assertEqual(m["attention"]["kind"], "gqa")
        self.assertEqual(m["attention"]["sparse"]["budget"], 2048)
        self.assertEqual(m["linear"]["kind"], "gated_deltanet")
        self.assertEqual(m["extras"]["ple"]["layers"], [1])
        self.assertEqual(m["extras"]["hyper"]["streams"], 4)
        self.assertEqual(m["quant"]["by_part"]["experts"], "NVFP4")
        self.assertEqual(m["estimates"]["kv_bytes_per_token"], 12 * 2 * 2 * 256 * 2)   # BF16 when the engine does not say

    def test_dense_vl(self):
        m = profile.build(load("qwen3-vl-32b-config.json"))["model"]
        self.assertEqual(set(m["layer_types"]), {"attention"})
        self.assertIsNone(m["ffn"]["moe"])
        self.assertEqual(m["ffn_types"], ["dense"] * m["layers"])
        self.assertIsNotNone(m["vision"])

    def test_gemma_like_sliding(self):
        c = {"num_hidden_layers": 12, "hidden_size": 1024, "num_attention_heads": 8, "num_key_value_heads": 4, "vocab_size": 1000,
             "sliding_window": 512, "sliding_window_pattern": 6, "intermediate_size": 4096}
        m = profile.build(c)["model"]
        self.assertEqual(m["layer_types"], ["sliding"] * 5 + ["attention"] + ["sliding"] * 5 + ["attention"])
        self.assertEqual(m["attention"]["sliding_window"], 512)

    def test_deepseek_like_mla_moe(self):
        c = {"num_hidden_layers": 4, "hidden_size": 512, "num_attention_heads": 8, "num_key_value_heads": 8, "vocab_size": 1000,
             "kv_lora_rank": 128, "n_routed_experts": 64, "num_experts_per_tok": 6, "n_shared_experts": 2, "first_k_dense_replace": 1, "moe_intermediate_size": 256}
        m = profile.build(c)["model"]
        self.assertEqual(m["attention"]["kind"], "mla")
        self.assertEqual(m["ffn_types"], ["dense", "moe", "moe", "moe"])
        self.assertEqual(m["ffn"]["moe"]["shared"], 2)

    def test_runtime_from_metrics(self):
        prom = ('vllm:cache_config_info{block_size="16",cache_dtype="fp8",gpu_memory_utilization="0.9",kv_cache_size_tokens="1000",enable_prefix_caching="True"} 1\n'
                'vllm:spec_decode_num_accepted_tokens_per_pos_total{position="0"} 5\nvllm:spec_decode_num_accepted_tokens_per_pos_total{position="1"} 3\n')
        p = profile.build(load("flash-next-config.json"), metrics_text=prom)
        self.assertEqual(p["runtime"]["kv"]["block_size"], 16)
        self.assertEqual(p["runtime"]["spec"]["k"], 2)
        self.assertEqual(p["model"]["estimates"]["kv_bytes_per_token"], 12 * 2 * 2 * 256)


class Weights(unittest.TestCase):
    def _st(self, d, name, tensors):
        hdr, off = {}, 0
        for n, (dt, shape, nb) in tensors.items():
            hdr[n] = {"dtype": dt, "shape": shape, "data_offsets": [off, off + nb]}
            off += nb
        h = json.dumps(hdr).encode()
        with open(os.path.join(d, name), "wb") as f:
            f.write(struct.pack("<Q", len(h)) + h + b"\0" * off)

    def test_safetensors_parts_and_packing(self):
        with tempfile.TemporaryDirectory() as d:
            self._st(d, "model.safetensors", {
                "model.embed_tokens.weight": ("BF16", [100, 8], 1600),
                "model.layers.0.self_attn.q_proj.weight": ("BF16", [8, 8], 128),
                "model.layers.0.mlp.experts.0.up_proj.weight": ("U8", [16, 4], 64),            # NVFP4: two values per byte
                "model.layers.0.mlp.experts.0.up_proj.weight_scale": ("F8_E4M3", [16, 1], 16),
                "lm_head.weight": ("BF16", [100, 8], 1600)})
            s = weights.scan_safetensors(d)
            self.assertEqual(s["parts"]["embed"]["params"], 800)
            self.assertEqual(s["parts"]["experts"]["params"], 128)
            self.assertEqual(s["parts"]["head"]["params"], 800)
            self.assertEqual(s["total_bytes"], 1600 + 128 + 64 + 16 + 1600)

    def test_gguf(self):
        def s(x):
            b = x.encode()
            return struct.pack("<Q", len(b)) + b
        kv = [("general.architecture", 8, s("llama")), ("llama.block_count", 4, struct.pack("<I", 2)), ("llama.embedding_length", 4, struct.pack("<I", 64)),
              ("llama.attention.head_count", 4, struct.pack("<I", 4)), ("llama.attention.head_count_kv", 4, struct.pack("<I", 2)),
              ("llama.feed_forward_length", 4, struct.pack("<I", 128)), ("llama.vocab_size", 4, struct.pack("<I", 1000))]
        tens = [("token_embd.weight", [64, 1000], 1, 0), ("blk.0.attn_q.weight", [64, 64], 1, 128000), ("output.weight", [64, 1000], 1, 136192)]
        body = b"GGUF" + struct.pack("<I", 3) + struct.pack("<Q", len(tens)) + struct.pack("<Q", len(kv))
        for k, t, v in kv:
            body += s(k) + struct.pack("<I", t) + v
        for n, dims, t, off in tens:
            body += s(n) + struct.pack("<I", len(dims)) + b"".join(struct.pack("<Q", x) for x in dims) + struct.pack("<I", t) + struct.pack("<Q", off)
        body += b"\0" * ((32 - len(body) % 32) % 32) + b"\0" * (136192 + 128000)
        with tempfile.NamedTemporaryFile(suffix=".gguf", delete=False) as f:
            f.write(body)
        try:
            meta, summ = weights.read_gguf(f.name)
            cfg = weights.gguf_to_config(meta)
            self.assertEqual(cfg["num_hidden_layers"], 2)
            self.assertEqual(cfg["num_key_value_heads"], 2)
            self.assertEqual(summ["parts"]["embed"]["params"], 64000)
            self.assertEqual(summ["parts"]["attention"]["params"], 4096)
            m = profile.build(cfg, summ, "gguf")["model"]
            self.assertEqual(m["layers"], 2)
            self.assertEqual(m["attention"]["kind"], "gqa")
        finally:
            os.unlink(f.name)


class Launch(unittest.TestCase):
    def test_allowlist_drops_secrets(self):
        argv = ["/usr/bin/python3", "/usr/local/bin/vllm", "serve", "m", "--api-key", "SECRET", "--max-num-seqs", "4", "--port", "8000",
                "--speculative-config", '{"method":"mtp","num_speculative_tokens":3,"secret":"x"}', "--enable-chunked-prefill"]
        orig = launch._procs
        launch._procs = lambda: iter([("1", argv)])
        try:
            f = launch.flags(8000)
        finally:
            launch._procs = orig
        self.assertEqual(f["max_seqs"], 4)
        self.assertEqual(f["spec"], {"method": "mtp", "num_speculative_tokens": 3})
        self.assertTrue(f["chunked_prefill"])
        self.assertNotIn("SECRET", json.dumps(f))


if __name__ == "__main__":
    unittest.main()
