#!/usr/bin/env python3
"""Run one durable local media job. Output JSON is also saved as <output>.json."""

import argparse
import fcntl
import hashlib
import json
import mimetypes
import os
from pathlib import Path
import secrets
import subprocess
import sys
import tempfile
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid

from workflows import boogu_reference_size, motion, node, still

BASE = os.environ.get("DIEYING_COMFY_URL", "http://127.0.0.1:18188").rstrip("/")
TIMEOUT = int(os.environ.get("DIEYING_RENDER_TIMEOUT", "2400"))


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(",", ":")).encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def file_hash(path):
    with Path(path).open("rb") as f:
        return (
            hashlib.file_digest(f, "sha256").hexdigest()
            if hasattr(hashlib, "file_digest")
            else digest(f.read())
        )


def atomic(path, data):
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as f:
        f.write(data)
        f.flush()
        os.fsync(f.fileno())
    os.replace(f.name, path)


def write_json(path, value):
    atomic(path, json.dumps(value, indent=2, ensure_ascii=False).encode())


def http(path, body=None, headers=None):
    req = urllib.request.Request(BASE + path, body, headers or {})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.read()
    except urllib.error.HTTPError as e:
        raise RuntimeError(
            f"ComfyUI {path.split('?')[0]} returned {e.code}: {e.read().decode(errors='replace')[:1200]}"
        ) from e


def get(path):
    return json.loads(http(path))


def inspect(path):
    probe = subprocess.run(
        [
            "ffprobe",
            "-v",
            "error",
            "-count_frames",
            "-select_streams",
            "v:0",
            "-show_entries",
            "stream=codec_name,width,height,nb_read_frames,avg_frame_rate:format=duration",
            "-of",
            "json",
            str(path),
        ],
        check=True,
        capture_output=True,
    )
    res = json.loads(probe.stdout)
    s = res["streams"][0]
    return dict(
        width=s["width"],
        height=s["height"],
        codec=s["codec_name"],
        frames=int(s["nb_read_frames"]),
        frame_rate=s["avg_frame_rate"],
        duration=float(res["format"].get("duration") or 0),
    )


def upload(path):
    data = Path(path).read_bytes()
    suffix = Path(path).suffix.lower()
    if suffix not in {".png", ".jpg", ".jpeg", ".webp"}:
        raise ValueError("Authorized image input must be a PNG/JPEG/WebP file")
    name = digest(data) + suffix
    boundary = uuid.uuid4().hex
    fields = [
        f'--{boundary}\r\nContent-Disposition: form-data; name="image"; filename="{name}"\r\nContent-Type: {mimetypes.guess_type(name)[0]}\r\n\r\n'.encode(),
        data,
        f'\r\n--{boundary}\r\nContent-Disposition: form-data; name="subfolder"\r\n\r\ndieying\r\n--{boundary}\r\nContent-Disposition: form-data; name="overwrite"\r\n\r\ntrue\r\n--{boundary}--\r\n'.encode(),
    ]
    result = json.loads(
        http(
            "/upload/image",
            b"".join(fields),
            {"Content-Type": "multipart/form-data; boundary=" + boundary},
        )
    )
    return "/".join(filter(None, [result.get("subfolder"), result["name"]]))


class GpuMeter:
    """Windows driver samples total board usage, including co-tenants."""

    def __enter__(self):
        self.samples = []
        self.proc = None
        host = os.environ.get("DIEYING_GPU_SSH", "Win4090")
        if not host:
            return self
        try:
            self.proc = subprocess.Popen(
                [
                    "ssh",
                    "-T",
                    "-o",
                    "BatchMode=yes",
                    "-o",
                    "ConnectTimeout=3",
                    host,
                    "nvidia-smi",
                    "--query-gpu=memory.used,memory.free,utilization.gpu,power.draw",
                    "--format=csv,noheader,nounits",
                    "-l",
                    "2",
                ],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                text=True,
            )
        except OSError:
            return self

        def collect():
            for line in self.proc.stdout:
                try:
                    self.samples.append([float(x) for x in line.split(",")])
                except ValueError:
                    continue

        self.thread = threading.Thread(target=collect, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *_):
        if self.proc:
            self.proc.terminate()
            try:
                self.proc.wait(timeout=3)
            except subprocess.TimeoutExpired:
                self.proc.kill()
                self.proc.wait()
            self.thread.join(timeout=2)

    def result(self):
        s = self.samples
        if not s:
            return {"samples": 0}
        return {
            "samples": len(s),
            "scope": "whole GPU including other services; sampled every 2 seconds",
            "initial_used_mib": s[0][0],
            "peak_used_mib": max(row[0] for row in s),
            "min_free_mib": min(row[1] for row in s),
            "peak_utilization_pct": max(row[2] for row in s),
            "peak_power_w": max(row[3] for row in s),
        }


