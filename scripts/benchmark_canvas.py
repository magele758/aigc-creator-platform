"""Measure the shipped directory, editor and canvas against an isolated synthetic project store.

Run with Python playwright, Node >=22.15 and Chromium. CHROME_CHANNEL=chrome selects desktop Chrome.
The browser's network may be shaped with --network target (30 Mbps download / 50 ms latency).
All generated assets, including the synthetic 256x144 thumbnail, are removed with the temporary store.
"""

import argparse
from contextlib import closing
import json
import math
import os
from pathlib import Path
import platform
import random
import socket
import sqlite3
import statistics
import struct
import subprocess
import tempfile
import time
from urllib.request import urlopen
import zlib

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[1]
PROJECT = "canvas-benchmark-00"
RATE = 30_000_000 / 8


def percentile(values, p):
    order = sorted(values)
    return order[max(0, math.ceil(len(order) * p) - 1)]


def stats(values):
    return {
        "samples": len(values),
        "p50Ms": round(statistics.median(values), 2),
        "p95Ms": round(percentile(values, 0.95), 2),
        "maxMs": round(max(values), 2),
    }


def thumbnail(path):
    rng = random.Random(17)

    def chunk(k, b):
        return struct.pack(">I", len(b)) + k + b + struct.pack(">I", zlib.crc32(k + b))

    w, h = 256, 144
    rows = []
    for y in range(h):
        row = bytearray([0])
        for x in range(w):
            n = rng.randrange(32)
            row.extend((int(25 + 130 * x / w) + n, int(40 + 120 * y / h) + n, 70 + n))
        rows.append(row)
    path.write_bytes(
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress(b"".join(rows)))
        + chunk(b"IEND", b"")
    )


def make_dataset(tmp):
    # Use the shipping schema, including directory indexes and materialization triggers.
    env = {**os.environ, "STUDIO_DATA_DIR": str(tmp)}
    subprocess.run(
        ["node", "--input-type=module", "-e", "import('./server/store.mjs')"],
        cwd=ROOT,
        env=env,
        check=True,
    )
    target = tmp / "objects" / "bench.png"
    target.parent.mkdir(exist_ok=True)
    thumbnail(target)
    prose = ("山中邮差在雨棚候车。列车驶入站台，远处亮起一盏红灯。" * 260)[:5000]
    assert len(prose) == 5000
    with closing(sqlite3.connect(tmp / "studio.sqlite")) as db:
        for pi in range(100):
            pid = f"canvas-benchmark-{pi:02d}"
            assets = [
                {
                    "id": f"asset-{pi}-{i}",
                    "file": "bench.png",
                    "title": f"场景参考 {i}",
                    "kind": "image",
                    "mime": "image/png",
                    "width": 256,
                    "height": 144,
                }
                for i in range(1000)
            ]
            outline = []
            chapters = []
            if pi == 0:
                for ci in range(10):
                    outline.append(
                        {
                            "id": f"o-{ci}",
                            "title": f"第 {ci+1} 章",
                            "beat": "人物穿过雨棚。",
                        }
                    )
                    shots = [
                        {
                            "id": f"s-{ci}-{i}",
                            "title": f"镜头 {ci+1}.{i+1}",
                            "prompt": "站台缓慢推镜。",
                            "image": assets[ci * 50 + i]["id"],
                        }
                        for i in range(50)
                    ]
                    chapters.append(
                        {
                            "id": f"c-{ci}",
                            "outlineId": f"o-{ci}",
                            "title": f"第 {ci+1} 章",
                            "text": prose,
                            "shots": shots,
                        }
                    )
            p = {
                "id": pid,
                "name": f"场景项目 {pi+1:03d}",
                "brief": "山中邮局的一天，试拍工作项目。",
                "revision": 1,
                "createdAt": "2026-01-01T00:00:00Z",
                "updatedAt": "2026-01-01T00:00:00Z",
                "outline": outline,
                "chapters": chapters,
                "assets": assets,
                "sequence": [],
                "mapLayout": {},
                "storyLinks": [],
                "history": [],
            }
            db.execute(
                "INSERT INTO projects VALUES (?,?)",
                (pid, json.dumps(p, ensure_ascii=False, separators=(",", ":"))),
            )
        db.commit()
    return {
        "projects": 100,
        "assetsPerProject": 1000,
        "totalAssetSummaries": 100000,
        "activeChapters": 10,
        "shots": 500,
        "screenplayCharacters": 50000,
        "syntheticThumbnailBytes": target.stat().st_size,
        "databaseBytes": (tmp / "studio.sqlite").stat().st_size,
    }


