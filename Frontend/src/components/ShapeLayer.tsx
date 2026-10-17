/** SVG overlay that renders shape objects above the bitmap canvas.
 *
 * The svg root is pointer-transparent so freehand drawing reaches the canvas
 * underneath. Each shape carries an invisible fat hit-stroke (touch friendly)
 * plus, when selected: a selection box, 8 resize handles (corners + edges,
 * drag past the opposite edge to mirror), and a rotation handle above.
 * Coords are world-minus-pan, i.e. CSS pixels on screen.
 * In locked (preview) mode shapes render without any UI and ignore input.
 */
import { useRef } from 'react';
import type { CanvasShape, ResizeHandle, ShapeKind } from '@/lib/shapes';
import { shapeCenter, toLocal } from '@/lib/shapes';
import { createLogger } from '@/lib/logger';

const log = createLogger('shapelayer');

interface LayerProps {
  shapes: CanvasShape[];
  selectedId: string | null;
  dark: boolean;
  pan: { x: number; y: number };
  /** Preview only: render shapes with no selection UI and take no input. */
  locked: boolean;
  onSelect: (id: string | null) => void;
  onMove: (id: string, dx: number, dy: number) => void;
  onResize: (id: string, handle: ResizeHandle, dx: number, dy: number) => void;
  onRotate: (id: string, rotation: number) => void;
  /** Fired when any shape gesture starts (parent pushes an undo snapshot). */
  onInteractStart: () => void;
}

type DragMode = { kind: 'move' } | { kind: 'resize'; handle: ResizeHandle } | { kind: 'rotate' };

/** Mini preview icon for the shapes panel (true geometry, currentColor). */
export function ShapePreview({ kind, size = 20 }: { kind: ShapeKind; size?: number }) {
  const p = { fill: 'none', stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const };
  switch (kind) {
    case 'rectangle':
      return (
        <svg width={size} height={size} viewBox="0 0 20 20">
          <rect x="2" y="5" width="16" height="10" {...p} />
        </svg>
      );
    case 'square':
      return (
        <svg width={size} height={size} viewBox="0 0 20 20">
          <rect x="4" y="4" width="12" height="12" {...p} />
        </svg>
      );
    case 'ellipse':
      return (
        <svg width={size} height={size} viewBox="0 0 20 20">
          <ellipse cx="10" cy="10" rx="8" ry="5.5" {...p} />
        </svg>
      );
    case 'triangle':
      return (
        <svg width={size} height={size} viewBox="0 0 20 20">
          <polygon points="10,3 18,17 2,17" {...p} />
        </svg>
      );
    case 'right-triangle':
      return (
        <svg width={size} height={size} viewBox="0 0 20 20">
          <polygon points="5,3 5,17 17,17" {...p} />
        </svg>
      );
    case 'diamond':
      return (
        <svg width={size} height={size} viewBox="0 0 20 20">
          <polygon points="10,2 18,10 10,18 2,10" {...p} />
        </svg>
      );
    case 'line':
      return (
        <svg width={size} height={size} viewBox="0 0 20 20">
          <line x1="3" y1="10" x2="17" y2="10" {...p} />
        </svg>
      );
    case 'arrow':
      return (
        <svg width={size} height={size} viewBox="0 0 20 20">
          <line x1="2" y1="10" x2="15" y2="10" {...p} />
          <polyline points="10.5,5.5 15,10 10.5,14.5" {...p} />
        </svg>
      );
  }
}

