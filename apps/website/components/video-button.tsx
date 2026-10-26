'use client';

import { Play, X } from 'lucide-react';
import { useRef, useState } from 'react';

/**
 * A button that opens the demo video in a modal. The player is only created when the modal
 * opens (nothing is downloaded before), starts only when the visitor presses play, and shows
 * captions when a .vtt file is configured.
 */
export function VideoButton({
  url,
  captions,
  poster,
  locale,
  label,
  title,
  close,
  className,
}: {
  url: string;
  captions: string;
  poster: string;
  locale: string;
  label: string;
  title: string;
  close: string;
  className: string;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const show = () => {
    setOpen(true);
    dialog.current?.showModal();
  };
  const hide = () => {
    dialog.current?.close();
  };
  return (
    <>
      <button type="button" onClick={show} className={className}>
        <Play aria-hidden className="size-4" />
        {label}
      </button>
      <dialog
        ref={dialog}
        aria-label={title}
        onClose={() => setOpen(false)}
        onClick={(event) => event.target === dialog.current && hide()}
        className="m-auto w-[min(56rem,calc(100vw-2rem))] overflow-visible bg-transparent p-0 backdrop:bg-black/75"
      >
        <div className="relative">
          <button
            type="button"
            onClick={hide}
            aria-label={close}
            className="absolute -top-12 flex size-10 items-center justify-center rounded-full bg-white/10 text-white hover:bg-white/20 ltr:right-0 rtl:left-0"
          >
            <X aria-hidden className="size-5" />
          </button>
          {open && (
            <video
              controls
              playsInline
              preload="none"
              poster={poster}
              className="aspect-video w-full rounded-2xl bg-black"
            >
              <source src={url} />
              {captions && <track kind="captions" src={captions} srcLang={locale} default />}
            </video>
          )}
        </div>
      </dialog>
    </>
  );
}
