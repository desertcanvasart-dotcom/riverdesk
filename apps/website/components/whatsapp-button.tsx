import { MessageCircle } from 'lucide-react';
import { useTranslations } from 'next-intl';
import { whatsappLink } from '../lib/site';

/** The floating WhatsApp button on every page; hidden when no number is configured. */
export function WhatsAppButton() {
  const t = useTranslations('cta');
  const href = whatsappLink(t('whatsappMessage'));
  if (!href) return null;
  return (
    <a
      href={href}
      target="_blank"
      rel="noopener noreferrer"
      aria-label={t('whatsapp')}
      className="fixed bottom-4 z-50 inline-flex size-14 items-center justify-center gap-2 rounded-full bg-[#1f8f4e] text-white shadow-[var(--shadow-lift)] transition hover:opacity-90 sm:bottom-6 sm:size-auto sm:px-5 sm:py-3.5 ltr:right-4 rtl:left-4 sm:ltr:right-6 sm:rtl:left-6"
    >
      <MessageCircle aria-hidden className="size-6 sm:size-5" />
      <span className="hidden text-sm font-semibold sm:inline">{t('whatsapp')}</span>
    </a>
  );
}
