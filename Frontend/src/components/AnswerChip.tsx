/** Draggable answer chip with a hover-to-delete cross.
 *
 * react-draggable locates its DOM node through the legacy
 * ReactDOM.findDOMNode, which no longer exists on React 19 — without an
 * explicit nodeRef every drag start resolves to undefined and the chip
 * renders but can't move. Each chip owns its ref; uncontrolled
 * defaultPosition keeps dragging smooth and per-chip (no shared state).
 *
 * The delete cross stops mousedown/touchstart propagation so pressing it
 * never starts a drag. It appears on hover/focus, and is always visible on
 * touch devices where hover doesn't exist.
 */
import { useRef } from 'react';
import Draggable from 'react-draggable';
import { X } from 'lucide-react';
import { createLogger } from '@/lib/logger';

const log = createLogger('chip');

interface ChipProps {
  latex: string;
  initialPosition: { x: number; y: number };
  onDelete: () => void;
}

export default function AnswerChip({ latex, initialPosition, onDelete }: ChipProps) {
  const nodeRef = useRef<HTMLDivElement>(null);

  const swallowPress = (e: React.SyntheticEvent) => {
    // Keep the press off Draggable: delete must not start (or break) a drag.
    e.stopPropagation();
  };

  const handleDelete = () => {
    log.info('chip: deleted by user');
    onDelete();
  };

  return (
    <Draggable
      nodeRef={nodeRef}
      defaultPosition={initialPosition}
      onStop={(_e, data) => {
        log.debug(`chip: dropped at (${Math.round(data.x)},${Math.round(data.y)})`);
      }}
    >
      <div ref={nodeRef} className="panel-brutal group absolute touch-none cursor-move select-none p-2">
        <button
          type="button"
          onClick={handleDelete}
          onMouseDown={swallowPress}
          onTouchStart={swallowPress}
          aria-label="Delete answer"
          title="Delete answer"
          className="absolute -right-2 -top-2 border-2 border-black bg-white p-0.5 text-black opacity-0 shadow-[2px_2px_0_#000] group-hover:opacity-100 group-focus-within:opacity-100 dark:border-[#ede6d6] dark:bg-[#2a2a2a] dark:text-[#ede6d6] dark:shadow-[2px_2px_0_#ede6d6] [@media(hover:none)]:opacity-100"
        >
          <X size={12} />
        </button>
        <div className="latex-content text-black dark:text-[#ede6d6]">{latex}</div>
      </div>
    </Draggable>
  );
}
