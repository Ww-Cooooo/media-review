# 首次准备的固定依赖

下载版本和 SHA-256 以 `scripts/setup-dependencies.json` 为准；Node 的无运行时引导摘要同时固化在 `scripts/first-use.cmd`。升级时同步并复测；首次使用不取无法复现的 latest。

| 依赖 | 本版默认 | 来源与许可 |
| --- | --- | --- |
| Node.js | 24.16.0 Windows x64 | [官方下载](https://nodejs.org/dist/v24.16.0/)与 SHASUMS256；[许可](https://github.com/nodejs/node/blob/v24.16.0/LICENSE) |
| PowerShell | 7.6.7 Windows x64 ZIP | [微软发布包](https://github.com/PowerShell/PowerShell/releases/tag/v7.6.7)，MIT 与其附带第三方许可 |
| FFmpeg／FFprobe | Gyan 9.0.2 essentials | [FFmpeg 官方下载页](https://ffmpeg.org/download.html)列出的 [Gyan 构建](https://github.com/GyanD/codexffmpeg/releases/tag/9.0.2)，GPL；保留下载包内许可 |
| whisper.cpp | 1.7.6 CPU x64 | [项目发布包](https://github.com/ggml-org/whisper.cpp/releases/tag/v1.7.6)，MIT；固定 CPU 版，不依赖 GPU/CUDA |
| Whisper small 多语种模型 | GGML small，487,601,967 字节 | [whisper.cpp 模型仓库](https://huggingface.co/ggerganov/whisper.cpp)，固定 revision `5359861c739e955e79d9a303bcbc70fb988958b1` 和 LFS SHA-256；[Whisper 模型许可](https://github.com/openai/whisper/blob/main/LICENSE) |

Node 官方站连接失败或持续过慢时，使用 [node-bin-gen 发布的 npm 二进制包](https://github.com/aredridel/node-bin-gen)作为固定后备分发源。先校验固定压缩包，再只提取 node.exe，并按**同一个 Node 官方 SHA-256**校验；不运行 npm 安装脚本或压缩包内其他代码。后备源是社区分发，不冒称 Node 官方站。

工具和模型在首次使用时从上述来源获取，不随 Media Review ZIP 重新分发，也不因 Media Review 的 MIT 许可而改变各自许可。现有自选工具／模型仍需遵守对应来源的条款。

SHA-256 可核对下载内容，不能代替实际运行测试；首用必须经过真实中文语音识别。本版自动配置只验证 Windows x64；转写当前固定中文，不能据此宣称任意语言和系统均可用。
