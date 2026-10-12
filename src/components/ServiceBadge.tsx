import { Tooltip } from 'antd';
import { CheckCircleFilled, ExclamationCircleFilled, SyncOutlined } from '@ant-design/icons';
import type { ServiceState } from '../lib/use-service-status';

const LABEL: Record<ServiceState, string> = { connecting: '正在连接', online: '服务运行中', reconnecting: '连接暂慢 · 重试中', offline: '暂无法连接', incompatible: '版本／身份不匹配', restarted: '正在核验新会话' };
export function ServiceBadge({ state }: { state: ServiceState }) {
  return <Tooltip title={state === 'online' ? '本机服务连接正常；素材不上传云端' : '请保留当前输入，可用右侧“重启服务”按钮或桌面入口核验并按需重开；版本不匹配时不强行重启'}>
    <span className={`service-badge is-${state}`} role="status" aria-live="polite" data-service-state={state}>
      {state === 'online' ? <CheckCircleFilled aria-hidden /> : state === 'offline' || state === 'incompatible' ? <ExclamationCircleFilled aria-hidden /> : <SyncOutlined aria-hidden spin />}
      <span>{LABEL[state]}</span>
    </span>
  </Tooltip>;
}
