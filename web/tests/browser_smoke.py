"""Exercise the shipped browser against an isolated instance of the real HTTP service.

Requires Node >=22.15, ffprobe, Python playwright and a Chromium installation.
Set CHROME_CHANNEL=chrome to use installed desktop Chrome, otherwise Playwright Chromium.
The intentionally unavailable worker exercises durable submission and error handling offline.
"""

import json
import os
from pathlib import Path
import socket
import struct
import subprocess
import tempfile
import time
from urllib.request import Request, urlopen
import zlib

from playwright.sync_api import sync_playwright

ROOT = Path(__file__).resolve().parents[2]


def png(size=32):
    def chunk(name, data):
        return struct.pack(">I", len(data)) + name + data + struct.pack(">I", zlib.crc32(name + data))

    rgb = bytes((60, 110, 70)) * size
    return (
        b"\x89PNG\r\n\x1a\n"
        + chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 2, 0, 0, 0))
        + chunk(b"IDAT", zlib.compress((b"\0" + rgb) * size))
        + chunk(b"IEND", b"")
    )


def available_port():
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def start_service(tmp):
    port = available_port()
    env = {
        **os.environ,
        "PORT": str(port),
        "STUDIO_DATA_DIR": str(tmp / "data"),
        "STUDIO_PYTHON": str(tmp / "intentionally-unavailable-worker"),
    }
    proc = subprocess.Popen(["node", "server/index.mjs"], cwd=ROOT, env=env, stdout=subprocess.DEVNULL)
    api = "http://127.0.0.1:" + str(port)
    for _ in range(60):
        if proc.poll() is not None:
            raise RuntimeError("browser-test backend exited")
        try:
            with urlopen(api + "/api/projects", timeout=1):
                return proc, api
        except OSError:
            time.sleep(0.1)
    proc.terminate()
    raise RuntimeError("browser-test service did not listen")


def call(base, path, payload=None, method=None):
    data = None if payload is None else json.dumps(payload).encode()
    req = Request(
        base + path,
        data=data,
        method=method,
        headers={"Content-Type": "application/json"},
    )
    with urlopen(req, timeout=10) as r:
        return json.load(r)


