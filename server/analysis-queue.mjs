import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { ordinaryDirectory, atomicJson, readJson, keyedSerial, ReviewError } from './runtime.mjs';
import { taskIdentity } from './review-tasks.mjs';

const ACTIVE = new Set(['queued', 'waiting-resources', 'running']);
const RESULT_BYTES = 8 * 1024 * 1024;
export class AnalysisQueue {
  constructor(local, execute, { maxPending = 32, maxRemembered = 64, maxRecords = 4096, maxResultFiles = 64, maxResultBytes = 128 * 1024 * 1024, freeMemory = () => os.freemem() } = {}) {
    this.directory = path.join(local, 'jobs'); this.execute = execute; this.maxPending = maxPending;
    this.maxRemembered = maxRemembered; this.maxRecords = maxRecords; this.recordCount = 0;
    this.maxResultFiles = maxResultFiles; this.maxResultBytes = maxResultBytes; this.freeMemory = freeMemory;
    this.jobs = new Map(); this.waiters = new Map(); this.serial = keyedSerial(); this.warnings = [];
    this.running = null; this.stopped = false; this.timer = null; this.pumping = false; this.order = 0;
  }
  warn() {
    const message = '部分分析缓存或登记暂不可读写，原资料保留；可手动校对，请检查本机jobs目录与磁盘。';
    if (!this.warnings.includes(message)) this.warnings.push(message);
  }
  validate(value, id) {
    if (value.format !== 'media-review-job/v1' || value.id !== id || !Array.isArray(value.owners) || value.owners.length > 100) throw new ReviewError('分析登记不可读，原文件保留；请检查本机jobs目录');
    value.owners.forEach(taskIdentity); return value;
  }
  async init() {
    await ordinaryDirectory(this.directory);
    const entries = await fs.opendir(this.directory);
    for await (const entry of entries) {
      if (!/^[a-f0-9-]{36}\.json$/u.test(entry.name)) continue;
      if (++this.recordCount > this.maxRecords) { this.warn(); break; }
      const file = path.join(this.directory, entry.name);
      try {
        const value = this.validate(await readJson(file, 16_384), taskIdentity(entry.name.slice(0, -5)));
        const partial = path.join(this.directory, `${value.id}.partial.json`), stat = await fs.lstat(partial).catch(cause => { if (cause.code !== 'ENOENT') throw cause; return null; });
        if (stat?.isFile() && !stat.isSymbolicLink()) await fs.unlink(partial);
        if (ACTIVE.has(value.state)) {
          value.state = 'interrupted'; value.message = '服务曾退出；尚未完成分析，请明确重试。';
          this.jobs.set(value.id, value);
          await atomicJson(file, value);
        }
      } catch { this.warn(); }
    }
    this.trim();
    await this.pruneResults().catch(() => this.warn());
    return this;
  }
  get activeCount() { return [...this.jobs.values()].filter(item => ACTIVE.has(item.state)).length; }
  summary() {
    return { running: this.running ? 1 : 0, queued: [...this.jobs.values()].filter(item => ['queued', 'waiting-resources'].includes(item.state)).length, limit: this.maxPending, threads: '各工具的显式线程参数上限4；不是操作系统CPU或总线程硬上限', warnings: this.warnings };
  }
  async persist(job) {
    return this.serial(`job:${job.id}`, async () => {
      const { controller, run, ...disk } = job;
      await atomicJson(path.join(this.directory, `${job.id}.json`), disk);
    });
  }
  async persistSafely(job) {
    try { await this.persist(job); return true; }
    catch { this.warn(); return false; }
  }
  trim() {
    for (const [id, job] of this.jobs) {
      if (this.jobs.size <= this.maxRemembered) break;
      if (!ACTIVE.has(job.state) && !this.waiters.has(id)) this.jobs.delete(id);
    }
  }
  async enqueue({ kind, owner, key, payload = {}, priority = 0, memoryBytes = 512 * 1024 * 1024, run = null }) {
    if (owner) taskIdentity(owner);
    return this.serial('queue', async () => {
      if (this.unavailable) throw new ReviewError('分析登记目录暂不可用，可手动校对；请核对jobs目录，原资料保留', 'analysis_unavailable', 503);
      if (this.stopped) throw new ReviewError('校对室正在退出，未接收新的重分析', 'service_closing', 503);
      const shared = [...this.jobs.values()].find(item => !run && item.kind === kind && item.key === key && ACTIVE.has(item.state));
      if (shared) {
        if (owner && !shared.owners.includes(owner)) {
          if (shared.owners.length >= 100) throw new ReviewError('此共享分析的任务归属已满，请稍后重试', 'queue_capacity', 429);
          const owners = [...shared.owners, owner], requesters = [...new Set([...(shared.requesters ?? shared.owners), owner])];
          if (requesters.length > 100) throw new ReviewError('此共享分析的累计任务归属已满，请稍后重试', 'queue_capacity', 429);
          const previousOwners = shared.owners, previousRequesters = shared.requesters;
          shared.owners = owners; shared.requesters = requesters;
          try { await this.persist(shared); }
          catch (cause) {
            if (shared.owners === owners) shared.owners = previousOwners;
            if (shared.requesters === requesters) shared.requesters = previousRequesters;
            throw cause;
          }
        }
        return this.public(shared);
      }
      if (this.activeCount >= this.maxPending) throw new ReviewError('重分析队列已满；任务仍保留，可稍后重试分析', 'queue_capacity', 429);
      if (this.recordCount >= this.maxRecords) throw new ReviewError('分析登记已达4096项上限，请先整理本机jobs目录；任务和正式意见仍保留', 'job_capacity', 429);
      const job = { format: 'media-review-job/v1', id: randomUUID(), kind, owners: owner ? [owner] : [], requesters: owner ? [owner] : [], key, payload, priority, order: ++this.order, memoryBytes, state: 'queued', createdAt: new Date().toISOString(), progress: null, message: '', resultPath: null, controller: new AbortController(), run };
      await this.persist(job); this.recordCount++; this.jobs.set(job.id, job); this.trim();
      this.schedule(); return this.public(job);
    });
  }
  schedule() { if (!this.stopped) setImmediate(() => { this.pump().catch(() => this.warn()); }); }
  public(job) {
    return { id: job.id, kind: job.kind, state: job.state, owners: [...job.owners], requesters: [...(job.requesters ?? job.owners)], createdAt: job.createdAt, progress: job.progress, partialReady: !!job.partialReady, message: job.message, resultPath: job.resultPath };
  }
  async partial(id, result) {
    const job = this.jobs.get(taskIdentity(id));
    if (!job || job.state !== 'running' || Buffer.byteLength(JSON.stringify(result)) > RESULT_BYTES) return;
    await atomicJson(path.join(this.directory, `${id}.partial.json`), result); job.partialReady = true;
  }
  async read(id, result = false) {
    taskIdentity(id);
    const inMemory = this.jobs.get(id), job = this.validate(inMemory ?? await readJson(path.join(this.directory, `${id}.json`), 16_384), id);
    if (!inMemory && ACTIVE.has(job.state)) { job.state = 'interrupted'; job.message = '服务曾退出，未自动续跑；请明确重试。'; }
    const value = this.public(job);
    if (result && job.state === 'running' && job.partialReady) {
      try { value.result = await readJson(path.join(this.directory, `${id}.partial.json`), RESULT_BYTES); }
      catch (cause) { if (cause.code === 'ENOENT' && job.state !== 'running') return this.read(id, result); throw cause; }
    }
    if (result && job.state === 'completed') {
      const expected = path.join(this.directory, `${id}.result.json`);
      if (job.resultPath !== expected) throw new ReviewError('分析结果位置不匹配，未读取其他文件');
      try { value.result = await readJson(expected, RESULT_BYTES); }
      catch (cause) {
        if (cause.code !== 'ENOENT' || !['media', 'browser-upload'].includes(job.kind)) throw cause;
        job.state = 'expired'; job.resultPath = null; job.message = '可重建分析缓存已回收，请明确重试；意见和自检证据保留。';
        await this.persistSafely(job); return this.public(job);
      }
    }
    return value;
  }
  async pruneResults() {
    return this.serial('results', async () => {
      const files = [];
      for await (const entry of await fs.opendir(this.directory)) {
        if (!/^[a-f0-9-]{36}\.result\.json$/u.test(entry.name) || !entry.isFile() || entry.isSymbolicLink()) continue;
        const id = entry.name.slice(0, -12);
        if (this.waiters.has(id) || this.jobs.get(id) === this.running) continue;
        try {
          const job = this.validate(this.jobs.get(id) ?? await readJson(path.join(this.directory, `${id}.json`), 16_384), id);
          const file = path.join(this.directory, entry.name), stat = await fs.lstat(file);
          if (job.state === 'completed' && ['media', 'browser-upload'].includes(job.kind) && job.resultPath === file && stat.isFile() && !stat.isSymbolicLink()) files.push({ file, stat, job });
        } catch { this.warn(); }
      }
      files.sort((a, b) => b.stat.mtimeMs - a.stat.mtimeMs);
      let bytes = 0;
      for (let index = 0; index < files.length; index++) {
        const { file, stat, job } = files[index]; bytes += stat.size;
        if (index < this.maxResultFiles && bytes <= this.maxResultBytes) continue;
        const expired = { ...job, state: 'expired', resultPath: null, message: '可重建分析缓存已回收，请明确重试；意见和自检证据保留。' };
        await this.persist(expired); Object.assign(job, { state: expired.state, resultPath: null, message: expired.message });
        await fs.unlink(file);
      }
    });
  }
  async wait(id) {
    const current = await this.read(id, true);
    if (!ACTIVE.has(current.state)) {
      if (current.state !== 'completed') throw new ReviewError(current.message || '分析未完成', 'analysis_interrupted');
      return current.result;
    }
    return new Promise((resolve, reject) => {
      const list = this.waiters.get(id) ?? []; list.push({ resolve, reject }); this.waiters.set(id, list);
      const job = this.jobs.get(id);
      if (job && !ACTIVE.has(job.state)) void this.settle(job);
    });
  }
  async transient(run, { signal, onQueued, owner, memoryBytes } = {}) {
    signal?.throwIfAborted();
    const job = await this.enqueue({ kind: 'browser-upload', key: randomUUID(), run, priority: 1, owner, memoryBytes });
    const cancel = () => { this.cancel(job.id, owner).catch(() => this.warn()); };
    signal?.addEventListener('abort', cancel, { once: true }); if (signal?.aborted) cancel();
    try { await onQueued?.(job.id); return await this.wait(job.id); }
    catch (cause) { await this.cancel(job.id, owner).catch(() => this.warn()); throw cause; }
    finally { signal?.removeEventListener('abort', cancel); }
  }
  async settle(job) {
    const waiters = this.waiters.get(job.id) ?? []; this.waiters.delete(job.id);
    if (!waiters.length) return;
    try {
      const current = await this.read(job.id, true);
      if (current.state !== 'completed') throw new ReviewError(current.message || '分析已取消或中断', 'analysis_interrupted');
      for (const waiter of waiters) waiter.resolve(current.result);
    } catch (cause) { for (const waiter of waiters) waiter.reject(cause); }
  }
  async pump() {
    if (this.pumping || this.stopped) return;
    this.pumping = true; let finished;
    this.pumpDone = new Promise(resolve => { finished = resolve; });
    let next, waiting = false;
    try {
      next = [...this.jobs.values()].filter(job => ['queued', 'waiting-resources'].includes(job.state)).sort((a, b) => b.priority - a.priority || a.order - b.order)[0];
      if (!next) return;
      if (this.freeMemory() < next.memoryBytes) {
        next.state = 'waiting-resources'; next.message = '可用内存不足，已暂停重分析；播放与手动意见不受影响。';
        await this.persist(next); waiting = true;
        clearTimeout(this.timer); this.timer = setTimeout(() => { this.pump().catch(() => this.warn()); }, 5000); this.timer.unref(); return;
      }
      this.running = next; next.state = 'running'; next.message = '';
      await this.persist(next); next.controller.signal.throwIfAborted();
      const progress = value => { next.progress = value; };
      const result = await (next.run ? next.run(next.controller.signal) : this.execute(next, next.controller.signal, progress));
      next.controller.signal.throwIfAborted();
      const resultPath = path.join(this.directory, `${next.id}.result.json`);
      if (Buffer.byteLength(JSON.stringify(result)) > RESULT_BYTES) throw new Error('分析结果超过容量');
      await atomicJson(resultPath, result); next.resultPath = resultPath; next.state = 'completed';
    } catch (cause) {
      if (next) {
        next.state = next.controller.signal.aborted ? (this.stopped ? 'interrupted' : 'cancelled') : 'failed';
        next.message = next.controller.signal.aborted ? '分析已停止，未冒称完成；已有资料保留。' : cause instanceof ReviewError ? cause.message : '本机分析未完成，可重试；请核对工具或磁盘，原媒体与意见未改动。';
      }
    } finally {
      if (next && !ACTIVE.has(next.state)) {
        if (!await this.persistSafely(next)) { next.state = 'failed'; next.message = '分析状态未能落盘确认，请核对本机磁盘'; }
        await fs.unlink(path.join(this.directory, `${next.id}.partial.json`)).catch(() => {});
        await this.settle(next);
      }
      this.running = null; this.trim(); this.pumping = false; finished();
      await this.pruneResults().catch(() => this.warn());
      if (!waiting && this.activeCount) this.schedule();
    }
  }
  async cancel(id, owner = null) {
    const job = this.jobs.get(taskIdentity(id));
    if (!job || !ACTIVE.has(job.state)) return { cancelled: false };
    if (owner) {
      if (!job.owners.includes(owner)) {
        if (job.requesters?.includes(owner)) return { cancelled: false, detached: true };
        throw new ReviewError('该分析不属于此任务，未取消其他调用者', 'job_owner');
      }
      job.owners = job.owners.filter(value => value !== owner);
      if (job.owners.length) { await this.persist(job); return { cancelled: false, detached: true }; }
    }
    job.controller.abort();
    if (job !== this.running) { job.state = 'cancelled'; job.message = '排队分析已取消'; await this.persistSafely(job); await this.settle(job); }
    else { try { await this.wait(id); } catch { /* 取消结果在状态查询中保留。 */ } }
    return { cancelled: true };
  }
  async close() {
    this.stopped = true; clearTimeout(this.timer);
    const pending = [];
    for (const job of this.jobs.values()) if (ACTIVE.has(job.state)) {
      job.controller.abort();
      if (job !== this.running) { job.state = 'interrupted'; job.message = '校对室退出，未执行完；请明确重试'; pending.push(job); }
    }
    await Promise.all(pending.map(async job => { await this.persistSafely(job); await this.settle(job); }));
    await this.pumpDone;
  }
}
