import { ReviewProgress } from './review-progress.mjs';
import { productRoute } from './review-product.mjs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { ReviewTasks, taskIdentity } from './review-tasks.mjs';
import { ReviewClients } from './review-clients.mjs';
import { AnalysisQueue } from './analysis-queue.mjs';
import { AnalysisCache, analysisProfile, contentHash } from './analysis-cache.mjs';
import { MediaAnalysisService, MAX_MEDIA_BYTES } from './media-analysis.mjs';
import { ReviewError, ordinaryDirectory, readJson } from './runtime.mjs';
import { selfCheck } from './self-check.mjs';
import { sampledFingerprint } from './review-workflow.mjs';

export class ReviewService {
  constructor(root, local, reviews, options = {}) {
    this.root = root; this.local = local; this.locationOpener = options.locationOpener;
    this.tasks = new ReviewTasks(local, reviews, options.tasks);
    this.clients = new ReviewClients(options.clients);
    this.progress = new ReviewProgress(this.tasks);
    this.cache = new AnalysisCache(local, options.cache);
    this.queue = new AnalysisQueue(local, (job, signal, progress) => this.execute(job, signal, progress), options.queue);
    this.uploads = new MediaAnalysisService(root, {
      scheduler: this.queue, processMedia: (job, emit, perform) => this.cachedUpload(job, emit, perform),
      onQueued: (job, id) => job.owner?.taskId ? this.tasks.setJob(job.owner.taskId, 'media', id) : undefined,
      resourceBudget: async () => (await analysisProfile(this.root, 'media')).memoryBytes,
      ...options.uploads,
    });
    this.mediaViews = new Map();
  }
  async init() {
    await ordinaryDirectory(this.local); await this.tasks.init();
    try { await this.tasks.importLegacyInbox(); } catch { this.tasks.warnings.push('旧交接兼容处理未完全确认，原资料保留；新任务入口仍可使用。'); }
    try { await this.queue.init(); } catch { this.queue.unavailable = true; this.queue.warn(); }
    try { await this.cache.init(); } catch { this.cacheUnavailable = true; }
    await this.recoverTemps().catch(() => { this.uploads.cleanupWarning = true; }); return this;
  }
  async recoverTemps() {
    const entries = await fs.opendir(this.local);
    for await (const entry of entries) {
      if (!/^analysis-[A-Za-z0-9]{6}$/u.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) continue;
      const directory = path.join(this.local, entry.name);
      let marker;
      try { marker = await readJson(path.join(directory, 'owner.json'), 1024); } catch { continue; }
      if (marker.format !== 'media-review-temp/v2') continue;
      const names = await fs.readdir(directory, { withFileTypes: true });
      if (names.some(item => !item.isFile() || item.isSymbolicLink() || !['source.media', 'audio.wav', 'transcript.srt', 'owner.json'].includes(item.name))) continue;
      for (const item of names) await fs.unlink(path.join(directory, item.name));
      await fs.rmdir(directory);
    }
  }
  summary() {
    return { ...this.clients.summary(), pendingTasks: this.tasks.activeCount, uploads: this.uploads.jobs.size, analysis: this.queue.summary() };
  }
  analysisActivity() {
    this.clients.prune();
    const active = ['running', 'queued', 'waiting-resources'];
    const uploads = [...this.uploads.jobs.values()];
    const describe = (job, upload = null) => {
      const ownerIds = upload?.owner?.taskId ? [upload.owner.taskId] : job.owners ?? [];
      const tasks = ownerIds.map(id => this.tasks.headers.get(id)).filter(Boolean).map(task => ({ id: task.id, title: task.title, label: task.label, name: task.media.name, manual: task.manual }));
      const pages = [...this.clients.clients.entries()].filter(([id, page]) => upload?.owner?.clientId ? id === upload.owner.clientId && page.taskId === (upload.owner.taskId ?? null) : ownerIds.includes(page.taskId)).map(([clientId, page]) => ({ clientId, taskId: page.taskId, visible: page.visible }));
      const progress = upload && job.state === 'running' ? upload.progress ?? null : job.progress ?? null;
      return { id: job.id, kind: job.kind, state: job.state, progress, mediaName: tasks[0]?.name ?? '来源未登记的媒体', tasks, pages };
    };
    const items = [...this.queue.jobs.values()].filter(job => active.includes(job.state)).sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running') || b.priority - a.priority || a.order - b.order).map(job => describe(job, uploads.find(upload => upload.queueId === job.id)));
    for (const upload of uploads) {
      if (items.some(item => item.id === upload.queueId)) continue;
      const state = upload.cancelled ? 'cancelling' : !upload.processing ? 'uploading' : upload.queueId ? 'finalizing' : 'preparing';
      items.push(describe({ id: upload.id, kind: 'browser-upload', state, progress: { phase: state, percent: state === 'uploading' ? Math.floor(upload.written / upload.size * 100) : null } }, upload));
    }
    return { runtimeId: this.runtimeId, items };
  }
  get busy() { return this.tasks.activeCount > 0 || this.tasks.warnings.length > 0 || this.clients.summary().windows > 0 || this.queue.activeCount > 0 || this.uploads.jobs.size > 0; }
  scopeKey(context, fingerprint) { return context?.taskId ? `task:${context.taskId}` : `legacy:${fingerprint}`; }
  async assertMedia(context, identity) {
    if (!context?.taskId) return;
    const task = await this.tasks.read(taskIdentity(context.taskId));
    if (['name', 'size', 'type', 'fingerprint'].some(key => task.media[key] !== identity[key])) throw new ReviewError('意见与当前任务的媒体身份不匹配，未保存到另一任务', 'task_conflict');
  }
  async scope(context, fingerprint, writing = false) {
    if (context) { taskIdentity(context.clientId); if (context.taskId !== null && context.taskId !== undefined) taskIdentity(context.taskId); }
    const directory = await this.tasks.scope(context?.taskId, fingerprint);
    const key = directory === this.tasks.legacyReviews ? `legacy:${fingerprint}` : this.scopeKey(context, fingerprint);
    if (writing) {
      if (context?.taskId && (await this.tasks.read(context.taskId)).status !== 'waiting') throw new ReviewError('任务尚未开始等待或已结束，请明确继续后再编辑；本页意见保留', 'task_closed');
      this.clients.assert(key, context);
    }
    return directory;
  }
  async enqueue(taskId, kind, durationMs = null, sampleTimesMs = []) {
    if (!['inspection', 'media'].includes(kind)) throw new ReviewError('分析种类无效', 'invalid_job', 400);
    if (!Array.isArray(sampleTimesMs) || sampleTimesMs.length > 100 || sampleTimesMs.some(time => !Number.isSafeInteger(time) || time < 0 || time > 172800000)) throw new ReviewError('检查位置无效', 'invalid_job', 400);
    const task = await this.tasks.read(taskIdentity(taskId));
    if (task.status !== 'waiting') throw new ReviewError('任务尚未开始等待或已结束，请先明确继续', 'task_closed');
    const media = await this.tasks.source(taskId);
    if (media.size > MAX_MEDIA_BYTES) throw new ReviewError('自动分析上限1GiB；任务已登记，请手动打开更大的原媒体', 'analysis_size');
    if (kind === 'media') {
      if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 172800000) throw new ReviewError('分析需要当前文件的有效时长', 'invalid_job', 400);
      await this.tasks.setDuration(taskId, durationMs);
    }
    const profile = await analysisProfile(this.root, kind);
    const key = createHash('sha256').update(JSON.stringify({ media, profile: profile.key, durationMs, kind, sampleTimesMs })).digest('hex');
    const previousId = task.jobs[kind];
    if (previousId) {
      const old = await this.queue.read(previousId).catch(() => null);
      if (old?.state === 'completed') {
        // 完成结果复用前仍进入单槽验证完整内容，不能只凭抽样指纹或文件名命中。
      } else if (old && old.owners.includes(taskId) && ['queued', 'running', 'waiting-resources'].includes(old.state)) { if (old.key !== key) throw new ReviewError('同一任务的其他检查正在运行，请完成或撤回后再提交新的检查范围', 'inspection_in_progress'); return old; }
    }
    const job = await this.queue.enqueue({ kind, owner: taskId, key, payload: { taskId, durationMs, sampleTimesMs }, priority: kind === 'media' ? 1 : 0, memoryBytes: profile.memoryBytes });
    await this.tasks.setJob(taskId, kind, job.id); return job;
  }
  async cacheRead(key) {
    if (this.cacheUnavailable) return null;
    try { return await this.cache.get(key); } catch { this.cacheWarning = true; return null; }
  }
  async cacheWrite(key, result) {
    if (this.cacheUnavailable) return;
    try { await this.cache.put(key, result); } catch { this.cacheWarning = true; }
  }
  async execute(job, signal, progress) {
    const source = await this.tasks.source(job.payload.taskId), profile = await analysisProfile(this.root, job.kind);
    if (profile.memoryBytes > job.memoryBytes) throw new ReviewError('模型或工具已变化，请重新排队以核对资源预算', 'tool_changed');
    const hash = await contentHash(source.source, signal);
    for (const owner of job.owners) await this.tasks.bindContent(owner, hash);
    const key = this.cache.key(job.kind, hash, `${profile.key}:${job.payload.durationMs ?? ''}:${JSON.stringify(job.payload.sampleTimesMs ?? [])}`);
    const cached = await this.cacheRead(key);
    let result = cached;
    if (!result && job.kind === 'inspection') result = await selfCheck(this.root, source.source, { signal, sampleTimesMs: job.payload.sampleTimesMs ?? [] });
    if (!result && job.kind === 'media') {
      const service = new MediaAnalysisService(this.root);
      const events = []; let partial = Promise.resolve();
      try {
        await service.fromFile(source.source, job.payload.durationMs, event => {
          if (event.kind === 'progress') progress(event);
          else {
            events.push(event);
            if (event.kind === 'wave') partial = this.queue.partial(job.id, { events: [event] }).catch(() => { /* 中间缓存不可用时仍在最终结果返回波形，不伪造处理阶段。 */ });
          }
        }, signal);
        await partial;
        result = { format: 'media-review-analysis/v1', events };
      } finally { await service.close(); }
    }
    if (job.kind === 'inspection' && result.durationSeconds) await this.tasks.setDuration(job.payload.taskId, Math.round(result.durationSeconds * 1000));
    signal.throwIfAborted();
    if (await contentHash(source.source, signal) !== hash) throw new ReviewError('原媒体在分析期间变化，未将结果记为完成', 'media_changed');
    if (!cached) await this.cacheWrite(key, result);
    for (const owner of job.owners) await this.tasks.bindContent(owner, hash);
    return { ...result, contentHash: hash, cacheReused: !!cached, taskMedia: { name: source.name, fingerprint: source.fingerprint, size: source.size } };
  }
  async cachedUpload(job, emit, perform) {
    const profile = await analysisProfile(this.root, 'media');
    const hash = await contentHash(job.source, job.controller.signal);
    if (job.owner?.taskId) {
      const task = await this.tasks.read(job.owner.taskId);
      if (task.media.size !== job.size || task.media.fingerprint !== await sampledFingerprint(job.source)) throw new ReviewError('上传内容与当前任务不匹配，未套用旧波形、台词或意见', 'media_changed');
      await this.tasks.bindContent(task.id, hash); await this.tasks.setDuration(task.id, job.durationMs);
    }
    const key = this.cache.key('media', hash, `${profile.key}:${job.durationMs}`);
    const cached = await this.cacheRead(key);
    if (cached) { for (const event of cached.events) emit(event); return { ...cached, contentHash: hash, cacheReused: true }; }
    const events = [];
    await perform(event => { if (event.kind !== 'progress') events.push(event); emit(event); });
    job.controller.signal.throwIfAborted();
    const result = { format: 'media-review-analysis/v1', events };
    await this.cacheWrite(key, result); return { ...result, contentHash: hash, cacheReused: false };
  }
  async media(id, context, readOnly = false) {
    const task = await this.tasks.read(taskIdentity(id)), media = await this.tasks.source(id);
    if (media.size > MAX_MEDIA_BYTES) throw new ReviewError('自动带入上限1GiB，请手动选择更大的原媒体', 'media_size');
    if (!context?.clientId) throw new ReviewError('需要当前窗口身份再带入媒体', 'invalid_client', 400);
    if (!readOnly) await this.scope({ ...context, taskId: id }, media.fingerprint, true);
    this.clients.prune();
    for (const clientId of this.mediaViews.keys()) if (!this.clients.clients.has(clientId)) this.mediaViews.delete(clientId);
    const others = [...this.mediaViews.entries()].filter(([clientId]) => clientId !== context.clientId);
    if (others.length >= 2 || others.reduce((sum, [, value]) => sum + value.size, 0) + media.size > MAX_MEDIA_BYTES) throw new ReviewError('当前媒体加载预算已用完，请先挂起一个校对窗口；不会后台预载更多视频', 'media_view_capacity', 429);
    this.mediaViews.set(context.clientId, { id, size: media.size });
    const stat = await fs.lstat(media.source), handle = await fs.open(media.source, 'r'), opened = await handle.stat();
    if (!stat.isFile() || stat.isSymbolicLink() || opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size !== media.size || opened.mtimeMs !== media.mtimeMs) { await handle.close(); throw new ReviewError('媒体在读取前变化，未带入新内容', 'media_changed'); }
    return { ...media, handle, opened, task };
  }
  async *mediaStream(media) {
    const stream = media.handle.createReadStream({ highWaterMark: 256 * 1024 });
    const hash = createHash('sha256'); let previous = null, total = 0;
    try {
      for await (const chunk of stream) {
        hash.update(chunk); total += chunk.length;
        if (previous) yield previous;
        previous = chunk;
      }
      const stat = await fs.lstat(media.source);
      if (stat.isSymbolicLink() || total !== media.size || ['dev', 'ino', 'size', 'mtimeMs'].some(key => stat[key] !== media.opened[key])) throw new ReviewError('媒体在带入期间变化，未确认这份文件', 'media_changed');
      await this.tasks.bindContent(media.task.id, hash.digest('hex'));
      if (previous) yield previous; // 完整内容与任务核对后才交出最后一块，不让截断传输冒称完整文件。
    } finally { stream.destroy(); await media.handle.close().catch(() => {}); }
  }
  async route(pathname, body, context) {
    if (pathname === '/api/tasks/register') return { task: await this.tasks.registerSource(body.source, { requestId: body.requestId, title: body.title, label: body.label, previousTaskId: body.previousTaskId }) };
    if (pathname === '/api/tasks/manual') return { task: await this.tasks.registerManual(body.media, { requestId: body.requestId, newTask: body.newTask, mtimeMs: body.mtimeMs, label: body.label, previousTaskId: body.previousTaskId }) };
    const product = await productRoute(this, pathname, body, context);
    if (product !== null) return product;
    if (pathname === '/api/tasks/list') {
      const data = this.tasks.list(body);
      data.items = await Promise.all(data.items.map(async task => ({ ...task, jobStates: Object.fromEntries(await Promise.all(Object.entries(task.jobs).slice(0, 2).map(async ([kind, id]) => {
        const job = await this.queue.read(id).catch(() => ({ state: 'interrupted', owners: [] }));
        return [kind, ['queued', 'running', 'waiting-resources'].includes(job.state) && !job.owners.includes(task.id) ? 'detached' : job.state];
      }))) })));
      data.warnings = [...data.warnings, ...this.queue.warnings, ...(this.cacheUnavailable || this.cacheWarning ? ['可重建缓存暂不可用；仍可重新分析，不影响正式意见。'] : []), ...(this.uploads.cleanupWarning ? ['部分临时上传未能清理，请查看本机临时目录；原资料保留。'] : [])];
      return { ...data, service: this.summary(), activity: this.analysisActivity() };
    }
    if (pathname === '/api/tasks/get') return { task: this.tasks.headers.get(taskIdentity(body.taskId)) ?? await this.tasks.read(body.taskId) };
    if (pathname === '/api/tasks/status') {
      taskIdentity(body.taskId);
      const others = this.clients.taskUse(body.taskId, context?.clientId);
      if (body.status === 'closed' && others.windows && body.confirmOtherWindows !== true) throw new ReviewError(`另有${others.windows}个窗口正在使用此任务，其中${others.unsavedWindows}个报告未保存输入。请先让其保存／挂起，或明确确认结束；不会自动清空那些窗口。`, 'task_in_use');
      const task = await this.tasks.changeStatus(body.taskId, body.status);
      if (body.status === 'closed') for (const id of Object.values(task.jobs)) await this.queue.cancel(id, task.id);
      return { task };
    }
    if (pathname === '/api/tasks/open-location') {
      const task = await this.tasks.read(taskIdentity(body.taskId)), directory = await this.tasks.scope(task.id, task.media.fingerprint);
      if (!this.locationOpener) throw new ReviewError('系统打开入口不可用，请使用当前意见记录路径', 'location_unavailable', 503);
      await this.locationOpener(directory, null); return { requested: true, directory };
    }
    if (pathname === '/api/clients/heartbeat') {
      const value = this.clients.heartbeat(body);
      let lease = null, taskStatus = null;
      if (body.taskId) {
        const task = await this.tasks.read(body.taskId), directory = await this.tasks.scope(body.taskId, task.media.fingerprint); taskStatus = task.status;
        if (task.status === 'waiting') lease = this.clients.leases.get(directory === this.tasks.legacyReviews ? `legacy:${task.media.fingerprint}` : `task:${task.id}`);
      }
      return { ...value, taskStatus, editing: lease?.clientId === body.clientId, leaseId: lease?.clientId === body.clientId ? lease.leaseId : null };
    }
    if (pathname === '/api/clients/claim') {
      if (body.taskId && (await this.tasks.read(taskIdentity(body.taskId))).status !== 'waiting') throw new ReviewError('任务已结束或尚未明确继续，未取得编辑权；输入保留，请从任务列表继续', 'task_closed');
      const directory = await this.tasks.scope(body.taskId, body.fingerprint);
      const key = directory === this.tasks.legacyReviews ? `legacy:${body.fingerprint}` : `task:${body.taskId}`;
      if (typeof body.takeover !== 'boolean') throw new ReviewError('接管请求无效', 'invalid_client', 400);
      const claim = this.clients.claim(key, body.clientId, body.takeover);
      if (claim.editing) this.clients.clients.get(body.clientId).taskId = body.taskId;
      return claim;
    }
    if (pathname === '/api/clients/release') { this.mediaViews.delete(body.clientId); return this.clients.release(body.clientId); }
    if (pathname === '/api/browser/claim') return this.clients.browserClaim(body.force === true);
    if (pathname === '/api/session/activity') return this.analysisActivity();
    if (pathname === '/api/session/summary') return this.summary();
    if (pathname === '/api/jobs/enqueue') return { job: await this.enqueue(body.taskId, body.kind, body.durationMs, body.sampleTimesMs) };
    if (pathname === '/api/jobs/status') return { job: await this.queue.read(body.id, body.result === true) };
    if (pathname === '/api/jobs/cancel') return this.queue.cancel(body.id, taskIdentity(body.taskId));
    return null;
  }
  async close() {
    const results = await Promise.allSettled([this.queue.close(), this.uploads.close()]);
    if (results.some(result => result.status === 'rejected')) this.uploads.cleanupWarning = true;
  }
}
