import type { HandoffRound } from './review-product';
import { formatTime, type ReviewRecord } from './review.ts';

export interface ReviewSaveReceipt {
  saved: boolean;
  fileName: string;
  recordPath: string;
  savedAt: string;
  record: ReviewRecord;
  revision?: string;
}

export interface ReviewHandoff {
  record: ReviewRecord;
  recordPath: string;
  savedAt: string;
  text: string;
}

export function verifySaveReceipt(value: ReviewSaveReceipt, expected: ReviewRecord): ReviewSaveReceipt {
  if (!value || value.saved !== true) throw new Error('服务没有确认保存，意见仍在页面，请重试。');
  const fileName = `${expected.media.fingerprint}.review.json`;
  if (value.fileName !== fileName || value.record?.format !== expected.format ||
      JSON.stringify(value.record) !== JSON.stringify(expected)) {
    throw new Error('保存回读的内容与当前意见不一致，未生成交接内容，请重试核对。');
  }
  if (typeof value.recordPath !== 'string' || !/^(?:[A-Za-z]:\/|\/)/u.test(value.recordPath) ||
      /[\r\n\0]/u.test(value.recordPath) || !value.recordPath.endsWith(`/${fileName}`) ||
      typeof value.savedAt !== 'string' || !Number.isFinite(Date.parse(value.savedAt))) {
    throw new Error('保存回执缺少有效的记录位置或时间，未生成交接内容，请重新打开审阅台后重试。');
  }
  return value;
}

export function createReviewHandoff(receipt: ReviewSaveReceipt, round?: HandoffRound): ReviewHandoff {
  const { record, recordPath, savedAt } = structuredClone(receipt);
  const { media, notes } = record;
  const counts = ['modify', 'keep', 'discuss'].map(kind => notes.filter(note => note.kind === kind).length);
  const noChanges = record.completion?.outcome === 'no-changes';
  const text = [
    noChanges ? `我已完成对${JSON.stringify(media.name)}的本轮审阅，没有意见。请读取下列记录确认结果；无需据此生成返修版，此结果不代表上传或发布许可。` : `我已完成对${JSON.stringify(media.name)}的本轮审阅。请读取本机意见记录，按以下要求开始处理。`,
    '',
    ...(round ? [`任务 ID：${round.taskId}`, `意见修订：${round.revision}`, `作品版本：V${round.version.number}；来源对话：${round.sourceLabel}`, '这份路径是固定交接快照；后续编辑不会改变这一轮。'] : []),
    `记录路径：${JSON.stringify(round?.recordPath ?? recordPath)}`,
    `媒体身份：${media.size} 字节；时长 ${formatTime(media.durationMs)}；指纹 ${media.fingerprint}`,
    `本轮保存：${savedAt}；共 ${notes.length} 条意见（修改 ${counts[0]}、保留 ${counts[1]}、待讨论 ${counts[2]}）。`,
    '',
    ...(noChanges ? ['仅确认本轮审阅结果，不自动修改、上传或发布。'] : [
    'scope 为 whole 的条目是整片意见，startMs/endMs 为 null；请按整片理解，不要当作 0 秒问题。',
    '先核对记录与源素材的媒体身份，不要只凭文件名认素材。时间以被审文件的 0 秒为起点；画面矩形是相对实际画幅的归一化坐标，精确剪点请回到源素材核对。记录未提供独立参考帧或截图时，不要猜补。',
    '如意见包含 reference，frameMs 是独立参考帧时间，不是时间段起点；参考图在意见记录同目录的 references/<媒体指纹>/<reference.fileName>，以完整画幅和归一化矩形共同定位。缺失图片时保留原意见并回源核对，不把其他帧当作原截图。',
    '如意见包含 regions，每个区域的 id 对应画面编号，text 是可选的该框说明；没有单独说明时使用本条共用文字，rect 是该区域的归一化坐标。同一条意见的时间段、参考帧和多个区域须一并处理；旧记录的单个 rect 仍有效。',
    '先回报收到的任务 ID、意见修订、意见条数和待澄清项；通过 acknowledge 保存接手回执。使用 progress 逐条记录返修状态、实际新版和说明，不能代用户确认。',
    '修改项请逐条返修，保留项不要误动，待讨论项先和我确认。忠于我的原话和意见，不自行改变含义。',
    '如果无法确定源素材位置，只向我补问缺少的文件位置，不要要求我重写全部意见。',
    '交付新版本，并逐条说明意见如何处理；不要覆盖原素材、已有成片或原意见记录，不要自行上传或发布。',
    ]),
  ].join('\n');
  return { record, recordPath, savedAt, text };
}