function ShapeBody({ s, hit }: { s: CanvasShape; hit: boolean }) {
  const p = hit
    ? {
        fill: 'none',
        stroke: 'transparent',
        strokeWidth: Math.max(16, s.strokeWidth + 10),
        strokeLinecap: 'round' as const,
        strokeLinejoin: 'round' as const,
        pointerEvents: 'stroke' as const,
      }
    : {
        fill: 'none',
        stroke: s.color,
        strokeWidth: s.strokeWidth,
        strokeLinecap: 'round' as const,
        strokeLinejoin: 'round' as const,
        pointerEvents: 'none' as const,
      };
  const { x, y, w, h } = s;
  switch (s.kind) {
    case 'rectangle':
    case 'square':
      return <rect x={x} y={y} width={w} height={h} {...p} />;
    case 'ellipse':
      return <ellipse cx={x + w / 2} cy={y + h / 2} rx={Math.abs(w) / 2} ry={Math.abs(h) / 2} {...p} />;
    case 'triangle':
      return <polygon points={`${x + w / 2},${y} ${x + w},${y + h} ${x},${y + h}`} {...p} />;
    case 'right-triangle':
      return <polygon points={`${x},${y + h} ${x},${y} ${x + w},${y + h}`} {...p} />;
    case 'diamond':
      return (
        <polygon
          points={`${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`}
          {...p}
        />
      );
    case 'line':
      return <line x1={x} y1={y} x2={x + w} y2={y + h} {...p} />;
    case 'arrow': {
      const ex = x + w;
      const ey = y + h;
      const ang = Math.atan2(h, w);
      const len = 14;
      const spread = Math.PI / 6;
      const hx1 = ex - len * Math.cos(ang - spread);
      const hy1 = ey - len * Math.sin(ang - spread);
      const hx2 = ex - len * Math.cos(ang + spread);
      const hy2 = ey - len * Math.sin(ang + spread);
      return (
        <g>
          <line x1={x} y1={y} x2={ex} y2={ey} {...p} />
          <polyline points={`${hx1},${hy1} ${ex},${ey} ${hx2},${hy2}`} {...p} />
        </g>
      );
    }
  }
}

const HANDLES: { id: ResizeHandle; cursor: string; at: (s: CanvasShape) => { x: number; y: number } }[] = [
  { id: 'nw', cursor: 'nwse-resize', at: (s) => ({ x: s.x, y: s.y }) },
  { id: 'n', cursor: 'ns-resize', at: (s) => ({ x: s.x + s.w / 2, y: s.y }) },
  { id: 'ne', cursor: 'nesw-resize', at: (s) => ({ x: s.x + s.w, y: s.y }) },
  { id: 'e', cursor: 'ew-resize', at: (s) => ({ x: s.x + s.w, y: s.y + s.h / 2 }) },
  { id: 'se', cursor: 'nwse-resize', at: (s) => ({ x: s.x + s.w, y: s.y + s.h }) },
  { id: 's', cursor: 'ns-resize', at: (s) => ({ x: s.x + s.w / 2, y: s.y + s.h }) },
  { id: 'sw', cursor: 'nesw-resize', at: (s) => ({ x: s.x, y: s.y + s.h }) },
  { id: 'w', cursor: 'ew-resize', at: (s) => ({ x: s.x, y: s.y + s.h / 2 }) },
];

const HANDLE_R = 7;
const ROTATE_OFFSET = 30;

