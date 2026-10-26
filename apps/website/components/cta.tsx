import { ArrowRight } from 'lucide-react';
import { getLocale, getTranslations } from 'next-intl/server';
import { Link } from '../i18n/routing';
import { site } from '../lib/site';
import {
  primaryButton as primary,
  primaryDark,
  secondaryButton as secondary,
  secondaryDark,
} from './buttons';
import { VideoButton } from './video-button';

const SECOND = {
  features: ['/features', 'features'],
  docs: ['/docs', 'docs'],
  browse: ['/docs', 'browseDocs'],
  start: ['/docs/getting-started/overview', 'startGuide'],
} as const;

/** "Request a free pilot for your vessel" (the /pilot form), then a second link. */
export async function DemoButtons({
  second = 'features',
  dark = false,
}: {
  /** The second button: the features, the docs home, the getting-started guide, or the demo video. */
  second?: 'features' | 'docs' | 'browse' | 'start' | 'video';
  /** On a dark band. */
  dark?: boolean;
}) {
  const t = await getTranslations('cta');
  const locale = await getLocale();
  const video = site.demoVideo[locale === 'ar' ? 'ar' : 'en'];
  return (
    <div className="flex flex-wrap gap-3">
      <Link href="/pilot" className={dark ? primaryDark : primary}>
        {t('pilot')}
        <ArrowRight aria-hidden className="size-4 rtl:-scale-x-100" />
      </Link>
      {second === 'video' ? (
        // Hidden until the video exists: no "coming soon".
        video.url && (
          <VideoButton
            url={video.url}
            captions={video.captions}
            poster={`/screens/${locale}/desktop-book.jpg`}
            locale={locale}
            label={t('video')}
            title={t('videoTitle')}
            close={t('close')}
            className={dark ? secondaryDark : secondary}
          />
        )
      ) : (
        <Link href={SECOND[second][0]} className={dark ? secondaryDark : secondary}>
          {t(SECOND[second][1])}
        </Link>
      )}
    </div>
  );
}

export { primaryButton, secondaryButton } from './buttons';

/** A small label above a section title. */
export function Kicker({
  children,
  light = false,
}: {
  children: React.ReactNode;
  light?: boolean;
}) {
  return (
    <p
      className={`text-xs font-semibold tracking-[0.14em] uppercase ${light ? 'text-[#7fe0d6]' : 'text-sand'}`}
    >
      {children}
    </p>
  );
}
