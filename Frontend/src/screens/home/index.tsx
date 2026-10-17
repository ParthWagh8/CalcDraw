import { useCallback, useEffect, useRef, useState } from 'react';
import AnswerChip from '@/components/AnswerChip';
import {
  Eraser,
  FileImage,
  FileText,
  Hand,
  History as HistoryIcon,
  Moon,
  Redo2,
  Share2,
  Shapes as ShapesIcon,
  Sun,
  Trash2,
  Undo2,
  X,
} from 'lucide-react';
import ShapeLayer, { ShapePreview } from '@/components/ShapeLayer';
import {
  SHAPE_KINDS,
  createId,
  createShape,
  drawShapeOnCanvas,
  resizeShape,
  snapRotation,
  type CanvasShape,
  type ResizeHandle,
  type ShapeKind,
} from '@/lib/shapes';
import { paintViewport, applyPanDelta, hitStrokes, type Stroke } from '@/lib/paint';
import { toLatexDisplay } from '@/lib/latex';
import { SWATCHES } from '@/constants';
import { calculate, type CalculateItem } from '@/lib/api';
import { addHistory, clearHistory, formatWhen, loadHistory, type HistoryEntry } from '@/lib/history';
import { createLogger } from '@/lib/logger';
import { applyTheme, canvasBaseColor, getInitialTheme, type Theme } from '@/lib/theme';
import { downloadPDF, downloadPNG } from '@/lib/share';

const log = createLogger('home');

declare global {
    interface Window {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        MathJax?: any;
    }
}

const DEFAULT_LATEX_POS = { x: 10, y: 200 };
const DEFAULT_INK: Record<Theme, string> = { light: '#000000', dark: '#FFFFFF' };
const UNDO_CAP = 50;
const STROKE_WIDTH = 3;

/** One undo step: retained strokes + shape objects (restored + repainted together). */
interface CanvasSnapshot {
  strokes: Stroke[];
  shapes: CanvasShape[];
}

interface Pan {
  x: number;
  y: number;
}

