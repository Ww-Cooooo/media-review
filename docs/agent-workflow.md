# 把 Media Review 接进 Agent 的出片循环

本文对应0.3.0-beta.3的`media-review-agent/v2`契约，基本异步契约沿用beta.2，不适用于旧beta.1的同步回执。Agent需要本机文件／进程权限，并能发现或显式读取Skill；纯网页聊天不能直接执行任意本机命令。校对页唤起已安装的固定本机入口，是另一条需安装配置及可能系统确认的路径，不授予聊天本机执行权限。安装不证明宿主已加载，Skill文本也不能强制所有宿主遵从。

## 首次接入与核验

以安装器回执给出的完整目录为准，不凭默认位置猜路径。在有本机执行权限的Agent聊天中替换占位符后发送：

> 请读取“<实际Skill目录>/SKILL.md”，将Media Review接入当前剪辑任务。先运行`node scripts/review.mjs doctor`，每个可审版本导出完成后主动执行`after-export --media "<成片绝对路径>" --request-id "<本轮新建并记住的UUID>" --label "<短来源>"`，同次重试沿用该UUID，记住返回的taskId与jobId，并查询真实自检结果。遵从browser回执，不另外新建浏览器窗口来证明送达，不切走用户正在审的片；只报告实际检查过的画面和声音。保留原片与既有版本，不自行发布。

源码方式读取仓库的`skill/SKILL.md`，从仓库根目录用`scripts/review-agent.mjs`替换上述`scripts/review.mjs`。这验证本次接入，不保证所有未来对话自动加载；权限被拒时不能用全局hook绕过。

## 出片后主动送达

成片已经成功导出且写入结束后，从完整Skill目录执行：

```sh
node scripts/review.mjs after-export --media "<成片绝对路径>" --request-id "<本轮新建并记住的UUID>" --label "<任务简短来源>"
```

源码目录使用`scripts/review-agent.mjs`。`request-id`可省略，此时每次调用新建任务；同一次调用重试应沿用UUID，防止重复建任务。新版本或独立意图使用新UUID，不按同名或相同内容合并用户意见。label只写短来源，不扫描聊天历史或放入秘密。

命令启动／复用同用户、同数据根的兼容服务，登记任务并排队自检，快速返回。它不是文件监控，不拦截任意剪辑器，也不安装全局hook。共享服务一次运行中只自动请求打开浏览器一次；心跳消失可能是窗口休眠，不据此再开页。后续任务进入列表，不能抢占当前媒体。

**不要接着调用宿主browser.open或新建tab。** `browser.open=true`是入口已请求系统打开，不是Agent已看见窗口；false不等于任务没送到。任务送达用taskId和任务查询确认。自检使用本对话安全持有的页面或实际生成的工具证据；没有可复用页面时，不为每轮检查打断用户窗口。确有独立自动化检查需要时说明用途，并只清理自己创建的上下文。用户明确要求重开某项任务时用`open --task "<taskId>"`（beta.3），不另建任务；给用户返回本轮`taskUrl`及本机启动入口，`url`仅代表共用校对室，不能用它代替具体对话的任务链接。入口不能保证系统聚焦既有tab。

自动化或不需要打开系统浏览器时可加`--no-browser`，仍建任务、排队。Agent工作结束不要默认`quit`；用户可能稍后才回来。

### 回执与异步查询

下面是字段含义，不是伪造的运行结果：

| 字段 | 含义与下一步 |
| --- | --- |
| `pass`、`contract` | 入口交接成功与契约版本；不是自检通过或用户认可 |
| `task.id`、`task.label` | 本轮独立任务及来源；后续查询、取消、导出按它归属 |
| `url`、`taskUrl`、`reused` | 实际本机入口、具体任务链接与服务是否复用，不自己猜端口 |
| `browser.open`、`browser.requested`、`browser.reason` | 打开许可／请求及原因；不据此声称已查看页面，不二次开页 |
| `inspection.id`、`inspection.state` | 自检作业ID与真实排队／运行状态；不是同步证据 |

```sh
node scripts/review.mjs status --task "<taskId>" --job "<jobId>" --result
node scripts/review.mjs tasks
node scripts/review.mjs summary
```

`status`省略job时查该任务最近一次inspection，不用全局current猜对话归属。按状态合理间隔查询，不常驻CLI或忙轮询：

- `queued`、`running`、`waiting-resources`：仍在排队／执行／等资源，不能说已检查完成。
- `completed`：从`job.result`读取真实结果。自检`status=limited/needs-check/evidence-ready`分别表示能力受限、需进一步检查、工具证据产生，不是审美通过。
- `failed`、`cancelled`、`interrupted`：未完成，明确原因后才重试。
- `expired`：可重建的波形／台词结果已回收，需明确重试；正式意见与self-checks证据没按缓存删除。
- 入口`inspection.state=not-queued`：任务仍已登记，但分析拒绝入队；标准输出保留任务回执、退出码为2，不要重新建同一任务来掩盖失败。

