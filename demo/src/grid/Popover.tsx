/** A fixed-position panel anchored to the element that opened it. */
import { useEffect, useRef, type ReactNode } from 'react';

export interface PopoverProps {
  anchor: HTMLElement;
  onClose: () => void;
  align?: 'start' | 'end';
  width?: number;
  children: ReactNode;
}

export function Popover({ anchor, onClose, align = 'start', width, children }: PopoverProps) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node;
      if (ref.current?.contains(target) || anchor.contains(target)) return;
      onClose();
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.stopPropagation();
        onClose();
      }
    }
    window.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown, true);
    window.addEventListener('resize', onClose);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown, true);
      window.removeEventListener('resize', onClose);
    };
  }, [anchor, onClose]);

  const box = anchor.getBoundingClientRect();
  const panelWidth = width ?? 232;
  const left =
    align === 'end'
      ? Math.max(8, box.right - panelWidth)
      : Math.min(box.left, window.innerWidth - panelWidth - 8);

  return (
    <div
      ref={ref}
      className="popover"
      role="menu"
      style={{ top: Math.round(box.bottom + 6), left: Math.round(left), width: panelWidth }}
    >
      {children}
    </div>
  );
}
