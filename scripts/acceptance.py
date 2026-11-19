"""Exercise the running app through its normal HTTP API and decode the real outputs."""

import argparse
import base64
import hashlib
import json
import os
import struct
import subprocess
import time
import uuid
import zlib
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urljoin
from urllib.request import Request, urlopen


def request(path, payload=None, method=None):
    url = urljoin(args.base + "/", path)
    raw = json.dumps(payload).encode() if payload is not None else None
    try:
        with urlopen(
            Request(url, data=raw, method=method, headers={"Content-Type": "application/json"}),
            timeout=30,
        ) as r:
            return json.load(r)
    except HTTPError as e:
        raise RuntimeError(f"{path} {e.code}: " + e.read(500).decode(errors="replace")) from None


def write(name, data):
    p = args.output / name
    p.with_suffix(".tmp").write_text(json.dumps(data, ensure_ascii=False, indent=2))
    os.replace(p.with_suffix(".tmp"), p)


def saved(name, fn):
    p = args.output / name
    if not p.exists():
        write(name, fn())
    return json.loads(p.read_text())


def run_job(name, payload):
    ident = saved(name + "-request.json", lambda: {"idempotencyKey": str(uuid.uuid4()), **payload})
    job = request("/api/jobs", ident)["job"]
    deadline = time.monotonic() + args.timeout
    last = None
    while True:
        j = request("/api/jobs/" + job["id"])["job"]
        current = (j["status"], j.get("stage"), len(j.get("events", [])))
        if current != last:
            print(time.strftime("%H:%M:%S"), name, *current, flush=True)
            last = current
        if j["status"] in {"succeeded", "completed"}:
            write(name + "-job.json", j)
            return j
        if j["status"] not in {"queued", "running"}:
            write(name + "-job.json", j)
            raise RuntimeError(str(j.get("error", j["status"])))
        if time.monotonic() > deadline:
            raise TimeoutError("任务仍可在工作台继续查看：" + j["id"])
        time.sleep(2)


def download(url, name):
    p = args.output / name
    with urlopen(urljoin(args.base + "/", url), timeout=60) as r:
        p.write_bytes(r.read())
    return p


def ffprobe(path):
    return json.loads(
        subprocess.check_output(
            [
                "ffprobe",
                "-v",
                "error",
                "-count_frames",
                "-show_streams",
                "-show_format",
                "-of",
                "json",
                str(path),
            ]
        )
    )


def pixels(path, *, frame=None):
    cmd = ["ffmpeg", "-v", "error"]
    if frame is not None:
        cmd += ["-ss", str(frame)]
    return subprocess.check_output(
        cmd + ["-i", str(path), "-frames:v", "1", "-vf", "format=rgb24", "-f", "rawvideo", "pipe:1"]
    )


