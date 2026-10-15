import { useEffect, useState } from 'react';
import { Alert, Button, Descriptions, Tag } from 'antd';
import { request } from '../lib/api';

interface Readiness { runtime: string; baseVersion: string; localRevision: string | null; node: string; ffmpeg: boolean; whisper: boolean; model: boolean; host: string; playback: string; publication: string; toolsHelp: string }
export function ReadinessPanel() {
  const [data, setData] = useState<Readiness | null>(null), [error, setError] = useState('');
  const refresh = async () => { try { setData(await request<Readiness>('/api/session/readiness', {})); setError(''); } catch (cause) { setError(cause instanceof Error ? cause.message : '本机状态暂不可读'); } };
  useEffect(() => { void refresh(); }, []);
  return <section aria-label="本机可用性"><Button onClick={() => void refresh()}>重新检查本机状态</Button>{error && <Alert type="warning" title={error} />}{data && <><Descriptions bordered column={1} size="small" styles={{ label: { width: 112, whiteSpace: 'nowrap' } }} items={[
    { key: 'version', label: '运行版本', children: <>{data.baseVersion}<br />运行修订：{data.runtime}{data.localRevision && <><br />本机定制：{data.localRevision}</>}</> },
    { key: 'distribution', label: '版本来源', children: data.publication },
    { key: 'host', label: 'Agent 接入', children: data.host },
    { key: 'play', label: '播放与标注', children: data.playback + '；手动标注、保存和导出不依赖转写工具。' },
    { key: 'wave', label: '波形与取帧', children: <><Tag color={data.ffmpeg ? 'success' : 'warning'}>{data.ffmpeg ? '工具已就绪' : '缺少 FFmpeg'}</Tag>处理结果还需按文件检查。</> },
    { key: 'transcript', label: '自动台词', children: <><Tag color={data.ffmpeg && data.whisper && data.model ? 'success' : 'warning'}>{data.ffmpeg && data.whisper && data.model ? '工具已就绪' : '工具未齐备'}</Tag>{!data.whisper && '缺少识别器；'}{!data.model && '缺少语音模型；'}可直接导入已有字幕。</> },
    { key: 'runtime', label: '本机环境', children: `Node.js ${data.node}` },
  ]} /><p>{data.toolsHelp}</p>{data.localRevision && <Alert type="info" title="升级请保留本机改进" description="当前版本带有本机定制。升级前应比较差异并保留当前副本。" />}</>}</section>;
}
