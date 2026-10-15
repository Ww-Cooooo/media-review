import type { ReviewNote, MediaIdentity } from './review';
import type { ReviewDraft } from './review-draft';
import type { ReviewContext } from './api';

export interface ReviewWorkspace {
  format: 'media-review-workspace/v1' | 'media-review-workspace/v2' | 'media-review-workspace/v3' | 'media-review-workspace/v4'; media: MediaIdentity; currentMs: number;
  notes: ReviewNote[]; baseNotes: ReviewNote[]; dirty: boolean;
  newDraft: ReviewDraft; editDraft: ReviewDraft; parked: ReviewDraft[];
  view: { kind: 'new' } | { kind: 'detail' | 'edit'; id: string };
}
interface Cached { at: number; workspace: ReviewWorkspace; taskId?: string; clientId?: string; fingerprint?: string }
function database(rootId: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const request = indexedDB.open(`media-review-recovery-${rootId}`, 3);
    request.onupgradeneeded = () => {
      const store = request.result.objectStoreNames.contains('workspaces') ? request.transaction!.objectStore('workspaces') : request.result.createObjectStore('workspaces');
      if (!store.indexNames.contains('task-time')) store.createIndex('task-time', ['taskId', 'fingerprint', 'at']);
      if (!request.result.objectStoreNames.contains('usage')) {
        const usage = request.result.createObjectStore('usage'); let count = 0, bytes = 0;
        const cursor = store.openCursor();
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (item) { count++; bytes += new Blob([JSON.stringify(item.value)]).size; item.continue(); }
          else usage.put({ count, bytes }, 'total');
        };
      }
    };
    request.onsuccess = () => { if (settled) request.result.close(); else { settled = true; resolve(request.result); } };
    request.onerror = () => { settled = true; reject(new Error('浏览器恢复存储不可用')); };
    request.onblocked = () => { settled = true; reject(new Error('另一旧页面正在使用恢复存储，请保留输入后关闭旧版页面')); };
  });
}
const cacheKey = (fingerprint: string, context?: ReviewContext) => context ? `${context.taskId ?? 'legacy'}:${fingerprint}:${context.clientId}` : fingerprint;
export async function cacheWorkspace(rootId: string, workspace: ReviewWorkspace, context?: ReviewContext): Promise<void> {
  const db = await database(rootId);
  try { await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction(['workspaces', 'usage'], 'readwrite');
    const store = transaction.objectStore('workspaces'), usage = transaction.objectStore('usage');
    const key = cacheKey(workspace.media.fingerprint, context), previous = store.get(key), total = usage.get('total');
    const value = { at: Date.now(), workspace, taskId: context?.taskId ?? 'legacy', clientId: context?.clientId ?? '', fingerprint: workspace.media.fingerprint };
    let failure = '';
    const update = () => {
      if (previous.readyState !== 'done' || total.readyState !== 'done') return;
      const before = total.result ?? { count: 0, bytes: 0 };
      const count = before.count + (previous.result ? 0 : 1);
      const bytes = before.bytes - (previous.result ? new Blob([JSON.stringify(previous.result)]).size : 0) + new Blob([JSON.stringify(value)]).size;
      if (count > 1024 || bytes > 256 * 1024 * 1024) { failure = '浏览器恢复资料已达1024份或256MiB，请先保存到本机并整理旧资料；未自动删除草稿'; transaction.abort(); return; }
      store.put(value, key); usage.put({ count, bytes }, 'total');
    };
    previous.onsuccess = update; total.onsuccess = update;
    transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(new Error('浏览器恢复副本未能保留')); transaction.onabort = () => reject(new Error(failure || '浏览器恢复副本写入中断'));
  }); } finally { db.close(); }
}
export async function cachedWorkspace(rootId: string, fingerprint: string, context?: ReviewContext): Promise<Cached | null> {
  const db = await database(rootId);
  try { return await new Promise((resolve, reject) => {
    const store = db.transaction('workspaces').objectStore('workspaces'), own = store.get(cacheKey(fingerprint, context));
    own.onsuccess = () => {
      if (own.result || !context) { resolve(own.result ?? null); return; }
      // 仅选同任务的最新恢复副本，一次取一份，不把所有截图副本读入内存。
      const range = IDBKeyRange.bound([context.taskId ?? 'legacy', fingerprint, 0], [context.taskId ?? 'legacy', fingerprint, Number.MAX_SAFE_INTEGER]);
      const latest = store.index('task-time').openCursor(range, 'prev');
      latest.onsuccess = () => resolve(latest.result?.value ?? null); latest.onerror = () => reject(new Error('浏览器恢复副本未能读取'));
    };
    own.onerror = () => reject(new Error('浏览器恢复副本未能读取'));
  }); } finally { db.close(); }
}
