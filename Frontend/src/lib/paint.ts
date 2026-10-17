/** Retained freehand strokes + viewport painter.
 *
 * Infinite-canvas model: strokes live in unbounded world coords, the bitmap
 * canvas only ever renders the current viewport frame (world - pan). That
 * frame is exactly what gets sent to the AI and saved — nothing off-screen.
 */
import { createLogger } from '@/lib/logger';

const log = createLogger('paint');

export interface Vec {
  x: number;
  y: number;
}

/** One freehand stroke in world coords. Points are never mutated after commit. */
export interface Stroke {
  id: string;
  color: string;
  width: number;
  points: Vec[];
}

/** Pan math: content follows the finger/pointer (grab-the-paper).
 *
 * Viewport shows world [pan, pan + size], so moving the pointer by (dx, dy)
 * must move the viewport origin by (-dx, -dy) for the content to track the
 * pointer 1:1. Adding the delta instead mirrors the motion (bug).
 */
export function applyPanDelta(
  startPan: Vec,
  startCentroid: Vec,
  centroid: Vec,
): Vec {
  const dx = centroid.x - startCentroid.x;
  const dy = centroid.y - startCentroid.y;
  if (!Number.isFinite(dx + dy)) {
    log.error(`applyPanDelta: non-finite delta (${dx},${dy}) — pan unchanged`);
    return startPan;
  }
  return { x: Math.round(startPan.x - dx), y: Math.round(startPan.y - dy) };
}

/** Eraser hit tolerance in CSS px (generous for fingers/stylus). */
export const ERASER_TOLERANCE = 14;

function pointSegDist(p: Vec, a: Vec, b: Vec): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  if (len2 === 0) return Math.hypot(p.x - a.x, p.y - a.y);
  let t = ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
}

/**
 * Ids of strokes passing within tolerance of a world-space point.
 * Single-point strokes (dots) hit by radius. Never throws.
 */
export function hitStrokes(strokes: Stroke[], at: Vec, tolerance: number = ERASER_TOLERANCE): string[] {
  if (!Number.isFinite(at.x + at.y) || !Number.isFinite(tolerance) || tolerance < 0) {
    log.error(`hitStrokes: invalid point (${at?.x},${at?.y}) or tolerance ${tolerance}`);
    return [];
  }
  const hits: string[] = [];
  for (const s of strokes) {
    if (s.points.length === 0) continue;
    if (s.points.length === 1) {
      const p = s.points[0];
      if (Number.isFinite(p.x + p.y) && Math.hypot(at.x - p.x, at.y - p.y) <= tolerance) hits.push(s.id);
      continue;
    }
    for (let i = 1; i < s.points.length; i++) {
      const a = s.points[i - 1];
      const b = s.points[i];
      if (!Number.isFinite(a.x + a.y + b.x + b.y)) continue;
      if (pointSegDist(at, a, b) <= tolerance) {
        hits.push(s.id);
        break;
      }
    }
  }
  return hits;
}

/** Paint every stroke visible through the viewport. Never throws. */
export function paintViewport(
  canvas: HTMLCanvasElement,
  strokes: Stroke[],
  pan: Vec,
): void {
  const ctx = ((): CanvasRenderingContext2D | null => {
    try {
      return canvas.getContext('2d');
    } catch (e) {
      log.error('paintViewport: getContext threw', e);
      return null;
    }
  })();
  if (!ctx) {
    log.error('paintViewport: getContext(2d) null — viewport not painted');
    return;
  }
  try {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.save();
    ctx.translate(-pan.x, -pan.y);
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    let painted = 0;
    for (const s of strokes) {
      if (s.points.length === 0) continue;
      let ok = true;
      for (const p of s.points) {
        if (!Number.isFinite(p.x + p.y)) {
          ok = false;
          break;
        }
      }
      if (!ok) {
        log.warn(`paintViewport: skipping stroke ${s.id} with non-finite points`);
        continue;
      }
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.width;
      ctx.beginPath();
      if (s.points.length === 1) {
        // Single tap: dot, since a zero-length path may not rasterize.
        ctx.arc(s.points[0].x, s.points[0].y, s.width / 2, 0, Math.PI * 2);
        ctx.fillStyle = s.color;
        ctx.fill();
      } else {
        ctx.moveTo(s.points[0].x, s.points[0].y);
        for (let i = 1; i < s.points.length; i++) ctx.lineTo(s.points[i].x, s.points[i].y);
        ctx.stroke();
      }
      painted++;
    }
    ctx.restore();
    log.debug(`paintViewport: ${painted}/${strokes.length} strokes at pan=(${pan.x},${pan.y})`);
  } catch (e) {
    try {
      ctx.restore();
    } catch {
      /* already broken; just log below */
    }
    log.error('paintViewport: rasterization failed', e);
  }
}
