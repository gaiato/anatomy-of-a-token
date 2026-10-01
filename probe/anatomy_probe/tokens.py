"""Turn raw tokenizer pieces into readable text without losing what they really are.

Byte-level BPE (GPT-2, Qwen, Llama 3) writes bytes as printable stand-ins: 'Ġ' is a space and 'Ċ' a
newline. SentencePiece (Llama 2, Gemma, Mistral) uses '▁' for a space and <0x0A> for raw bytes.
"""
import re

_SPECIAL = re.compile(r"^(<\|[^|<>]{1,40}\|>|</?[A-Za-z_][\w:-]{0,30}>|\[/?[A-Z_]{2,20}\])$")
_BYTE = re.compile(r"^<0x([0-9A-Fa-f]{2})>$")


def _bytes_to_unicode():
    bs = list(range(ord("!"), ord("~") + 1)) + list(range(ord("¡"), ord("¬") + 1)) + list(range(ord("®"), ord("ÿ") + 1))
    cs = bs[:]
    n = 0
    for b in range(256):
        if b not in bs:
            bs.append(b)
            cs.append(256 + n)
            n += 1
    return {chr(c): b for b, c in zip(bs, cs)}


_U2B = _bytes_to_unicode()


def _is_bytelevel(strs):
    return any(s and ("Ġ" in s or "Ċ" in s) for s in strs)


def _decode_bytelevel(s):
    try:
        return bytes(_U2B[c] for c in s).decode("utf-8", "replace")
    except KeyError:
        return s


def _decode_sp(s):
    m = _BYTE.match(s)
    if m:
        b = int(m.group(1), 16)
        return chr(b) if b < 128 else "�"
    return s.replace("▁", " ")


def pieces(ids, strs, special_ids=None):
    """[{id, text, special}] for a tokenised prompt. `text` is what the piece means, spaces and newlines included."""
    strs = list(strs or []) + [None] * max(0, len(ids) - len(strs or []))
    special_ids = set(special_ids or [])
    bl = _is_bytelevel([s for s in strs if s])
    out = []
    for i, raw in zip(ids, strs):
        if raw is None:
            out.append({"id": i, "text": "", "special": i in special_ids})
            continue
        sp = i in special_ids or bool(_SPECIAL.match(raw))
        text = raw if sp else (_decode_bytelevel(raw) if bl else _decode_sp(raw))
        out.append({"id": i, "text": text, "special": sp})
    return out


def from_bytes(b, fallback):
    """Text of a generated token from the logprobs `bytes` field (exact), else its string."""
    if b:
        try:
            return bytes(b).decode("utf-8")
        except (UnicodeDecodeError, ValueError, TypeError):
            return bytes(b).decode("utf-8", "replace") if isinstance(b, list) else (fallback or "")
    return fallback or ""
