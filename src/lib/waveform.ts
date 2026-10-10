/** 同一段归一化RMS按真实时间重叠聚合；缩放与平移不另调增益。 */
export function visibleRms(values: number[], durationMs: number, startMs: number, endMs: number, requestedBars: number): number[] {
  if (!values.length || durationMs <= 0 || endMs <= startMs) return [];
  const start = Math.max(0, Math.min(values.length, startMs / durationMs * values.length));
  const end = Math.max(start, Math.min(values.length, endMs / durationMs * values.length));
  if (end <= start) return [];
  const count = Math.max(1, Math.min(720, Math.floor(requestedBars), Math.ceil(end - start)));
  const width = (end - start) / count;
  return Array.from({ length: count }, (_, i) => {
    const from = start + i * width;
    const to = start + (i + 1) * width;
    let energy = 0;
    for (let at = Math.floor(from); at < Math.ceil(to) && at < values.length; at++) {
      const overlap = Math.max(0, Math.min(to, at + 1) - Math.max(from, at));
      energy += values[at] * values[at] * overlap;
    }
    return Math.sqrt(energy / (to - from));
  });
}
