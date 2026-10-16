import { useEffect, useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { Button, Input } from 'antd';
import { CheckOutlined, DeleteOutlined } from '@ant-design/icons';
import gsap from 'gsap';
import { useGSAP } from '@gsap/react';
import { formatTime, type FrameRegion } from '../lib/review';
import { placeFrameComment } from '../lib/frame-comment-placement';

interface Props {
  region?: FrameRegion; stage: RefObject<HTMLDivElement | null>; frameMs: number | null;
  reduced: boolean; disabled: boolean; drawing: boolean;
  onChange: (id: number, text: string) => void; onComplete: () => void; onDelete: (id: number) => void;
}

export function FrameComment(props: Props) {
  const [last, setLast] = useState(props.region);
  const current = useRef(props.region); current.current = props.region;
  useEffect(() => { if (props.region) setLast(props.region); }, [props.region]);
  const shown = props.region ?? last;
  return shown ? <FrameCommentCard {...props} region={shown} open={!!props.region} onExited={() => { if (!current.current) setLast(undefined); }} /> : null;
}

function FrameCommentCard({ region, stage, frameMs, reduced, disabled, drawing, onChange, onComplete, onDelete, open, onExited }: Props & { region: FrameRegion; open: boolean; onExited: () => void }) {
  const slot = useRef<HTMLDivElement>(null), card = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<ReturnType<typeof placeFrameComment>>(null);
  const [ready, setReady] = useState(false);
  const [required, setRequired] = useState(false);
  useLayoutEffect(() => {
    const area = stage.current, frame = area?.querySelector('.video-holder'), note = card.current;
    if (!area || !frame || !note) return;
    const measure = () => {
      const a = area.getBoundingClientRect(), f = frame.getBoundingClientRect(), r = region.rect;
      const next = placeFrameComment({ x: 0, y: 0, width: a.width, height: a.height },
        { x: f.left - a.left, y: f.top - a.top, width: f.width, height: f.height },
        { x: f.left - a.left + r.x * f.width, y: f.top - a.top + r.y * f.height, width: r.width * f.width, height: r.height * f.height },
        { width: note.offsetWidth, height: note.offsetHeight });
      setPosition(old => JSON.stringify(old) === JSON.stringify(next) ? old : next); setReady(true);
    };
    const observer = new ResizeObserver(measure); [area, frame, note].forEach(node => observer.observe(node));
    measure(); return () => observer.disconnect();
  }, [stage, region.id, region.rect.x, region.rect.y, region.rect.width, region.rect.height]);
  useLayoutEffect(() => {
    setRequired(false);
    if (!open) return;
    const timer = requestAnimationFrame(() => {
      const input = card.current?.querySelector('textarea'); input?.focus({ preventScroll: true });
      const b = card.current?.getBoundingClientRect();
      if (b && (b.bottom > innerHeight - 16 || b.top < 76)) card.current?.scrollIntoView({ block: 'nearest', behavior: 'instant' });
    });
    return () => cancelAnimationFrame(timer);
  }, [region.id, open]);
  useGSAP(() => {
    if (!card.current || !ready) return;
    if (reduced) { gsap.set(card.current, { clearProps: 'transform,opacity' }); if (!open) onExited(); return; }
    if (!open) { gsap.to(card.current, { opacity: 0, x: position?.side === 'left' ? 12 : -12, scale: .92, duration: .17, ease: 'power2.in', onComplete: onExited, overwrite: true }); return; }
    gsap.fromTo(card.current, { opacity: 0, x: position?.side === 'left' ? 16 : -16, scaleX: .92, scaleY: .94 },
      { opacity: 1, x: 0, scaleX: 1, scaleY: 1, duration: .25, ease: 'power3.out', overwrite: true });
  }, { scope: slot, dependencies: [region.id, open, ready, reduced], revertOnUpdate: true });
  const { contextSafe } = useGSAP({ scope: slot });
  const complete = contextSafe(() => {
    if (!region.text?.trim()) { setRequired(true); card.current?.querySelector('textarea')?.focus(); return; }
    // The draft already owns every keystroke. Exit motion only hides its view.
    onComplete();
  });
  return <div ref={slot} inert={!open} aria-hidden={!open || undefined} className={`frame-comment-slot ${position ? 'is-floating' : 'is-docked'}${open ? '' : ' is-closing'}`} style={position ? { left: position.x, top: position.y } : undefined}>
    <div ref={card} className="frame-comment" role="group" aria-label={`框 ${region.id} 的意见`} data-region-comment-editor={region.id} data-lenis-prevent>
      <header><span className="frame-comment-badge">{region.id}</span><div><label htmlFor={`frame-opinion-${region.id}`}>框 {region.id} 的意见</label><small>{frameMs !== null ? formatTime(frameMs) : '当前参考画面'} · 只对应此框</small></div><span className={`frame-comment-status ${region.text?.trim() ? 'is-filled' : 'is-pending'}`}>{region.text?.trim() ? '已填写' : '待填写'}</span></header>
      <Input.TextArea id={`frame-opinion-${region.id}`} aria-label={`框 ${region.id} 的意见内容`} value={region.text ?? ''} disabled={disabled} maxLength={2000} autoSize={{ minRows: 3, maxRows: 6 }} placeholder="这里有什么问题，希望怎么改？" status={required && !region.text?.trim() ? 'error' : undefined} onChange={event => onChange(region.id, event.target.value)} onKeyDown={event => { if ((event.ctrlKey || event.metaKey) && event.key === 'Enter' && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); complete(); } }} />
      <div className="frame-comment-help" role="status">{required && !region.text?.trim() ? '请填写这个框的意见，或删除此框。' : drawing ? '写完点完成，即可继续在画面上拖框。' : '完成后，记得保存整条意见。'}<span>{(region.text ?? '').length}/2000</span></div>
      <footer><Button danger type="text" icon={<DeleteOutlined />} disabled={disabled} onClick={() => onDelete(region.id)}>删除</Button><Button type="primary" icon={<CheckOutlined />} disabled={disabled} onClick={complete}>完成</Button></footer>
    </div>
  </div>;
}
