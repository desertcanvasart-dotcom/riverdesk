import { z } from 'zod';
import { DomainError } from '@vs/contracts';
import type { VsDatabase } from '@vs/db';
import { DEFAULT_BRAND, normalizeHex } from '@vs/shared';
import { audit } from '../audit';
import { parseInput, type EngineContext } from '../internal';

/**
 * Branding (Batch D1): the company's logo, two colours and the contact block printed on every
 * document. A company without a row uses the defaults. The logo is a PNG or JPEG of at most
 * 200 KB; its type is read from the file itself, not from what the browser says.
 */

export const LOGO_MAX_BYTES = 200 * 1024;

/** What every document prints: the company's name, look and contact details. */
export interface DocumentBrand {
  name: string;
  /** data: URL, or null for no logo. */
  logo: string | null;
  primary: string;
  secondary: string;
  contact: {
    phone: string | null;
    whatsapp: string | null;
    email: string | null;
    website: string | null;
    address: { ar: string; en: string };
  };
}

function dataUrl(bytes: Buffer | null, type: string | null): string | null {
  return bytes && type ? `data:${type};base64,${bytes.toString('base64')}` : null;
}

async function loadBranding(db: VsDatabase, ctx: EngineContext) {
  return db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const operator = await tx.selectFrom('operator').select('name').executeTakeFirstOrThrow();
    const row = await tx.selectFrom('operator_branding').selectAll().executeTakeFirst();
    return { name: operator.name, row };
  });
}

/** For the Branding screen: everything, with the logo as a data: URL. */
export async function getBranding(db: VsDatabase, ctx: EngineContext) {
  const { row } = await loadBranding(db, ctx);
  return {
    primaryColor: row?.primary_color ?? DEFAULT_BRAND.primary,
    secondaryColor: row?.secondary_color ?? DEFAULT_BRAND.secondary,
    logo: dataUrl(row?.logo ?? null, row?.logo_type ?? null),
    phone: row?.phone ?? null,
    whatsapp: row?.whatsapp ?? null,
    email: row?.email ?? null,
    website: row?.website ?? null,
    addressAr: row?.address_ar ?? null,
    addressEn: row?.address_en ?? null,
  };
}

/** For the document renderer. */
export async function documentBrand(db: VsDatabase, ctx: EngineContext): Promise<DocumentBrand> {
  const { name, row } = await loadBranding(db, ctx);
  return {
    name,
    logo: dataUrl(row?.logo ?? null, row?.logo_type ?? null),
    primary: row?.primary_color ?? DEFAULT_BRAND.primary,
    secondary: row?.secondary_color ?? DEFAULT_BRAND.secondary,
    contact: {
      phone: row?.phone ?? null,
      whatsapp: row?.whatsapp ?? null,
      email: row?.email ?? null,
      website: row?.website ?? null,
      address: { ar: row?.address_ar ?? '', en: row?.address_en ?? '' },
    },
  };
}

const color = z.string().transform((value, check) => {
  const hex = normalizeHex(value);
  if (!hex) check.addIssue({ code: 'custom', message: 'Must be a colour like #165a5c' });
  return hex ?? '';
});
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullable()
    .transform((value) => (value ? value : null));

export const updateBrandingInput = z
  .object({
    primaryColor: color,
    secondaryColor: color,
    phone: text(50),
    whatsapp: text(50),
    email: z
      .union([z.email(), z.literal('')])
      .nullable()
      .transform((value) => (value ? value.toLowerCase() : null)),
    website: text(200),
    addressAr: text(300),
    addressEn: text(300),
  })
  .partial();

const COLUMNS = {
  primaryColor: 'primary_color',
  secondaryColor: 'secondary_color',
  phone: 'phone',
  whatsapp: 'whatsapp',
  email: 'email',
  website: 'website',
  addressAr: 'address_ar',
  addressEn: 'address_en',
} as const;

export async function updateBranding(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof updateBrandingInput>,
) {
  const data = parseInput(updateBrandingInput, input);
  const before = await getBranding(db, ctx);
  const set = Object.fromEntries(
    Object.entries(data).map(([key, value]) => [COLUMNS[key as keyof typeof COLUMNS], value]),
  );
  await db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    await tx
      .insertInto('operator_branding')
      .values({ operator_id: ctx.operatorId, ...set })
      .onConflict((oc) => oc.column('operator_id').doUpdateSet(set))
      .execute();
    const changed = Object.keys(data).filter(
      (key) => before[key as keyof typeof before] !== data[key as keyof typeof data],
    );
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: 'branding.updated',
      entity: 'operator',
      entityId: ctx.operatorId,
      before: Object.fromEntries(changed.map((key) => [key, before[key as keyof typeof before]])),
      after: Object.fromEntries(changed.map((key) => [key, data[key as keyof typeof data]])),
    });
  });
  return getBranding(db, ctx);
}

/** PNG or JPEG by its first bytes, or null. */
function imageType(bytes: Buffer): 'image/png' | 'image/jpeg' | null {
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])))
    return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'image/jpeg';
  return null;
}

export const setLogoInput = z.object({
  /** The file, base64 (no data: prefix). */
  base64: z.string().max(Math.ceil((LOGO_MAX_BYTES * 4) / 3) + 4),
});

/** Replaces the logo; `base64: ''` removes it. */
export async function setLogo(
  db: VsDatabase,
  ctx: EngineContext,
  input: z.input<typeof setLogoInput>,
) {
  const { base64 } = parseInput(setLogoInput, input);
  const bytes = base64 ? Buffer.from(base64, 'base64') : null;
  const type = bytes ? imageType(bytes) : null;
  if (bytes && (!type || bytes.length > LOGO_MAX_BYTES)) {
    throw new DomainError('VALIDATION_FAILED', {
      message: !type ? 'The logo must be a PNG or JPEG image' : 'The logo must be 200 KB or less',
      details: { field: 'logo', bytes: bytes.length },
    });
  }
  await db.withTenantTx(ctx.operatorId, ctx.actor, async ({ db: tx }) => {
    const before = await tx.selectFrom('operator_branding').select('logo_type').executeTakeFirst();
    await tx
      .insertInto('operator_branding')
      .values({ operator_id: ctx.operatorId, logo: bytes, logo_type: type })
      .onConflict((oc) => oc.column('operator_id').doUpdateSet({ logo: bytes, logo_type: type }))
      .execute();
    await audit(tx, ctx.operatorId, ctx.actor, {
      action: bytes ? 'branding.logo_set' : 'branding.logo_removed',
      entity: 'operator',
      entityId: ctx.operatorId,
      before: { logo: before?.logo_type ?? null },
      after: { logo: type, bytes: bytes?.length ?? 0 },
    });
  });
  return getBranding(db, ctx);
}
