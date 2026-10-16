# 从本轮意见到新版复核

收到用户实际发送的交接后，或正在返修出新版时读本文件。页面保存、复制、工具回执都不能替用户授权返修或发布。以下命令均从已安装 Skill 根目录运行；源码仓库使用 scripts/review-agent.mjs 替代 scripts/review.mjs。

## 1. 固定本轮输入，确认接手

交接文字给出 taskId、意见修订 revision、作品版本、来源对话和不可变快照路径。先读这一轮：

```text
scripts/review.cmd round --task "<taskId>" --revision "<revision>"
scripts/review.cmd progress --task "<taskId>"
```

`round.record` 是用户交回的固定意见；`progress.recordRevision` 是当前正式意见修订。两者不同时，不把旧轮结果套进新意见。回读最新变化并明确当前要处理哪轮；已经有用户明确范围则照该范围做，无法确定的差异才问。快照不是可编辑真源，不写回快照或用户意见。

向用户简短回报收到哪项任务、多少条修改/保留/待讨论意见、哪些需要澄清；用接手对话的可识别短名登记回执，不扫描别的聊天寻找名称：

```text
scripts/review.cmd acknowledge --task "<taskId>" --revision "<revision>" --agent "<接手对话短名>" --clarify "<待澄清意见ID,另一ID>" --text "<收到的范围和缺项>"
```

没有待澄清意见则省略 `--clarify`。回执保存了确切收到的意见 ID，不把它说成已经返修。工具不可用时继续能完成的真实业务，但说明进度登记未完成，不伪造成功。

## 2. 按原意见处理

- `scope: whole` 表示整片；起止时间为 null，不是 0 秒。
- `startMs/endMs` 是旧版范围；`reference.frameMs` 是独立参考帧。参考图按该轮记录目录解析 `references/<fingerprint>/<fileName>`。
- `regions[].id` 是稳定编号，删除后可能是 1、3、4；不能重新编号。可选 `regions[].text` 对应这一框，没有文字时使用整条 `text`；两者共同构成意见，冲突才澄清。
- “修改/保留/待讨论”是意图；“待处理/待澄清/已修改待复核/用户确认”是进度。保留项不得为了完成进度而改动；待讨论项不能擅自执行。
- 参考图缺失时保留原意见并回源核对；不能把重新取的另一帧冒充原参考图。精准剪点需回原媒体检查，浏览器细步和显示时间不保证帧级精度。

需要澄清时登记具体问题，其他已明确且不依赖该答案的项可继续：

```text
scripts/review.cmd progress --task "<原任务ID>" --revision "<revision>" --note "<意见ID>" --state clarify --text "<具体缺项及其影响>"
```

## 3. 新版必须关联原版

完成真实返修并导出后，原成片和原意见不覆盖。每个新版本用新 request-id，同一调用重试沿用原 ID：

```text
scripts/review.cmd after-export --media "<新版绝对路径>" --request-id "<新UUID>" --label "<当前对话短名>" --previous-task "<直接上一版taskId>" --check-times "<新版修改位置毫秒,另一位置>"
```

先记录返回的新 task.id，再按 job.id 查询自检实际完成状态。`--previous-task` 只是版本关系，不迁移旧坐标。`--check-times` 必须来自新版实际位置，不能直接照抄旧时间；无可靠映射时省略并写明定位未核实。指定位置会在默认代表帧之外补取帧，最多 100 个；越出新片长度的位置会列为未覆盖。只看静帧不能证明动态、声音和字幕都检查过。

随后逐条登记做了什么，关联真实新版；`--at` 是可选的新版毫秒位置，必须在已核实的新片时长内：

```text
scripts/review.cmd progress --task "<原任务ID>" --revision "<revision>" --note "<意见ID>" --state changed --text "<原问题、实际处理、仍有的限制>" --target "<新版taskId>" --at "<新版毫秒位置>"
```

例如“将字幕上移约一行，位于 V2 的 00:04.200；原人物位置保留”比“已优化”可核查。对保留项，说明“按要求保留并核对”的实际证据，不写成改动。`changed` 仅表示已提交结果等待用户复核；Agent 不能写入 `confirmed`。用户可在新版的“版本与返修”中定位结果、回看原意见、确认或重新打开。意见内容修改后，旧处理状态自动成为待重新核对的历史。

## 4. 自检必须有范围与实际观察

先读工具报告和实际帧，必要时播放修改前后片段、回听声音、核对字幕。根据修改影响选择范围：局部字幕位置核相应画面及进出场；配乐改动需听修改段和衔接；全片字号或音量等全局修改应覆盖整片或说明抽查范围。每条明确的保留意见也要核对是否误动；不能只检查修改项。

用 `check-report` 登记实际检查，不为填满表格宣称已看或已听。写一个 UTF-8 JSON 文件，再提交：

```text
scripts/review.cmd check-report --task "<新版taskId>" --report "<报告JSON绝对路径>"
```

报告结构（这是字段示例，执行时必须换成真实观察）：

```json
{
  "coverage": [
    { "startMs": 3200, "endMs": 5200, "aspects": ["visual", "subtitle"], "result": "checked", "detail": "播放此段，核对字幕与人物间距以及字幕进出场。" },
    { "startMs": 0, "endMs": 12000, "aspects": ["audio"], "result": "unverified", "detail": "尚未实际试听，不能判断听感。" }
  ],
  "findings": "记录实际发现；没有发现只限于已检查范围。",
  "notVerified": "明确写出尚未核实的内容及下一步。",
  "keptNotes": [
    { "taskId": "<保留意见所属任务ID>", "recordRevision": "<该轮交接revision>", "noteId": "<保留意见ID>", "result": "checked", "detail": "核对原片与新版，指定镜头和原声保持。" }
  ]
}
```

`aspects` 可用 visual/audio/subtitle/pace；`result` 可用 checked/issue/unverified。没有保留意见时 keptNotes 用空数组。有未核实的保留项就写 unverified 和原因，不省略成“已全部保留”。检查报告独立于用户意见，固定 `origin: agent`、`userApproved: false`；工具解码、黑场/静音检测与取帧证据也不自动变成人工检查结果。

## 5. 交付与故障处理

交付新版 taskUrl、逐条处理结果及未解决项，等待用户复核。无需再新建浏览器窗口证明送达，也不结束共用服务。没有意见的完成结果无需虚构返修版；审阅完成、用户确认和允许发布仍是不同状态。

冲突时刷新原任务和进度，保留本次文字，核对变化后重试一次。不要不断重试旧 revision，也不要直接编辑进度 JSON 绕过版本核验。只影响当前条目时继续独立部分。

导出的 `返修清单.html` 可在浏览器直接阅读；`annotated/` 是嵌入原图的编号框 SVG，`references/` 保留原始截图，`review.json` 保留全部坐标与分框说明。资料包不含原媒体，不自动上传。“本机可用性”页和 `readiness` 显示当前工具状态、运行版本及本机定制信息；它不查询 GitHub 最新版本，也不能证明当前聊天已经加载 Skill。
