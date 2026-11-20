from contextlib import ExitStack
import json
from pathlib import Path
import subprocess
import tempfile
import time
import unittest
from unittest.mock import patch

import connect
import render
from workflows import BOOGU, WAN, Z_IMAGE, boogu_reference_size, motion, still


class LocalRenderTests(unittest.TestCase):
    def test_forward_recovers_live_gpu_service_without_wsl_launch(self):
        with ExitStack() as stack:
            stack.enter_context(patch("sys.argv", ["connect.py", "--host", "gpu-test"]))
            stack.enter_context(patch.object(connect, "healthy", side_effect=[False, True]))
            stack.enter_context(patch.object(connect, "remote_healthy", return_value=True))
            start = stack.enter_context(patch.object(connect, "start_service"))
            stack.enter_context(patch.object(connect.socket, "create_connection", side_effect=ConnectionRefusedError()))
            ssh = stack.enter_context(patch.object(connect.subprocess, "run"))
            stack.enter_context(patch("builtins.print"))
            connect.main()
            start.assert_not_called()
            ssh.assert_called_once()
            self.assertIn("127.0.0.1:18188:127.0.0.1:18188", ssh.call_args.args[0])

    def test_model_service_probe_checks_project_and_port(self):
        launch = ["main.py", "--user-directory", "/home/test/.local/share/dieying-render/user", "--port", "18188"]

        def stats(argv):
            return json.dumps({"devices": [{"name": "cuda:0"}], "system": {"argv": argv}})

        self.assertTrue(connect.project_service(stats(launch), 18188))
        self.assertFalse(connect.project_service(stats(launch), 18189))
        self.assertFalse(connect.project_service(stats(["main.py", "--port", "18188"]), 18188))

    def test_text_image_and_all_reference_slots(self):
        g, model = still("a blue lamp", 640, 448, 8, 5, [])
        self.assertEqual(model, Z_IMAGE)
        self.assertEqual(g["5"]["inputs"]["text"], "a blue lamp")
        g, model = still("change paint", 640, 448, 8, 5, ["base.png", "lamp.png", "light.png"])
        self.assertEqual(model, BOOGU)
        self.assertEqual(
            [g[g["5"]["inputs"][f"images.image_{i}"][0]]["inputs"]["image"] for i in range(1, 4)],
            ["base.png", "lamp.png", "light.png"],
        )

    def test_local_edit_uses_source_vae_latent_with_noise_mask(self):
        g, _ = still(
            "recolor the mug",
            640,
            448,
            8,
            42,
            ["source.png"],
            mask_image="brush.png",
            edit_strength=0.55,
        )
        self.assertEqual(boogu_reference_size(640, 448), (1216, 864))
        self.assertEqual(g["8"]["inputs"]["latent_image"], ["6", 0])
        self.assertEqual(g["8"]["inputs"]["denoise"], 0.55)
        self.assertEqual(g["6"]["class_type"], "SetLatentNoiseMask")
        self.assertEqual(g["62"]["class_type"], "VAEEncode")
        self.assertEqual(g["61"]["inputs"]["image"], ["21", 0])
        self.assertEqual(g["21"]["inputs"]["image"], "source.png")
        self.assertEqual(g["63"]["inputs"]["image"], "brush.png")
        self.assertEqual(g["65"]["class_type"], "ImageToMask")

    def test_wan_receives_first_frame_only_when_supplied(self):
        for image in [None, "reference.png"]:
            g, model = motion("camera pans", 640, 352, 8, 5, 25, 12, image)
            self.assertEqual(model, WAN)
            self.assertEqual("start_image" in g["9"]["inputs"], image is not None)
            self.assertEqual(g["13"]["inputs"]["fps"], 12.0)
            self.assertNotIn("7", g)
            self.assertEqual(g["11"]["inputs"]["cfg"], 5.0)
            self.assertEqual(g["1"]["inputs"]["weight_dtype"], "default")

    def test_reject_empty_input_and_invalid_frames_before_submission(self):
        with tempfile.TemporaryDirectory() as folder, patch.object(
            render, "http", side_effect=AssertionError("reached GPU")
        ):
            with self.assertRaisesRegex(ValueError, "Provide text"):
                render.render({"kind": "image"}, Path(folder) / "new.png")
            with self.assertRaisesRegex(ValueError, "4n"):
                render.render(
                    {"kind": "video", "prompt": "a cat", "frames": 22}, Path(folder) / "new.mp4"
                )

    def test_resume_accepted_history_without_reposting_or_billing(self):
        with tempfile.TemporaryDirectory() as folder:
            journal = Path(folder) / "job.json"
            output = Path(folder) / "clip.mp4"
            g = {"10": {"test": True}}
            stage = {
                "id": "recorded",
                "submitted_unix": 1,
                "accepted": True,
                "graph_sha256": render.digest(render.canonical(g)),
            }
            state = {"stages": {"render": stage}}
            history = {
                "recorded": {
                    "status": {
                        "status_str": "success",
                        "messages": [
                            ["execution_start", {"timestamp": 1000}],
                            ["execution_success", {"timestamp": 4000}],
                        ],
                    },
                    "outputs": {
                        "10": {
                            "video": [{"filename": "clip.mp4", "type": "output", "subfolder": "dieying"}]
                        }
                    },
                }
            }
            with patch.object(render, "get", return_value=history), patch.object(
                render, "http", return_value=b"clip"
            ) as http:
                render.run_graph(g, WAN, output, journal, state, "render", time.monotonic() + 5)
            self.assertEqual(output.read_bytes(), b"clip")
            self.assertEqual(stage["execution_seconds"], 3)
            self.assertEqual(http.call_count, 1)
            self.assertTrue(http.call_args[0][0].startswith("/view?"))

    def test_mask_keeps_every_unpainted_rgb_pixel(self):
        with tempfile.TemporaryDirectory() as folder:
            p = Path(folder)

            def fixture(name, filt):
                subprocess.run(
                    [
                        "ffmpeg",
                        "-nostdin",
                        "-v",
                        "error",
                        "-y",
                        "-f",
                        "lavfi",
                        "-i",
                        filt,
                        "-frames:v",
                        "1",
                        str(p / name),
                    ],
                    check=True,
                )

            fixture("src.png", "color=red:s=96x64,format=rgb24")
            fixture("new.png", "color=cyan:s=96x64,format=rgb24")
            fixture(
                "mask.png",
                "color=black:s=96x64,drawbox=x=20:y=10:w=30:h=40:color=white:t=fill,format=gray",
            )
            render.mask_compose(p / "src.png", p / "new.png", p / "mask.png", p / "result.png")

            def raw(name, fmt):
                return subprocess.check_output(
                    [
                        "ffmpeg",
                        "-v",
                        "error",
                        "-i",
                        str(p / name),
                        "-pix_fmt",
                        fmt,
                        "-frames:v",
                        "1",
                        "-f",
                        "rawvideo",
                        "-",
                    ]
                )

            src, new, mask, result = (
                raw("src.png", "rgb24"),
                raw("new.png", "rgb24"),
                raw("mask.png", "gray"),
                raw("result.png", "rgb24"),
            )
            self.assertEqual(set(mask), {0, 255})
            for i, v in enumerate(mask):
                ref = new if v else src
                self.assertEqual(result[3 * i : 3 * i + 3], ref[3 * i : 3 * i + 3])


if __name__ == "__main__":
    unittest.main()
