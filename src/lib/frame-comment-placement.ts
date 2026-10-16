export interface Bounds { x: number; y: number; width: number; height: number }

// All coordinates are relative to the player's workspace, not the viewport.
// If no side leaves the selected region visible, use normal document flow.
export function placeFrameComment(area: Bounds, frame: Bounds, region: Bounds, card: { width: number; height: number }) {
  const gap = 14, margin = 8;
  const clamp = (n: number, a: number, b: number) => Math.max(a, Math.min(b, n));
  const overlap = (a: Bounds, b: Bounds) => Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) * Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
  if (area.width < 570 || card.width + margin * 2 > area.width || card.height + margin * 2 > area.height) return null;
  const anchor = frame.height > frame.width ? frame : region;
  const candidates = [
    { x: anchor.x + anchor.width + gap, y: region.y, side: 'right' },
    { x: anchor.x - card.width - gap, y: region.y, side: 'left' },
    { x: region.x, y: region.y + region.height + gap, side: 'bottom' },
    { x: region.x, y: region.y - card.height - gap, side: 'top' },
  ].map(item => ({ ...item, x: clamp(item.x, margin, area.width - card.width - margin), y: clamp(item.y, margin, area.height - card.height - margin), ...card }));
  const safe = candidates.filter(item => !overlap(item, { x: region.x - 6, y: region.y - 6, width: region.width + 12, height: region.height + 12 }));
  safe.sort((a, b) => overlap(a, frame) - overlap(b, frame));
  return safe[0] ?? null;
}
