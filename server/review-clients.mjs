import { randomUUID } from 'node:crypto';
import { ReviewError } from './runtime.mjs';
import { taskIdentity } from './review-tasks.mjs';

export class ReviewClients {
  constructor({ now = () => performance.now(), leaseMs = 90_000, clientMs = 120_000, maxClients = 64 } = {}) {
    this.now = now; this.leaseMs = leaseMs; this.clientMs = clientMs; this.maxClients = maxClients;
    this.clients = new Map(); this.leases = new Map(); this.openedAt = -Infinity; this.primaryId = null; this.presented = false;
  }
  prune() {
    const at = this.now();
    for (const [id, item] of this.clients) if (at - item.seen > this.clientMs) this.clients.delete(id);
    for (const [scope, item] of this.leases) if (at >= item.until) this.leases.delete(scope);
    if (!this.clients.has(this.primaryId)) this.primaryId = this.clients.keys().next().value ?? null;
  }
  heartbeat({ clientId, taskId = null, visible = true, dirty = false }) {
    taskIdentity(clientId); if (taskId !== null) taskIdentity(taskId);
    if (typeof visible !== 'boolean' || typeof dirty !== 'boolean') throw new ReviewError('窗口状态无效', 'invalid_client', 400);
    this.prune();
    if (!this.clients.has(clientId) && this.clients.size >= this.maxClients) throw new ReviewError('已连接窗口达到上限，请关闭不再使用的校对页', 'client_capacity', 429);
    this.clients.set(clientId, { seen: this.now(), taskId, visible, dirty });
    for (const item of this.leases.values()) if (item.clientId === clientId) item.until = this.now() + this.leaseMs;
    this.presented = true; this.primaryId ??= clientId;
    return { connected: true, clients: this.clients.size, primary: this.primaryId === clientId };
  }
  claim(scope, clientId, takeover = false) {
    taskIdentity(clientId); this.prune();
    if (!this.clients.has(clientId)) this.heartbeat({ clientId });
    const old = this.leases.get(scope);
    if (old && old.clientId !== clientId && !takeover) return { editing: false, owner: old.clientId, leaseId: null };
    for (const [key, item] of this.leases) if (key !== scope && item.clientId === clientId) this.leases.delete(key);
    const next = old?.clientId === clientId ? old : { clientId, leaseId: randomUUID() };
    next.until = this.now() + this.leaseMs; this.leases.set(scope, next);
    return { editing: true, owner: clientId, leaseId: next.leaseId };
  }
  assert(scope, context) {
    this.prune(); const lease = this.leases.get(scope);
    if (!context && !lease && scope.startsWith('legacy:')) return;
    if (!lease || lease.clientId !== context?.clientId || lease.leaseId !== context?.leaseId) throw new ReviewError('编辑权已在另一窗口或已过期；本页草稿保留，请重新连接或明确接管后核对版本。', 'edit_lease_lost');
    lease.until = this.now() + this.leaseMs;
  }
  release(clientId, scope = null) {
    taskIdentity(clientId);
    for (const [key, item] of this.leases) if (item.clientId === clientId && (!scope || scope === key)) this.leases.delete(key);
    if (!scope) this.clients.delete(clientId);
    return { released: true };
  }
  summary() {
    this.prune(); return { windows: this.clients.size, unsavedWindows: [...this.clients.values()].filter(item => item.dirty).length };
  }
  taskUse(taskId, excludeClient = null) {
    this.prune();
    const others = [...this.clients.entries()].filter(([id, item]) => id !== excludeClient && item.taskId === taskId);
    return { windows: others.length, unsavedWindows: others.filter(([, item]) => item.dirty).length };
  }
  browserClaim(force = false) {
    this.prune(); const at = this.now();
    if (at - this.openedAt < 1500 || !force && this.presented) return { open: false, reason: '任务已送达共用校对室，不再次打开或切走当前素材；窗口可能休眠，不能凭心跳消失判断已关闭。需要重开时请使用桌面入口。' };
    this.presented = true; this.openedAt = at; return { open: true };
  }
}