def mask_png(w, h):
    def block(kind, raw):
        return struct.pack(">I", len(raw)) + kind + raw + struct.pack(">I", zlib.crc32(kind + raw))

    rows = []
    for y in range(h):
        active = h // 8 <= y < 7 * h // 8
        rows.append(bytes([255 if active and w // 6 <= x < 5 * w // 6 else 0 for x in range(w)]))
    png = b"\x89PNG\r\n\x1a\n" + block(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
    return png + block(b"IDAT", zlib.compress(b"".join(b"\0" + row for row in rows))) + block(
        b"IEND", b""
    ), b"".join(rows)


def project(id):
    return request("/api/projects/" + id)["project"]


def image_flow():
    pr = saved(
        "independent-project.json",
        lambda: request(
            "/api/projects", {"name": "色彩研究 · 独立图片", "brief": "单图生成和蓝釉局部修改"}
        )["project"],
    )
    pid = pr["id"]
    first = run_job(
        "generate",
        {
            "projectId": pid,
            "kind": "image",
            "prompt": "Studio catalogue photograph, one rich orange ceramic coffee cup, centered on a matte cream tabletop. A single handle. Soft north window daylight. No text or people.",
            "width": 640,
            "height": 448,
            "seed": 73402,
        },
    )
    assets = project(pid)["assets"]
    a = next(x for x in assets if x["id"] == first["result"]["assetId"])
    base = download(a["src"], "original.png")
    v = ffprobe(base)["streams"][0]
    data, mask = mask_png(v["width"], v["height"])
    (args.output / "mask.png").write_bytes(data)
    mask_asset = saved(
        "mask-asset.json",
        lambda: request(
            "/api/projects/" + pid + "/assets",
            {"title": "局部选区", "dataUrl": "data:image/png;base64," + base64.b64encode(data).decode()},
        )["asset"],
    )
    second = run_job(
        "edit",
        {
            "projectId": pid,
            "kind": "edit",
            "prompt": "Change the orange ceramic mug to a deep cobalt blue glazed ceramic mug. Keep the same single handle, same shape, position and background.",
            "mainAssetId": a["id"],
            "maskAssetId": mask_asset["id"],
            "seed": 73403,
        },
    )
    pr = project(pid)
    b = next(x for x in pr["assets"] if x["id"] == second["result"]["assetId"])
    edited = download(b["src"], "edited.png")
    before = pixels(base)
    after = pixels(edited)
    assert len(before) == len(after) == len(mask) * 3
    outside = inside = 0
    for i, value in enumerate(mask):
        off = i * 3
        if before[off : off + 3] != after[off : off + 3]:
            if value:
                inside += 1
            else:
                outside += 1
    selected = [i for i, m in enumerate(mask) if m]
    # This particular acceptance brief asks for a blue glaze on an orange cup.
    # Measure change in the orange subject area in addition to file validity.
    subject = [
        3 * i
        for i in selected
        if before[3 * i] > before[3 * i + 1] * 1.28 and before[3 * i + 1] > before[3 * i + 2] * 1.12
    ]
    blue_gain = sum((after[k + 2] - after[k]) - (before[k + 2] - before[k]) for k in subject) / max(
        1, len(subject)
    )
    assert len(subject) > 200 and blue_gain > 25, (len(subject), blue_gain)
    # Reject a rescaled cup pasted into the rectangle, even if all pixels
    # outside it survived. These neutral pixels belong to the nearby background.
    neutral = []
    for i in selected:
        offset = i * 3
        rgb = before[offset : offset + 3]
        if max(rgb) - min(rgb) > 52 or (rgb[0] > rgb[1] * 1.21 and rgb[1] > rgb[2] * 1.12):
            continue
        neutral.append(sum(abs(a - b) for a, b in zip(rgb, after[offset : offset + 3])) / 3)
    background_error = sum(neutral) / max(1, len(neutral))
    assert neutral and background_error < 15, background_error
    assert outside == 0 and inside > len(selected) * 0.02, (outside, inside)
    assert not pr["chapters"] and not pr["sequence"]
    result = {
        "projectId": pid,
        "source": a["id"],
        "edited": b["id"],
        "width": v["width"],
        "height": v["height"],
        "meanBlueGainOnOrangeSubject": round(blue_gain, 2),
        "backgroundMeanRgbErrorInsideMask": round(background_error, 2),
        "changedInsidePixels": inside,
        "changedOutsidePixels": outside,
        "protectedPixels": mask.count(0),
        "generation": first.get("metrics"),
        "edit": second.get("metrics"),
    }
    write("independent-report.json", result)


def film_flow():
    brief = (
        f"请创建《{args.film_title}》并交付完整成片。两章、每章一个镜头。第一章，一只折纸红船从拱桥阴影漂向雨后的光斑；"
        "第二章，用更近的低机位拍同一只红色折纸船驶入金色反光。两个镜头色调、纸材和船形连续，运动要可见，无人无字。"
        "生成大纲和剧本，真实生成两幅关键帧，用关键帧分别生成动态镜头，建立全剧 Map，按章合片。"
    )
    j = run_job(
        "film",
        {
            "kind": "agent",
            "name": args.film_title,
            "brief": brief,
            "prompt": brief,
            "chapters": 2,
            "frames": 49,
            "fps": 12,
        },
    )
    pid = j["projectId"] or j["result"]["projectId"]
    pr = project(pid)
    assert len(pr["outline"]) == len(pr["chapters"]) == 2
    shots = [s for c in pr["chapters"] for s in c["shots"]]
    assert all(c["text"].strip() for c in pr["chapters"])
    assert len(shots) >= 2 and all(s.get("image") and s.get("video") for s in shots)
    assert len(pr["sequence"]) >= 2
    dest = download(j["result"]["deliveryUrl"], "红舟过雨.mp4")
    spec = ffprobe(dest)
    v = next(s for s in spec["streams"] if s["codec_type"] == "video")
    assert v["codec_name"] == "h264" and int(v["nb_read_frames"]) > 1
    assert any(s["codec_name"] == "aac" for s in spec["streams"])
    assets = {a["id"]: a for a in pr["assets"]}
    clips = []
    cursor = 0
    for i, c in enumerate(pr["sequence"]):
        a = assets[c["assetId"]]
        src = download(a.get("playback") or a["src"], f"shot-{i+1}.mp4")
        clip = ffprobe(src)
        stream = next(s for s in clip["streams"] if s["codec_type"] == "video")
        seconds = float(clip["format"]["duration"])
        ref_time = min(0.35, seconds / 4)
        original = pixels(src, frame=(c.get("trimIn", 0) + ref_time))
        merged = pixels(dest, frame=cursor + ref_time)

        # Compare at a common size to handle timebase conversion and letterboxing.
        def tiny(path, t):
            return subprocess.check_output(
                [
                    "ffmpeg",
                    "-v",
                    "error",
                    "-ss",
                    str(t),
                    "-i",
                    str(path),
                    "-frames:v",
                    "1",
                    "-vf",
                    "scale=32:18",
                    "-pix_fmt",
                    "rgb24",
                    "-f",
                    "rawvideo",
                    "pipe:1",
                ]
            )

        x = tiny(src, c.get("trimIn", 0) + ref_time)
        y = tiny(dest, cursor + ref_time)
        err = sum(abs(i - j) for i, j in zip(x, y)) / len(x)
        assert err < 22 and original and merged, (i, err)
        d0 = tiny(src, 0)
        d1 = tiny(src, max(0, seconds - 0.25))
        diff = sum(abs(a - b) for a, b in zip(d0, d1)) / len(d0)
        assert diff > 0.25, (i, diff)
        k = c.get("duration") or seconds
        clips.append(
            {
                "asset": a["id"],
                "sha256": hashlib.sha256(src.read_bytes()).hexdigest(),
                "nativeFrames": int(stream["nb_read_frames"]),
                "duration": seconds,
                "firstLastMeanDifference": round(diff, 2),
                "cutMeanError": round(err, 2),
            }
        )
        cursor += k
    fps = eval_fps(v["avg_frame_rate"])
    assert abs(int(v["nb_read_frames"]) / fps - cursor) < 0.1
    write("film-project.json", pr)
    write(
        "film-report.json",
        {
            "projectId": pid,
            "jobId": j["id"],
            "chapters": [c["title"] for c in pr["chapters"]],
            "shots": clips,
            "width": v["width"],
            "height": v["height"],
            "frames": int(v["nb_read_frames"]),
            "fps": fps,
            "duration": float(spec["format"]["duration"]),
            "sha256": hashlib.sha256(dest.read_bytes()).hexdigest(),
            "metrics": j["metrics"],
        },
    )


def recut_flow():
    source = json.loads((args.film_run / "film-project.json").read_text())
    pid = source["id"]
    clips = source["sequence"]
    assert len(clips) == 2 and clips[1]["duration"] >= 3.25
    prompt = "请只修改当前时间线。把原来第 2 段移到第 1 位，把这段的源入点设为 0.25 秒、长度裁成 3 秒，另一段保持原来入点和时长，然后实际导出新版本。"
    j = run_job("recut", {"kind": "command", "projectId": pid, "prompt": prompt})
    updated = project(pid)["sequence"]
    assert [s["assetId"] for s in updated] == [clips[1]["assetId"], clips[0]["assetId"]]
    assert updated[0]["trimIn"] == 0.25 and updated[0]["duration"] == 3
    assert j["result"].get("deliveryUrl")
    dest = download(j["result"]["deliveryUrl"], "重新剪辑.mp4")
    v = ffprobe(dest)["streams"][0]
    assert int(v["nb_read_frames"]) == round((3 + clips[0]["duration"]) * 24)
    write(
        "recut-report.json",
        {
            "operations": j["result"]["operations"],
            "frames": int(v["nb_read_frames"]),
            "duration": float(v["duration"]),
            "elapsedSeconds": j["metrics"].get("elapsedSeconds"),
        },
    )


def eval_fps(value):
    a, b = value.split("/")
    return int(a) / int(b)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("case", choices=["film", "images", "both", "recut"])
    parser.add_argument("--film-run", type=Path, help="Initial film acceptance folder for recut")
    parser.add_argument("--film-title", default="红舟过雨")
    parser.add_argument("--base", default="http://127.0.0.1:4327")
    parser.add_argument(
        "--output", type=Path, required=True, help="Use the same folder to resume an existing run"
    )
    parser.add_argument("--timeout", type=int, default=5400)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    if args.case in ("film", "both"):
        film_flow()
    if args.case in ("images", "both"):
        image_flow()
    if args.case == "recut":
        if not args.film_run:
            parser.error("recut requires --film-run")
        recut_flow()
    print("PASS", args.case, args.output)
