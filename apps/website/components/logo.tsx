/** Riverdesk mark: a river's bend under a deck line. */
export function Logo({ className = '', light = false }: { className?: string; light?: boolean }) {
  return (
    <span className={`inline-flex items-center gap-2.5 font-bold ${className}`} dir="ltr">
      <svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true">
        <defs>
          <linearGradient id="rd-mark" x1="0" y1="0" x2="1" y2="1">
            <stop offset="0" stopColor="#14857f" />
            <stop offset="1" stopColor="#0a4a4a" />
          </linearGradient>
        </defs>
        <rect width="32" height="32" rx="9" fill="url(#rd-mark)" />
        <path d="M7 11h18" stroke="#ffffff" strokeWidth="2.4" strokeLinecap="round" />
        <path
          d="M6 20c3-3 6-3 9 0s7 3 11-1"
          stroke="#f2c88a"
          strokeWidth="2.4"
          fill="none"
          strokeLinecap="round"
        />
      </svg>
      <span className={`text-[1.15rem] tracking-tight ${light ? 'text-white' : ''}`}>
        Riverdesk
      </span>
    </span>
  );
}
