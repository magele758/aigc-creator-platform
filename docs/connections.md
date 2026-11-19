# 模型连接

默认文字工序由已有的 `ppeng-agent-core/agent-loop` 驱动。设置 `PPENG_AGENT_CORE_DIR` 指向已构建的仓库，或将两个仓库并列放置。文字连接继承 Agent Home 的当前默认目录，也可用 `STUDIO_TEXT_BASE_URL`、`STUDIO_TEXT_MODEL`、`STUDIO_TEXT_API_KEY` 显式指定。云端文字模型会收到当前委托所需的剧本及项目说明。要求完全内网的项目应选择内网文字模型。

默认媒体连接为自有 ComfyUI，`DIEYING_COMFY_URL` 可覆盖回环地址。worker 的原生模型文件名与输入图、视频的节点图见 [workflows.py](../workers/workflows.py)。配置独立 HTTP 服务时支持 Images 协议，需实际实现用于文生图的 `/images/generations` 和传入 `images[].image_url` 的 JSON 编辑接口。

## 按需启用图片 API

以下变量在服务端设置。只有显式选择相应执行端的任务才向其传输文本或图片。密钥保持在服务器，页面可查看已配置状态。表格中的云连接经过请求和解析回归，付费账号验收应分别在对应地域和模型下进行。本次实机验收使用本地图片与视频。

| 连接 | 必需环境变量 | 当前实现 |
|---|---|---|
| OpenAI | `STUDIO_OPENAI_IMAGE_KEY` | 文生图、带一个或多个图片的编辑；可用 `STUDIO_OPENAI_IMAGE_MODEL` 覆盖模型。[Images 编辑](https://developers.openai.com/api/reference/resources/images/methods/edit) |
| Google | `STUDIO_GEMINI_IMAGE_KEY` | Gemini Interactions API 生图、带图编辑；可用 `STUDIO_GEMINI_IMAGE_MODEL` 覆盖模型。[官方图片工作流](https://aistudio.google.com/docs/image-generation) |
| 阿里云 | `STUDIO_DASHSCOPE_IMAGE_KEY`、`STUDIO_DASHSCOPE_ORIGIN` | 对应业务空间的 HTTPS 域名，以及 Qwen Image 同步多模态接口；最多三张输入图，可用 `STUDIO_DASHSCOPE_IMAGE_MODEL` 覆盖模型。[百炼接口](https://help.aliyun.com/zh/model-studio/qwen-image-generation-and-editing-api-reference) |
| 即梦企业视觉 | `STUDIO_VOLC_ACCESS_KEY`、`STUDIO_VOLC_SECRET_KEY` | 签名提交单张文生图，按任务号查询与归档。企业接口要求可访问的输入图片 URL，目前这个连接启用纯文本输入。[官方 4.0 文档](https://docs.volcengine.com/docs/jimeng-ai/jimeng-ai-image-generation-40-interface-documentation?lang=zh) |
| 自部署 HTTP | `STUDIO_IMAGE_BASE_URL`、`STUDIO_HTTP_IMAGE_MODEL` | 使用含版本前缀的基地址，支持可选 `STUDIO_HTTP_IMAGE_KEY`。 |

选区编辑在当前版本使用本地 Boogu 模型生成候选，再按原尺寸蒙版保护原图。参考图驱动的 Wan 视频先显式允许额外的关键帧合成，界面应显示这一步的额外算力开销。外部连接未配置时返回明确错误，工作室保留现有项目数据。
