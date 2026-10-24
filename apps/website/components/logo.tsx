/** Riverdesk mark: a river's bend under a deck line. */
export function Logo({ className = '' }: { className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 font-bold ${className}`} dir="ltr">
      <svg width="28" height="28" viewBox="0 0 32 32" aria-hidden="true">
        <rect width="32" height="32" rx="8" fill="var(--color-brand)" />
        <path
          d="M7 11h18"
          stroke="var(--color-brand-ink)"
          strokeWidth="2.4"
          strokeLinecap="round"
        />
        <path
          d="M6 20c3-3 6-3 9 0s7 3 11-1"
          stroke="var(--color-brand-ink)"
          strokeWidth="2.4"
          fill="none"
          strokeLinecap="round"
        />
      </svg>
      <span className="text-lg tracking-tight">Riverdesk</span>
    </span>
  );
}
