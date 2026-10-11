import { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Empty, Progress, Spin, Switch, Tooltip } from 'antd';
import { ANALYSIS_LABEL } from '../lib/analysis-status';
import type { AnalysisProgress } from '../lib/api';
import { ScissorOutlined } from '@ant-design/icons';
import { formatTime } from '../lib/review';
import { useEstimatedProgress } from '../lib/estimated-progress';

export type TranscriptFormat = 'srt' | 'vtt';

export interface TranscriptCue {
  startMs: number;
  endMs: number;
  text: string;
}

export interface TranscriptPanelProps {
  disabled?: boolean;
  mediaKey: string;
  cues: TranscriptCue[];
  status: 'loading' | 'ready' | 'unavailable';
  error: string;
  progress?: AnalysisProgress;
  elapsedMs?: number;
  onCancel?: () => void;
  onRetry?: () => void;
  currentMs: number;
  durationMs?: number;
  onSeek: (timeMs: number) => void;
  onMark: (cue: TranscriptCue) => void;
}

const MAX_CUES = 2_000;
const MAX_CUE_CHARACTERS = 2_000;
const TIMESTAMP = String.raw`\d{2,}(?::\d{2}){1,2}[,.]\d{1,3}`;
const TIMING_LINE = new RegExp(`^(${TIMESTAMP})[ \t]*-->[ \t]*(${TIMESTAMP})(?:[ \t]+.*)?$`);

function timestampToMs(value: string): number | null {
  const [clock, fraction] = value.split(/[,.]/);
  const parts = clock.split(':').map(Number);
  if (parts.length < 2 || parts.length > 3 || parts.some((part) => !Number.isFinite(part))) return null;
  const seconds = parts[parts.length - 1];
  const minutes = parts[parts.length - 2];
  if (seconds > 59 || (parts.length === 3 && minutes > 59)) return null;
  const hours = parts.length === 3 ? parts[0] : 0;
  const milliseconds = ((hours * 60 + minutes) * 60 + seconds) * 1_000 + Number(fraction.padEnd(3, '0'));
  return Number.isSafeInteger(milliseconds) ? milliseconds : null;
}

function readableCueText(value: string): string {
  // Common subtitle styling is removed as text. Unknown markup remains literal,
  // and React renders the result as text rather than inserting HTML.
  return value
    .replace(/<\/?(?:i|b|u|ruby|rt|c(?:\.[\w.-]+)?|v(?:\s+[^<>]*)?|lang(?:\s+[^<>]*)?)>/gi, '')
    .replace(/\{\\an\d+\}/g, '')
    .replace(/&(?:amp|lt|gt|quot|apos|nbsp);/gi, (entity) => {
      const decoded: Record<string, string> = {
        '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'", '&nbsp;': ' ',
      };
      return decoded[entity.toLowerCase()] ?? entity;
    })
    .trim();
}

/** Parse UTF-8 timecoded text returned by the local recognizer. */
export function parseTranscriptText(source: string, format: TranscriptFormat): TranscriptCue[] {
  const text = source.replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').trim();
  if (format === 'vtt' && !/^WEBVTT(?:[ \t].*)?(?:\n|$)/i.test(text)) {
    throw new Error('这个文件没有 WebVTT 标头，请选择正确的 .vtt 字幕。');
  }
  const vttHeader = text.split(/\n[ \t]*\n/, 1)[0];
  if (format === 'vtt' && /^X-TIMESTAMP-MAP\s*=/im.test(vttHeader)) {
    throw new Error('这个 VTT 含流媒体时间映射，当前不能保证与视频时间对齐。');
  }

  const blocks = text.split(/\n[ \t]*\n/);
  const cues: TranscriptCue[] = [];
  for (const block of blocks) {
    const lines = block.split('\n').map((line) => line.trim());
    const first = lines[0] ?? '';
    if (!first || (format === 'vtt' && /^(?:WEBVTT|NOTE(?:\s|$)|STYLE(?:\s|$)|REGION(?:\s|$))/i.test(first))) continue;
    const timingIndex = lines.findIndex((line, index) => index < 2 && line.includes('-->'));
    if (timingIndex < 0) continue;
    const match = lines[timingIndex].match(TIMING_LINE);
    if (!match) throw new Error('字幕里有无法识别的时间行，请检查 SRT / WebVTT 格式。');
    const startMs = timestampToMs(match[1]);
    const endMs = timestampToMs(match[2]);
    if (startMs === null || endMs === null || endMs <= startMs) {
      throw new Error('字幕里有结束时间早于开始时间的片段，请检查文件。');
    }
    const cueText = readableCueText(lines.slice(timingIndex + 1).join('\n'));
    if (!cueText) continue;
    if (cueText.length > MAX_CUE_CHARACTERS) throw new Error('有一条字幕过长，无法安全显示。');
    cues.push({ startMs, endMs, text: cueText });
    if (cues.length > MAX_CUES) throw new Error(`字幕超过 ${MAX_CUES} 条，请先拆成较短的文件。`);
  }
  if (cues.length === 0) throw new Error('没有找到带时间的字幕。请选择 SRT 或 WebVTT 文件。');
  return cues.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
}

