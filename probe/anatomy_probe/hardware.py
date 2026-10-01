"""What machine is serving: GPU, memory, CPU. Static facts once, live readings on demand."""
import os
import platform
import shutil
import socket
import subprocess


def _sh(cmd, timeout=4):
    try:
        return subprocess.run(cmd, capture_output=True, text=True, timeout=timeout).stdout.strip()
    except Exception:
        return ""


def _num(x):
    try:
        return float(x)
    except (TypeError, ValueError):
        return None


def _meminfo():
    out = {}
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                k, v = line.split(":", 1)
                out[k] = int(v.split()[0]) * 1024
    except OSError:
        pass
    return out


def gpus():
    if not shutil.which("nvidia-smi"):
        return []
    q = _sh(["nvidia-smi", "--query-gpu=name,memory.total,memory.used,power.draw,power.limit,temperature.gpu,utilization.gpu,clocks.sm",
             "--format=csv,noheader,nounits"])
    out = []
    for line in q.splitlines():
        f = [x.strip() for x in line.split(",")]
        if len(f) < 8:
            continue
        mt = _num(f[1])
        out.append({"name": f[0], "mem_total_bytes": mt * 1048576 if mt else None, "mem_used_bytes": _num(f[2]) * 1048576 if _num(f[2]) else None,
                    "power_w": _num(f[3]), "power_limit_w": _num(f[4]), "temp_c": _num(f[5]), "util_pct": _num(f[6]), "sm_mhz": _num(f[7]),
                    "unified": mt is None})   # GB10 / Jetson report [N/A]: the GPU uses system memory
    return out


def cpu():
    models, n = [], os.cpu_count()
    lscpu = _sh(["lscpu"])
    for line in lscpu.splitlines():
        if line.startswith("Model name:"):
            models.append(line.split(":", 1)[1].strip())
    if not models:
        models = [platform.processor() or platform.machine()]
    return {"models": models, "cores": n, "arch": platform.machine()}


def static(name=None):
    g = gpus()
    m = _meminfo()
    return {"name": name, "hostname": socket.gethostname(), "cpu": cpu(), "gpus": [{k: v for k, v in x.items() if k in ("name", "mem_total_bytes", "unified", "power_limit_w")} for x in g],
            "mem_total_bytes": m.get("MemTotal"), "unified": bool(g and g[0]["unified"])}


def live():
    """Shape kept compatible with the original page's status feed: {host: {gpu, mem}}."""
    g = gpus()
    m = _meminfo()
    gpu = g[0] if g else {}
    total, avail = m.get("MemTotal"), m.get("MemAvailable")
    return {"gpu": {"power_w": gpu.get("power_w"), "temp_c": gpu.get("temp_c"), "util_pct": gpu.get("util_pct"), "sm_mhz": gpu.get("sm_mhz")},
            "mem": {"total": total, "available": avail, "used": (total - avail) if total and avail else None}}