参数／启动错误返回非零退出码。没有有效结构化回执时不能宣布送达；保留现有资料，补齐明确条件，不杀未知服务或覆盖成片。

### 原任务重试，不另建任务

自检失败、中断、未能入队或需要复查时，保留原成片和任务，在完整Skill目录执行：

```sh
node scripts/review.mjs self-check --media "<原成片绝对路径>" --request-id "<原taskId>" --label "<原task.label>" --title "<原task.title>"
```

这里的占位符来自原回执；标题和来源须与原登记完全相同；原来源为空时省略`--label`，不要传空字符串。当前契约的taskId就是登记requestId。源码入口替换为`scripts/review-agent.mjs`。活动分析返回原job，已终止的分析取得新jobId；完成结果会重新核验完整媒体内容，配置一致时可能复用缓存，不表示强制重跑全部工具。记录新回执再用`status --task ... --job ... --result`查询，不用新UUID掩盖失败。源文件已经变化时应登记新版本，不沿用旧任务。网页波形／台词使用“重新识别台词”重试当前任务，不需要重新送片。

## Agent自己也要校对

完成后读取`job.result.reportPath`及`job.result.frameDirectory`中的实际报告／代表帧，或安全复用已持有页面检查本轮媒体。仅看代表帧不能声称看过完整动态或听过全片。工具缺失、未实际播放、未回听、字幕未校正，分别写成未验证项。

FFmpeg解码、黑场／静音检测和取帧只能提供对应工具证据；有意黑场或停顿不直接判错。语义、美感、录屏可读性、听感和事实需要真实观察。self-checks资料带`origin:agent`、`userApproved:false`，与用户意见分开；不把命令退出、模型完成或自动送片当作用户认可／发布授权。

## 用户实际交接后返修

1. 收到用户实际发送的请求后，读取当次记录及其引用的参考图，以实际记录路径和任务为准，不遍历所有历史。
2. 核对源媒体。旧review记录的fingerprint是大小＋首尾256KiB抽样SHA-256，不等于完整摘要；新任务会在服务读取／分析后绑定完整摘要。不能仅按同名认版本，不能凭抽样身份复用分析缓存。
3. 时间以当前文件0秒为起点，不猜在另一原片中的偏移；参考帧时间与区间起点独立，坐标相对完整画幅。
4. 修改逐条处理，保留不误动，待讨论不擅自批准；缺图回源核对，不补假截图。已知源文件直接核对，只补问真正缺失的位置。
5. 另行输出返修成片，不覆盖原媒体、既有成片或旧意见。新版本再次送达并取得新taskId。

保存、复制、Agent自检和测试资料都不自动授权返修、上传或发布。任务ID与来源不自动绑定原聊天或跨聊天发送消息；用户需把交接发送到负责该任务的对话。应用没有整片认可或发布按钮，用户明确认可和发布授权以实际聊天表态分别判断，不能把保留项、结束任务或工具通过自动映射为认可。

## 取消、结束与退出

```sh
node scripts/review.mjs cancel --task "<taskId>" --job "<jobId>"
node scripts/review.mjs end-task --task "<taskId>" --confirm
node scripts/review.mjs quit
```

取消只撤回该任务的分析需求，其他共享归属可继续。结束任务只结束等待，不删除或认可；有其他窗口使用时拒绝默认结束，先让其保存／挂起，或在用户明确要求后使用`--confirm-other-windows`。

`quit`不带确认只显示全局使用情况。用户明确要求退出整个服务后才加`--confirm`；`--keep-drafts`只允许在有窗口报告未保存时退出，不替那些窗口保存，也不关闭浏览器。未回传的最后输入不能保证迁移成功。旧版退出与升级见[Windows安装说明](install-windows.md)。

## 诊断与返修资料包

```sh
node scripts/review.mjs doctor
node scripts/review.mjs self-check --media "<成片绝对路径>"
node scripts/review.mjs export --task "<taskId>" --fingerprint "<媒体指纹>" --out "<新的输出目录>"
```

self-check也走共享队列，默认不开网页。doctor只报告工具可用性与有记录的退出状态，不打印令牌、环境全文或完整进程参数，不下载。异常退出只能记录为原因未确认，不能凭没有退出记录判断用户为什么终止它。

新任务导出必须带taskId；只有旧版全局资料才省略。资料包含清单、结构化意见与相对参考图，不默认包含原媒体、其他任务、恢复缓存或绝对源路径；不会上传或执行，也不覆盖已有输出目录。指纹可从该任务正式JSON或交接弹窗取得；普通用户用侧栏“导出返修资料包”，不需要查这些字段。
