import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';

export const ANALYSIS_THREADS = Math.max(1, Math.min(4, os.availableParallelism() - 2));

// 只收尾本次spawn取得且尚未退出的子进程，不枚举或结束其他程序。
export function runTool(executable, args, { signal, timeout = 120_000, maxBuffer = 1024 * 1024, onOutput } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    let stdout = '', stderr = '', bytes = 0, failure, settled = false;
    const stop = reason => {
      if (settled || failure) return;
      failure = reason;
      if (child.pid && child.exitCode === null && child.signalCode === null) {
        if (process.platform === 'win32') {
          const killer = spawn(path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
          killer.on('error', () => child.kill()); killer.unref();
        } else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      }
    };
    const abort = () => stop(new DOMException('分析已取消', 'AbortError'));
    signal?.addEventListener('abort', abort, { once: true });
    if (signal?.aborted) abort();
    const timer = setTimeout(() => stop(new Error('本机工具处理超时')), timeout); timer.unref();
    for (const [stream, kind] of [[child.stdout, 'stdout'], [child.stderr, 'stderr']]) stream.on('data', chunk => {
      bytes += chunk.length;
      if (bytes > maxBuffer) { stop(new Error('本机工具输出超过限制')); return; }
      if (kind === 'stdout') stdout += chunk.toString('utf8'); else stderr += chunk.toString('utf8');
      onOutput?.(chunk, kind);
    });
    child.on('error', cause => { failure ??= cause; });
    child.once('close', code => {
      settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
      if (failure || code !== 0) reject(failure ?? new Error('本机工具未完成处理'));
      else resolve({ stdout, stderr });
    });
  });
}
