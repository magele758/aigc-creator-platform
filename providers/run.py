"""Optional server-side image connectors. The authenticated caller selects the route."""

import argparse
import fcntl
import base64
import hashlib
import hmac
import json
import mimetypes
import os
import subprocess
import sys
import tempfile
import time
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError
from urllib.parse import urlencode, urlsplit
from urllib.request import Request, urlopen

ROUTES = json.loads(Path(__file__).with_name("routes.json").read_text())
MAX = 64 * 1024 * 1024


def fetch(url, headers=None, data=None):
    try:
        with urlopen(Request(url, headers=headers or {}, data=data), timeout=240) as response:
            raw = response.read(MAX + 1)
    except HTTPError as error:
        raise ValueError(f"服务响应 HTTP {error.code}，请核对账号权限、地区、输入与配额") from None
    if len(raw) > MAX:
        raise ValueError("服务返回的数据过大")
    return raw


def post(url, payload, headers):
    return json.loads(
        fetch(url, {"Content-Type": "application/json", **headers}, json.dumps(payload).encode())
    )


def bearer(key):
    return {"Authorization": "Bearer " + key} if key else {}


def images(request):
    result = []
    for name in ([request["image"]] if request.get("image") else []) + (request.get("references") or []):
        p = Path(name)
        mime = mimetypes.guess_type(str(p))[0]
        if mime not in {"image/jpeg", "image/png", "image/webp"} or p.stat().st_size > MAX // 4:
            raise ValueError("参考文件须为 16 MiB 内的 PNG、JPEG 或 WebP")
        result.append((mime, base64.b64encode(p.read_bytes()).decode()))
    return result


def result_bytes(item):
    if item.get("b64_json"):
        return base64.b64decode(item["b64_json"], validate=True)
    url = item.get("url", "")
    if urlsplit(url).scheme != "https":
        raise ValueError("服务没有返回可归档的图片")
    return fetch(url)


def openai_image(model, prompt, refs, base, key):
    body = {"model": model, "prompt": prompt, "n": 1}
    if refs:
        body["images"] = [{"image_url": f"data:{mime};base64,{data}"} for mime, data in refs]
    op = "edits" if refs else "generations"
    r = post(base.rstrip("/") + "/images/" + op, body, bearer(key))
    return result_bytes(r["data"][0]), r.get("usage")


def google_image(model, prompt, refs):
    content = [
        {"type": "text", "text": prompt},
        *({"type": "image", "mime_type": mime, "data": d} for mime, d in refs),
    ]
    r = post(
        "https://generativelanguage.googleapis.com/v1beta/interactions",
        {
            "model": model,
            "input": content,
            "response_format": {"type": "image", "mime_type": "image/png"},
        },
        {"x-goog-api-key": os.environ["STUDIO_GEMINI_IMAGE_KEY"], "Api-Revision": "2026-05-20"},
    )
    img = r.get("output_image") or next(
        (x for x in reversed(r.get("outputs", [])) if x.get("type") == "image"), {}
    )
    if not img:
        for step in reversed(r.get("steps", [])):
            if step.get("type") == "model_output":
                img = next(
                    (x for x in reversed(step.get("content", [])) if x.get("type") == "image"), {}
                )
                if img:
                    break
    if not img.get("data"):
        raise ValueError("Gemini 返回中没有生成的图片")
    return base64.b64decode(img["data"], validate=True), r.get("usage")


def aliyun_image(model, prompt, refs):
    if len(refs) > 3:
        raise ValueError("当前千问连接最多接受三张输入图")
    content = [{"image": f"data:{mime};base64,{d}"} for mime, d in refs] + [{"text": prompt}]
    origin = os.environ["STUDIO_DASHSCOPE_ORIGIN"].rstrip("/")
    r = post(
        origin + "/api/v1/services/aigc/multimodal-generation/generation",
        {
            "model": model,
            "input": {"messages": [{"role": "user", "content": content}]},
            "parameters": {"n": 1},
        },
        bearer(os.environ["STUDIO_DASHSCOPE_IMAGE_KEY"]),
    )
    contents = r["output"]["choices"][0]["message"]["content"]
    return result_bytes({"url": next(x["image"] for x in contents if "image" in x)}), r.get("usage")