def start(tmp):
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    base = "http://127.0.0.1:" + str(port)
    env = {**os.environ, "PORT": str(port), "STUDIO_DATA_DIR": str(tmp)}
    proc = subprocess.Popen(["node", "server/index.mjs"], cwd=ROOT, env=env, stdout=subprocess.DEVNULL)
    for _ in range(70):
        if proc.poll() is not None:
            raise RuntimeError("temporary studio stopped")
        try:
            with urlopen(base + "/api/projects?summary=1", timeout=1):
                return proc, base
        except OSError:
            time.sleep(0.1)
    proc.terminate()
    raise RuntimeError("temporary studio did not start")


def browser_results(browser, base, samples, network):
    directory = []
    board = []
    queries = {}
    errs = []

    def context():
        ctx = browser.new_context(viewport={"width": 1440, "height": 900}, device_scale_factor=1)
        page = ctx.new_page()
        page.on("pageerror", lambda e: errs.append(str(e)))
        if network == "target":
            cdp = ctx.new_cdp_session(page)
            cdp.send("Network.enable")
            cdp.send(
                "Network.emulateNetworkConditions",
                {
                    "offline": False,
                    "latency": 50,
                    "downloadThroughput": RATE,
                    "uploadThroughput": RATE,
                    "connectionType": "ethernet",
                },
            )
        return ctx, page

    for _ in range(samples):
        ctx, page = context()
        page.goto(base, wait_until="domcontentloaded")
        page.wait_for_function("document.querySelectorAll('[data-project]').length===100")
        directory.append(page.evaluate("performance.now()"))
        ctx.close()
    for _ in range(samples):
        ctx, page = context()
        page.goto(base + "/#/p/" + PROJECT + "/map", wait_until="domcontentloaded")
        page.wait_for_function(
            "document.querySelectorAll('.node.shot').length===500 && document.querySelector('.mapdetail h2')"
        )
        board.append(page.evaluate("performance.now()"))
        ctx.close()
    ctx, page = context()
    page.goto(base + "/#/p/" + PROJECT + "/map", wait_until="domcontentloaded")
    page.locator(".node.shot").first.wait_for(state="attached")
    page.evaluate("""() => {window.benchFrame={intervals:[],maxThumbnails:0,enabled:false,last:0};
      function sample(ts){const v=benchFrame;if(v.enabled){if(v.last)v.intervals.push(ts-v.last);
        v.maxThumbnails=Math.max(v.maxThumbnails,document.querySelectorAll('.node img[src]').length);v.last=ts}
        requestAnimationFrame(sample)}requestAnimationFrame(sample)}""")
    pan = page.locator(".mapview").bounding_box()
    # Zoom from the whole-story view onto the first chapter; use real wheel and pointer events.
    page.mouse.move(pan["x"] + 50, pan["y"] + pan["height"] / 2)
    for _ in range(12):
        page.mouse.wheel(0, -180)
    page.wait_for_timeout(250)
    startX = pan["x"] + 12
    startY = pan["y"] + 12
    page.evaluate("benchFrame.enabled=true")
    for i in range(30):
        # Alternating movements prevent drifting off the canvas.
        page.mouse.move(startX, startY)
        page.mouse.down()
        page.mouse.move(startX + 48, startY + 24, steps=4)
        page.mouse.up()
        page.mouse.move(startX + 48, startY + 24)
        page.mouse.down()
        page.mouse.move(startX, startY, steps=4)
        page.mouse.up()
        page.mouse.wheel(0, -35 if i % 2 == 0 else 35)
    page.wait_for_timeout(90)
    frames = page.evaluate("()=>{benchFrame.enabled=false;return benchFrame}")
    assert frames["intervals"] and frames["maxThumbnails"] <= 30
    queries["mapImageRequests"] = page.evaluate(
        "performance.getEntriesByType('resource').filter(r=>r.name.includes('/media/')).length"
    )
    page.goto(base + "/#/p/" + PROJECT + "/script", wait_until="domcontentloaded")
    textarea = page.locator("#chapter-text")
    textarea.wait_for()
    before = textarea.input_value()
    assert len(before) == 5000
    page.evaluate(
        """()=>{window.inputTimings=[];document.querySelector('#chapter-text').addEventListener('input',()=>{
      const entered=performance.now();requestAnimationFrame(()=>requestAnimationFrame(()=>inputTimings.push(performance.now()-entered)))})}"""
    )
    textarea.focus()
    textarea.press("End")
    for _ in range(500):
        page.keyboard.insert_text("字")
    page.wait_for_function("inputTimings.length===500")
    assert len(textarea.input_value()) == len(before) + 500
    inputTimes = page.evaluate("inputTimings")
    page.locator("[data-act=save]").click()
    page.wait_for_function("document.querySelector('#content').dataset.dirty !== 'true'")
    page.reload()
    page.locator("#chapter-text").wait_for()
    assert len(page.locator("#chapter-text").input_value()) == 5500
    ctx.close()
    return directory, board, frames, inputTimes, queries, errs


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--samples", type=int, default=30)
    parser.add_argument("--network", choices=["local", "target"], default="target")
    parser.add_argument("--output", type=Path, default=ROOT / "runs" / "benchmark-canvas.json")
    args = parser.parse_args()
    if args.samples < 1:
        parser.error("samples must be at least one")
    with tempfile.TemporaryDirectory(prefix="cine-scale-") as folder, sync_playwright() as w:
        tmp = Path(folder)
        dataset = make_dataset(tmp)
        proc, base = start(tmp)
        try:
            api = []
            for _ in range(args.samples):
                t = time.perf_counter()
                with urlopen(base + "/api/projects?summary=1") as f:
                    payload = f.read()
                api.append((time.perf_counter() - t) * 1000)
            directoryPayload = json.loads(payload)
            assert (
                len(directoryPayload["projects"]) == 100
                and directoryPayload["projects"][0]["assetCount"] == 1000
            )
            opts = {"headless": True}
            if os.environ.get("CHROME_CHANNEL"):
                opts["channel"] = os.environ["CHROME_CHANNEL"]
            browser = w.chromium.launch(**opts)
            directory, board, frames, inputTimes, queries, errors = browser_results(
                browser, base, args.samples, args.network
            )
            assert not errors, errors
            result = {
                "dataset": dataset,
                "browser": browser.version,
                "system": platform.system() + " " + platform.machine(),
                "measurement": "Cold browser contexts; already-running local service, synthetic 256x144 imagery and a chapter-sized editable text area; foreground sole test tab. Input latency measures input to second animation frame.",
                "network": args.network,
                "directorySummaryHttpMs": stats(api),
                "directoryPayloadBytes": len(payload),
                "directoryInteractiveMs": stats(directory),
                "mapInteractiveMs": stats(board),
                "mapFrameIntervalsMs": stats(frames["intervals"]),
                "mapMaximumLoadedThumbnails": frames["maxThumbnails"],
                "mapImageRequestsAcrossGestures": queries["mapImageRequests"],
                "typingToNextPaintMs": stats(inputTimes),
                "typedCharactersVerifiedAfterReload": 500,
                "pageErrors": errors,
            }
            args.output.parent.mkdir(parents=True, exist_ok=True)
            args.output.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n")
            print(json.dumps(result, ensure_ascii=False, indent=2))
            browser.close()
        finally:
            proc.terminate()
            proc.wait(timeout=8)


if __name__ == "__main__":
    main()
