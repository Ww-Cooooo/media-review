import { useEffect, useRef, useState } from 'react';
import type { FrameRegion, Rect } from '../lib/review';

interface Props { selected?: number | null; onSelect?: (id: number) => void; regions: FrameRegion[]; regionSerial: number; drawing: boolean; onChange: (regions: FrameRegion[]) => void; onDone: (region: FrameRegion) => void }

export function FrameRegions({ regions, labelsOnly = false, selected, onSelect }: { regions: FrameRegion[]; labelsOnly?: boolean; selected?: number | null; onSelect?: (id: number) => void }) {
  return <>{regions.map(({ id, rect }) => <span key={id} data-region-id={id} role={onSelect ? 'button' : undefined} tabIndex={onSelect ? 0 : undefined} aria-label={onSelect ? `查看区域 ${id} 的说明` : undefined} onClick={onSelect ? () => onSelect(id) : undefined} onKeyDown={onSelect ? event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onSelect(id); } } : undefined} className={(labelsOnly ? 'region-label-anchor' : 'region-rect') + (selected === id ? ' region-active' : '') + (onSelect ? ' region-interactive' : '')} style={{ left: rect.x * 100 + '%', top: rect.y * 100 + '%', width: rect.width * 100 + '%', height: rect.height * 100 + '%' }}><b className="region-number">{id}</b></span>)}</>;
}

export function FrameCanvas({ regions, regionSerial, drawing, onChange, onDone, selected, onSelect }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onChange, onDone, drawing, regions, regionSerial, selected, onSelect });
  callbacks.current = { onChange, onDone, drawing, regions, regionSerial, selected, onSelect };
  const [failure, setFailure] = useState('');
  const sync = useRef<(() => void) | null>(null);
  useEffect(() => { sync.current?.(); }, [regions, selected]);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    let cancelled = false, dispose = () => {};
    void import('fabric').then(({ Canvas, Rect: FabricRect }) => {
      if (cancelled) return;
      const element = document.createElement('canvas'); node.append(element);
      const canvas = new Canvas(element, { selection: false, renderOnAddRemove: false, enableRetinaScaling: true, stopContextMenu: true });
      const shapes = new Map<number, InstanceType<typeof FabricRect>>();
      let preview: InstanceType<typeof FabricRect> | null = null;
      let origin: { x: number; y: number } | null = null;
      const width = () => Math.max(1, canvas.getWidth()), height = () => Math.max(1, canvas.getHeight());
      const add = (r: Rect) => {
        const shape = new FabricRect({ left: r.x * width(), top: r.y * height(), width: r.width * width(), height: r.height * height(),
          originX: 'left', originY: 'top', fill: '#cf8b5018', stroke: '#ffd1a6', strokeWidth: 2, strokeUniform: true,
          cornerColor: '#ffd1a6', cornerStrokeColor: '#483527', cornerSize: 10, transparentCorners: false,
          lockRotation: true, lockScalingFlip: true });
        shape.setControlsVisibility({ mtr: false }); canvas.add(shape); return shape;
      };
      const normalized = (shape: InstanceType<typeof FabricRect>): Rect => {
        const x = Math.max(0, Math.min(.98, (shape.left ?? 0) / width()));
        const y = Math.max(0, Math.min(.98, (shape.top ?? 0) / height()));
        return { x, y, width: Math.min(1 - x, Math.max(.02, shape.width * shape.scaleX / width())), height: Math.min(1 - y, Math.max(.02, shape.height * shape.scaleY / height())) };
      };
      const render = () => {
        if (origin) return;
        canvas.setDimensions({ width: Math.max(1, node.clientWidth), height: Math.max(1, node.clientHeight) });
        const values = callbacks.current.regions;
        for (const [id, shape] of shapes) if (!values.some(item => item.id === id)) { canvas.remove(shape); shapes.delete(id); }
        for (const { id, rect } of values) {
          const shape = shapes.get(id) ?? add(rect); shapes.set(id, shape);
          shape.set({ left: rect.x * width(), top: rect.y * height(), width: rect.width * width(), height: rect.height * height(), scaleX: 1, scaleY: 1 }).setCoords();
        }
        const active = callbacks.current.selected;
        if (!callbacks.current.drawing && active && shapes.has(active)) canvas.setActiveObject(shapes.get(active)!);
        else if (!active) canvas.discardActiveObject();
        canvas.requestRenderAll();
      };
      render(); canvas.skipTargetFind = drawing;
      canvas.on('mouse:down', event => {
        if (!callbacks.current.drawing || callbacks.current.regions.length >= 50) return;
        origin = { x: Math.max(0, Math.min(width(), event.scenePoint.x)), y: Math.max(0, Math.min(height(), event.scenePoint.y)) };
        preview = add({ x: origin.x / width(), y: origin.y / height(), width: .001, height: .001 });
        canvas.requestRenderAll();
      });
      canvas.on('mouse:move', event => {
        if (!origin || !preview) return;
        const x = Math.max(0, Math.min(width(), event.scenePoint.x)), y = Math.max(0, Math.min(height(), event.scenePoint.y));
        preview.set({ left: Math.min(origin.x, x), top: Math.min(origin.y, y), width: Math.abs(x - origin.x), height: Math.abs(y - origin.y) });
        canvas.requestRenderAll();
      });
      canvas.on('mouse:up', () => {
        if (!origin || !preview) return;
        origin = null;
        const valid = preview.width / width() >= .02 && preview.height / height() >= .02;
        const rect = normalized(preview); canvas.remove(preview); preview = null;
        if (valid) callbacks.current.onDone({ id: Math.max(callbacks.current.regionSerial, 0, ...callbacks.current.regions.map(item => item.id)) + 1, rect });
        canvas.requestRenderAll();
      });
      const select = () => { const entry = [...shapes].find(([, shape]) => shape === canvas.getActiveObject()); if (entry) callbacks.current.onSelect?.(entry[0]); };
      canvas.on('selection:created', select); canvas.on('selection:updated', select);
      canvas.on('object:modified', event => {
        const entry = [...shapes].find(([, shape]) => shape === event.target);
        if (!entry) return;
        callbacks.current.onChange(callbacks.current.regions.map(item => item.id === entry[0] ? { ...item, rect: normalized(entry[1]) } : item));
      });
      const observer = new ResizeObserver(render); observer.observe(node); sync.current = render;
      dispose = () => { sync.current = null; observer.disconnect(); void canvas.dispose(); };
    }).catch(() => { if (!cancelled) setFailure('画面绘制层未能加载，已有标记仍保留。请重新进入框选。'); });
    return () => { cancelled = true; dispose(); };
  }, [drawing]);
  return <div className="frame-layer" data-drawing={drawing} aria-label="画面框选与方框编辑"><div className="frame-canvas-host" ref={host} /><FrameRegions regions={regions} labelsOnly selected={selected} />{failure && <p role="alert" className="canvas-failure">{failure}</p>}</div>;
}