export default function Home() {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const pendingTimers = useRef<ReturnType<typeof setTimeout>[]>([]);
    const pointers = useRef(new Map<number, { x: number; y: number }>());
    const gesture = useRef<null | { panX: number; panY: number; cx: number; cy: number }>(null);
    const gestureLock = useRef(false);
    const activeStrokeId = useRef<string | null>(null);
    const erasing = useRef(false);
    const latest = useRef<{ strokes: Stroke[]; pan: Pan }>({ strokes: [], pan: { x: 0, y: 0 } });
    const [theme, setTheme] = useState<Theme>(getInitialTheme);
    const [color, setColor] = useState<string>(() => DEFAULT_INK[getInitialTheme()]);
    const [strokes, setStrokes] = useState<Stroke[]>([]);
    const [pan, setPan] = useState<Pan>({ x: 0, y: 0 });
    /** Lock = preview only: free scroll, no ink, shapes show no UI and take no input. */
    const [lockMode, setLockMode] = useState(false);
    /** Eraser: tap/scrub a stroke to delete the whole pen run. Mutually exclusive with Lock. */
    const [eraserMode, setEraserMode] = useState(false);
    const [dictOfVars, setDictOfVars] = useState<Record<string, string>>({});
    const [latexPosition, setLatexPosition] = useState(DEFAULT_LATEX_POS);
    const [latexExpression, setLatexExpression] = useState<Array<{ id: string; latex: string }>>([]);
    const [isLoading, setIsLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [history, setHistory] = useState<HistoryEntry[]>(loadHistory);
    const [historyOpen, setHistoryOpen] = useState(false);
    const [shareOpen, setShareOpen] = useState(false);
    const [shapesOpen, setShapesOpen] = useState(false);
    const [shapes, setShapes] = useState<CanvasShape[]>([]);
    const [selectedId, setSelectedId] = useState<string | null>(null);
    const [undoStack, setUndoStack] = useState<CanvasSnapshot[]>([]);
    const [redoStack, setRedoStack] = useState<CanvasSnapshot[]>([]);

    // Stable helpers first: effects below depend on renderLatexToCanvas.
    // It only appends state via functional setState, so an empty dep array is correct.
    const renderLatexToCanvas = useCallback((expression: string, answer: string) => {
        const latex = toLatexDisplay(expression, answer);
        log.debug(`renderLatexToCanvas: expr=${expression.slice(0, 80)} answer=${answer.slice(0, 80)}`);
        // Stable id per answer: deleting one chip must not shift the rest.
        setLatexExpression((prev) => [...prev, { id: createId('answer'), latex }]);
    }, []);

    const deleteAnswer = useCallback((id: string) => {
        setLatexExpression((prev) => prev.filter((entry) => entry.id !== id));
        log.info(`answer: deleted ${id}`);
    }, []);

    /** Paint the viewport frame (world strokes shifted by pan). */
    function paint(strokeList: Stroke[], view: Pan) {
        const canvas = canvasRef.current;
        if (!canvas) {
            log.error('paint: canvasRef null — viewport not painted');
            return;
        }
        paintViewport(canvas, strokeList, view);
    }

    /**
     * Record an undo step BEFORE mutating. Skipped when nothing changed since
     * the stack top (immutable updates keep ref equality), so tapping around
     * never fills undo with no-ops.
     */
    const pushSnapshot = useCallback(() => {
        const top = undoStack[undoStack.length - 1];
        if (top && top.strokes === strokes && top.shapes === shapes) {
            log.debug('snapshot: identical to stack top — skipped');
            return;
        }
        setUndoStack((prev) => [...prev.slice(-(UNDO_CAP - 1)), { strokes, shapes }]);
        setRedoStack([]);
        log.debug(`snapshot: pushed strokes=${strokes.length} shapes=${shapes.length}`);
    }, [shapes, strokes, undoStack]);

    function handleReset() {
        log.info('reset: clearing view, strokes, shapes, stacks, expressions, vars and error');
        pendingTimers.current.forEach((t) => clearTimeout(t));
        pendingTimers.current = [];
        activeStrokeId.current = null;
        gesture.current = null;
        gestureLock.current = false;
        pointers.current.clear();
        const origin = { x: 0, y: 0 };
        setPan(origin);
        setStrokes([]);
        setShapes([]);
        setSelectedId(null);
        setUndoStack([]);
        setRedoStack([]);
        setLatexExpression([]);
        setDictOfVars({});
        setError(null);
        setIsLoading(false);
        const canvas = canvasRef.current;
        if (canvas) paintViewport(canvas, [], origin);
        else log.error('reset: canvasRef null — viewport not cleared');
    }

    // ---- Shapes (declared before effects: the key handler below uses deleteSelected) ----
    const deleteSelected = useCallback(() => {
        if (!selectedId) {
            log.warn('shape: delete requested with nothing selected');
            return;
        }
        pushSnapshot();
        setShapes((prev) => prev.filter((s) => s.id !== selectedId));
        log.info(`shape: deleted ${selectedId}`);
        setSelectedId(null);
    }, [selectedId, pushSnapshot]);

    function insertShape(kind: ShapeKind) {
        const canvas = canvasRef.current;
        const rect = canvas?.getBoundingClientRect();
        // Viewport center in world coords (shapes live in the infinite world).
        const cx = (rect ? rect.width / 2 : 200) + pan.x;
        const cy = (rect ? rect.height / 2 : 200) + pan.y;
        pushSnapshot();
        const shape = createShape(kind, cx, cy, color);
        setShapes((prev) => [...prev, shape]);
        setSelectedId(shape.id);
        log.info(`shape: inserted ${kind} id=${shape.id} at world (${Math.round(cx)},${Math.round(cy)})`);
    }

    function pickColor(next: string) {
        setColor(next);
        if (selectedId) {
            setShapes((prev) => prev.map((s) => (s.id === selectedId ? { ...s, color: next } : s)));
            log.info(`shape: recolored ${selectedId} -> ${next}`);
        } else {
            log.debug(`ink: ${next}`);
        }
    }

    const handleMoveShape = useCallback((id: string, dx: number, dy: number) => {
        setShapes((prev) => prev.map((s) => (s.id === id ? { ...s, x: s.x + dx, y: s.y + dy } : s)));
    }, []);

    const handleResizeShape = useCallback((id: string, handle: ResizeHandle, dx: number, dy: number) => {
        setShapes((prev) => prev.map((s) => (s.id === id ? resizeShape(s, handle, dx, dy) : s)));
    }, []);

    const handleRotateShape = useCallback((id: string, rawDeg: number) => {
        const rotation = snapRotation(rawDeg);
        setShapes((prev) => prev.map((s) => (s.id === id ? { ...s, rotation } : s)));
    }, []);

    /** Shape gesture started: snapshot so the whole drag is one undo step. */
    const handleShapeInteractStart = useCallback(() => {
        pushSnapshot();
    }, [pushSnapshot]);

    /** Bitmap + shapes merged into the visible frame (CSS-px world scaled to bitmap px). */
    function getCompositedCanvas(): HTMLCanvasElement | null {
        const src = canvasRef.current;
        if (!src) {
            log.error('composite: canvasRef null');
            return null;
        }
        if (src.width === 0 || src.height === 0) {
            log.error(`composite: canvas has zero size ${src.width}x${src.height}`);
            return null;
        }
        try {
            const out = document.createElement('canvas');
            out.width = src.width;
            out.height = src.height;
            const ctx = out.getContext('2d');
            if (!ctx) {
                log.error('composite: getContext(2d) null on export canvas');
                return null;
            }
            ctx.drawImage(src, 0, 0);
            if (shapes.length > 0) {
                const rect = src.getBoundingClientRect();
                ctx.save();
                // World (CSS px, panned) -> bitmap px.
                ctx.setTransform(
                    src.width / rect.width,
                    0,
                    0,
                    src.height / rect.height,
                    (-pan.x * src.width) / rect.width,
                    (-pan.y * src.height) / rect.height,
                );
                for (const s of shapes) drawShapeOnCanvas(ctx, s);
                ctx.restore();
            }
            log.debug(
                `composite: bitmap=${src.width}x${src.height} pan=(${pan.x},${pan.y}) shapes=${shapes.length}`,
            );
            return out;
        } catch (e) {
            log.error('composite: merge failed', e);
            return null;
        }
    }

    function restoreSnapshot(snap: CanvasSnapshot, view: Pan, why: string) {
        setStrokes(snap.strokes);
        setShapes(snap.shapes);
        setSelectedId(null);
        const canvas = canvasRef.current;
        if (!canvas) {
            log.error(`${why}: canvasRef null — state restored but viewport not repainted`);
            return;
        }
        paintViewport(canvas, snap.strokes, view);
        log.info(`${why}: ok (strokes=${snap.strokes.length} shapes=${snap.shapes.length})`);
    }

    function handleUndo() {
        if (undoStack.length === 0) {
            log.warn('undo: stack empty — nothing to undo');
            return;
        }
        const prev = undoStack[undoStack.length - 1];
        setRedoStack((r) => [...r, { strokes, shapes }]);
        setUndoStack((u) => u.slice(0, -1));
        restoreSnapshot(prev, pan, 'undo');
    }

    function handleRedo() {
        if (redoStack.length === 0) {
            log.warn('redo: stack empty — nothing to redo');
            return;
        }
        const next = redoStack[redoStack.length - 1];
        setUndoStack((u) => [...u.slice(-(UNDO_CAP - 1)), { strokes, shapes }]);
        setRedoStack((r) => r.slice(0, -1));
        restoreSnapshot(next, pan, 'redo');
    }

    function toggleTheme() {
        const next: Theme = theme === 'light' ? 'dark' : 'light';
        applyTheme(next);
        setTheme(next);
    }

    /** Lock = preview only: scroll freely with one finger, shapes take no input and show no UI. */
    function toggleLock() {
        const next = !lockMode;
        if (next) {
            // Freeze any in-progress stroke (kept ink stops extending) and hide shape UI.
            activeStrokeId.current = null;
            erasing.current = false;
            if (eraserMode) {
                setEraserMode(false);
                log.info('eraser: OFF (lock engaged)');
            }
            setSelectedId(null);
            setShapesOpen(false);
        }
        setLockMode(next);
        log.info(`lock mode: ${next ? 'ON (preview only — scroll freely)' : 'OFF'}`);
    }

    function toggleEraser() {
        const next = !eraserMode;
        if (next && lockMode) {
            setLockMode(false);
            log.info('lock mode: OFF (eraser engaged)');
        }
        if (next) setSelectedId(null);
        setEraserMode(next);
        log.info(`eraser: ${next ? 'ON (tap a stroke to delete the whole pen run)' : 'OFF'}`);
    }

    /** Delete every stroke under a viewport point (offset + pan -> world). */
    function eraseAt(px: number, py: number) {
        if (!Number.isFinite(px + py)) {
            log.warn('eraser: skipping non-finite point');
            return;
        }
        const hits = hitStrokes(strokes, { x: px + pan.x, y: py + pan.y });
        if (hits.length === 0) return;
        const gone = new Set(hits);
        const next = strokes.filter((s) => !gone.has(s.id));
        setStrokes(next);
        paint(next, pan);
        log.info(`eraser: removed ${hits.length} stroke(s) at world (${Math.round(px + pan.x)},${Math.round(py + pan.y)})`);
    }

    useEffect(() => {
        if (!selectedId) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') {
                setSelectedId(null);
                log.debug('shape: deselected via Escape');
            } else if (e.key === 'Delete' || e.key === 'Backspace') {
                deleteSelected();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [selectedId, deleteSelected]);

        // Latest state for the non-React wheel listener below (assignment only, no setState).
    useEffect(() => {
        latest.current = { strokes, pan };
    });

    // Trackpad / mouse-wheel scroll pans the infinite canvas.
    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) {
            log.error('wheel: canvasRef null — wheel pan unavailable');
            return;
        }
        const onWheel = (e: WheelEvent) => {
            e.preventDefault();
            const { strokes: s, pan: p } = latest.current;
            const f = e.deltaMode === 1 ? 16 : 1;
            const next = { x: Math.round(p.x + e.deltaX * f), y: Math.round(p.y + e.deltaY * f) };
            setPan(next);
            paintViewport(canvas, s, next);
        };
        canvas.addEventListener('wheel', onWheel, { passive: false });
        return () => canvas.removeEventListener('wheel', onWheel);
    }, []);

    useEffect(() => {
        if (latexExpression.length > 0 && window.MathJax) {            const t = setTimeout(() => {
                try {
                    window.MathJax.Hub.Queue(['Typeset', window.MathJax.Hub]);
                } catch (e) {
                    log.error('MathJax typeset failed', e);
                }
            }, 0);
            return () => clearTimeout(t);
        }
    }, [latexExpression]);

    useEffect(() => {
        applyTheme(getInitialTheme());
        const canvas = canvasRef.current;

        if (canvas) {
            const ctx = canvas.getContext('2d');
            if (ctx) {
                canvas.width = window.innerWidth;
                canvas.height = window.innerHeight - canvas.offsetTop;
                ctx.lineCap = 'round';
                ctx.lineWidth = 3;
                log.info(`canvas: sized ${canvas.width}x${canvas.height}`);
            } else {
                log.error('canvas: getContext(2d) returned null during setup');
            }
        } else {
            log.error('canvas: canvasRef is null during setup');
        }
        const script = document.createElement('script');
        script.src = 'https://cdnjs.cloudflare.com/ajax/libs/mathjax/2.7.9/MathJax.js?config=TeX-MML-AM_CHTML';
        script.async = true;
        document.head.appendChild(script);
        log.debug('mathjax: script tag injected');

        script.onload = () => {
            try {
                window.MathJax.Hub.Config({
                    tex2jax: { inlineMath: [['$', '$'], ['\\(', '\\)']] },
                });
                log.info('mathjax: loaded and configured');
            } catch (e) {
                log.error('mathjax: config failed after load', e);
            }
        };
        script.onerror = (ev) => {
            log.error('mathjax: CDN script failed to load — formulas will show as raw text', ev);
        };

        return () => {
            pendingTimers.current.forEach((t) => clearTimeout(t));
            pendingTimers.current = [];
            if (document.head.contains(script)) {
                document.head.removeChild(script);
                log.debug('mathjax: script tag removed on unmount');
            }
        };

    }, []);

    // ---- Pointer gestures: draw (one finger) vs pan (two fingers, or Lock mode) ----
    function centroid(): { x: number; y: number } {
        let sx = 0;
        let sy = 0;
        let n = 0;
        pointers.current.forEach((p) => {
            sx += p.x;
            sy += p.y;
            n++;
        });
        return { x: sx / Math.max(1, n), y: sy / Math.max(1, n) };
    }

    function beginPanGesture() {
        const c = centroid();
        gesture.current = { panX: pan.x, panY: pan.y, cx: c.x, cy: c.y };
        log.debug(`pan: gesture start pointers=${pointers.current.size} pan=(${pan.x},${pan.y})`);
    }

    /** A second finger landed mid-stroke: keep committed ink, drop an accidental dot. */
    function abortActiveStroke() {
        const id = activeStrokeId.current;
        activeStrokeId.current = null;
        if (!id) return;
        const s = strokes.find((k) => k.id === id);
        if (s && s.points.length <= 1) {
            const next = strokes.filter((k) => k.id !== id);
            setStrokes(next);
            paint(next, pan);
            log.debug('pan: dropped single-point stroke as gesture took over');
        }
    }

    function capturePointer(canvas: HTMLCanvasElement, pointerId: number) {
        try {
            canvas.setPointerCapture(pointerId);
        } catch (e) {
            log.error('pointer: capture failed', e);
        }
    }

    const onCanvasPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
        const canvas = canvasRef.current;
        if (!canvas) {
            log.error('pointerdown: canvasRef null');
            return;
        }
        capturePointer(canvas, e.pointerId);
        pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (selectedId) {
            setSelectedId(null);
            log.debug('shape: deselected (canvas press)');
        }

        const count = pointers.current.size;
        if (lockMode || count >= 2) {
            if (count >= 2) {
                abortActiveStroke();
                erasing.current = false;
            }
            if (!gesture.current) beginPanGesture();
            return;
        }
        if (gestureLock.current) {
            log.debug('pointerdown: ignored (gesture lock — lift all fingers first)');
            return;
        }
        if (eraserMode) {
            // One undo step covers the whole scrub gesture.
            pushSnapshot();
            erasing.current = true;
            eraseAt(e.nativeEvent.offsetX, e.nativeEvent.offsetY);
            return;
        }
        // Snapshot BEFORE mutating: undo restores the pre-stroke state.
        pushSnapshot();
        const px = e.nativeEvent.offsetX;
        const py = e.nativeEvent.offsetY;
        if (!Number.isFinite(px + py)) {
            log.error(`stroke: non-finite offset (${px},${py}) — stroke not started`);
            return;
        }
        const id = createId('stroke');
        const stroke: Stroke = {
            id,
            color,
            width: STROKE_WIDTH,
            points: [{ x: px + pan.x, y: py + pan.y }],
        };
        activeStrokeId.current = id;
        const next = [...strokes, stroke];
        setStrokes(next);
        paint(next, pan);
        log.debug(`stroke: start id=${id}`);
    };

    const onCanvasPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
        const rec = pointers.current.get(e.pointerId);
        if (!rec) return; // hover or untracked pointer
        rec.x = e.clientX;
        rec.y = e.clientY;
        if (gesture.current) {
            const c = centroid();
            const g = gesture.current;
            const nextPan = applyPanDelta({ x: g.panX, y: g.panY }, { x: g.cx, y: g.cy }, c);
            setPan(nextPan);
            paint(strokes, nextPan);
            return;
        }
        if (lockMode) return; // ink locked: preview only, no strokes
        if (erasing.current) {
            eraseAt(e.nativeEvent.offsetX, e.nativeEvent.offsetY);
            return;
        }
        const id = activeStrokeId.current;
        if (!id) return;
        const px = e.nativeEvent.offsetX;
        const py = e.nativeEvent.offsetY;
        if (!Number.isFinite(px + py)) {
            log.warn('stroke: skipping non-finite point');
            return;
        }
        const next = strokes.map((s) =>
            s.id === id ? { ...s, points: [...s.points, { x: px + pan.x, y: py + pan.y }] } : s,
        );
        setStrokes(next);
        paint(next, pan);
    };

    const endPointer = (e: React.PointerEvent<HTMLCanvasElement>) => {
        pointers.current.delete(e.pointerId);
        const left = pointers.current.size;
        if (left === 0) {
            gesture.current = null;
            gestureLock.current = false;
            activeStrokeId.current = null;
            erasing.current = false;
            return;
        }
        if (gesture.current && !lockMode && left < 2) {
            // Pinch over: remaining finger must lift before drawing resumes.
            gesture.current = null;
            gestureLock.current = true;
            log.debug('pan: gesture ended, drawing locked until lift');
        } else if (gesture.current) {
            // Re-anchor so the view doesn't jump when a finger lifts mid-pan.
            const c = centroid();
            gesture.current = { panX: pan.x, panY: pan.y, cx: c.x, cy: c.y };
        }
    };

    /** Scan the canvas for ink and return its center in bitmap px (found=false -> default). */
    const computeInkCenter = (canvas: HTMLCanvasElement): { x: number; y: number; found: boolean } => {
        try {
            const ctx = canvas.getContext('2d');
            if (!ctx) {
                log.error('computeInkCenter: getContext(2d) null — using default position');
                return { ...DEFAULT_LATEX_POS, found: false };
            }
            const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
            let minX = canvas.width, minY = canvas.height, maxX = 0, maxY = 0;
            let found = false;

            for (let y = 0; y < canvas.height; y++) {
                for (let x = 0; x < canvas.width; x++) {
                    const i = (y * canvas.width + x) * 4;
                    if (imageData.data[i + 3] > 0) {  // If pixel is not transparent
                        found = true;
                        if (x < minX) minX = x;
                        if (y < minY) minY = y;
                        if (x > maxX) maxX = x;
                        if (y > maxY) maxY = y;
                    }
                }
            }

            if (!found) {
                log.warn('computeInkCenter: no ink pixels found — using default position');
                return { ...DEFAULT_LATEX_POS, found: false };
            }
            const center = { x: (minX + maxX) / 2, y: (minY + maxY) / 2, found: true };
            log.debug(`computeInkCenter: box=(${minX},${minY})-(${maxX},${maxY}) center=(${center.x},${center.y})`);
            return center;
        } catch (e) {
            log.error('computeInkCenter: getImageData failed — using default position', e);
            return { ...DEFAULT_LATEX_POS, found: false };
        }
    };

    const runRoute = async () => {
        if (isLoading) {
            log.warn('runRoute: ignored — a calculation is already in flight');
            return;
        }
        const canvas = canvasRef.current;
        if (!canvas) {
            const msg = 'Canvas is not ready. Reload the page.';
            log.error('runRoute: canvasRef null');
            setError(msg);
            return;
        }
        const composited = getCompositedCanvas();
        if (!composited) {
            const msg = 'Could not prepare the drawing for analysis. See console.';
            log.error('runRoute: composite failed');
            setError(msg);
            return;
        }

        setIsLoading(true);
        setError(null);
        log.info(`runRoute: start vars=${JSON.stringify(dictOfVars).slice(0, 300)} shapes=${shapes.length}`);

        try {
            const image = composited.toDataURL('image/png');
            log.debug(`runRoute: canvas encoded payload_chars=${image.length}`);
            const resp = await calculate(image, dictOfVars);
            log.info(`runRoute: backend answered items=${resp.data.length}`);

            // Merge variable assignments in ONE state update (loop setStates lose entries).
            const assigned: Record<string, string> = {};
            for (const item of resp.data) {
                if (item.assign === true) assigned[item.expr] = item.result;
            }
            if (Object.keys(assigned).length > 0) {
                log.info(`runRoute: assigning vars ${Object.keys(assigned).join(',')}`);
                setDictOfVars((prev) => ({ ...prev, ...assigned }));
            } else {
                log.debug('runRoute: no variable assignments in response');
            }

            if (resp.data.length === 0) {
                log.warn('runRoute: backend returned zero items — nothing to render');
                setError('The model returned no answers. Try redrawing more clearly.');
                return;
            }

            setHistory((prev) =>
                addHistory(prev, resp.data.map((d) => ({ expr: d.expr, result: d.result }))),
            );
            // Answer chip goes where the ink is: bitmap px -> screen px.
            const rect = canvas.getBoundingClientRect();
            const box = computeInkCenter(composited);
            if (box.found) {
                const screen = {
                    x: box.x / (composited.width / rect.width),
                    y: box.y / (composited.height / rect.height),
                };
                log.debug(`runRoute: answer at screen (${Math.round(screen.x)},${Math.round(screen.y)})`);
                setLatexPosition(screen);
            } else {
                setLatexPosition(DEFAULT_LATEX_POS);
            }
            resp.data.forEach((data: CalculateItem) => {
                // Stagger rendering; each timer is tracked so Reset/unmount can cancel it.
                const t = setTimeout(() => {
                    log.debug(`runRoute: rendering expr=${data.expr.slice(0, 80)}`);
                    renderLatexToCanvas(data.expr, data.result);
                    // Solved ink leaves the viewport (undo still restores it via snapshots).
                    setStrokes([]);
                    const c = canvasRef.current;
                    if (c) paintViewport(c, [], pan);
                    else log.error('runRoute: canvasRef null — solved ink not cleared');
                }, 1000);
                pendingTimers.current.push(t);
            });
        } catch (e) {
            const msg = e instanceof Error ? e.message : 'Calculation failed unexpectedly.';
            log.error(`runRoute: failed — ${msg}`, e);
            setError(msg);
        } finally {
            setIsLoading(false);
            log.debug('runRoute: finished (isLoading=false)');
        }
    };

    const handleSharePNG = () => {
        const composited = getCompositedCanvas();
        if (!composited) {
            setError('Canvas is not ready. Reload the page.');
            return;
        }
        try {
            downloadPNG(composited, canvasBaseColor(theme));
            log.info('sharePNG: download started');
            setShareOpen(false);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'Image export failed.');
        }
    };

    const handleSharePDF = () => {
        const composited = getCompositedCanvas();
        if (!composited) {
            setError('Canvas is not ready. Reload the page.');
            return;
        }
        try {
            downloadPDF(composited, canvasBaseColor(theme));
            log.info('sharePDF: download started');
            setShareOpen(false);
        } catch (e) {
            setError(e instanceof Error ? e.message : 'PDF export failed.');
        }
    };

    const handleClearHistory = () => {
        setHistory(clearHistory());
    };

    return (
        <>
            <header className="relative z-20 border-b-2 border-black bg-[#f6f1e5] dark:border-[#ede6d6] dark:bg-[#232323]">
                <div className="flex flex-wrap items-center gap-2 p-2">
                    <span className="mr-1 text-sm font-black uppercase tracking-widest">Calcdraw</span>
                    <button className="btn-brutal px-2" onClick={handleUndo} disabled={undoStack.length === 0} title="Undo" aria-label="Undo">
                        <Undo2 size={14} />
                    </button>
                    <button className="btn-brutal px-2" onClick={handleRedo} disabled={redoStack.length === 0} title="Redo" aria-label="Redo">
                        <Redo2 size={14} />
                    </button>
                    <button
                        className={`btn-brutal px-2 ${eraserMode ? 'bg-black text-white dark:bg-[#ede6d6] dark:text-black' : ''}`}
                        onClick={toggleEraser}
                        aria-pressed={eraserMode}
                        title="Eraser: tap a stroke to delete the whole pen run"
                        aria-label="Eraser"
                    >
                        <Eraser size={14} />
                    </button>
                    <div className="flex items-center gap-1" role="group" aria-label="Ink color">
                        {SWATCHES.map((swatch) => (
                            <button
                                key={swatch}
                                onClick={() => pickColor(swatch)}
                                aria-pressed={color === swatch}
                                aria-label={`Ink ${swatch}`}
                                title={swatch}
                                style={{ background: swatch }}
                                className={`h-7 w-7 border-2 border-black dark:border-[#ede6d6] ${color === swatch ? 'ring-2 ring-black ring-offset-2 ring-offset-[#f6f1e5] dark:ring-[#ede6d6] dark:ring-offset-[#232323]' : ''}`}
                            />
                        ))}
                    </div>
                    <div className="relative">
                        <button
                            className="btn-brutal"
                            onClick={() => {
                                setShapesOpen((o) => !o);
                                log.debug(`shapes panel: ${!shapesOpen ? 'open' : 'closed'}`);
                            }}
                            aria-expanded={shapesOpen}
                        >
                            <ShapesIcon size={14} /> Shapes
                        </button>
                        {shapesOpen && (
                            <div className="panel-brutal absolute left-0 top-full z-30 mt-2 w-60 p-2">
                                <div className="mb-2 flex items-center justify-between">
                                    <span className="font-mono text-xs font-black uppercase tracking-widest">Insert shape</span>
                                    <button onClick={() => setShapesOpen(false)} aria-label="Close shapes" className="border-2 border-current px-1">
                                        <X size={12} />
                                    </button>
                                </div>
                                <div className="grid grid-cols-4 gap-1" role="group" aria-label="Shapes">
                                    {SHAPE_KINDS.map(({ kind, label }) => (
                                        <button
                                            key={kind}
                                            onClick={() => insertShape(kind)}
                                            title={label}
                                            aria-label={`Insert ${label}`}
                                            className="flex flex-col items-center gap-1 border-2 border-black p-1 font-mono text-[10px] font-bold uppercase hover:bg-black hover:text-white dark:border-[#ede6d6] dark:hover:bg-[#ede6d6] dark:hover:text-black"
                                        >
                                            <ShapePreview kind={kind} size={20} />
                                            {label}
                                        </button>
                                    ))}
                                </div>
                                <button className="btn-brutal mt-2 w-full" onClick={deleteSelected} disabled={!selectedId}>
                                    Delete selected
                                </button>
                            </div>
                        )}
                    </div>
                    <button
                        className="btn-brutal"
                        onClick={runRoute}
                        disabled={isLoading}
                    >
                        {isLoading ? 'Running…' : 'Run'}
                    </button>
                    <button
                        className={`btn-brutal ${lockMode ? 'bg-black text-white dark:bg-[#ede6d6] dark:text-black' : ''}`}
                        onClick={toggleLock}
                        aria-pressed={lockMode}
                        title="Lock: preview only — scroll freely, no edits"
                    >
                        <Hand size={14} /> Lock
                    </button>
                    <button
                        className="btn-brutal"
                        onClick={() => {
                            setHistoryOpen((o) => !o);
                            log.debug(`history panel: ${!historyOpen ? 'open' : 'closed'}`);
                        }}
                        aria-expanded={historyOpen}
                    >
                        <HistoryIcon size={14} /> History
                    </button>
                    <div className="relative">
                        <button
                            className="btn-brutal"
                            onClick={() => setShareOpen((o) => !o)}
                            aria-expanded={shareOpen}
                            aria-haspopup="menu"
                        >
                            <Share2 size={14} /> Share
                        </button>
                        {shareOpen && (
                            <div role="menu" className="panel-brutal absolute left-0 top-full z-30 mt-2 w-52 p-1">
                                <button
                                    role="menuitem"
                                    className="flex w-full items-center gap-2 px-2 py-2 font-mono text-xs font-bold uppercase tracking-widest hover:bg-black hover:text-white dark:hover:bg-[#ede6d6] dark:hover:text-black"
                                    onClick={handleSharePNG}
                                >
                                    <FileImage size={14} /> As Image
                                </button>
                                <button
                                    role="menuitem"
                                    className="flex w-full items-center gap-2 px-2 py-2 font-mono text-xs font-bold uppercase tracking-widest hover:bg-black hover:text-white dark:hover:bg-[#ede6d6] dark:hover:text-black"
                                    onClick={handleSharePDF}
                                >
                                    <FileText size={14} /> As PDF
                                </button>
                            </div>
                        )}
                    </div>
                    <button className="btn-brutal px-2" onClick={toggleTheme} title="Toggle light/dark" aria-label="Toggle theme">
                        {theme === 'light' ? <Moon size={14} /> : <Sun size={14} />}
                    </button>
                    <button className="btn-brutal px-2" onClick={handleReset} title="Clear canvas" aria-label="Clear canvas">
                        <Trash2 size={14} />
                    </button>
                </div>
            </header>
            {error && (
                <div role="alert" className="panel-brutal relative z-20 m-2 flex items-start justify-between gap-2 p-2 text-xs font-bold">
                    <span>{error}</span>
                    <button onClick={() => setError(null)} aria-label="Dismiss error" className="shrink-0 border-2 border-current px-1">
                        <X size={12} />
                    </button>
                </div>
            )}
            {isLoading && (
                <div aria-live="polite" className="relative z-20 m-2 inline-block border-2 border-black bg-white px-2 py-1 font-mono text-xs font-bold uppercase tracking-widest dark:border-[#ede6d6] dark:bg-[#2a2a2a]">
                    Analyzing drawing… (free model can take a few minutes)
                </div>
            )}
            <canvas
                ref={canvasRef}
                id="canvas"
                className={`absolute left-0 top-0 h-full w-full touch-none ${theme === 'dark' ? 'canvas-dots-dark' : 'canvas-dots-light'} ${lockMode ? 'cursor-grab active:cursor-grabbing' : eraserMode ? 'cursor-cell' : 'cursor-crosshair'}`}
                style={{ backgroundPosition: `${-pan.x}px ${-pan.y}px` }}
                onPointerDown={onCanvasPointerDown}
                onPointerMove={onCanvasPointerMove}
                onPointerUp={endPointer}
                onPointerOut={endPointer}
                onPointerCancel={endPointer}
            />
            <ShapeLayer
                shapes={shapes}
                selectedId={selectedId}
                dark={theme === 'dark'}
                pan={pan}
                locked={lockMode}
                onSelect={(id) => {
                    setSelectedId(id);
                    if (id) log.debug(`shape: selected ${id}`);
                }}
                onMove={handleMoveShape}
                onResize={handleResizeShape}
                onRotate={handleRotateShape}
                onInteractStart={handleShapeInteractStart}
            />

            {historyOpen && (
                <aside aria-label="Calculation history" className="panel-brutal absolute right-2 top-24 z-20 w-80 max-w-[calc(100vw-1rem)]">
                    <div className="flex items-center justify-between border-b-2 border-black p-2 dark:border-[#ede6d6]">
                        <span className="font-mono text-xs font-black uppercase tracking-widest">History</span>
                        <button className="btn-brutal px-2 py-1" onClick={() => setHistoryOpen(false)}>
                            Done
                        </button>
                    </div>
                    <ul className="max-h-80 overflow-auto">
                        {history.length === 0 && (
                            <li className="p-3 font-mono text-xs">No calculations yet — draw and hit Run.</li>
                        )}
                        {history.map((h, i) => (
                            <li key={`${h.at}-${i}`} className="border-b border-black/20 p-2 dark:border-white/20">
                                <div className="font-mono text-sm font-bold">{h.expr} = {h.result}</div>
                                <div className="font-mono text-[11px] opacity-70">{formatWhen(h.at)}</div>
                            </li>
                        ))}
                    </ul>
                    <div className="p-2">
                        <button className="btn-brutal w-full" onClick={handleClearHistory} disabled={history.length === 0}>
                            Clear
                        </button>
                    </div>
                </aside>
            )}

            {latexExpression && latexExpression.map((entry) => (
                <AnswerChip
                    key={entry.id}
                    latex={entry.latex}
                    initialPosition={latexPosition}
                    onDelete={() => deleteAnswer(entry.id)}
                />
            ))}
        </>
    );
}
