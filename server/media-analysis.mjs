import { randomBytes } from 'node:crypto';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { runtimePaths, readJson, ordinaryDirectory } from './runtime.mjs';
import { createReadStream } from 'node:fs';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import { progressDecoder } from './analysis-progress.mjs';

export const MAX_MEDIA_BYTES = 1024 * 1024 * 1024;
export const MAX_CHUNK_BYTES = 2 * 1024 * 1024;
const MAX_TRANSCRIPT_MS = 30 * 60 * 1000;

export class MediaAnalysisError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MediaAnalysisError';
  }
}

function mediaError(message) {
  return new MediaAnalysisError(message);
}

export async function bundledTools(root) {
  const location = await runtimePaths(root);
  if (location.standalone) {
    let configured = {};
    try { configured = await readJson(path.join(location.local, 'tools.json'), 16_384); } catch (cause) { if (cause.code !== 'ENOENT') throw mediaError('本机工具配置不可读，原文件保留'); }
    const resolve = async (key, command) => {
      if (Object.hasOwn(configured, key)) {
        const file = configured[key], stat = typeof file === 'string' && path.isAbsolute(file) ? await fs.lstat(file).catch(() => null) : null;
        if (!stat?.isFile() || stat.isSymbolicLink()) throw mediaError(`${key}本机绑定已失效，请重新指定`);
        return file;
      }
      if (!command) return null;
      try {
        const result = await promisify(execFile)(process.platform === 'win32' ? 'where.exe' : '/usr/bin/which', [command], { windowsHide: true, timeout: 3000 });
        for (const candidate of result.stdout.trim().split(/\r?\n/u)) if ((await fs.lstat(candidate).catch(() => null))?.isFile()) return candidate;
      } catch { /* 缺少工具只影响对应分析能力，不自动下载。 */ }
      return null;
    };
    return { ffmpeg: () => resolve('ffmpeg', 'ffmpeg'), whisper: () => resolve('whisper_cpu', 'whisper-cli'), model: () => resolve('model', null) };
  }
  const editor = path.resolve(root, '..', '..');
  const local = path.join(editor, '.assistant-local', 'components', 'component.high-value-video-runtime');
  const bindingFile = path.join(local, 'runtime-paths.json');
  let bindings = {};
  try {
    const stat = await fs.lstat(bindingFile);
    if (!stat.isFile() || stat.isSymbolicLink()) throw mediaError('本机媒体工具绑定不是普通文件。');
    const parsed = JSON.parse(await fs.readFile(bindingFile, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw mediaError('本机媒体工具绑定不是 JSON 对象。');
    bindings = parsed;
  } catch (cause) {
    if (cause.code !== 'ENOENT') throw cause;
  }
  async function resolved(key, fallback) {
    if (!Object.hasOwn(bindings, key)) return fallback;
    const declared = bindings[key];
    const stat = typeof declared === 'string' && path.isAbsolute(declared)
      ? await fs.lstat(declared).catch(() => null) : null;
    if (!stat?.isFile() || stat.isSymbolicLink()) {
      throw mediaError(`${key} 的本机绑定已失效，请在当前电脑重新指定；不会悄悄换用其他工具。`);
    }
    return declared;
  }
  const ffmpegRoot = path.join(local, 'tools', 'ffmpeg');
  let ffmpeg = null;
  try {
    const builds = (await fs.readdir(ffmpegRoot, { withFileTypes: true }))
      .filter((item) => item.isDirectory() && /^ffmpeg[-_]/u.test(item.name))
      .sort((a, b) => b.name.localeCompare(a.name, undefined, { numeric: true }));
    for (const build of builds) {
      const candidate = path.join(ffmpegRoot, build.name, 'bin', 'ffmpeg.exe');
      if ((await fs.stat(candidate).catch(() => null))?.isFile()) { ffmpeg = candidate; break; }
    }
  } catch { /* A missing local tool is a scoped capability limit. */ }
  const whisper = path.join(local, 'tools', 'whisper-cpu', 'Release', 'whisper-cli.exe');
  const model = path.join(local, 'models', 'ggml-small.bin');
  const bundledWhisper = (await fs.stat(whisper).catch(() => null))?.isFile() ? whisper : null;
  const bundledModel = (await fs.stat(model).catch(() => null))?.isFile() ? model : null;
  return {
    ffmpeg: () => resolved('ffmpeg', ffmpeg),
    whisper: () => resolved('whisper_cpu', bundledWhisper),
    model: () => resolved('model', bundledModel),
  };
}

async function wavDataOffset(file) {
  const handle = await fs.open(file, 'r');
  try {
    const header = Buffer.alloc(4096);
    const { bytesRead } = await handle.read(header, 0, header.length, 0);
    if (bytesRead < 44 || header.toString('ascii', 8, 12) !== 'WAVE') throw mediaError('声音格式无法读取。');
    let offset = 12;
    while (offset + 8 <= bytesRead) {
      const id = header.toString('ascii', offset, offset + 4);
      const size = header.readUInt32LE(offset + 4);
      if (id === 'data') return { offset: offset + 8, bytes: size };
      offset += 8 + size + (size % 2);
    }
    throw mediaError('声音数据无法读取。');
  } finally { await handle.close(); }
}

export async function waveRms(file, targetBars) {
  const { offset, bytes } = await wavDataOffset(file);
  const stat = await fs.stat(file);
  const samples = Math.floor(Math.min(bytes, stat.size - offset) / 2);
  if (samples <= 0) throw mediaError('没有读到可用声音。');
  // FFmpeg 输出16kHz单声道PCM：约20ms一窗，长媒体限制点数。
  const bars = Math.min(samples, 36_000, Math.max(1, Math.round(targetBars ?? Math.ceil(samples / 320))));
  const energy = new Float64Array(bars);
  const counts = new Uint32Array(bars);
  let index = 0;
  let leftover = null;
  const add = (sample) => {
    const bar = Math.min(bars - 1, Math.floor(index * bars / samples));
    energy[bar] += sample * sample;
    counts[bar] += 1;
    index += 1;
  };
  for await (const chunk of createReadStream(file, { start: offset, end: offset + samples * 2 - 1, highWaterMark: 128 * 1024 })) {
    let start = 0;
    if (leftover !== null && chunk.length) {
      add((leftover | (chunk[0] << 8)) << 16 >> 16);
      start = 1;
      leftover = null;
    }
    const end = chunk.length - ((chunk.length - start) % 2);
    for (let at = start; at < end; at += 2) add(chunk.readInt16LE(at));
    if (end < chunk.length) leftover = chunk[end];
  }
  const rms = Array.from(energy, (sum, i) => Math.sqrt(sum / Math.max(1, counts[i])));
  const maximum = Math.max(...rms, 1);
  // 整段共用增益；静音为0，不设置假高度，也不逐窗归一化。
  return rms.map(value => Math.round(value / maximum * 10_000) / 10_000);
}

async function runProgram(job, executable, args, timeoutMs, phase, onEvent) {
  if (job.cancelled) throw mediaError('分析已取消。');
  await new Promise((resolve, reject) => {
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', phase === 'decoding' ? 'pipe' : 'ignore', 'pipe'] });
    job.child = child;
    let stderr = '';
    let timedOut = false;
    const decode = progressDecoder(phase, job.durationMs, event => { if (!job.cancelled) onEvent(event); });
    child.stdout?.on('data', decode);
    child.stderr.on('data', chunk => {
      stderr = (stderr + chunk.toString()).slice(-3000);
      if (phase === 'transcribing') decode(chunk);
    });
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.once('error', () => { clearTimeout(timer); reject(mediaError('本机媒体工具未能启动，请检查当前工具路径。')); });
    child.once('close', code => {
      clearTimeout(timer);
      job.child = null;
      if (job.cancelled) reject(mediaError('分析已取消。'));
      else if (timedOut) reject(mediaError(phase === 'transcribing' ? '本机语音识别已超时，可重试；仍可播放和标记。' : '本机音轨处理已超时，可重试。'));
      else if (code === 0) resolve();
      else reject(mediaError(stderr.includes('matches no streams') || stderr.includes('does not contain any stream')
        ? '这段媒体没有可解码的音轨。' : phase === 'transcribing' ? '本机语音识别失败，可重试；不会改动原媒体。' : '本机声音处理失败，请检查媒体编码。'));
    });
  });
}

async function cleanup(job) {
  if (job.handle) { await job.handle.close(); job.handle = null; }
  for (const file of [job.source, job.wav, `${job.transcript}.srt`]) {
    await fs.unlink(file).catch((cause) => { if (cause.code !== 'ENOENT') throw cause; });
  }
  await fs.rmdir(job.directory).catch((cause) => { if (cause.code !== 'ENOENT') throw cause; });
}

export class MediaAnalysisService {
  constructor(root) {
    this.root = root;
    this.job = null;
  }

  async start(size, durationMs) {
    if (!Number.isSafeInteger(size) || size < 1 || size > MAX_MEDIA_BYTES) {
      throw mediaError('媒体大小超出本机分析范围；仍可播放和标记。');
    }
    if (!Number.isSafeInteger(durationMs) || durationMs < 1 || durationMs > 172800000) {
      throw mediaError('媒体时长无效。');
    }
    if (this.job || this.starting) throw mediaError('上一段媒体仍在分析，请稍等或取消。');
    this.starting = true;
    let started;
    this.startDone = new Promise(resolve => { started = resolve; });
    try {
      const localRoot = (await runtimePaths(this.root)).local;
      await ordinaryDirectory(localRoot);
      const directory = await fs.mkdtemp(path.join(localRoot, 'analysis-'));
      const source = path.join(directory, 'source.media');
      const handle = await fs.open(source, 'wx', 0o600);
      let finished;
      const done = new Promise(resolve => { finished = resolve; });
      this.job = {
        id: randomBytes(16).toString('hex'), size, durationMs, directory, source,
        wav: path.join(directory, 'audio.wav'), transcript: path.join(directory, 'transcript'),
        handle, nextIndex: 0, written: 0, child: null, cancelled: false, processing: false,
        done, finished, cancelPromise: null,
      };
      return this.job.id;
    } finally { this.starting = false; started(); }
  }

  async append(id, index, base64) {
    const job = this.job;
    if (!job || job.id !== id || job.processing || job.cancelled) throw mediaError('本次媒体分析已经结束。');
    if (!Number.isSafeInteger(index) || index !== job.nextIndex || typeof base64 !== 'string' ||
        base64.length < 1 || base64.length > Math.ceil(MAX_CHUNK_BYTES * 4 / 3) + 4 ||
        !/^[A-Za-z0-9+/]+={0,2}$/u.test(base64)) throw mediaError('媒体分片无效或顺序不对。');
    const bytes = Buffer.from(base64, 'base64');
    if (!bytes.length || bytes.length > MAX_CHUNK_BYTES || bytes.toString('base64') !== base64 ||
        job.written + bytes.length > job.size) throw mediaError('媒体分片大小无效。');
    let offset = 0;
    while (offset < bytes.length) {
      const result = await job.handle.write(bytes, offset, bytes.length - offset, job.written + offset);
      if (!result.bytesWritten) throw mediaError('本机媒体暂存未写完。');
      offset += result.bytesWritten;
    }
    job.written += bytes.length;
    job.nextIndex += 1;
    return job.written;
  }

  async finish(id, onEvent) {
    const job = this.job;
    if (!job || job.id !== id || job.processing || job.cancelled) throw mediaError('本次媒体分析已经结束。');
    if (job.written !== job.size) throw mediaError('媒体尚未完整到达本机分析器。');
    job.processing = true;
    try {
      await job.handle.close();
      job.handle = null;
      let tools;
      let ffmpeg;
      try {
        tools = await bundledTools(this.root);
        ffmpeg = await tools.ffmpeg();
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : '本机媒体工具不可用。';
        onEvent({ kind: 'wave-error', message });
        onEvent({ kind: 'transcript-error', message });
        return;
      }
      if (!ffmpeg) {
        onEvent({ kind: 'wave-error', message: '本机没有连接 FFmpeg，不能生成声音波形。' });
        onEvent({ kind: 'transcript-error', message: '本机没有连接 FFmpeg，暂不能自动识别台词。' });
        return;
      }
      try {
        onEvent({ kind: 'progress', phase: 'decoding', percent: 0 });
        await runProgram(job, ffmpeg, [
          '-nostdin', '-hide_banner', '-loglevel', 'error', '-y', '-nostats', '-progress', 'pipe:1',
          '-protocol_whitelist', 'file,pipe', '-i', job.source, '-map', '0:a:0',
          '-vn', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', job.wav,
        ], 15 * 60 * 1000, 'decoding', onEvent);
        if (job.cancelled) throw mediaError('分析已取消。');
        onEvent({ kind: 'progress', phase: 'waveform', percent: null });
        onEvent({ kind: 'wave', metric: 'rms', peaks: await waveRms(job.wav) });
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : '声音波形生成失败。';
        onEvent({ kind: 'wave-error', message });
        onEvent({ kind: 'transcript-error', message: '未能读出音轨，暂不能自动识别台词。' });
        return;
      }
      if (job.durationMs > MAX_TRANSCRIPT_MS) {
        onEvent({ kind: 'transcript-error', message: '超过 30 分钟的长片暂不自动整段转写；波形和标记仍可用。' });
        return;
      }
      let whisper;
      let model;
      try {
        whisper = await tools.whisper();
        model = await tools.model();
      } catch (cause) {
        onEvent({ kind: 'transcript-error', message: cause instanceof Error ? cause.message : '本机语音模型不可用。' });
        return;
      }
      if (!whisper || !model) {
        onEvent({ kind: 'transcript-error', message: '本机还没有连接可用的离线语音识别模型。' });
        return;
      }
      try {
        if (job.cancelled) throw mediaError('分析已取消。');
        onEvent({ kind: 'progress', phase: 'loading-model', percent: null });
        await runProgram(job, whisper, [
          '-m', model, '-f', job.wav, '-l', 'zh', '-osrt', '-of', job.transcript, '-pp', '-ng',
        ], 30 * 60 * 1000, 'transcribing', onEvent);
        if (job.cancelled) throw mediaError('分析已取消。');
        onEvent({ kind: 'progress', phase: 'finalizing', percent: null });
        const srt = await fs.readFile(`${job.transcript}.srt`, 'utf8');
        if (srt.trim()) onEvent({ kind: 'transcript', srt });
        else onEvent({ kind: 'transcript-error', message: '这段音轨未识别出可用台词；仍可按波形标记，也可重试识别。' });
      } catch (cause) {
        onEvent({ kind: 'transcript-error', message: cause instanceof MediaAnalysisError ? cause.message : '本机语音识别没有完成；可重试，仍可按波形和画面标记。' });
      }
    } finally {
      try { await cleanup(job); }
      catch { onEvent({ kind: 'cleanup-warning', message: '临时媒体未能自动清理，请关闭工具后检查本机临时目录。' }); }
      if (this.job === job) this.job = null;
      job.finished();
    }
  }

  async cancel(id) {
    const job = this.job;
    if (!job || job.id !== id) return false;
    job.cancelPromise ??= (async () => {
      job.cancelled = true;
      job.child?.kill();
      if (job.processing) await job.done;
      else {
        try { await cleanup(job); }
        finally { if (this.job === job) this.job = null; job.finished(); }
      }
      return true;
    })();
    return job.cancelPromise;
  }

  async close() {
    await this.startDone;
    if (this.job) await this.cancel(this.job.id);
  }
}
