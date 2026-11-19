#!/usr/bin/env python3
"""Start the project's loopback-only ComfyUI on an SSH host and forward it locally."""

import argparse
import json
import os
import shlex
import socket
import subprocess
import time
import urllib.request

REMOTE_SCRIPT = r"""
set -euo pipefail
root_dir="$HOME/.local/share/dieying-render"
session_name="dieying-render-$remote_port"
if tmux has-session -t "=$session_name" 2>/dev/null; then exit 0; fi
if [[ -z "$comfy_dir" ]]; then
    for candidate in "$HOME/ComfyUI" "$HOME/comfy-ui/ComfyUI"; do
        if [[ -f "$candidate/main.py" ]]; then comfy_dir="$candidate"; break; fi
    done
    if [[ -z "$comfy_dir" ]]; then comfy_dir=$(find "$HOME" -xdev -maxdepth 5 -type d -name ComfyUI -print -quit 2>/dev/null || true); fi
fi
if [[ -z "$python_bin" ]]; then
    for candidate in "$comfy_dir/.venv/bin/python" "$comfy_dir/venv/bin/python" "$HOME/anaconda3/envs/comfyui-flux/bin/python" "$HOME/miniconda3/envs/comfyui/bin/python"; do
        if [[ -x "$candidate" ]]; then python_bin="$candidate"; break; fi
    done
fi
[[ -f "$comfy_dir/main.py" && -x "$python_bin" ]] || { echo "Set DIEYING_REMOTE_COMFY_DIR and DIEYING_REMOTE_PYTHON to the existing installation" >&2; exit 1; }
python3 -c 'import socket,sys; s=socket.socket(); s.bind(("127.0.0.1",int(sys.argv[1]))); s.close()' "$remote_port"
mkdir -p "$root_dir"/{input,output,temp,user}
cd "$comfy_dir"
flags=(--listen 127.0.0.1 --port "$remote_port" --disable-all-custom-nodes --disable-api-nodes
       --input-directory "$root_dir/input" --output-directory "$root_dir/output" --temp-directory "$root_dir/temp"
       --user-directory "$root_dir/user" --database-url "sqlite:///$root_dir/project.db" --lowvram
       --disable-dynamic-vram --disable-pinned-memory --disable-async-offload --reserve-vram "$reserve_gib" --disable-smart-memory --cache-none)
printf -v launch 'cd %q && exec env OMP_NUM_THREADS=6 %q -u main.py ' "$comfy_dir" "$python_bin"
printf -v options '%q ' "${flags[@]}"
printf -v logfile '%q' "$root_dir/service.log"
tmux new-session -d -s "$session_name" "$launch$options >$logfile 2>&1"
"""


def healthy(url):
    try:
        with urllib.request.urlopen(url + "/system_stats", timeout=2) as r:
            data = json.load(r)
        return isinstance(data.get("system"), dict) and bool(data.get("devices"))
    except (OSError, ValueError):
        return False


def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument(
        "--host", default=os.environ.get("DIEYING_GPU_SSH", "Win4090"), help="SSH config alias"
    )
    p.add_argument(
        "--runtime", choices=["wsl", "linux"], default=os.environ.get("DIEYING_REMOTE_RUNTIME", "wsl")
    )
    p.add_argument("--port", type=int, default=int(os.environ.get("DIEYING_COMFY_PORT", "18188")))
    p.add_argument(
        "--reserve-gib",
        type=float,
        default=None,
        help="VRAM to reserve for co-tenants. Default measures active GPU users.",
    )
    a = p.parse_args()
    if not 1024 <= a.port <= 65535 or not a.host or a.host.startswith("-"):
        p.error("Provide a valid SSH alias and private service port")
    url = f"http://127.0.0.1:{a.port}"
    ssh = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=6", "-T", a.host]
    reserve = a.reserve_gib
    if reserve is None:
        raw = subprocess.check_output(
            ssh
            + ["nvidia-smi", "--query-gpu=memory.used,memory.total", "--format=csv,noheader,nounits"],
            text=True,
        )
        used, total = map(float, raw.splitlines()[0].split(","))
        reserve = min((total - 1536) / 1024, max(1.5, round(used / 1024 + 0.8, 1)))
    if not 0 < reserve < 128:
        p.error("Invalid VRAM reserve")
    vals = {
        "remote_port": a.port,
        "reserve_gib": reserve,
        "comfy_dir": os.environ.get("DIEYING_REMOTE_COMFY_DIR", ""),
        "python_bin": os.environ.get("DIEYING_REMOTE_PYTHON", ""),
    }
    script = "\n".join(k + "=" + shlex.quote(str(v)) for k, v in vals.items()) + "\n" + REMOTE_SCRIPT
    subprocess.run(
        ssh + (["wsl", "-e"] if a.runtime == "wsl" else []) + ["bash", "-s"],
        input=script,
        text=True,
        check=True,
    )
    try:
        with socket.create_connection(("127.0.0.1", a.port), timeout=1):
            pass
    except OSError:
        subprocess.run(
            [
                "ssh",
                "-fNT",
                "-o",
                "BatchMode=yes",
                "-o",
                "ExitOnForwardFailure=yes",
                "-o",
                "ServerAliveInterval=30",
                "-L",
                f"127.0.0.1:{a.port}:127.0.0.1:{a.port}",
                a.host,
            ],
            check=True,
        )
    deadline = time.monotonic() + 60
    while not healthy(url):
        if time.monotonic() > deadline:
            raise SystemExit(
                "Service not ready. Inspect ~/.local/share/dieying-render/service.log on the GPU host."
            )
        time.sleep(1)
    print(json.dumps({"endpoint": url, "available": True, "service": f"dieying-render-{a.port}"}))


if __name__ == "__main__":
    main()