def test_ui(web, base, tmp):
    opts = {"headless": True}
    if os.environ.get("CHROME_CHANNEL"):
        opts["channel"] = os.environ["CHROME_CHANNEL"]
    browser = web.chromium.launch(**opts)
    page = browser.new_page(viewport={"width": 1440, "height": 900})
    page.set_default_timeout(9000)
    errors = []
    page.on("pageerror", lambda e: errors.append(str(e)))

    def go(path, head):
        page.goto(base + "/#/" + path)
        page.get_by_role("heading", name=head, exact=True).first.wait_for()

    def act(name):
        return page.locator('[data-act="' + name + '"]')

    page.goto(base)
    page.get_by_role("heading", name="项目目录", exact=True).wait_for()
    for theme in ["classic", "field", "cinema"]:
        page.locator("#theme-button").click()
        page.locator('[data-theme-choice="' + theme + '"]').click()
        page.reload()
        page.locator(".featured").wait_for()
        assert page.locator("html").get_attribute("data-theme") == theme
    print("PASS three themes, stored across reload", flush=True)

    act("new").click()
    page.locator("#pname").fill("浏览器验收")
    page.locator("#pbrief").fill("两章故事，邮差在山里收到一封信。")
    page.get_by_role("button", name="创建项目", exact=True).click()
    page.get_by_role("heading", name="浏览器验收", exact=True).wait_for()
    projects = call(base, "/api/projects")["projects"]
    assert len(projects) == 1
    pid = projects[0]["id"]
    prefix = "p/" + pid + "/"

    # A standalone action is exercised on a project with no screenplay at all.
    go(prefix + "image", "图片工作室")
    page.locator("#prompt").fill("一盏绿灯，暖色棚拍")
    lost = []

    def lose_acknowledgement(route):
        # The real server commits this job. Only the browser response is lost.
        response = route.fetch()
        assert response.status == 202
        lost.append(response.json()["job"]["id"])
        route.abort("connectionreset")

    page.route("**/api/jobs", lose_acknowledgement, times=1)
    with page.expect_event(
        "requestfailed", lambda r: r.url.endswith("/api/jobs") and r.method == "POST"
    ):
        act("generate").click()
    page.wait_for_function("!document.querySelector('[data-act=generate]').disabled")
    with page.expect_response(
        lambda r: r.url.endswith("/api/jobs") and r.request.method == "POST"
    ) as created:
        act("generate").click()
    assert created.value.status == 202
    submitted = created.value.request.post_data_json
    assert (
        submitted["projectId"],
        submitted["kind"],
        submitted["prompt"],
        submitted["provider"],
    ) == (pid, "image", "一盏绿灯，暖色棚拍", "local")
    assert not submitted.get("shotId")
    job = created.value.json()["job"]
    assert lost == [job["id"]] and len(call(base, "/api/jobs")["jobs"]) == 1
    page.locator("#job-detail").wait_for()
    assert call(base, "/api/jobs/" + job["id"])["job"]["projectId"] == pid
    page.locator("#job-detail .tag.failed").wait_for()
    assert call(base, "/api/jobs/" + job["id"])["job"]["error"]
    print("PASS real HTTP submission and durable unavailable-worker error", flush=True)

    go(prefix + "image", "图片工作室")
    page.locator('[data-input="mainOn"]').click()
    art = tmp / "green.png"
    art.write_bytes(png())
    page.locator("#upload").set_input_files(art)
    page.wait_for_function("document.querySelector('#base')?.value.length > 0")
    aid = page.locator("#base").input_value()
    # Natural-resolution mask raster is uploaded before the edit job.
    act("brush").click()
    canvas = page.locator("#brush-canvas")
    canvas.wait_for()
    rect = canvas.bounding_box()
    x, y = rect["x"] + rect["width"] * 0.35, rect["y"] + rect["height"] * 0.4
    page.mouse.move(x, y)
    page.mouse.down()
    page.mouse.move(x + rect["width"] * 0.2, y + rect["height"] * 0.2, steps=4)
    page.mouse.up()
    with page.expect_response(
        lambda r: r.url.endswith("/api/jobs") and r.request.method == "POST"
    ) as edited:
        act("generate").click()
    assert edited.value.status == 202
    payload = edited.value.request.post_data_json
    assert payload["kind"] == "edit" and payload["mainAssetId"] == aid and payload["maskAssetId"] != aid
    current = call(base, "/api/projects/" + pid)["project"]
    assert not current["chapters"] and not current["sequence"]
    mask = next(a for a in current["assets"] if a["id"] == payload["maskAssetId"])
    assert mask["width"] == mask["height"] == 32 and mask["role"] == "mask"
    print("PASS upload, mask, standalone edit payload, project persisted", flush=True)

    go(prefix + "outline", "故事大纲")
    act("add").click()
    page.locator("[data-title]").fill("信抵达")
    page.locator("[data-beat]").fill("邮差走进山中邮局。")
    act("save").click()
    page.wait_for_function("document.querySelector('#content').dataset.dirty !== 'true'")
    go(prefix + "script", "章节剧本")
    act("add-ch").click()
    page.locator("#chapter-title").fill("第一章")
    page.locator("#chapter-text").fill("内景，山里邮局。邮差拆开信。")
    act("save").click()
    page.wait_for_function("document.querySelector('#content').dataset.dirty !== 'true'")
    act("add-shot").click()
    page.locator(".mapdetail").wait_for()
    act("shot").click()
    page.locator("#sh-title").fill("邮差近景")
    page.locator("#sh-prompt").fill("A close-up of a letter")
    page.locator("dialog [data-act=save]").click()
    page.locator(".mapdetail").get_by_text("邮差近景", exact=True).wait_for()
    go(prefix + "video", "镜头工作室")
    go(prefix + "cut", "成片剪辑")
    go(prefix + "assets", "资源与共享")
    assert page.locator(".asset").count() == 2
    page.locator('#top [data-act="agent"]').click()
    assert page.locator("#agent-mode").input_value() == "command"
    page.locator("dialog [data-dismiss]").click()
    go("home", "项目目录")
    page.set_viewport_size({"width": 390, "height": 844})
    assert page.evaluate("document.documentElement.scrollWidth <= innerWidth")
    page.locator("#mobile-menu").click()
    assert page.locator('#rail [data-nav="image"]').is_visible()
    assert not errors, errors
    print("PASS manual stages, Map edit, director scope and mobile navigation", flush=True)
    browser.close()


if __name__ == "__main__":
    with tempfile.TemporaryDirectory(prefix="dieying-browser-") as tmp, sync_playwright() as w:
        proc, base = start_service(Path(tmp))
        try:
            test_ui(w, base, Path(tmp))
        finally:
            proc.terminate()
            proc.wait(timeout=5)
