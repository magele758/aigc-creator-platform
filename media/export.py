"""Frame-accurate local timeline export. Time values passed by the app are seconds."""

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
import time
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

SR = 48_000


def run(args):
    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode:
        raise ValueError(result.stderr.strip()[-1800:] or "媒体编解码器执行失败")
    return result.stdout


def probe(path, count=False):
    options = ["-count_frames"] if count else []
    return json.loads(
        run(
            [
                "ffprobe",
                "-v",
                "error",
                *options,
                "-show_streams",
                "-show_format",
                "-of",
                "json",
                str(path),
            ]
        )
    )


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def time_value(value):
    n = Decimal(str(value))
    if not n.is_finite() or n < 0:
        raise ValueError("时间必须是非负有限值")
    return n


def to_frame(seconds, fps):
    return int((seconds * fps).to_integral_value(rounding=ROUND_HALF_UP))


def sec(frames, fps):
    return format(Decimal(frames) / fps, ".10f")


def bounded_int(n, low, high):
    if isinstance(n, bool) or int(n) != n or not low <= int(n) <= high:
        raise ValueError("输出规格超出可用范围")
    return int(n)


def export(req, dest):
    started = time.perf_counter()
    clips = req["clips"]
    if not isinstance(clips, list) or not 1 <= len(clips) <= 500:
        raise ValueError("时间线需要至少一个有源镜头，最多 500 段")
    fps = bounded_int(req.get("fps", 24), 12, 60)
    cache = {}
    dest = dest.resolve()
    if dest.suffix.lower() != ".mp4":
        raise ValueError("输出应为 .mp4")
    dest.parent.mkdir(exist_ok=True, parents=True)
    with tempfile.TemporaryDirectory(prefix=".cut-", dir=dest.parent) as tmp:
        wd = Path(tmp)
        edl = []
        parts = []
        cursor = 0
        w, h = req.get("width"), req.get("height")
        for i, clip in enumerate(clips):
            path = Path(clip["path"]).resolve(strict=True)
            if not path.is_file() or path == dest:
                raise ValueError("时间线使用了无效源文件")
            if path not in cache:
                cache[path] = probe(path), digest(path)
            info, source_hash = cache[path]
            v = next(
                (
                    x
                    for x in info["streams"]
                    if x["codec_type"] == "video" and not x.get("disposition", {}).get("attached_pic")
                ),
                None,
            )
            if not v:
                raise ValueError(f"第 {i+1} 段缺少视频轨")
            if i == 0:
                w = bounded_int(v["width"] if w is None else w, 16, 4096)
                h = bounded_int(v["height"] if h is None else h, 16, 4096)
            if w % 2 or h % 2:
                raise ValueError("输出宽高应为偶数")
            length = time_value(v.get("duration") or info["format"]["duration"])
            start = to_frame(time_value(clip.get("trimIn", 0)), fps)
            available = to_frame(length, fps) - start
            n = (
                to_frame(time_value(clip["duration"]), fps)
                if clip.get("duration") is not None
                else available
            )
            if not 0 < n <= available or cursor + n > fps * 3600:
                raise ValueError(f"第 {i+1} 段裁切超出素材时长或工程长度上限")
            source_audio = any(x["codec_type"] == "audio" for x in info["streams"])
            audio = "0:a:0" if source_audio else "1:a:0"
            samples = round((cursor + n) * SR / fps) - round(cursor * SR / fps)
            vf = (
                f"fps={fps},scale={w}:{h}:force_original_aspect_ratio=decrease:force_divisible_by=2,"
                f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2,setsar=1,format=yuv420p,"
                f"tpad=stop_mode=clone:stop_duration={2/fps},trim=end_frame={n},setpts=PTS-STARTPTS"
            )
            af = f"aresample={SR},aformat=channel_layouts=stereo,apad,atrim=end_sample={samples},asetpts=PTS-STARTPTS"
            part = wd / f"cut-{i:04d}.mov"
            cmd = [
                "ffmpeg",
                "-nostdin",
                "-hide_banner",
                "-v",
                "error",
                "-y",
                "-ss",
                sec(start, fps),
                "-i",
                str(path),
            ]
            if not source_audio:
                cmd += ["-f", "lavfi", "-i", f"anullsrc=r={SR}:cl=stereo"]
            run(
                cmd
                + [
                    "-map",
                    "0:v:0",
                    "-map",
                    audio,
                    "-vf",
                    vf,
                    "-af",
                    af,
                    "-c:v",
                    "libx264",
                    "-crf",
                    "17",
                    "-preset",
                    "veryfast",
                    "-video_track_timescale",
                    "48000",
                    "-c:a",
                    "pcm_s16le",
                    "-ar",
                    str(SR),
                    "-map_metadata",
                    "-1",
                    str(part),
                ]
            )
            parts += [f"file '{part.name}'", f"duration {sec(n, fps)}"]
            edl.append(
                {
                    "shotId": clip.get("shotId"),
                    "assetId": clip.get("assetId"),
                    "title": clip.get("title"),
                    "sourceSha256": source_hash,
                    "sourceSize": [v["width"], v["height"]],
                    "sourceFps": v.get("avg_frame_rate"),
                    "sourceInFrame": start,
                    "sequenceInFrame": cursor,
                    "frames": n,
                    "audio": "source" if source_audio else "silence",
                }
            )
            cursor += n
        listing = wd / "timeline.txt"
        listing.write_text("ffconcat version 1.0\n" + "\n".join(parts) + "\n")
        out = wd / "delivery.mp4"
        run(
            [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-y",
                "-f",
                "concat",
                "-safe",
                "1",
                "-i",
                str(listing),
                "-map",
                "0:v:0",
                "-map",
                "0:a:0",
                "-c:v",
                "copy",
                "-c:a",
                "aac",
                "-b:a",
                "192k",
                "-video_track_timescale",
                "48000",
                "-movflags",
                "+faststart",
                "-map_metadata",
                "-1",
                str(out),
            ]
        )
        check = probe(out, count=True)
        video = next(x for x in check["streams"] if x["codec_type"] == "video")
        audio = next(x for x in check["streams"] if x["codec_type"] == "audio")
        if (
            int(video["nb_read_frames"]) != cursor
            or abs(float(video["duration"]) - cursor / fps) > 0.6 / fps
        ):
            raise ValueError("交付文件没有通过帧数或时长检查")
        if int(audio["sample_rate"]) != SR or abs(float(audio["duration"]) - cursor / fps) > 0.05:
            raise ValueError("交付文件声画时长不符")
        summary = {
            "kind": "export",
            "codec": "h264",
            "audioCodec": "aac",
            "sampleRate": SR,
            "width": w,
            "height": h,
            "fps": fps,
            "frames": cursor,
            "duration": cursor / fps,
            "clips": edl,
            "sha256": digest(out),
            "seconds": round(time.perf_counter() - started, 3),
        }
        sidecar = wd / "manifest.json"
        sidecar.write_text(json.dumps(summary, ensure_ascii=False, indent=2))
        os.replace(out, dest)
        os.replace(sidecar, str(dest) + ".json")
        return summary


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True, type=Path)
    parser.add_argument("--output", required=True, type=Path)
    args = parser.parse_args()
    try:
        print(json.dumps(export(json.loads(args.request.read_text()), args.output), ensure_ascii=False))
    except (ValueError, OSError, KeyError, StopIteration, ArithmeticError, TypeError) as exc:
        sys.exit(f"无法导出成片：{exc}")
