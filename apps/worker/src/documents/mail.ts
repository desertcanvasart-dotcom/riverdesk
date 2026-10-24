import nodemailer, { type Transporter } from 'nodemailer';
import type { Config } from '@vs/shared';

let transport: Transporter | undefined;

/** Outgoing mail, if SMTP_URL is set; otherwise null (the pack is still stored for download). */
export function mailer(config: Config): Transporter | null {
  if (!config.SMTP_URL) return null;
  transport ??= nodemailer.createTransport(config.SMTP_URL);
  return transport;
}
