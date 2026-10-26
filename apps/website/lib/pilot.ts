/** The /pilot form: its fields and the checks shared by the browser and the server. */

export const OPTIONS = {
  vesselCount: ['1', '2-4', '5+'],
  vesselType: ['cruise', 'dahabiya', 'both'],
  homePort: ['luxor', 'aswan', 'cairo', 'other'],
  currentTool: ['excel', 'whatsapp', 'paper', 'other_system', 'other'],
} as const;

export interface PilotInput {
  fullName: string;
  company: string;
  vessels: string;
  vesselCount: string;
  vesselType: string;
  whatsapp: string;
  email: string;
  homePort: string;
  currentTool: string;
  message: string;
  consent: boolean;
  /** The honeypot: hidden from people, so only bots fill it in. */
  website: string;
}

export type PilotField = Exclude<keyof PilotInput, 'website'>;
export type PilotError = 'required' | 'whatsapp' | 'email' | 'consent';

const LIMITS: Partial<Record<PilotField, number>> = {
  fullName: 120,
  company: 160,
  vessels: 300,
  email: 254,
  message: 2000,
};

/**
 * A WhatsApp number in E.164 (+201001234567), or null. Accepts Arabic-Indic digits, spaces,
 * dashes and brackets; Egyptian mobiles written locally (01001234567) or with 0020 / 20.
 */
export function normaliseWhatsApp(raw: string): string | null {
  const digits = raw
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0))
    .replace(/[\s\-().‎‏]/g, '');
  let number = digits.startsWith('00') ? `+${digits.slice(2)}` : digits;
  if (/^01[0125]\d{8}$/.test(number)) number = `+20${number.slice(1)}`;
  else if (/^20\d{10}$/.test(number)) number = `+${number}`;
  return /^\+[1-9]\d{7,14}$/.test(number) ? number : null;
}

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Field errors; an empty object means the request can be sent. */
export function validatePilot(input: PilotInput): Partial<Record<PilotField, PilotError>> {
  const errors: Partial<Record<PilotField, PilotError>> = {};
  for (const field of ['fullName', 'company', 'vessels', 'whatsapp'] as const) {
    if (!input[field].trim()) errors[field] = 'required';
  }
  for (const [field, max] of Object.entries(LIMITS) as [PilotField, number][]) {
    if (String(input[field]).length > max) errors[field] = 'required';
  }
  if (input.fullName.trim().length === 1) errors.fullName = 'required';
  if (!errors.whatsapp && !normaliseWhatsApp(input.whatsapp)) errors.whatsapp = 'whatsapp';
  if (input.email.trim() && !EMAIL.test(input.email.trim())) errors.email = 'email';
  for (const [field, allowed] of Object.entries(OPTIONS) as [PilotField, readonly string[]][]) {
    if (input[field] && !allowed.includes(String(input[field]))) errors[field] = 'required';
  }
  if (input.consent !== true) errors.consent = 'consent';
  return errors;
}

/** Reads a request body into a PilotInput, treating anything missing or of the wrong type as empty. */
export function parsePilot(body: unknown): PilotInput {
  const value = (body ?? {}) as Record<string, unknown>;
  const text = (key: string) => (typeof value[key] === 'string' ? (value[key] as string) : '');
  return {
    fullName: text('fullName'),
    company: text('company'),
    vessels: text('vessels'),
    vesselCount: text('vesselCount'),
    vesselType: text('vesselType'),
    whatsapp: text('whatsapp'),
    email: text('email'),
    homePort: text('homePort'),
    currentTool: text('currentTool'),
    message: text('message'),
    consent: value.consent === true,
    website: text('website'),
  };
}
