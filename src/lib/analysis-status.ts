import type { AnalysisProgress } from './api';

export const ANALYSIS_LABEL = {
  preparing: '正在准备本机任务',
  uploading: '素材传送到本机',
  decoding: '正在读取音轨',
  waveform: '正在生成声音波形',
  'loading-model': '正在加载语音模型',
  transcribing: '正在识别台词',
  finalizing: '正在整理台词和时间码',
};

export function analysisText(progress: AnalysisProgress): string {
  return `${ANALYSIS_LABEL[progress.phase]}${progress.percent === null ? '' : ` · ${progress.percent}%`}`;
}
