/** Where the website links to. Set per environment; the defaults are the local servers. */
export const site = {
  /** The back office (staff sign in). */
  appUrl: process.env.NEXT_PUBLIC_APP_URL ?? 'http://localhost:3100',
  /** The live Channel API reference (rendered from openapi.yaml). */
  apiDocsUrl: process.env.NEXT_PUBLIC_API_DOCS_URL ?? 'http://localhost:4000/docs',
  /** Where "Request a demo" writes to; the button is hidden when unset. */
  contactEmail: process.env.NEXT_PUBLIC_CONTACT_EMAIL ?? '',
};
