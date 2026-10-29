import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const { appRouter } = await import('../server/router');
const { can, MFA_REQUIRED, PERMISSIONS } = await import('../server/permissions');

const staff = (role: 'owner' | 'reservations' | 'finance' | 'read_only' | 'onboard') => ({
  staffUserId: crypto.randomUUID(),
  operatorId: crypto.randomUUID(),
  role,
  vesselId: role === 'onboard' ? crypto.randomUUID() : null,
});

describe('back-office authorization (server side)', () => {
  it('refuses calls without a linked staff session', async () => {
    await expect(appRouter.createCaller({ session: null }).me.profile()).rejects.toMatchObject({
      code: 'UNAUTHORIZED',
    });
  });

  it('refuses everything until MFA is passed for roles that need it', async () => {
    const session = {
      authUserId: crypto.randomUUID(),
      email: null,
      aal: 'aal1' as const,
      staff: staff('owner'),
      platformAdmin: false,
      needsMfa: true,
    };
    await expect(appRouter.createCaller({ session }).home.actionList()).rejects.toMatchObject({
      code: 'FORBIDDEN',
      message: 'MFA_REQUIRED',
    });
  });

  it('owner and finance need MFA; reservations and read-only do not', () => {
    expect([...MFA_REQUIRED].sort()).toEqual(['finance', 'owner']);
  });

  it('read-only may read and do nothing else', () => {
    for (const permission of Object.keys(PERMISSIONS) as (keyof typeof PERMISSIONS)[]) {
      expect(can('read_only', permission)).toBe(
        ['read', 'self', 'checkin.view', 'analytics.view'].includes(permission),
      );
    }
    expect(can('finance', 'finance')).toBe(true);
    expect(can('finance', 'bookings.write')).toBe(false);
    expect(can('reservations', 'finance')).toBe(false);
    expect(can('reservations', 'rates.write')).toBe(false);
    expect(can('owner', 'settings.write')).toBe(true);
  });

  it('every mutation refuses a read-only user before touching its input', async () => {
    const session = {
      authUserId: crypto.randomUUID(),
      email: null,
      aal: 'aal1' as const,
      staff: staff('read_only'),
      platformAdmin: false,
      needsMfa: false,
    };
    const caller = appRouter.createCaller({ session }) as unknown as Record<
      string,
      Record<string, (input: unknown) => Promise<unknown>>
    >;
    const mutations = Object.entries(appRouter._def.procedures)
      .filter(([, procedure]) => (procedure as { _def: { type: string } })._def.type === 'mutation')
      .map(([path]) => path)
      // Changing one's own language is allowed to everyone, and an Analytics export, an
      // invoice PDF, a statement or the aging only makes a file of what the person can see.
      .filter(
        (path) =>
          ![
            'me.setLocale',
            'analytics.export',
            'invoices.requestPdf',
            'receivables.requestStatement',
            'receivables.requestAging',
            'financeReports.requestReport',
          ].includes(path),
      );
    expect(mutations).toEqual(
      expect.arrayContaining(['book.create', 'bookings.cancel', 'requests.accept']),
    );
    for (const path of mutations) {
      const [group, name] = path.split('.') as [string, string];
      await expect(caller[group]![name]!({}), path).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
  });

  it('reservations draft proformas; only finance drafts, issues and credits invoices', async () => {
    const session = {
      authUserId: crypto.randomUUID(),
      email: null,
      aal: 'aal1' as const,
      staff: staff('reservations'),
      platformAdmin: false,
      needsMfa: false,
    };
    const caller = appRouter.createCaller({ session });
    const id = { invoiceId: crypto.randomUUID() };
    for (const call of [
      () => caller.invoices.createDraft({ type: 'invoice', bookingIds: [crypto.randomUUID()] }),
      () => caller.invoices.issue(id),
      () => caller.invoices.creditNote({ ...id, reason: 'x' }),
      () => caller.finance.settings(),
      () => caller.finance.updateSettings({ invoicePrefix: 'X' }),
      () => caller.finance.saveTax({ nameAr: 'x', nameEn: 'x', rateBps: 0 }),
      () => caller.invoices.requestRegister({ from: '2026-01-01', to: '2026-01-31' }),
      () => caller.receipts.list({}),
      () => caller.receipts.account({ billingPartyId: crypto.randomUUID() }),
      () =>
        caller.receipts.record({
          billingPartyId: crypto.randomUUID(),
          amount: 100,
          currency: 'USD',
          method: 'cash',
          reference: 'x',
          receivedOn: '2026-01-01',
        }),
      () => caller.receipts.allocate({ receiptId: id.invoiceId, ...id, amount: 1 }),
      () => caller.receipts.unallocate({ receiptId: id.invoiceId, ...id }),
      () => caller.receipts.reverse({ receiptId: id.invoiceId, reason: 'x' }),
      () => caller.financeReports.accountCodes(),
      () => caller.analytics.cash({ from: '2026-01-01', to: '2026-01-31' }),
      () => caller.analytics.revenue({ from: '2026-01-01', to: '2026-01-31' }),
      () =>
        caller.analytics.export({
          report: 'cash',
          locale: 'en',
          filter: { from: '2026-01-01', to: '2026-01-31' },
        }),
      () =>
        caller.financeReports.exportPreview({
          content: 'journal',
          from: '2026-01-01',
          to: '2026-01-31',
        }),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    expect(can('reservations', 'bookings.write')).toBe(true);
  });

  it('on-board staff get Check-in and their own profile, nothing else', async () => {
    const allowed = (Object.keys(PERMISSIONS) as (keyof typeof PERMISSIONS)[]).filter((p) =>
      can('onboard', p),
    );
    expect(allowed.sort()).toEqual(
      ['checkin.view', 'checkin.write', 'documents.create', 'manifests', 'self'].sort(),
    );
    expect(MFA_REQUIRED).not.toContain('onboard');
    const session = {
      authUserId: crypto.randomUUID(),
      email: null,
      aal: 'aal1' as const,
      staff: staff('onboard'),
      platformAdmin: false,
      needsMfa: false,
    };
    const caller = appRouter.createCaller({ session });
    for (const call of [
      () => caller.home.actionList(),
      () => caller.bookings.search({}),
      () => caller.payments.ledger({}),
      () => caller.receivables.aging({}),
      () => caller.checkin.vessels(),
    ]) {
      await expect(call()).rejects.toMatchObject({ code: 'FORBIDDEN' });
    }
    // Booking documents are refused before any database work.
    await expect(
      caller.documents.request({
        kind: 'voucher',
        bookingId: crypto.randomUUID(),
        locale: 'ar',
      }),
    ).rejects.toMatchObject({ code: 'FORBIDDEN' });
  });
});
