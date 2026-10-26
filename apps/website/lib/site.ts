/** Where the website links to. Set per environment; the defaults are the local servers. */
export const site = {
  /** This website's own address, for canonical links, hreflang and Open Graph. */
  siteUrl: process.env.NEXT_PUBLIC_SITE_URL ?? 'http://localhost:3200',
  /** The back office (staff sign in). */
  appUrl: process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3100',
  /** The live Channel API reference (rendered from openapi.yaml). */
  apiDocsUrl: process.env.NEXT_PUBLIC_API_DOCS_URL ?? 'http://localhost:4000/docs',
  /** WhatsApp number in international format, digits only (201001234567). Unset: no WhatsApp buttons. */
  whatsappNumber: (process.env.NEXT_PUBLIC_WHATSAPP_NUMBER ?? '').replace(/\D/g, ''),
  /** How many founding vessels the program takes. */
  foundingSeats: Number(process.env.NEXT_PUBLIC_FOUNDING_SEATS ?? 20),
  /** The 90-second demo video per language. Unset: the "See it in 90 seconds" button is hidden. */
  demoVideo: {
    ar: {
      url: process.env.NEXT_PUBLIC_DEMO_VIDEO_URL_AR ?? '',
      captions: process.env.NEXT_PUBLIC_DEMO_VIDEO_CAPTIONS_AR ?? '',
    },
    en: {
      url: process.env.NEXT_PUBLIC_DEMO_VIDEO_URL_EN ?? '',
      captions: process.env.NEXT_PUBLIC_DEMO_VIDEO_CAPTIONS_EN ?? '',
    },
  },
};

/** A wa.me link that opens WhatsApp with the message already typed, or null when no number is set. */
export function whatsappLink(message: string): string | null {
  return site.whatsappNumber
    ? `https://wa.me/${site.whatsappNumber}?text=${encodeURIComponent(message)}`
    : null;
}