export function TranscriptPanel({ disabled = false, mediaKey, cues, status, error, progress = { phase: 'preparing', percent: null }, elapsedMs = 0, onCancel, onRetry, currentMs, durationMs, onSeek, onMark }: TranscriptPanelProps) {
  const [followPlayback, setFollowPlayback] = useState(true);
  const listRef = useRef<HTMLDivElement | null>(null);
  const estimated = useEstimatedProgress(progress, status === 'loading', mediaKey);

  useEffect(() => {
    setFollowPlayback(true);
  }, [mediaKey]);

  const activeIndex = useMemo(() => {
    for (let index = cues.length - 1; index >= 0; index -= 1) {
      if (cues[index].startMs <= currentMs && currentMs < cues[index].endMs) return index;
    }
    return -1;
  }, [cues, currentMs]);

  useEffect(() => {
    if (!followPlayback || activeIndex < 0 || !listRef.current) return;
    const list = listRef.current;
    const item = list.children[activeIndex] as HTMLElement | undefined;
    if (!item) return;
    const listBounds = list.getBoundingClientRect();
    const itemBounds = item.getBoundingClientRect();
    const position = list.scrollTop + itemBounds.top - listBounds.top - (list.clientHeight - itemBounds.height) / 2;
    list.scrollTo({ top: Math.max(0, position), behavior: 'auto' });
  }, [activeIndex, followPlayback]);

  const exceedsMedia = !!durationMs && cues.some((cue) => cue.startMs >= durationMs || cue.endMs > durationMs + 1_000);

  return <section className="transcript-content" aria-label="字幕对照">
    <div className="panel-description"><span>本机自动识别 · 未校对</span><label className="transcript-follow"><Switch size="small" checked={followPlayback} onChange={setFollowPlayback} aria-label="字幕跟随播放" />跟随播放</label></div>
    {error && <p className="transcript-status error" role="alert">{error}</p>}
    {status === 'loading' && <div className="transcript-progress" data-phase={progress.phase} data-percent={progress.percent ?? ''} aria-busy="true">
      <div className="transcript-progress-title" role="status"><Spin size="small" /><strong>{ANALYSIS_LABEL[progress.phase]}</strong></div>
      {estimated.display !== null && <><div className="estimated-readout"><strong>预计 {estimated.display.toFixed(1)}%</strong></div><Progress percent={estimated.display} status="normal" showInfo={false} strokeColor="#b95337" /></>}
      <div className="transcript-progress-meta"><span>已用 {formatTime(elapsedMs, false)}</span>{onCancel && <Button type="text" size="small" onClick={onCancel}>停止识别</Button>}</div>
      <p>{progress.phase === 'queued' ? '多个任务共用一个重分析槽。这里只是排队，不表示识别已开始或已经通过；仍可手动校对。' : progress.phase === 'waiting-resources' ? '可用内存不足，已暂停重分析，不会结束其他程序。可以先播放和写意见，资源恢复后继续。' : estimated.silentMs > 90_000 ? '较长时间没有新进度回报。当前估算已接近上限；可以继续等候，或停止后重试，意见不受影响。' : progress.phase === 'loading-model' ? '本机正在加载语音模型，尚无可量化百分比。' : progress.phase === 'finalizing' ? '正在整理文字和时间码，结果返回前不会显示完成。' : '两次真实回报之间有限估算当前阶段；不是完成承诺，也不代表识别变快。仍可播放、选段和写意见。'}</p>
    </div>}
    {status === 'unavailable' && onRetry && <div className="transcript-retry"><Button size="small" onClick={onRetry} disabled={!durationMs}>重新识别台词</Button><span>重试不会清空意见或修改原媒体。</span></div>}
    {status === 'ready' && <p className="transcript-ready" role="status">已生成 {cues.length} 句台词 · 自动识别，未校对</p>}
    {exceedsMedia && <p className="transcript-status error" role="status">部分台词时间超出媒体，不能定位或标记；请核对是否同一版本。</p>}
    {cues.length > 0 ? <div className="cue-list" ref={listRef} data-lenis-prevent aria-label="按时间排列的字幕" onWheel={() => setFollowPlayback(false)}>
      {cues.map((cue, index) => {
        const active = index === activeIndex;
        const outside = !!durationMs && cue.startMs >= durationMs;
        return <div className={`cue-row ${active ? 'active' : ''}`} key={`${cue.startMs}-${cue.endMs}-${index}`}>
          <Button className="cue-jump" type="text" aria-label={`定位台词：${cue.text}`} aria-current={active ? 'true' : undefined} disabled={outside} onClick={() => onSeek(cue.startMs)}>
            <span className="cue-metadata"><span className="cue-number">{String(index + 1).padStart(2, '0')}</span><time>{formatTime(cue.startMs, false)}</time>{active && <span className="now-reading">当前</span>}</span>
            <span className="cue-text">{cue.text}{outside && '（超出时长）'}</span>
          </Button>
          <Tooltip title="标记这句的完整时间范围"><Button className="cue-select" type="text" size="small" icon={<ScissorOutlined />} aria-label={`标记第 ${index + 1} 句`} disabled={disabled || outside || (!!durationMs && cue.endMs > durationMs)} onClick={() => onMark(cue)} /></Tooltip>
        </div>;
      })}
    </div> : status !== 'loading' && <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="没有可对照的台词，仍可按时间标记" />}
    <div className="transcript-footnote">自动识别可能有误，文字与时间请回听原音核对。</div>
  </section>;
}
