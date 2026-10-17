/** Shape objects: geometry model + canvas rasterizer.
 *
 * Shapes live as objects (movable/resizable/rotatable) in an SVG overlay in
 * unbounded world coords. When the drawing is sent to the backend or
 * exported, they are rasterized onto the bitmap with drawShapeOnCanvas().
 * Every unknown kind logs an error.
 */
import { createLogger } from '@/lib/logger';

const log = createLogger('shapes');

export type ShapeKind =
  | 'rectangle'
  | 'square'
  | 'ellipse'
  | 'triangle'
  | 'right-triangle'
  | 'diamond'
  | 'line'
  | 'arrow';

export interface CanvasShape {
  id: string;
  kind: ShapeKind;
  /** Top-left in world coords (screen = world - pan). */
  x: number;
  y: number;
  w: number;
  h: number;
  /** Degrees clockwise. */
  rotation: number;
  color: string;
  strokeWidth: number;
}

/** Resize handles: 4 corners + 4 edges. */
export type ResizeHandle = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export interface Vec {
  x: number;
  y: number;
}

export const SHAPE_KINDS: { kind: ShapeKind; label: string }[] = [
  { kind: 'rectangle', label: 'Rect' },
  { kind: 'square', label: 'Square' },
  { kind: 'ellipse', label: 'Ellipse' },
  { kind: 'triangle', label: 'Triangle' },
  { kind: 'right-triangle', label: 'Right tri' },
  { kind: 'diamond', label: 'Diamond' },
  { kind: 'line', label: 'Line' },
  { kind: 'arrow', label: 'Arrow' },
];

export const DEFAULT_STROKE_WIDTH = 3;
export const MIN_SHAPE_SIDE = 8;
/** Rotation snaps to this step so alignment stays predictable. */
export const ROTATION_SNAP_DEG = 15;