def volc(action, payload):
    host = "visual.volcengineapi.com"
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    scope = stamp[:8] + "/cn-north-1/cv/request"
    query = urlencode({"Action": action, "Version": "2022-08-31"})
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    digest = hashlib.sha256(raw).hexdigest()
    headers = {
        "content-type": "application/json",
        "host": host,
        "x-content-sha256": digest,
        "x-date": stamp,
    }
    signed = ";".join(sorted(headers))
    canonical = "\n".join(
        ["POST", "/", query, "".join(f"{k}:{headers[k]}\n" for k in sorted(headers)), signed, digest]
    )
    message = "\n".join(["HMAC-SHA256", stamp, scope, hashlib.sha256(canonical.encode()).hexdigest()])
    key = os.environ["STUDIO_VOLC_SECRET_KEY"].encode()
    for part in scope.split("/"):
        key = hmac.digest(key, part.encode(), "sha256")
    sig = hmac.new(key, message.encode(), "sha256").hexdigest()
    headers["Authorization"] = (
        f"HMAC-SHA256 Credential={os.environ['STUDIO_VOLC_ACCESS_KEY']}/{scope}, SignedHeaders={signed}, Signature={sig}"
    )
    resp = json.loads(fetch("https://" + host + "/?" + query, headers, raw))
    if resp.get("code") != 10000:
        raise ValueError("即梦任务接口返回状态 " + str(resp.get("code")) + "，请核对账号授权与工作流")
    return resp["data"]


def save_json(path, value):
    with tempfile.NamedTemporaryFile(mode="w", dir=path.parent, delete=False) as tmp:
        json.dump(value, tmp, ensure_ascii=False)
        tmp.flush()
        os.fsync(tmp.fileno())
    os.replace(tmp.name, path)


def jimeng_image(model, prompt, refs, output):
    if refs:
        raise ValueError("即梦图像输入要求已授权的远程图片 URL。本连接当前启用文生图。")
    receipt_path = Path(str(output) + ".submission.json")
    if receipt_path.exists():
        task = json.loads(receipt_path.read_text())["remoteTaskId"]
    else:
        receipt = volc(
            "CVSync2AsyncSubmitTask", {"req_key": model, "prompt": prompt, "force_single": True}
        )
        task = receipt["task_id"]
        save_json(receipt_path, {"remoteTaskId": task})
    deadline = time.monotonic() + 900
    while time.monotonic() < deadline:
        r = volc(
            "CVSync2AsyncGetResult",
            {"req_key": model, "task_id": task, "req_json": '{"return_url":false}'},
        )
        if r.get("status") == "done":
            if r.get("binary_data_base64"):
                return base64.b64decode(r["binary_data_base64"][0], validate=True), {"taskId": task}
            return result_bytes({"url": r["image_urls"][0]}), {"taskId": task}
        if r.get("status") not in {"in_queue", "generating"}:
            raise ValueError("即梦任务状态为 " + str(r.get("status")))
        time.sleep(3)
    raise ValueError("即梦查询超时，请使用已记录的远程任务号核对")