def run_graph(graph, model, output, journal, state, key, deadline):
    stage = state["stages"].get(key)
    if not stage:
        stage = {
            "id": str(uuid.uuid4()),
            "submitted_unix": time.time(),
            "model": model,
            "graph_sha256": digest(canonical(graph)),
        }
        state["stages"][key] = stage
        write_json(journal, state)
    if stage["graph_sha256"] != digest(canonical(graph)):
        raise RuntimeError("Saved job uses another workflow revision. Choose a new output.")
    job = stage["id"]
    prior = get("/history/" + job).get(job)
    if not prior:
        queue = get("/queue")
        existing = any(
            str(row[1]) == job for k in ("queue_running", "queue_pending") for row in queue.get(k, [])
        )
        if not existing:
            prior = get("/history/" + job).get(job)
        if not existing and not prior:
            if stage.get("accepted"):
                raise RuntimeError(
                    "Previously accepted job disappeared from server history. A new operation is required to retry it."
                )
            body = {"prompt": graph, "prompt_id": job, "client_id": job}
            response = json.loads(http("/prompt", canonical(body), {"Content-Type": "application/json"}))
            if response["prompt_id"] != job:
                raise RuntimeError("ComfyUI must support client-specified operation IDs")
        stage["accepted"] = True
        write_json(journal, state)
    while not prior:
        if time.monotonic() > deadline:
            raise TimeoutError(f"Timed out waiting for {job}; rerun this same job to resume.")
        time.sleep(1)
        try:
            prior = get("/history/" + job).get(job)
        except (urllib.error.URLError, TimeoutError, ConnectionError):
            continue
    status = prior.get("status", {})
    if status.get("status_str") != "success":
        errors = [evt for code, evt in status.get("messages", []) if code == "execution_error"]
        raise RuntimeError(
            f"{model}: "
            + str(
                [(e.get("node_type"), e.get("exception_message", "")[:400]) for e in errors]
                or status.get("status_str")
            )
        )
    slots = prior.get("outputs", {}).get("10", {})
    refs = [
        f
        for values in slots.values()
        if isinstance(values, list)
        for f in values
        if isinstance(f, dict) and f.get("filename") and f.get("type") == "output"
    ]
    if len(refs) != 1:
        raise RuntimeError(f"Expected one model output; received {len(refs)}")
    params = {k: refs[0][k] for k in ("filename", "subfolder", "type") if k in refs[0]}
    atomic(output, http("/view?" + urllib.parse.urlencode(params)))
    stamps = {k: v.get("timestamp") for k, v in status.get("messages", []) if v.get("timestamp")}
    start, end = stamps.get("execution_start"), stamps.get("execution_success")
    stage.update(
        execution_seconds=round((end - start) / 1000, 3) if start and end else None,
        queue_seconds=round(max(0, start / 1000 - stage["submitted_unix"]), 3) if start else None,
        result_sha256=file_hash(output),
    )
    write_json(journal, state)


def bounded(req, k, default, lo, hi):
    v = req.get(k, default)
    if isinstance(v, bool) or not isinstance(v, int) or not lo <= v <= hi:
        raise ValueError(f"{k} must be an integer between {lo} and {hi}")
    return v


