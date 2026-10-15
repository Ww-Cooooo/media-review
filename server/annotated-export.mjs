export const escapeHtml = value => String(value).replace(/[&<>"']/gu, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function annotatedSvg(reference, jpeg, regions) {
  const { width, height } = reference;
  const size = Math.max(18, Math.round(Math.min(width, height) * .045));
  const shapes = regions.map(({ id, rect }) => {
    const x = rect.x * width, y = rect.y * height, w = rect.width * width, h = rect.height * height;
    const labelWidth = Math.max(size, String(id).length * size * .65 + 8);
    const lx = Math.max(0, Math.min(width - labelWidth, x)), ly = Math.max(0, Math.min(height - size, y));
    return `<rect x="${x}" y="${y}" width="${w}" height="${h}" fill="none" stroke="#ffcd60" stroke-width="${Math.max(2, size / 9)}"/><rect x="${lx}" y="${ly}" width="${labelWidth}" height="${size}" rx="3" fill="#3b261d"/><text x="${lx + labelWidth / 2}" y="${ly + size * .78}" text-anchor="middle" fill="#fff" font-family="sans-serif" font-weight="700" font-size="${size * .76}">${id}</text>`;
  }).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="带编号区域的参考画面"><image width="${width}" height="${height}" href="data:image/jpeg;base64,${jpeg.toString('base64')}"/>${shapes}</svg>`;
}

export function readableExport(record, cards, metadata) {
  return `<!doctype html><html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; base-uri 'none'"><title>校对返修清单</title><style>body{font:16px/1.65 system-ui,sans-serif;color:#29251f;background:#faf8f3;max-width:980px;margin:32px auto;padding:0 24px}h1{font-size:28px}article{background:white;border:1px solid #ded9cd;border-radius:12px;padding:24px;margin:24px 0;break-inside:avoid}img{display:block;max-width:100%;max-height:70vh;object-fit:contain;margin:16px auto}pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}.meta{color:#615749;font-size:14px}li{margin:8px 0}a{color:#8a4326}@media print{body{background:#fff}article{border-color:#bbb}}</style><h1>音视频校对返修清单</h1><p>${escapeHtml(record.media.name)}</p><p class="meta">${metadata?.taskId ? `任务 ${escapeHtml(metadata.taskId)} · V${metadata.version?.number ?? 1} · 来源 ${escapeHtml(metadata.sourceLabel ?? '')}<br>` : ''}意见修订：${escapeHtml(metadata?.revision ?? '')}<br>时间基于此版原媒体，旧标记不自动套用新版。原片未包含，审阅完成不代表发布许可。</p>${record.completion ? `<p>${record.completion.outcome === 'no-changes' ? '本轮审阅完成，无修改意见。' : '本轮审阅完成，意见如下。'}</p>` : ''}${cards.join('\n')}<p class="meta">原图在 references，带编号框的独立图片在 annotated，完整数据在 review.json。进度说明是返修记录，不代替用户验收。</p></html>`;
}