export default function ShapeLayer({
  shapes,
  selectedId,
  dark,
  pan,
  locked,
  onSelect,
  onMove,
  onResize,
  onRotate,
  onInteractStart,
}: LayerProps) {
  const drag = useRef<null | ({ id: string; x: number; y: number } & DragMode)>(null);
  const sel = dark ? '#ede6d6' : '#000000';
  const selEdge = dark ? '#000000' : '#ffffff';

  function capture(e: React.PointerEvent) {
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch (err) {
      log.error('shapelayer: pointer capture failed', err);
    }
  }

  function begin(e: React.PointerEvent, id: string, mode: DragMode) {
    if (locked) return; // preview only: presses fall through to canvas pan
    e.stopPropagation();
    capture(e);
    onInteractStart();
    onSelect(id);
    drag.current = { id, ...mode, x: e.clientX, y: e.clientY };
    log.debug(`shapelayer: ${mode.kind} start ${id}`);
  }

  function shapeById(id: string): CanvasShape | undefined {
    return shapes.find((s) => s.id === id);
  }

  function move(e: React.PointerEvent) {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (dx === 0 && dy === 0) return;
    d.x = e.clientX;
    d.y = e.clientY;
    if (d.kind === 'move') {
      onMove(d.id, dx, dy);
    } else if (d.kind === 'resize') {
      const s = shapeById(d.id);
      if (!s) {
        log.error(`shapelayer: resize target ${d.id} vanished mid-drag`);
        drag.current = null;
        return;
      }
      const local = toLocal(dx, dy, s.rotation);
      onResize(d.id, d.handle, local.x, local.y);
    } else {
      const s = shapeById(d.id);
      if (!s) {
        log.error(`shapelayer: rotate target ${d.id} vanished mid-drag`);
        drag.current = null;
        return;
      }
      // Screen-space center (world - pan); rotation follows the finger.
      const c = shapeCenter(s);
      const pointerAngle = (Math.atan2(e.clientY - (c.y - pan.y), e.clientX - (c.x - pan.x)) * 180) / Math.PI;
      onRotate(d.id, pointerAngle + 90);
    }
  }

  function end() {
    if (drag.current) {
      log.debug(`shapelayer: ${drag.current.kind} end ${drag.current.id}`);
      drag.current = null;
    }
  }

  return (
    <svg
      aria-hidden={shapes.length === 0}
      className="absolute left-0 top-0 h-full w-full"
      style={{ pointerEvents: 'none' }}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
    >
      <g transform={`translate(${-pan.x},${-pan.y})`}>
        {shapes.map((s) => {
          const c = shapeCenter(s);
          const rot = `rotate(${s.rotation} ${c.x} ${c.y})`;
          const selected = !locked && selectedId === s.id;
          return (
            <g key={s.id} transform={rot}>
              <g
                style={{ pointerEvents: locked ? 'none' : 'auto', touchAction: 'none' }}
                onPointerDown={(e) => begin(e, s.id, { kind: 'move' })}
              >
                <ShapeBody s={s} hit />
                <g style={{ pointerEvents: 'none' }}>
                  <ShapeBody s={s} hit={false} />
                </g>
              </g>
              {selected && (
                <g style={{ pointerEvents: 'none' }}>
                  <rect
                    x={s.x - 7}
                    y={s.y - 7}
                    width={s.w + 14}
                    height={Math.max(s.h + 14, 14)}
                    fill="none"
                    stroke={sel}
                    strokeWidth={1.5}
                  />
                </g>
              )}
              {selected &&
                HANDLES.map(({ id, cursor, at }) => {
                  const p = at(s);
                  return (
                    <rect
                      key={id}
                      x={p.x - HANDLE_R}
                      y={p.y - HANDLE_R}
                      width={HANDLE_R * 2}
                      height={HANDLE_R * 2}
                      fill={sel}
                      stroke={selEdge}
                      strokeWidth={2}
                      style={{ pointerEvents: 'auto', touchAction: 'none', cursor }}
                      onPointerDown={(e) => begin(e, s.id, { kind: 'resize', handle: id })}
                    />
                  );
                })}
              {selected && (
                <g>
                  <line
                    x1={c.x}
                    y1={s.y - 8}
                    x2={c.x}
                    y2={s.y - ROTATE_OFFSET + 8}
                    stroke={sel}
                    strokeWidth={1.5}
                    style={{ pointerEvents: 'none' }}
                  />
                  <circle
                    cx={c.x}
                    cy={s.y - ROTATE_OFFSET}
                    r={9}
                    fill={sel}
                    stroke={selEdge}
                    strokeWidth={2}
                    style={{ pointerEvents: 'auto', touchAction: 'none', cursor: 'grab' }}
                    onPointerDown={(e) => begin(e, s.id, { kind: 'rotate' })}
                  />
                </g>
              )}
            </g>
          );
        })}
      </g>
    </svg>
  );
}
