'use server';

import { revalidatePath } from 'next/cache';
import { z } from 'zod';
import { createPlatformCompany, reinvitePlatformOwner } from '@vs/engine';
import { pgErrorCode } from '@vs/shared';
import { backofficeDb } from '../../server/db';
import { requirePlatformAdmin } from './guard';

export type PlatformFormState =
  | { ok: true; name: string; ownerEmail: string }
  | {
      ok: false;
      error: 'invalid' | 'slugTaken' | 'emailTaken' | 'hasOwner' | 'failed';
      /** What was typed, so the form keeps it after an error. */
      values?: Record<string, string>;
    }
  | null;

const email = z.string().trim().toLowerCase().email().max(200);
const companySchema = z.object({
  name: z.string().trim().min(2).max(200),
  slug: z
    .string()
    .trim()
    .toLowerCase()
    .regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
  prefix: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z]{2,5}$/),
  ownerEmail: email,
  ownerName: z.string().trim().min(1).max(200),
  locale: z.enum(['ar', 'en']),
});

function typed(form: FormData): Record<string, string> {
  return Object.fromEntries([...form].map(([key, value]) => [key, String(value)]));
}

function failure(error: unknown): Exclude<PlatformFormState, null | { ok: true }> {
  const code = pgErrorCode(error);
  const constraint = (error as { constraint?: string }).constraint ?? '';
  if (code === '23505' && constraint.includes('slug')) return { ok: false, error: 'slugTaken' };
  if (code === '23505' && constraint.includes('email')) return { ok: false, error: 'emailTaken' };
  if (code === '23514' && (error as Error).message?.includes('already has an owner'))
    return { ok: false, error: 'hasOwner' };
  if (code === '23514') return { ok: false, error: 'invalid' };
  return { ok: false, error: 'failed' };
}

export async function addCompany(_: PlatformFormState, form: FormData): Promise<PlatformFormState> {
  const session = await requirePlatformAdmin();
  const input = companySchema.safeParse(Object.fromEntries(form));
  if (!input.success) return { ok: false, error: 'invalid', values: typed(form) };
  try {
    await createPlatformCompany(backofficeDb(), session.email, {
      name: input.data.name,
      slug: input.data.slug,
      bookingRefPrefix: input.data.prefix,
      ownerEmail: input.data.ownerEmail,
      ownerName: input.data.ownerName,
      locale: input.data.locale,
    });
  } catch (error) {
    return { ...failure(error), values: typed(form) };
  }
  revalidatePath('/platform');
  return { ok: true, name: input.data.name, ownerEmail: input.data.ownerEmail };
}

const reinviteSchema = z.object({
  operatorId: z.uuid(),
  company: z.string(),
  ownerEmail: email,
  ownerName: z.string().trim().min(1).max(200),
});

export async function reinviteOwner(
  _: PlatformFormState,
  form: FormData,
): Promise<PlatformFormState> {
  const session = await requirePlatformAdmin();
  const input = reinviteSchema.safeParse(Object.fromEntries(form));
  if (!input.success) return { ok: false, error: 'invalid' };
  try {
    await reinvitePlatformOwner(backofficeDb(), session.email, input.data);
  } catch (error) {
    return failure(error);
  }
  revalidatePath('/platform');
  return { ok: true, name: input.data.company, ownerEmail: input.data.ownerEmail };
}