export function createId(prefix: string): string {
  try {
    return `${prefix}-${crypto.randomUUID()}`;
  } catch (e) {
    log.error('createId: crypto.randomUUID unavailable, using fallback', e);
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e9)}`;
  }
}

/** Default box per kind, centered on (cx, cy) in world coords. */
function defaultBox(kind: ShapeKind): { w: number; h: number } {
  switch (kind) {
    case 'rectangle':
      return { w: 170, h: 110 };
    case 'square':
      return { w: 120, h: 120 };
    case 'ellipse':
      return { w: 160, h: 110 };
    case 'triangle':
    case 'right-triangle':
    case 'diamond':
      return { w: 140, h: 120 };
    case 'line':
    case 'arrow':
      return { w: 150, h: 0 };
  }
}

export function createShape(kind: ShapeKind, cx: number, cy: number, color: string): CanvasShape {
  const { w, h } = defaultBox(kind);
  const shape: CanvasShape = {
    id: createId('shape'),
    kind,
    x: Math.round(cx - w / 2),
    y: Math.round(cy - h / 2),
    w,
    h,
    rotation: 0,
    color,
    strokeWidth: DEFAULT_STROKE_WIDTH,
  };
  log.debug(`createShape: ${kind} id=${shape.id} box=${w}x${h}`);
  return shape;
}

/** Convert a screen-space delta into the shape's local (possibly rotated) space. */
export function toLocal(dx: number, dy: number, rotationDeg: number): Vec {
  const r = (-rotationDeg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  return { x: dx * c - dy * s, y: dx * s + dy * c };
}

/** Center of a shape in its own coord space (world for state, screen after pan). */
export function shapeCenter(s: { x: number; y: number; w: number; h: number }): Vec {
  return { x: s.x + s.w / 2, y: s.y + s.h / 2 };
}

/**
 * Apply a resize drag in shape-local coords. Dragging past the opposite edge
 * mirrors the box (flip into the back direction) instead of collapsing it.
 * Returns a NEW shape; the input is never mutated.
 */
export function resizeShape(s: CanvasShape, handle: ResizeHandle, dx: number, dy: number): CanvasShape {
  if (!Number.isFinite(dx + dy)) {
    log.error(`resizeShape: non-finite delta id=${s.id} dx=${dx} dy=${dy}`);
    return s;
  }
  let { x, y, w, h } = s;
  if (handle.includes('e')) w += dx;
  if (handle.includes('w')) {
    x += dx;
    w -= dx;
  }
  if (handle.includes('s')) h += dy;
  if (handle.includes('n')) {
    y += dy;
    h -= dy;
  }
  // Flip: crossed the opposite edge -> mirror position, keep size positive.
  if (w < 0) {
    x += w;
    w = -w;
  }
  if (h < 0) {
    y += h;
    h = -h;
  }
  // Lines/arrows may stay flat; every other kind keeps a minimum box.
  const minH = s.kind === 'line' || s.kind === 'arrow' ? 0 : MIN_SHAPE_SIDE;
  if (w < MIN_SHAPE_SIDE) w = MIN_SHAPE_SIDE;
  if (h < minH) h = minH;
  return { ...s, x, y, w, h };
}

/** Snap a rotation to the step grid (keeps alignment predictable). */
export function snapRotation(deg: number): number {
  if (!Number.isFinite(deg)) {
    log.error(`snapRotation: non-finite angle ${deg}`);
    return 0;
  }
  const snapped = Math.round(deg / ROTATION_SNAP_DEG) * ROTATION_SNAP_DEG;
  return ((snapped % 360) + 360) % 360;
}

function arrowHead(
  ctx: CanvasRenderingContext2D,
  ex: number,
  ey: number,
  ang: number,
  len: number,
): void {
  for (const spread of [-Math.PI / 6, Math.PI / 6]) {
    ctx.moveTo(ex, ey);
    ctx.lineTo(ex - len * Math.cos(ang + spread), ey - len * Math.sin(ang + spread));
  }
}

/**
 * Stroke a shape onto a 2D context. Shape coords are in the context's units;
 * rotation applies around the box center. Never throws.
 */
export function drawShapeOnCanvas(ctx: CanvasRenderingContext2D, s: CanvasShape): void {
  const { x, y, w, h } = s;
  if (!Number.isFinite(x + y + w + h + s.rotation)) {
    log.error(
      `drawShapeOnCanvas: non-finite geometry id=${s.id} x=${x} y=${y} w=${w} h=${h} rot=${s.rotation}`,
    );
    return;
  }
  try {
    ctx.save();
    ctx.strokeStyle = s.color;
    ctx.lineWidth = s.strokeWidth;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    // Local frame: origin at box center so rotation pivots correctly.
    ctx.translate(x + w / 2, y + h / 2);
    ctx.rotate(((s.rotation || 0) * Math.PI) / 180);
    const X = -w / 2;
    const Y = -h / 2;
    ctx.beginPath();
    switch (s.kind) {
      case 'rectangle':
      case 'square':
        ctx.rect(X, Y, w, h);
        break;
      case 'ellipse':
        ctx.ellipse(0, 0, Math.abs(w) / 2, Math.abs(h) / 2, 0, 0, Math.PI * 2);
        break;
      case 'triangle':
        ctx.moveTo(0, Y);
        ctx.lineTo(X + w, Y + h);
        ctx.lineTo(X, Y + h);
        ctx.closePath();
        break;
      case 'right-triangle':
        ctx.moveTo(X, Y + h);
        ctx.lineTo(X, Y);
        ctx.lineTo(X + w, Y + h);
        ctx.closePath();
        break;
      case 'diamond':
        ctx.moveTo(0, Y);
        ctx.lineTo(X + w, Y + h / 2);
        ctx.lineTo(0, Y + h);
        ctx.lineTo(X, Y + h / 2);
        ctx.closePath();
        break;
      case 'line':
        ctx.moveTo(X, Y);
        ctx.lineTo(X + w, Y + h);
        break;
      case 'arrow': {
        const ex = X + w;
        const ey = Y + h;
        ctx.moveTo(X, Y);
        ctx.lineTo(ex, ey);
        arrowHead(ctx, ex, ey, Math.atan2(h, w), 14);
        break;
      }
      default:
        log.error(`drawShapeOnCanvas: unknown kind ${(s as { kind: string }).kind} id=${s.id}`);
        ctx.restore();
        return;
    }
    ctx.stroke();
    ctx.restore();
  } catch (e) {
    try {
      ctx.restore();
    } catch {
      /* context already broken */
    }
    log.error(`drawShapeOnCanvas: rasterization failed id=${s.id}`, e);
  }
}
