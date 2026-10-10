import type { ReviewNote, MediaIdentity } from './review';
import type { ReviewDraft } from './review-draft';

export interface ReviewWorkspace {
  format: 'media-review-workspace/v1'; media: MediaIdentity; currentMs: number;
  notes: ReviewNote[]; baseNotes: ReviewNote[]; dirty: boolean;
  newDraft: ReviewDraft; editDraft: ReviewDraft; parked: ReviewDraft[];
  view: { kind: 'new' } | { kind: 'detail' | 'edit'; id: string };
}
interface Cached { at: number; workspace: ReviewWorkspace }
function database(rootId: string): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(`media-review-recovery-${rootId}`, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('workspaces');
    request.onsuccess = () => resolve(request.result); request.onerror = () => reject(new Error('浏览器恢复存储不可用'));
  });
}
export async function cacheWorkspace(rootId: string, workspace: ReviewWorkspace): Promise<void> {
  const db = await database(rootId);
  try { await new Promise<void>((resolve, reject) => {
    const transaction = db.transaction('workspaces', 'readwrite');
    transaction.objectStore('workspaces').put({ at: Date.now(), workspace }, workspace.media.fingerprint);
    transaction.oncomplete = () => resolve(); transaction.onerror = () => reject(new Error('浏览器恢复副本未能保留')); transaction.onabort = () => reject(new Error('浏览器恢复副本写入中断'));
  }); } finally { db.close(); }
}
export async function cachedWorkspace(rootId: string, fingerprint: string): Promise<Cached | null> {
  const db = await database(rootId);
  try { return await new Promise((resolve, reject) => {
    const request = db.transaction('workspaces').objectStore('workspaces').get(fingerprint);
    request.onsuccess = () => resolve(request.result ?? null); request.onerror = () => reject(new Error('浏览器恢复副本未能读取'));
  }); } finally { db.close(); }
}
