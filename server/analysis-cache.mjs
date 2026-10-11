import fs from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { atomicJson, readJson, ordinaryDirectory, ReviewError } from './runtime.mjs';
import { bundledTools } from './media-analysis.mjs';
import { ANALYSIS_THREADS } from './tool-runner.mjs';

export async function contentHash(file, signal) {
  const before = await fs.lstat(file);
  if (!before.isFile() || before.isSymbolicLink()) throw new ReviewError('媒体不是普通文件，未执行分析', 'media_changed');
  const hash = createHash('sha256'); let bytes = 0;
  for await (const chunk of createReadStream(file, { highWaterMark: 256 * 1024, signal })) { hash.update(chunk); bytes += chunk.length; }
  const after = await fs.lstat(file);
  if (!after.isFile() || after.isSymbolicLink() || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytes !== before.size) throw new ReviewError('媒体在读取中变化，请等待导出结束后登记新任务', 'media_changed');
  return hash.digest('hex');
}

export async function analysisProfile(root, kind) {
  const tools = await bundledTools(root);
  const values = await Promise.all([tools.ffmpeg(), ...(kind === 'media' ? [tools.whisper(), tools.model()] : [])]);
  const stamps = await Promise.all(values.map(async file => {
    if (!file) return null;
    const stat = await fs.lstat(file);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new ReviewError('本机工具或模型绑定已变化', 'tool_changed');
    return { file, size: stat.size, mtimeMs: stat.mtimeMs };
  }));
  return { key: createHash('sha256').update(JSON.stringify({ format: 'analysis-profile/v2', kind, stamps, threads: ANALYSIS_THREADS, language: 'zh', waveform: 'rms-16k-36k', transcriptLimitMs: 1800000 })).digest('hex'), memoryBytes: Math.max(512 * 1024 * 1024, (stamps[2]?.size ?? 0) * 3 + 256 * 1024 * 1024) };
}

export class AnalysisCache {
  constructor(local, { maxBytes = 128 * 1024 * 1024, maxFiles = 64 } = {}) { this.directory = path.join(local, 'analysis-cache'); this.maxBytes = maxBytes; this.maxFiles = maxFiles; }
  async init() { await ordinaryDirectory(this.directory); return this; }
  key(kind, hash, profile) { return createHash('sha256').update(`${kind}:${hash}:${profile}`).digest('hex'); }
  async get(key) {
    if (!/^[a-f0-9]{64}$/u.test(key)) throw new Error('缓存身份无效');
    try {
      const file = path.join(this.directory, `${key}.json`), value = await readJson(file, 8 * 1024 * 1024);
      if (value.format !== 'media-review-analysis-cache/v1' || value.key !== key) return null;
      await fs.utimes(file, new Date(), new Date()); return value.result;
    } catch (cause) { if (cause.code === 'ENOENT') return null; throw new ReviewError('可重建分析缓存暂不可读，请检查磁盘；正式意见未改动', 'cache_unavailable'); }
  }
  async put(key, result) {
    await atomicJson(path.join(this.directory, `${key}.json`), { format: 'media-review-analysis-cache/v1', key, result });
    await this.prune();
  }
  async prune() {
    const rows = []; const entries = await fs.opendir(this.directory);
    for await (const entry of entries) if (/^[a-f0-9]{64}\.json$/u.test(entry.name)) {
      const file = path.join(this.directory, entry.name), stat = await fs.lstat(file);
      if (stat.isFile() && !stat.isSymbolicLink()) rows.push({ file, size: stat.size, at: stat.mtimeMs });
    }
    rows.sort((a, b) => a.at - b.at); let bytes = rows.reduce((sum, row) => sum + row.size, 0), count = rows.length;
    for (const row of rows) {
      if (bytes <= this.maxBytes && count <= this.maxFiles) break;
      // 仅本模块的可重建缓存；不遍历或删除reviews、self-checks、exports。
      await fs.unlink(row.file); bytes -= row.size; count--;
    }
  }
}
