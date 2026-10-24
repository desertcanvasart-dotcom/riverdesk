/** A real back-office screenshot (demo company), in a browser window or a phone frame. */
export function Screen({
  src,
  alt,
  phone = false,
  className = '',
  dark = false,
}: {
  src: string;
  alt: string;
  phone?: boolean;
  className?: string;
  /** On a dark band: a lighter rim instead of a shadowed border. */
  dark?: boolean;
}) {
  if (phone)
    return (
      <figure
        className={`overflow-hidden rounded-[2rem] border-4 border-[#1c2625] bg-[#1c2625] shadow-[var(--shadow-lift)] ${className}`}
      >
        <img src={src} alt={alt} loading="lazy" className="block w-full rounded-[1.6rem]" />
      </figure>
    );
  return (
    <figure
      className={`overflow-hidden rounded-2xl border ${
        dark ? 'border-white/15 bg-white/5 ring-1 ring-white/5' : 'border-line bg-surface'
      } shadow-[var(--shadow-lift)] ${className}`}
    >
      <div
        dir="ltr"
        className={`flex items-center gap-1.5 border-b px-3.5 py-2.5 ${
          dark ? 'border-white/10 bg-white/5' : 'border-line bg-bg/60'
        }`}
        aria-hidden="true"
      >
        <i className="size-2.5 rounded-full bg-[#ff5f57]" />
        <i className="size-2.5 rounded-full bg-[#febc2e]" />
        <i className="size-2.5 rounded-full bg-[#28c840]" />
        <span
          className={`mx-auto rounded-md px-10 py-0.5 text-[11px] ${
            dark ? 'bg-white/10 text-white/60' : 'bg-surface text-muted'
          }`}
        >
          app.riverdsk.com
        </span>
      </div>
      <img src={src} alt={alt} loading="lazy" className="block w-full" />
    </figure>
  );
}
