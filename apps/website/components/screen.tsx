/** A real back-office screenshot (demo company), in a device-like frame. */
export function Screen({
  src,
  alt,
  phone = false,
  className = '',
}: {
  src: string;
  alt: string;
  phone?: boolean;
  className?: string;
}) {
  return (
    <figure
      className={`overflow-hidden border border-line bg-surface shadow-xl ${phone ? 'rounded-[1.75rem] p-1.5' : 'rounded-2xl'} ${className}`}
    >
      <img
        src={src}
        alt={alt}
        loading="lazy"
        className={`block w-full ${phone ? 'rounded-[1.4rem]' : ''}`}
      />
    </figure>
  );
}
