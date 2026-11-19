#!/usr/bin/env python3
"""Exercise independent image generation and masked instruction editing against the configured real ComfyUI."""

import argparse
import json
from pathlib import Path
import subprocess
import sys
from render import inspect, write_json


def raw(path, fmt):
    return subprocess.check_output(
        [
            "ffmpeg",
            "-v",
            "error",
            "-i",
            str(path),
            "-frames:v",
            "1",
            "-pix_fmt",
            fmt,
            "-f",
            "rawvideo",
            "-",
        ]
    )


def verify(out):
    out.mkdir(parents=True, exist_ok=True)

    def run(name, req):
        request = out / (name + ".request.json")
        write_json(request, req)
        outname = out / (name + ".png")
        completed = subprocess.run(
            [
                sys.executable,
                str(Path(__file__).with_name("render.py")),
                "--request",
                str(request),
                "--output",
                str(outname),
            ],
            check=True,
            capture_output=True,
            text=True,
        )
        return outname, json.loads(completed.stdout)

    prompt = (
        "Product photograph of a single bright amber orange enamel mushroom table lamp, centered on a pale stone desk, "
        "against a dark teal wall, neutral daylight, completely unobstructed realistic solid orange dome lampshade "
        "and base, no text, no people."
    )
    src, gen = run(
        "01-lamp", dict(kind="image", prompt=prompt, width=640, height=448, steps=8, seed=8492)
    )
    mask = out / "02-shade-mask.png"
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            "color=black:s=640x448",
            "-vf",
            "drawbox=x=185:y=45:w=295:h=173:color=white:t=fill,format=gray",
            "-frames:v",
            "1",
            str(mask),
        ],
        check=True,
    )
    edit_prompt = (
        "Change only the enamel lampshade from orange to vivid cobalt blue. Keep its lighting, silhouette, "
        "warm orange base, neutral stone table, camera angle and teal wall intact."
    )
    edited, edit = run(
        "03-blue-shade",
        dict(
            kind="edit",
            prompt=edit_prompt,
            image=str(src.resolve()),
            mask=str(mask.resolve()),
            width=640,
            height=448,
            steps=8,
            seed=3322,
        ),
    )
    a, b, m = raw(src, "rgb24"), raw(edited, "rgb24"), raw(mask, "gray")
    changed, escaped, active = 0, 0, 0
    rgb_gain = 0
    for i, v in enumerate(m):
        x = a[3 * i : 3 * i + 3]
        y = b[3 * i : 3 * i + 3]
        different = x != y
        if v:
            active += 1
            changed += different
            rgb_gain += (y[2] - y[0]) - (x[2] - x[0])
        else:
            escaped += different
    evidence = {
        "image_model": gen["model"],
        "edit_model": edit["model"],
        "original_sha256": gen["sha256"],
        "edit_sha256": edit["sha256"],
        "mask_pixels": active,
        "changed_in_mask_pixels": changed,
        "changed_outside_mask_pixels": escaped,
        "mean_blue_minus_red_gain_in_mask": round(rgb_gain / max(1, active), 2),
        "image_seconds": gen["wall_seconds"],
        "edit_seconds": edit["wall_seconds"],
        "native": inspect(edited),
    }
    write_json(out / "verification.json", evidence)
    if escaped or changed < active * 0.15 or rgb_gain / active < 20:
        raise RuntimeError(
            "Edit failed protected pixels, visible change, or requested blue color direction"
        )
    print(json.dumps(evidence, indent=2))


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--out", type=Path, required=True)
    verify(parser.parse_args().out)
