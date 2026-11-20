# 叠映 Cine

在本机浏览器里从项目简报制作短片，或直接生成、修改一张图片。Web 服务持久保存项目，导演使用 `ppeng-agent-core/agent-loop` 调用创作工具，独立的 GPU worker 执行实际生成，FFmpeg 负责最终剪辑。工作台有叠映经典、Higgsfield 风格荧光和 Cinema 红黑三种外观。

[产品流程与 V3 设计稿](docs/design/workflow.md) · [实机验收](docs/verification.md)

## 启动

需要 Node.js 22.15+、npm、Python 3.10+、FFmpeg 和 ffprobe。首次安装执行：

```sh
npm ci
npm start
```

浏览器打开 [本机工作台](http://127.0.0.1:4327/)。应用绑定本机回环地址，默认将 SQLite、媒体和任务收据存放在被 Git 忽略的 `.studio-data/`。可用 `STUDIO_PORT` 和 `STUDIO_DATA_DIR` 覆盖。开新的空目录启动即可从零试用。

- **导演模型**。在相邻的 `ppeng-agent-core` 仓库配置 Agent Home，或设置 `PPENG_AGENT_CORE_DIR`。可独立设置 `STUDIO_TEXT_MODEL`、`STUDIO_TEXT_BASE_URL`、`STUDIO_TEXT_API_KEY` 来使用可调用工具的文字模型。仓库锁定发布版 SDK，开发时也能复用已有仓库的构建产物。
- **本地生成**。你的 GPU SSH 别名配置就绪后，执行 `python3 workers/connect.py --host Win4090`，使用既有 ComfyUI 和模型。搭建不同机器时可直接配置 `DIEYING_COMFY_URL`。镜头、素材和 PNG 遮罩从应用发往选定的私有 worker。[模型文件、端口与运行方式](workers/README.md)
- **外部与自定义连接**。支持按项目任务显式选择已配置的图片执行端，原生视频工作流当前优先本地 Wan。可在图像工作室查看连接是否配置。[模型连接](docs/connections.md)

## 由 Agent 操作工作室

从首页打开「导演 Agent」，默认是自由委托。可以从空工作室建项目，也可以在当前项目继续工作。导演通过同一个 agent-loop 会话读取工作室状态、执行动作、接收结果并继续。成功、部分执行和失败均保留工具回执，任务页可查看实际调用。整片制作也保留了单独入口。

| 委托示例 | 可核对的结果 |
|---|---|
| 新建「夜航」，只用本地 4090 生成一张 640×448 海报，给我看图 | 项目里只有一份图片，章节和时间线均为空 |
| 把本次附件导入美术库，按引用共享给指定项目；确认接收方能看到它 | 附件变为具名素材，接收项目有引用，源项目能撤销授权 |
| 读完第三章再改结尾，分别修改镜头的画面和运动指令，解除指定 Map 连线 | 正文可分页读全，文字、镜头及连线写入同一份项目 |
| 把第二镜移到开头，截取三秒，导出后检查第一帧并交付 | 时间线、可解码的 MP4、素材读帧回执和下载地址 |
| 切到 Cinema，打开某项目的剧本 Map | 提交委托的浏览器应用主题及页面，其他标签页保留原视图 |

外部 Agent 可通过本机 HTTP 入口提交同一类委托。向 `POST /api/jobs` 发送 `{"kind":"command","prompt":"列出工作室项目","idempotencyKey":"list-projects-1"}`，选择现有项目时加 `projectId`。用返回的任务 ID 查询 `GET /api/jobs/{id}`。以 `status`、`result.operations`、`result.assetUrl` / `deliveryUrl` 核对动作和产物。命令结果中的 `view` 由调用端按需展示。

文件通过委托的附件选择器提交，或在请求中传 `commandFiles: [{title, dataUrl}]`，PNG 遮罩可指定 `role: "mask"`。每次最多 6 份、合计 25 MiB。按指令检查画面时，抽取的预览帧会传给配置的导演模型；生图和视频默认使用本地 GPU。

## 两条创作路径

1. **整片制作**。从项目目录点「导演 Agent」，描述片名、章数、主体与摄影意图，选择制作成片。系统保存大纲、章节剧本、分镜指令和跨章镜头关系，生成各镜插图，将其作为首帧制作视频，再按时间线导出 H.264 MP4。现有镜头可以在剧本 Map 与剪辑页继续编辑。可用导演指令改写指定章节、改镜头指令、组接或裁切再导出。
2. **单独做图**。选择项目后直接打开「独立生图与修图」。可提交文字、主图或参考图，候选进入当前项目素材库。局部修改时在原图上画选区，服务使用真实模型生成候选，再保护选区外像素。可比较、下载或把结果关联到指定镜头。
3. **主题**。从右上角「主题」切换，可在刷新后继续使用上次选定的配色。

这是本机单用户工作台。项目有各自的素材命名空间、共享引用与独立副本；多人账号认证、外网托管、商业级高并发和多轨调音另需部署验收。Wan 此档输出无源声，交付器保留已有视频原声，对无声素材补齐立体声静音轨。

## 自动化回归

```sh
npm test
python3 -m unittest discover -s tests -v
python3 -m unittest discover -s workers -p 'test_*.py' -v
```

常规测试使用临时数据库，验证 SDK 工具授权、素材隔离、版本冲突、恢复、合片的帧序与声画，以及供应商请求协议。GitHub Actions 同时运行浏览器回归。真实模型验收从运行中的 HTTP 服务走正常入口：

```sh
python3 scripts/acceptance.py film --output runs/film
python3 scripts/acceptance.py images --output runs/images
python3 scripts/acceptance.py recut --film-run runs/film --output runs/recut
python3 scripts/benchmark_web.py --output runs/web-latency.json
```

同一验收目录会复用既有请求标识，便于中断后继续查看结果。换一个输出目录即可发起新的真实生成。两条流程的样片、图像对照、实机耗时和当前画质边界见[实机验收报告](docs/verification.md)。

浏览器回归可在普通开发机独立运行：

```sh
python3 -m pip install playwright
python3 -m playwright install chromium
python3 web/tests/browser_smoke.py
```
