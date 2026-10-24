import type { ReactNode } from 'react';

/** The dark band at the top of the inner pages. */
export function PageHero({
  kicker,
  title,
  intro,
  children,
}: {
  kicker: string;
  title: string;
  intro: string;
  children?: ReactNode;
}) {
  return (
    <section className="band-deep relative overflow-hidden">
      <div className="band-waves absolute inset-0" aria-hidden />
      <div className="container-site relative py-16 sm:py-20">
        <p className="text-xs font-semibold tracking-[0.14em] text-[#7fe0d6] uppercase">{kicker}</p>
        <h1 className="mt-3 max-w-3xl text-4xl font-bold tracking-tight text-balance text-white sm:text-5xl">
          {title}
        </h1>
        <p className="mt-4 max-w-2xl text-lg leading-relaxed text-pretty text-white/70">{intro}</p>
        {children}
      </div>
    </section>
  );
}
