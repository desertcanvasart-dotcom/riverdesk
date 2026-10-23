import Link from 'next/link';
import type {
  ButtonHTMLAttributes,
  InputHTMLAttributes,
  ReactNode,
  SelectHTMLAttributes,
} from 'react';

/** Small UI kit. Logical properties only (ms/me, ps/pe, start/end) so Arabic RTL just works. */

const cx = (...parts: (string | false | null | undefined)[]) => parts.filter(Boolean).join(' ');

type Tone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info' | 'brand';
const toneClass: Record<Tone, string> = {
  neutral: 'bg-line/60 text-ink',
  ok: 'bg-ok-bg text-ok',
  warn: 'bg-warn-bg text-warn',
  bad: 'bg-bad-bg text-bad',
  info: 'bg-info-bg text-ink',
  brand: 'bg-brand text-brand-ink',
};

export function Badge({ tone = 'neutral', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <span
      className={cx(
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium whitespace-nowrap',
        toneClass[tone],
      )}
    >
      {children}
    </span>
  );
}

export function Card({
  title,
  actions,
  children,
  className,
}: {
  title?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section className={cx('rounded-xl border border-line bg-surface p-4', className)}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
          {title && <h2 className="text-base font-semibold">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function PageHeader({
  title,
  subtitle,
  actions,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <header className="mb-4 flex flex-wrap items-end justify-between gap-3">
      <div>
        <h1 className="text-xl font-semibold">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-muted">{subtitle}</p>}
      </div>
      {actions && <div className="flex flex-wrap gap-2">{actions}</div>}
    </header>
  );
}

const buttonBase =
  'inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-4 text-sm font-medium transition disabled:cursor-not-allowed disabled:opacity-50';
const buttonVariant = {
  primary: 'bg-brand text-brand-ink hover:opacity-90',
  secondary: 'border border-line bg-surface text-ink hover:bg-line/40',
  danger: 'bg-bad text-white hover:opacity-90',
  ghost: 'text-brand hover:bg-line/40',
};

export function Button({
  variant = 'primary',
  className,
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: keyof typeof buttonVariant }) {
  return <button {...props} className={cx(buttonBase, buttonVariant[variant], className)} />;
}

export function LinkButton({
  href,
  variant = 'secondary',
  children,
}: {
  href: string;
  variant?: keyof typeof buttonVariant;
  children: ReactNode;
}) {
  return (
    <Link href={href} className={cx(buttonBase, buttonVariant[variant])}>
      {children}
    </Link>
  );
}

export function Field({
  label,
  hint,
  error,
  children,
}: {
  label: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      {children}
      {hint && !error && <span className="text-xs text-muted">{hint}</span>}
      {error && <span className="text-xs text-bad">{error}</span>}
    </label>
  );
}

const inputClass =
  'min-h-10 w-full rounded-lg border border-line bg-surface px-3 text-base sm:text-sm outline-none focus:border-brand focus:ring-2 focus:ring-brand/20';

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return <input {...props} className={cx(inputClass, props.className)} />;
}

export function Select({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <select {...props} className={cx(inputClass, props.className)}>
      {children}
    </select>
  );
}

export function Alert({ tone = 'info', children }: { tone?: Tone; children: ReactNode }) {
  return <div className={cx('rounded-lg px-3 py-2 text-sm', toneClass[tone])}>{children}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-sm text-muted">{children}</p>;
}

/** Tables scroll sideways inside their card on a phone; the page itself never does. */
export function Table({ head, children }: { head: ReactNode[]; children: ReactNode }) {
  return (
    <div className="-mx-4 overflow-x-auto px-4">
      <table className="w-full min-w-max border-collapse text-sm">
        <thead>
          <tr className="border-b border-line text-start text-xs text-muted">
            {head.map((h, i) => (
              <th key={i} className="px-2 py-2 text-start font-medium">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function Td({ children, className }: { children?: ReactNode; className?: string }) {
  return <td className={cx('border-b border-line px-2 py-2 align-top', className)}>{children}</td>;
}

export { cx };