def mask_compose(src, candidate, mask, output):
    orig = inspect(src)
    size = inspect(mask)
    w, h = orig["width"], orig["height"]
    if (w, h) != (size["width"], size["height"]):
        raise ValueError("Mask pixel dimensions must match the source")
    # GBR planes retain exact RGB values wherever the uploaded mask is black.
    vf = f"[0:v]format=gbrp[a];[1:v]scale={w}:{h}:flags=lanczos,format=gbrp[b];[2:v]format=gbrp[m];[a][b][m]maskedmerge,format=rgb24"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-i",
            str(src),
            "-i",
            str(candidate),
            "-i",
            str(mask),
            "-filter_complex",
            vf,
            "-frames:v",
            "1",
            "-c:v",
            "png",
            str(output),
        ],
        check=True,
    )


def render(req, output):
    output = Path(output)
    output.parent.mkdir(parents=True, exist_ok=True)
    receipt = Path(str(output) + ".json")
    journal = Path(str(output) + ".job.json")
    kind = req["kind"]
    if kind not in ("image", "edit", "video"):
        raise ValueError("kind must be image, edit or video")
    if output.suffix.lower() != (".mp4" if kind == "video" else ".png"):
        raise ValueError("Output file extension must match the requested media kind")
    raw_refs = req.get("references") or []
    if not isinstance(raw_refs, list) or len(raw_refs) > 3:
        raise ValueError("Up to three reference images are supported")
    refs = [Path(p) for p in raw_refs]
    src = Path(req["image"]) if req.get("image") else None
    mask = Path(req["mask"]) if req.get("mask") else None
    if kind == "edit" and not src or mask and (not src or kind == "video"):
        raise ValueError("Edit or mask requires an input image. Video masks are not supported.")
    supplied = (req.get("prompt") or "").strip()
    if not supplied and not src and not refs:
        raise ValueError("Provide text, an image or a reference")
    preset = (
        "Keep the scene composition, subtle slow camera move."
        if kind == "video"
        else "Preserve the subject, make a polished studio variation."
    )
    prompt = supplied or preset
    inputs = {str(path): file_hash(path) for path in [src, mask, *refs] if path}
    fingerprint = digest(canonical([req, inputs]))
    if receipt.exists() and output.exists():
        info = json.loads(receipt.read_text())
        if info["request_sha256"] != fingerprint or info["sha256"] != file_hash(output):
            raise ValueError("Output belongs to another input or has changed. Choose a new output path.")
        return info
    strength = req.get("edit_strength", 0.97)
    if (
        isinstance(strength, bool)
        or not isinstance(strength, (int, float))
        or not 0.05 <= strength <= 1.0
    ):
        raise ValueError("edit_strength must be between 0.05 and 1")
    video = kind == "video"
    source_shape = inspect(src) if src else None
    if mask:
        mask_shape = inspect(mask)
        if any(mask_shape[k] != source_shape[k] for k in ("width", "height")):
            raise ValueError("Mask dimensions must match source")
    if video and refs and not req.get("allow_reference_composition"):
        raise ValueError(
            "Wan cannot natively consume identity references. Approve an extra Boogu keyframe pass via allow_reference_composition."
        )
    unit = 32 if video else 16
    default_w, default_h = (
        (640, 352) if video or not source_shape else (source_shape["width"], source_shape["height"])
    )
    scale = min(1, 832 / max(default_w, default_h))
    default_w, default_h = [max(128, round(x * scale / unit) * unit) for x in (default_w, default_h)]
    w = bounded(req, "width", default_w, 128, 1024)
    h = bounded(req, "height", default_h, 128, 1024)
    if w % unit or h % unit:
        raise ValueError(f"width and height must be multiples of {unit}")
    video_profile = req.get("video_profile", "standard")
    if video_profile not in ("standard", "turbo"):
        raise ValueError("video_profile must be standard or turbo")
    sample_w, sample_h = (
        boogu_reference_size(source_shape["width"], source_shape["height"]) if mask else (w, h)
    )
    steps = bounded(req, "steps", 20 if video and video_profile == "standard" else 8, 1, 30)
    frames = bounded(req, "frames", 25, 5, 81)
    fps = bounded(req, "fps", 12, 4, 30)
    if video and (frames - 1) % 4:
        raise ValueError("Wan requires frames = 4n+1")
    state = (
        json.loads(journal.read_text())
        if journal.exists()
        else {
            "request_sha256": fingerprint,
            "started_unix": time.time(),
            "seed": bounded(req, "seed", secrets.randbits(31), 0, 2**63 - 1),
            "stages": {},
        }
    )
    if state["request_sha256"] != fingerprint:
        raise ValueError("Existing operation has different inputs. Choose a new output path.")
    write_json(journal, state)
    seed = state["seed"]
    deadline = time.monotonic() + TIMEOUT
    with tempfile.TemporaryDirectory(dir=output.parent) as d, GpuMeter() as meter:
        temp = Path(d)
        main = upload(src) if src else None
        mask_name = upload(mask) if mask else None
        reference_names = [upload(p) for p in refs]
        names = ([main] if main else []) + reference_names
        if video:
            if reference_names:
                prep = (
                    "Create the opening frame for this shot. "
                    + (
                        "Use image 1 as the composition anchor; use remaining references for appearance. "
                        if main
                        else "Use the provided images as appearance references. "
                    )
                    + prompt
                )
                g, model = still(prep, w, h, 8, seed, names)
                intermediate = output.with_name(output.stem + "-composed-keyframe.png")
                run_graph(g, model, intermediate, journal, state, "reference_composition", deadline)
                main = upload(intermediate)
            graph, model = motion(
                prompt, w, h, steps, seed, frames, fps, main, draft=video_profile == "turbo"
            )
        else:
            edit_instruction = prompt
            if reference_names:
                lead = (
                    "Image 1 is the editable base. The remaining images are visual references. "
                    if main
                    else "Create a new composition. Use the supplied images as visual appearance references. "
                )
                edit_instruction = lead + prompt
            graph, model = still(
                edit_instruction,
                sample_w,
                sample_h,
                steps,
                seed,
                names,
                mask_image=mask_name,
                edit_strength=strength,
            )
            if mask:
                graph["66"] = node(
                    "ImageScale",
                    image=["9", 0],
                    width=source_shape["width"],
                    height=source_shape["height"],
                    upscale_method="lanczos",
                    crop="disabled",
                )
                graph["10"]["inputs"]["images"] = ["66", 0]
        raw = temp / ("raw" + output.suffix)
        run_graph(graph, model, raw, journal, state, "render", deadline)
        if mask:
            composed = temp / "composed.png"
            mask_compose(src, raw, mask, composed)
            raw = composed
        spec = inspect(raw)
        if (spec["width"], spec["height"]) != (
            (source_shape["width"], source_shape["height"]) if mask else (w, h)
        ) or spec["frames"] != (frames if video else 1):
            raise RuntimeError(f"Output failed media validation: {spec}")
        os.replace(raw, output)
    info = {
        "kind": kind,
        "model": model,
        "output": str(output),
        "sha256": file_hash(output),
        "request_sha256": fingerprint,
        "operation_id": state["stages"]["render"]["id"],
        "stages": state["stages"],
        "wall_seconds": round(time.time() - state["started_unix"], 3),
        "physical_gpu": meter.result(),
        "media": spec,
        "video_profile": video_profile if video else None,
        "seed": seed,
        "steps": steps,
        "native_width": sample_w,
        "native_height": sample_h,
        "effective_prompt": prompt,
        "input_sha256": list(inputs.values()),
        "composited_mask": bool(mask),
        "mask_mode": "source_latent_noise_mask" if mask else None,
        "edit_strength": strength if mask else None,
    }
    write_json(receipt, info)
    return info


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    try:
        with Path(str(args.output) + ".lock").open("a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            result = render(json.loads(args.request.read_text()), args.output)
        print(json.dumps(result, ensure_ascii=False))
    except (
        KeyError,
        TypeError,
        ValueError,
        OSError,
        RuntimeError,
        TimeoutError,
        subprocess.CalledProcessError,
    ) as e:
        print(json.dumps({"error": str(e)}, ensure_ascii=False), file=sys.stderr)
        sys.exit(1)
