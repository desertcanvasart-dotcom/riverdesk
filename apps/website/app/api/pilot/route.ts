import { headers } from 'next/headers';
import { routing } from '../../../i18n/routing';
import { parsePilot, validatePilot } from '../../../lib/pilot';
import {
  clientHash,
  notifyPilotRequest,
  RateLimited,
  storePilotRequest,
} from '../../../lib/pilot-store';

/**
 * POST /api/pilot — the Founding Operator Program form. JSON in the body only, never in the
 * URL. Answers { ok: true }, 400 { errors }, 429 { error: 'rate_limited' } or 500.
 */
export async function POST(request: Request) {
  const body: unknown = await request.json().catch(() => null);
  const input = parsePilot(body);
  const requested = (body as { locale?: unknown } | null)?.locale;
  const locale = routing.locales.includes(requested as 'ar') ? (requested as string) : 'ar';

  // A bot filled the hidden field: pretend it worked, store nothing.
  if (input.website) return Response.json({ ok: true });

  const errors = validatePilot(input);
  if (Object.keys(errors).length) return Response.json({ errors }, { status: 400 });

  // The proxy in front of us (Railway) sets X-Real-IP and appends the address it saw to
  // X-Forwarded-For; earlier X-Forwarded-For entries come from the visitor and can be forged.
  const h = await headers();
  const ip =
    h.get('x-real-ip')?.trim() || h.get('x-forwarded-for')?.split(',').at(-1)?.trim() || 'unknown';
  let id: string;
  try {
    id = await storePilotRequest(input, locale, clientHash(ip));
  } catch (error) {
    if (error instanceof RateLimited) {
      return Response.json({ error: 'rate_limited' }, { status: 429 });
    }
    console.error('pilot request not stored:', (error as Error).message);
    return Response.json({ error: 'failed' }, { status: 500 });
  }
  // The request is stored; a mail failure must not make the visitor send it again.
  try {
    if (!(await notifyPilotRequest(input, locale, id))) {
      console.warn(
        `pilot request ${id} stored but not emailed (no SMTP_URL or PILOT_NOTIFY_EMAIL)`,
      );
    }
  } catch (error) {
    console.error(`pilot request ${id} stored but the email failed:`, (error as Error).message);
  }
  return Response.json({ ok: true });
}
