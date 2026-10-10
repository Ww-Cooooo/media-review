import { memo, useEffect, useRef, useState } from 'react';
import { visibleRms } from '../lib/waveform';

interface Props { values: number[]; contrast: boolean }
export const WavePlot = memo(function WavePlot({ values, contrast }: Props) {
  const host = useRef<HTMLDivElement>(null);
  const [ready, setReady] = useState(false);
  useEffect(() => {
    const node = host.current;
    if (!node || !node.clientWidth || !node.clientHeight || !values.length) return;
    let cancelled = false;
    let destroy = () => {};
    setReady(false);
    void import('@antv/g2').then(async ({ Chart }) => {
      if (cancelled) return;
      const chart = new Chart({ container: node, autoFit: true, height: node.clientHeight });
      destroy = () => chart.destroy();
      chart.options({
        type: 'interval', animate: false, padding: 0, margin: 0, inset: 0,
        data: values.map((value, i) => ({ i: String(i), rms: value, upper: (contrast ? value * value : value) * .46, lower: -(contrast ? value * value : value) * .46 })),
        encode: { x: 'i', y: 'upper', y1: 'lower' },
        scale: { x: { paddingInner: .34, paddingOuter: 0 }, y: { domain: [-.5, .5], nice: false } },
        axis: false, legend: false, interaction: { tooltip: false }, style: { fill: '#62775b', lineWidth: 0, radius: 1.5 },
      });
      try { await chart.render(); if (!cancelled) setReady(true); }
      catch { if (!cancelled) { chart.destroy(); destroy = () => {}; node.replaceChildren(); } }
    }).catch(() => {});
    return () => { cancelled = true; destroy(); node.replaceChildren(); };
  }, [values, contrast]);
  return <div className="wave-plot" aria-hidden="true">
    <div ref={host} className="g2-wave" style={{ opacity: ready ? 1 : 0 }} />
    {!ready && <svg viewBox={`0 0 ${Math.max(1, values.length) * 6} 100`} preserveAspectRatio="none">{values.map((value, i) => {
      const height = (contrast ? value * value : value) * 92;
      return <rect key={i} x={i * 6 + 1} y={50 - height / 2} width="3.6" height={height} rx="1.5" fill="#62775b" />;
    })}</svg>}
  </div>;
});
export { visibleRms };
