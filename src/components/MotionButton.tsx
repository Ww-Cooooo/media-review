import { useRef } from 'react';
import { Button, type ButtonProps } from 'antd';
import { useGSAP } from '@gsap/react';
import gsap from 'gsap';

/** 命中框不移动，只让按钮内部响应按下与释放；业务动作仍由 Ant Design 处理。 */
export function MotionButton({ children, icon, ...props }: ButtonProps) {
  const face = useRef<HTMLSpanElement>(null);
  const glyph = useRef<HTMLSpanElement>(null);
  useGSAP((_context, contextSafe) => {
    const button = face.current?.closest('button, a');
    if (!(button instanceof HTMLElement)) return;
    const targets = [face.current, glyph.current].filter(Boolean);
    const preference = window.matchMedia('(prefers-reduced-motion: reduce)');
    let pressed = false;
    let hovered = false;
    const disabled = () => button.matches(':disabled, [aria-disabled="true"], .ant-btn-loading');
    const draw = contextSafe!(() => {
      gsap.to(targets, {
        y: preference.matches ? 0 : pressed ? 1.5 : hovered ? -0.7 : 0,
        scale: preference.matches ? 1 : pressed ? 0.975 : 1,
        duration: preference.matches ? 0 : pressed ? 0.07 : 0.2,
        ease: 'power2.out', overwrite: true,
      });
      button.toggleAttribute('data-pressed', pressed && !disabled());
    });
    const enter = (event: Event) => {
      if ((event as PointerEvent).pointerType === 'touch' || disabled()) return;
      hovered = true;
      draw();
    };
    const release = () => { if (!pressed) return; pressed = false; draw(); };
    const leave = () => { if (!hovered && !pressed) return; hovered = false; pressed = false; draw(); };
    const down = (event: Event) => {
      if ((event as PointerEvent).button !== 0 || disabled()) return;
      pressed = true;
      draw();
    };
    const keydown = (event: Event) => {
      const key = (event as KeyboardEvent).key;
      if ((key !== ' ' && key !== 'Enter') || disabled()) return;
      pressed = true;
      draw();
    };
    const reset = () => { pressed = false; hovered = false; draw(); };
    const events: [string, EventListener][] = [
      ['pointerenter', enter], ['pointerleave', leave], ['pointerdown', down],
      ['pointercancel', reset], ['lostpointercapture', release], ['blur', reset],
      ['keydown', keydown], ['keyup', release],
    ];
    events.forEach(([name, handler]) => button.addEventListener(name, handler));
    window.addEventListener('pointerup', release);
    window.addEventListener('blur', reset);
    preference.addEventListener('change', reset);
    return () => {
      events.forEach(([name, handler]) => button.removeEventListener(name, handler));
      window.removeEventListener('pointerup', release);
      window.removeEventListener('blur', reset);
      preference.removeEventListener('change', reset);
      button.removeAttribute('data-pressed');
    };
  }, { scope: face });
  return <Button {...props} icon={icon ? <span className="control-glyph" ref={glyph} aria-hidden="true">{icon}</span> : undefined}>
    <span className="control-face" ref={face}>{children}</span>
  </Button>;
}
