import { Tooltip } from 'antd';
import { CheckCircleFilled, ExclamationCircleFilled, SyncOutlined } from '@ant-design/icons';
import type { ServiceState } from '../lib/use-service-status';

const LABEL: Record<ServiceState, string> = { connecting: '正在连接', online: '服务运行中', reconnecting: '连接中断 · 重连中', offline: '服务已断开', incompatible: '连接已失效', restarted: '会话已失效' };
export function ServiceBadge({ state }: { state: ServiceState }) {
  return <Tooltip title={state === 'online' ? '本机服务连接正常；素材不上传云端' : '请保留当前输入，双击桌面的“Media Review”或启动文件重开'}>
    <span className={`service-badge is-${state}`} role="status" aria-live="polite" data-service-state={state}>
      {state === 'online' ? <CheckCircleFilled aria-hidden /> : state === 'offline' || state === 'incompatible' || state === 'restarted' ? <ExclamationCircleFilled aria-hidden /> : <SyncOutlined aria-hidden spin />}
      <span>{LABEL[state]}</span>
    </span>
  </Tooltip>;
}
