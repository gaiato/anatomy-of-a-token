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
    """{MemTotal, MemAvailable} in bytes: /proc/meminfo on Linux, sysctl/vm_stat on macOS, GlobalMemoryStatusEx on Windows."""
    out = {}
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                k, v = line.split(":", 1)
                out[k] = int(v.split()[0]) * 1024
        return out
    except OSError:
        pass
    sysname = platform.system()
    if sysname == "Darwin":
        total = _num(_sh(["sysctl", "-n", "hw.memsize"]))
        if total:
            out["MemTotal"] = int(total)
            vm, page = _sh(["vm_stat"]), 16384
            for line in vm.splitlines():
                if "page size of" in line:
                    page = int(_num(line.split("page size of")[1].split()[0]) or page)
            free = sum(int(_num(l.split(":")[1].strip(" .")) or 0) for l in vm.splitlines()
                       if l.startswith(("Pages free", "Pages inactive", "Pages speculative", "Pages purgeable")))
            if free:
                out["MemAvailable"] = free * page
    elif sysname == "Windows":
        try:
            import ctypes

            class MS(ctypes.Structure):
                _fields_ = [("len", ctypes.c_ulong), ("load", ctypes.c_ulong), ("total", ctypes.c_ulonglong), ("avail", ctypes.c_ulonglong),
                            ("tp", ctypes.c_ulonglong), ("ap", ctypes.c_ulonglong), ("tv", ctypes.c_ulonglong), ("av", ctypes.c_ulonglong), ("ae", ctypes.c_ulonglong)]
            m = MS(); m.len = ctypes.sizeof(MS)
            if ctypes.windll.kernel32.GlobalMemoryStatusEx(ctypes.byref(m)):
                out["MemTotal"], out["MemAvailable"] = m.total, m.avail
        except Exception:
            pass
    return out


def _apple_gpu():
    """Apple silicon: the GPU is part of the chip and shares its memory (Metal; llama.cpp offloads to it by default)."""
    if platform.system() != "Darwin" or platform.machine() != "arm64":
        return []
    chip = _sh(["sysctl", "-n", "machdep.cpu.brand_string"]) or "Apple silicon"
    return [{"name": f"{chip} GPU", "mem_total_bytes": None, "mem_used_bytes": None, "power_w": None, "power_limit_w": None,
             "temp_c": None, "util_pct": None, "sm_mhz": None, "unified": True}]


def gpus():
    if not shutil.which("nvidia-smi"):
        return _apple_gpu()
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
    if not models and platform.system() == "Darwin":
        models = [x for x in [_sh(["sysctl", "-n", "machdep.cpu.brand_string"])] if x]
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
