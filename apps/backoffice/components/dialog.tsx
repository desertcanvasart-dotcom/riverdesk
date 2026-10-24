'use client';

import { useEffect, useRef, type ReactNode } from 'react';

/** A native <dialog>: focus trap, Escape and the backdrop come from the browser. */
export function Dialog({
  open,
  onClose,
  title,
  wide = false,
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: ReactNode;
  /** For forms with a table inside, such as a route's stops. */
  wide?: boolean;
  children: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);
  return (
    <dialog
      ref={ref}
      onClose={onClose}
      className={`m-auto w-[calc(100%-2rem)] ${wide ? 'max-w-3xl' : 'max-w-lg'} rounded-xl border border-line bg-surface p-0 text-ink shadow-xl backdrop:bg-black/40`}
    >
      {open && (
        <div className="max-h-[85dvh] overflow-y-auto p-4">
          <h2 className="mb-3 text-base font-semibold">{title}</h2>
          {children}
        </div>
      )}
    </dialog>
  );
}
