# 本地媒体 worker

本机控制进程需要 Python 3.9+、FFmpeg、ffprobe 和 SSH 客户端。GPU 工作站使用已安装的 ComfyUI 及下列权重。本项目只使用内置节点。默认的远端启动配置在用户目录下建立独立的输入、输出、数据库和日志，服务与转发均监听回环地址。

```sh
python3 workers/connect.py --host Win4090
python3 workers/render.py --request request.json --output runs/example.png
python3 -m unittest discover -s workers -p 'test_*.py'
python3 workers/verify_local.py --out runs/independent-retest
```

默认连接 Windows 上的 WSL 与本地端口 18188。原生 Linux 使用 `--runtime linux`。可用 `DIEYING_REMOTE_COMFY_DIR`、`DIEYING_REMOTE_PYTHON` 指定已装的程序与解释器，`DIEYING_GPU_SSH` 设置 SSH 别名，`DIEYING_COMFY_URL` 设置控制端访问的 Comfy 地址。另选端口时让该地址与 `--port` 一致。若已有受控的 Comfy 实例，可直接指定其地址，跳过启动与隧道。整卡指标从对应主机的 nvidia-smi 采样，设 `DIEYING_GPU_SSH=""` 可关闭这项观测。隧道失效时可再次运行连接命令。远端服务日志在 `~/.local/share/dieying-render/service.log`。权重仍使用原有 Comfy 模型目录。

```json
{"kind":"image","prompt":"雨夜站台上的一盏橙灯，写实摄影","width":640,"height":352,"seed":42}
```

`kind` 支持 `image`、`edit`、`video`。从服务端传入已经项目授权的磁盘路径，`image` 为主图，`references` 为最多三张参考图。`mask` 为与主图同尺寸的黑白遮罩，白色区域使用模型候选，黑色区域保留原来的 RGB 像素。局部编辑将原图编码为 VAE latent，画笔用作采样器的噪声遮罩；采样分辨率匹配 Boogu 的约 100 万像素参考网格，默认去噪强度 0.97，可用 `edit_strength` 对该次作业改写。解码后缩回原图尺寸，按原遮罩合成以消除 VAE 往返对受保护区的像素扰动。Wan 能以首帧或文字直接生视频；需要额外外观参考时，只有明确提供 `allow_reference_composition: true` 才会先用 Boogu 生成中间关键帧并归档，然后送入 Wan。所有模型调用均在配置的 Comfy 实例执行。

- Z-Image 基础组件为 `z_image_turbo_bf16.safetensors`、`qwen_3_4b.safetensors` 与 `ae.safetensors`。
- Boogu 指令编辑使用 `boogu_image_edit_turbo_int8_convrot.safetensors`、`qwen3vl_8b_fp8_scaled.safetensors` 与同一图像 VAE。
- Wan 图生/文生视频使用 `wan2.2_ti2v_5B_fp16.safetensors`、`umt5_xxl_fp8_e4m3fn_scaled.safetensors` 与 `wan2.2_vae.safetensors`。视频默认使用原始精度、20 步、CFG 5、uni_pc/simple、shift 8 与首帧潜空间节点。显式指定 `video_profile: "turbo"` 时启用 8 步、CFG 1、FP8 和 Turbo LoRA 的快速草稿档。该档在现有对照镜头出现过画面漂移。[官方工作流](https://docs.comfy.org/tutorials/video/wan/wan2_2)

图片输出 PNG，视频输出 MP4。相同输入与输出路径可恢复先前的作业。每次运行留存 `<output>.job.json` 和 `<output>.json`，包含推理作业 ID、节点图摘要、媒体实测规格与 SHA-256。整卡显存/功耗包含其他进程，采样间隔 2 秒。`execution_seconds` 取自服务端事件，`wall_seconds` 从首次派发算到本地文件验证结束。控制机与 GPU 主机时钟偏差会影响 `queue_seconds` 的估计。
