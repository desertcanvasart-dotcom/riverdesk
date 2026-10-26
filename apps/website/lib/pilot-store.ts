import 'server-only';
import { createHmac } from 'node:crypto';
import nodemailer from 'nodemailer';
import pg from 'pg';
import { loadConfig, required, roleConnection } from '@vs/shared';
import { normaliseWhatsApp, type PilotInput } from './pilot';

let pool: pg.Pool | undefined;

/** The website's own database role: it can only call vs.submit_pilot_request. */
function database(): pg.Pool {
  if (!pool) {
    const config = loadConfig();
    const connection = roleConnection(config, 'vs_website');
    pool = new pg.Pool({
      ...connection,
      ssl: connection.ssl ? { rejectUnauthorized: false } : false,
      max: 2,
    });
    pool.on('error', () => {});
  }
  return pool;
}

/**
 * A keyed hash of the visitor's IP address, for the rate limit. The address itself is never
 * stored; the key is the website role's password, a secret only this server holds.
 */
export function clientHash(ip: string): string {
  const key = required(loadConfig(), 'VS_WEBSITE_PASSWORD');
  return createHmac('sha256', key).update(`pilot:${ip}`).digest('hex');
}

export class RateLimited extends Error {}

/** Stores the request; throws RateLimited when this client has sent too many. */
export async function storePilotRequest(
  input: PilotInput,
  locale: string,
  hash: string,
): Promise<string> {
  const request = {
    full_name: input.fullName,
    company_name: input.company,
    vessel_names: input.vessels,
    vessel_count: input.vesselCount || null,
    vessel_type: input.vesselType || null,
    whatsapp: normaliseWhatsApp(input.whatsapp),
    email: input.email.trim() || null,
    home_port: input.homePort || null,
    current_tool: input.currentTool || null,
    message: input.message,
    locale,
    consent: input.consent,
  };
  try {
    const { rows } = await database().query<{ id: string }>(
      'select vs.submit_pilot_request($1::jsonb, $2) as id',
      [JSON.stringify(request), hash],
    );
    return rows[0]!.id;
  } catch (error) {
    if ((error as Error).message === 'rate_limited') throw new RateLimited();
    throw error;
  }
}

/** Emails the request to PILOT_NOTIFY_EMAIL. Returns false when mail is not configured. */
export async function notifyPilotRequest(input: PilotInput, locale: string, id: string) {
  const config = loadConfig();
  const to = process.env.PILOT_NOTIFY_EMAIL;
  if (!config.SMTP_URL || !to) return false;
  const lines = [
    ['Name', input.fullName],
    ['Company', input.company],
    ['Vessel(s)', input.vessels],
    ['Number of vessels', input.vesselCount],
    ['Vessel type', input.vesselType],
    ['WhatsApp', normaliseWhatsApp(input.whatsapp) ?? input.whatsapp],
    ['Email', input.email],
    ['Home port', input.homePort],
    ['Reservations today', input.currentTool],
    ['Language', locale],
    ['Message', input.message],
  ]
    .filter(([, value]) => value)
    .map(([label, value]) => `${label}: ${value}`);
  await nodemailer.createTransport(config.SMTP_URL).sendMail({
    from: config.MAIL_FROM ?? 'Riverdesk <no-reply@riverdsk.com>',
    to,
    replyTo: input.email.trim() || undefined,
    subject: `New pilot request: ${input.company} (${input.vessels})`.slice(0, 200),
    text: `${lines.join('\n')}\n\nRequest id: ${id}\n`,
  });
  return true;
}