def render(req, out):
    out.parent.mkdir(parents=True, exist_ok=True)
    with open(str(out) + ".lock", "a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX)
        return render_locked(req, out)


def render_locked(req, out):
    route_id = req["provider"]
    conf = ROUTES[route_id]
    if not all(os.getenv(k, "").strip() for k in conf["keys"]):
        raise ValueError("所选连接尚未配置服务端授权")
    if req["kind"] not in conf["kinds"] or req.get("mask"):
        raise ValueError("所选连接不支持此模式，局部遮罩编辑可选 4090")
    model = os.getenv(conf.get("modelEnv", ""), conf["model"])
    text = req.get("prompt", "").strip()
    if not text:
        raise ValueError("此连接需要文字指令")
    out.parent.mkdir(parents=True, exist_ok=True)
    refs = images(req)
    if req["kind"] == "edit" and not refs:
        raise ValueError("编辑需要原图")
    if req.get("image") and req.get("references"):
        text = "第一张是编辑底图，其余仅作视觉参考。\n" + text
    if route_id == "jimeng" and refs:
        raise ValueError("即梦连接仅接受纯文本")
    if route_id == "aliyun" and len(refs) > 3:
        raise ValueError("当前千问连接最多接受三张输入图")
    fingerprint = hashlib.sha256(
        json.dumps([route_id, model, req, text, refs], sort_keys=True).encode()
    ).hexdigest()
    journal = Path(str(out) + ".dispatch.json")
    metadata = Path(str(out) + ".json")
    if journal.exists():
        prev = json.loads(journal.read_text())
        if prev.get("fingerprint") != fingerprint:
            raise ValueError("作业标识对应的请求发生了变化")
        if metadata.exists() and out.is_file():
            done = json.loads(metadata.read_text())
            if done.get("sha256") == hashlib.sha256(out.read_bytes()).hexdigest():
                return done
        if route_id != "jimeng" or not Path(str(out) + ".submission.json").is_file():
            raise ValueError("此请求已经派发，未确认结果前不能自动重付。请核对供应商后台。")
    else:
        save_json(journal, {"fingerprint": fingerprint, "provider": route_id, "startedAt": time.time()})
    started = time.perf_counter()
    if route_id in ("openai", "selfhost"):
        host = (
            "https://api.openai.com/v1" if route_id == "openai" else os.environ["STUDIO_IMAGE_BASE_URL"]
        )
        key = (
            os.getenv("STUDIO_OPENAI_IMAGE_KEY")
            if route_id == "openai"
            else os.getenv("STUDIO_HTTP_IMAGE_KEY")
        )
        raw, usage = openai_image(model, text, refs, host, key)
    elif route_id == "google":
        raw, usage = google_image(model, text, refs)
    elif route_id == "aliyun":
        raw, usage = aliyun_image(model, text, refs)
    else:
        raw, usage = jimeng_image(model, text, refs, out)
    with tempfile.TemporaryDirectory(dir=out.parent) as tmp:
        result = Path(tmp) / "render.png"
        process = subprocess.run(
            [
                "ffmpeg",
                "-nostdin",
                "-v",
                "error",
                "-f",
                "image2pipe",
                "-i",
                "pipe:0",
                "-frames:v",
                "1",
                str(result),
            ],
            input=raw,
            capture_output=True,
        )
        if process.returncode or not result.exists():
            raise ValueError("服务返回的内容无法解码为图片")
        with result.open("rb") as f:
            png_header = f.read(24)
        width, height = [int.from_bytes(png_header[i : i + 4], "big") for i in (16, 20)]
        meta = {
            "provider": route_id,
            "model": model,
            "kind": req["kind"],
            "width": width,
            "height": height,
            "usage": usage,
            "seconds": round(time.perf_counter() - started, 3),
            "sha256": hashlib.sha256(result.read_bytes()).hexdigest(),
        }
        m = Path(tmp) / "result.json"
        m.write_text(json.dumps(meta, ensure_ascii=False))
        os.replace(result, out)
        os.replace(m, str(out) + ".json")
        return meta


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    a = parser.parse_args()
    try:
        print(json.dumps(render(json.loads(a.request.read_text()), a.output), ensure_ascii=False))
    except (ValueError, KeyError, OSError, IndexError, StopIteration, TypeError) as error:
        sys.exit("图像连接失败：" + str(error))
