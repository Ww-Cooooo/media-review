import { useEffect, useRef, useState } from 'react';
import type { Rect } from '../lib/review';

interface Props { rect: Rect | null; drawing: boolean; onChange: (rect: Rect) => void; onDone: (rect: Rect) => void }
export function FrameCanvas({ rect, drawing, onChange, onDone }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onChange, onDone, drawing, rect });
  callbacks.current = { onChange, onDone, drawing, rect };
  const [failure, setFailure] = useState('');
  const sync = useRef<(() => void) | null>(null);
  useEffect(() => { sync.current?.(); }, [rect]);
  useEffect(() => {
    const node = host.current;
    if (!node) return;
    let cancelled = false;
    let dispose = () => {};
    void import('fabric').then(({ Canvas, Rect: FabricRect }) => {
      if (cancelled) return;
      const element = document.createElement('canvas'); node.append(element);
      const canvas = new Canvas(element, { selection: false, renderOnAddRemove: false, enableRetinaScaling: true, stopContextMenu: true });
      let shape: InstanceType<typeof FabricRect> | null = null;
      let origin: { x: number; y: number } | null = null;
      const width = () => Math.max(1, node.clientWidth), height = () => Math.max(1, node.clientHeight);
      const add = (r: Rect) => {
        shape = new FabricRect({ left: r.x * width(), top: r.y * height(), width: r.width * width(), height: r.height * height(),
          originX: 'left', originY: 'top', fill: '#cf8b5018', stroke: '#ffd1a6', strokeWidth: 2, strokeUniform: true,
          cornerColor: '#ffd1a6', cornerStrokeColor: '#483527', cornerSize: 10, transparentCorners: false,
          lockRotation: true, lockScalingFlip: true, noScaleCache: false });
        shape.setControlsVisibility({ mtr: false }); canvas.add(shape);
      };
      const normalized = (): Rect => {
        if (!shape) return { x: 0, y: 0, width: .1, height: .1 };
        const x = Math.max(0, Math.min(.98, (shape.left ?? 0) / canvas.getWidth()));
        const y = Math.max(0, Math.min(.98, (shape.top ?? 0) / canvas.getHeight()));
        return { x, y, width: Math.min(1 - x, Math.max(.02, shape.width * shape.scaleX / canvas.getWidth())), height: Math.min(1 - y, Math.max(.02, shape.height * shape.scaleY / canvas.getHeight())) };
      };
      const fit = () => {
        const value = shape ? normalized() : callbacks.current.rect;
        canvas.setDimensions({ width: width(), height: height() });
        if (!shape && value) add(value);
        if (shape && value) shape.set({ left: value.x * width(), top: value.y * height(), width: value.width * width(), height: value.height * height(), scaleX: 1, scaleY: 1 }).setCoords();
        canvas.requestRenderAll();
      };
      fit();
      if (!drawing && shape) canvas.setActiveObject(shape);
      canvas.skipTargetFind = drawing;
      canvas.on('mouse:down', event => {
        if (!callbacks.current.drawing) return;
        origin = { x: event.scenePoint.x, y: event.scenePoint.y };
        if (shape) { canvas.remove(shape); shape = null; }
        add({ x: origin.x / width(), y: origin.y / height(), width: .001, height: .001 });
        canvas.requestRenderAll();
      });
      canvas.on('mouse:move', event => {
        if (!origin || !shape) return;
        const x = Math.max(0, Math.min(width(), event.scenePoint.x)), y = Math.max(0, Math.min(height(), event.scenePoint.y));
        shape.set({ left: Math.min(origin.x, x), top: Math.min(origin.y, y), width: Math.abs(x - origin.x), height: Math.abs(y - origin.y) });
        canvas.requestRenderAll();
      });
      canvas.on('mouse:up', () => {
        if (!origin || !shape) return;
        origin = null;
        if (shape.width / width() < .02 || shape.height / height() < .02) { canvas.remove(shape); shape = null; canvas.requestRenderAll(); return; }
        callbacks.current.onDone(normalized());
      });
      canvas.on('object:modified', () => { callbacks.current.onChange(normalized()); });
      const observer = new ResizeObserver(fit); observer.observe(node);
      sync.current = () => {
        const value = callbacks.current.rect;
        if (!shape || !value || origin) return;
        shape.set({ left: value.x * width(), top: value.y * height(), width: value.width * width(), height: value.height * height(), scaleX: 1, scaleY: 1 }).setCoords();
        canvas.requestRenderAll();
      };
      dispose = () => { sync.current = null; observer.disconnect(); void canvas.dispose(); };
    }).catch(() => { if (!cancelled) setFailure('画面绘制层未能加载，请重新框选；已有坐标仍保留。'); });
    return () => { cancelled = true; dispose(); };
  }, [drawing]);
  return <div className="frame-layer" ref={host} data-drawing={drawing} aria-label="画面框选与方框编辑">{failure && <p role="alert" className="canvas-failure">{failure}</p>}</div>;
}
