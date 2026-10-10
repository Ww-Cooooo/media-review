// 只从当前本机工具的输出提取进度，忽略原话和其他日志。
export function progressDecoder(stage, durationMs, onProgress) {
  let pending = '';
  let lastPercent = -1;
  let started = false;
  const report = percent => {
    const value = Math.max(0, Math.min(100, Math.floor(percent)));
    if (value <= lastPercent) return;
    lastPercent = value;
    onProgress({ kind: 'progress', phase: stage, percent: value });
  };
  const line = value => {
    if (stage === 'decoding') {
      const time = value.match(/^out_time_us=(\d+)$/u);
      if (time && durationMs > 0) report(Number(time[1]) / 1000 / durationMs * 100);
      if (value === 'progress=end') report(100);
    } else if (stage === 'transcribing') {
      if (!started && /^main:\s+processing\b/u.test(value)) { started = true; report(0); }
      const percent = value.match(/\bprogress\s*=\s*(\d+)\s*%/u);
      if (percent) { started = true; report(Number(percent[1])); }
    }
  };
  return chunk => {
    pending += chunk.toString();
    const lines = pending.split(/[\r\n]+/u);
    pending = (lines.pop() ?? '').slice(-4096);
    for (const value of lines) line(value.trim());
  };
}
