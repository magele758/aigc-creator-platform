import json
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from media.export import export
from providers import run


class CutTest(unittest.TestCase):
    def test_reorder_trim_and_original_sound(self):
        with tempfile.TemporaryDirectory() as tmp:
            d = Path(tmp)
            a = d / "a.mp4"
            b = d / "b.mp4"
            dest = d / "cut.mp4"

            def ff(*args):
                return subprocess.check_output(
                    ["ffmpeg", "-nostdin", "-y", "-v", "error", *map(str, args)]
                )

            ff(
                "-f",
                "lavfi",
                "-i",
                "color=c=red:s=192x128:r=16:d=2",
                "-f",
                "lavfi",
                "-i",
                "sine=frequency=440:sample_rate=48000:duration=2",
                "-c:v",
                "libx264",
                "-c:a",
                "aac",
                a,
            )
            ff("-f", "lavfi", "-i", "color=c=blue:s=256x144:r=24:d=1.5", "-c:v", "libx264", b)
            result = export(
                {
                    "clips": [
                        {"path": str(b), "trimIn": 0.25, "duration": 0.75},
                        {"path": str(a), "trimIn": 0.5, "duration": 1.25},
                    ]
                },
                dest,
            )
            self.assertEqual((result["frames"], result["duration"]), (48, 2))
            self.assertEqual([c["audio"] for c in result["clips"]], ["silence", "source"])
            for t, blue, audio in [(0.2, True, False), (1.1, False, True)]:
                rgb = ff(
                    "-ss",
                    t,
                    "-i",
                    dest,
                    "-frames:v",
                    1,
                    "-vf",
                    "scale=1:1",
                    "-f",
                    "rawvideo",
                    "-pix_fmt",
                    "rgb24",
                    "-",
                )
                self.assertEqual(rgb[2] > rgb[0], blue)
                pcm = ff("-ss", t, "-t", "0.12", "-i", dest, "-map", "0:a:0", "-f", "s16le", "-")
                self.assertEqual(max(pcm) > 2, audio)
            before = dest.read_bytes()
            with self.assertRaises(ValueError):
                export({"clips": [{"path": str(a), "trimIn": 1.5, "duration": 1}]}, dest)
            self.assertEqual(dest.read_bytes(), before)
            self.assertEqual(json.loads(Path(str(dest) + ".json").read_text())["frames"], 48)


class OptionalProviderContractTests(unittest.TestCase):
    @patch.dict(os.environ, {}, clear=True)
    def test_disabled_route_cannot_make_requests(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(
            run, "fetch", side_effect=AssertionError("outbound request")
        ):
            with self.assertRaisesRegex(ValueError, "尚未配置"):
                run.render(
                    {"kind": "image", "provider": "openai", "prompt": "cup"}, Path(tmp) / "unused.png"
                )

    @patch.dict(os.environ, {"STUDIO_OPENAI_IMAGE_KEY": "test-only"})
    def test_mask_is_not_silently_dropped(self):
        with tempfile.TemporaryDirectory() as tmp, patch.object(
            run, "fetch", side_effect=AssertionError("outbound request")
        ):
            with self.assertRaisesRegex(ValueError, "遮罩"):
                run.render(
                    {"kind": "edit", "provider": "openai", "prompt": "cup", "image": "a", "mask": "b"},
                    Path(tmp) / "unused.png",
                )

    @patch.object(run, "post", return_value={"data": [{"b64_json": "YWJj"}]})
    def test_openai_edit_sends_all_inputs(self, post):
        out, _ = run.openai_image(
            "model", "keep", [("image/png", "a"), ("image/jpeg", "b")], "https://example.test/v1", "key"
        )
        url, body, _ = post.call_args.args
        self.assertTrue(url.endswith("/images/edits"))
        self.assertEqual(
            [x["image_url"] for x in body["images"]],
            ["data:image/png;base64,a", "data:image/jpeg;base64,b"],
        )
        self.assertEqual(out, b"abc")

    @patch.dict(os.environ, {"STUDIO_GEMINI_IMAGE_KEY": "test-only"})
    @patch.object(
        run,
        "post",
        return_value={
            "steps": [{"type": "model_output", "content": [{"type": "image", "data": "YWJj"}]}]
        },
    )
    def test_google_image_response(self, post):
        self.assertEqual(run.google_image("model", "cup", [("image/png", "ref")])[0], b"abc")
        self.assertEqual(post.call_args.args[1]["input"][1]["data"], "ref")

    @patch.dict(
        os.environ,
        {"STUDIO_DASHSCOPE_ORIGIN": "https://example.test", "STUDIO_DASHSCOPE_IMAGE_KEY": "test-only"},
    )
    @patch.object(
        run,
        "post",
        return_value={
            "output": {
                "choices": [{"message": {"content": [{"image": "https://example.test/result.png"}]}}]
            }
        },
    )
    @patch.object(run, "fetch", return_value=b"img")
    def test_dashscope_source_roles(self, fetch, post):
        self.assertEqual(run.aliyun_image("model", "cup", [("image/png", "ref")])[0], b"img")
        payload = post.call_args.args[1]["input"]["messages"][0]["content"]
        self.assertEqual(payload, [{"image": "data:image/png;base64,ref"}, {"text": "cup"}])

    @patch.object(
        run, "volc", side_effect=[{"task_id": "t1"}, {"status": "done", "binary_data_base64": ["YWJj"]}]
    )
    def test_jimeng_submit_query_and_receipt(self, api):
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "out.png"
            raw, metrics = run.jimeng_image("model", "cup", [], dest)
            self.assertEqual((raw, metrics["taskId"]), (b"abc", "t1"))
            self.assertEqual(
                json.loads(Path(str(dest) + ".submission.json").read_text())["remoteTaskId"], "t1"
            )
            self.assertTrue(api.call_args_list[0].args[1]["force_single"])

    @patch.dict(os.environ, {"STUDIO_OPENAI_IMAGE_KEY": "test-only"})
    @patch.object(run, "openai_image", side_effect=OSError("connection lost after dispatch"))
    def test_ambiguous_sync_generation_is_not_rebilled(self, send):
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "out.png"
            req = {"provider": "openai", "kind": "image", "prompt": "cup"}
            with self.assertRaises(OSError):
                run.render(req, dest)
            with self.assertRaisesRegex(ValueError, "不能自动重付"):
                run.render(req, dest)
            self.assertEqual(send.call_count, 1)

    @patch.object(run, "volc", return_value={"status": "done", "binary_data_base64": ["YWJj"]})
    def test_jimeng_resumes_poll_of_recorded_job(self, api):
        with tempfile.TemporaryDirectory() as tmp:
            dest = Path(tmp) / "out.png"
            Path(str(dest) + ".submission.json").write_text('{"remoteTaskId":"existing"}')
            raw, _ = run.jimeng_image("model", "cup", [], dest)
            self.assertEqual(raw, b"abc")
            self.assertEqual(api.call_args.args[0], "CVSync2AsyncGetResult")
            self.assertEqual(api.call_count, 1)


if __name__ == "__main__":
    unittest.main()
