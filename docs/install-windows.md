# Windows 安装与首次校对

本说明面向已经取得完整 Media Review 安装 ZIP 的用户。源码仓库中的 `skill/` 只是模板；完整包应同时包含 `skill-package.json`、`app/`、`scripts/`、SKILL.md、README 和安装入口。

## 准备运行环境

- Node.js 24 或更新版本，用于运行本机服务。从 [Node.js 24 官方下载目录](https://nodejs.org/dist/latest-v24.x/)选择 Windows `.msi` 安装版；常见 x64 电脑选文件名以 `-x64.msi` 结尾的包，ARM64 电脑需对应的 `-arm64.msi`，后者未在本项目完成同等验证。安装时保留 npm 组件，供源码构建使用；完整安装包运行不需要 npm。
- PowerShell 7 或更新版本，按[微软官方 Windows 安装说明](https://learn.microsoft.com/zh-cn/powershell/scripting/install/install-powershell-on-windows)使用官方安装包。命令是 `pwsh`，它与 Windows PowerShell 5.1 并存，不能用后者代替。
- Microsoft Edge、Chrome 等支持素材编码的现代浏览器。

在终端检查：

```sh
node --version
pwsh --version
```

找不到命令时先安装对应运行环境并重新打开终端。Media Review 不自动下载运行环境、媒体工具或模型。

## 安装

1. 将完整 ZIP 解压到普通本机目录，不要只取出 SKILL.md。
2. 双击“安装 Media Review.cmd”。默认安装到当前用户的 `.claude/skills/media-review`，并创建“Media Review”桌面快捷方式。
3. 等待安装器明确报告 Skill 和桌面入口就绪，再双击图标打开。无需管理员权限，不设置开机启动、不改其他 Skill。

如果目标已有不同版本或本机修改，安装器会保留原内容并停止，不自动覆盖升级。先备份并选择新位置，不要删除旧数据来绕过提示。

仅复制完整包到其他宿主 Skill 目录的用户，首次运行“初始化桌面入口.cmd”补建图标。复制本身不会执行脚本或创建快捷方式，宿主是否发现 Skill 仍由宿主决定。

## 保存第一条意见

1. 打开浏览器能播放的视频或音频。
2. 暂停在要修改的位置，点击“标记时间点”，写一条意见。
3. 点击“保存这条意见”。写入并回读确认后，表单进入空白新意见。
4. 回到主页，在“校对历史”查看正式意见数量，点“打开记录文件夹”找到 JSON。

整轮完成时点击“保存并交给 Agent”，复制后回聊天实际发送请求，才交给 Agent 返修。没有 Agent 也能使用校对室，导出的返修资料可以交给剪辑人员。

## 可选工具与其他目录

从完整包目录执行，参数中的占位符需换成实际路径；路径中有空格时保留引号。`-Destination` 是**这个 Skill 包自身的完整目标目录**，不是上一级 `skills` 父目录；安装器不会自动再补一层 `media-review`。例如宿主的发现目录是 `<宿主的skills目录>`，目标可填 `<宿主的skills目录>\media-review`：

```powershell
pwsh -NoProfile -File .\scripts\install.ps1 -Destination "<宿主的skills目录>\media-review" -Ffmpeg "<ffmpeg.exe的绝对路径>" -Whisper "<whisper-cli.exe的绝对路径>" -Model "<离线模型的绝对路径>"
```

这些工具是可选的；只需指定已有且要使用的文件，可以省略未准备的参数。绑定只写入本机私有 `tools.json`，不进入分享包；已有绑定不会静默替换。安装器的 `-DesktopDirectory` 只用于明确指定快捷方式目录，例如隔离测试；不需要普通用户设置。

没有分析工具时仍可播放、手动标注、保存与交接。波形和转写会提示不可用，不会假装已分析。

### 分析工具接入范围

- FFmpeg 可从本机 PATH 查找，或用 `-Ffmpeg` 指定。Agent 解码／代表帧自检还要求同一目录中有 `ffprobe.exe`；`doctor` 不单独证明 FFprobe 已就绪，具体结果以自检报告为准。
- 语音入口是 **whisper.cpp 的 `whisper-cli`**，不是任意同名 Whisper 库或云端 API。当前实现使用 `-m`、`-f`、`-osrt`、`-of`、`-pp`、`-ng` 参数，模型应是该 CLI 能加载的 GGML `.bin` 模型；现有流程使用 small 模型，不自动替用户选模型或下载模型。
- 当前转写固定以 `-l zh` 调用，未提供语言选择控件；不要将它理解为任意语种／任意 CLI 版本均已验证。
- 本机检查环境为 Windows x64、Node.js 24、PowerShell 7 与 Edge。其他系统架构、浏览器编码组合和任意媒体工具发行版没有同等验收；Chrome 是建议浏览器，不等于所有 Chrome 版本／编码均测试通过。

工具是否找到、自检是否完成、台词是否准确和用户认可分别判断。不能因工具有文件名就宣布分析通过。

## 服务断开或重开

出现红色“服务已断开／会话已失效”时，当前不能确认保存。请保留旧页面，不要刷新或关闭，再双击桌面入口。服务正常时复用，失效时按需启动；启动文件会打开当前有效网址，不要收藏临时端口。

Agent 登记的文件可自动重开。手选文件要重新选择同一文件，再恢复已确认的位置和草稿。未确认的最后输入、清理浏览器缓存、原文件变化或端口冲突不能保证零损失；恢复副本也不是正式保存。

默认私有数据在用户主目录的 `.media-review-desk/data`，不在安装程序文件夹。迁移时应自行备份该目录及原媒体，不能仅复制程序就声称已迁移用户资料。
