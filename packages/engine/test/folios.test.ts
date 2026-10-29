import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { owner } from '@vs/db/testing';
import { isDomainError, type ErrorCode } from '@vs/contracts';
import {
  bookingFolios,
  cancelBooking,
  closeFolio,
  departureFolios,
  getAccountantExport,
  getFinanceReport,
  getExtrasSettings,
  getFolio,
  payFolio,
  postCharge,
  revenueReport,
  saveExtraItem,
  staffBook,
  updateContract,
  updateVesselFolio,
  voidCharge,
} from '../src/index';
import { bookingWorld, type BookingWorld } from './helpers/booking-world';

const codeOf = async (promise: Promise<unknown>): Promise<ErrorCode | 'ok'> =>
  promise.then(
    () => 'ok' as const,
    (e: unknown) => (isDomainError(e) ? e.code : Promise.reject(e)),
  );

describe('extras E1: price list and folios', () => {
  let w: BookingWorld;
  let legId: string;
  let cabins: string[];
  let water: string;
  let bookingId: string;
  const office = { vesselId: null };

  beforeAll(async () => {
    w = await bookingWorld();
    const sailingId = await w.sailing('LXR-4', 42);
    ({ bookingId } = await staffBook(w.db, w.ctx, {
      channelId: w.agents.credit,
      sailingId,
      market: 'international',
      cabins: [
        { categoryId: w.demo.categories.STD, adults: 2 },
        { categoryId: w.demo.categories.STD, adults: 1 },
      ],
      guests: [
        { cabin: 0, lead: true, firstName: 'Klaus', lastName: 'Meyer' },
        { cabin: 0, firstName: 'Ute', lastName: 'Meyer' },
        { cabin: 1, firstName: 'Jean', lastName: 'Martin' },
      ],
      requestKey: 'folios-1',
    }));
    const { rows } = await owner().query<{ id: string }>(
      `select l.id from vs.leg l join vs.sailing s on s.embark_date = l.depart_date and s.embark_port_id = l.from_port_id
       where s.id = $1 and l.vessel_id = s.vessel_id`,
      [sailingId],
    );
    legId = rows[0]!.id;
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  it('keeps a price list per vessel or for every vessel', async () => {
    water = (
      await saveExtraItem(w.db, w.ctx, {
        category: 'bar',
        nameAr: 'مياه معدنية',
        nameEn: 'Mineral water',
        price: 300n,
        currency: 'USD',
      })
    ).id;
    await saveExtraItem(w.db, w.ctx, {
      vesselId: w.demo.vesselId,
      category: 'laundry',
      nameAr: 'قميص',
      nameEn: 'Shirt',
      price: 400,
      currency: 'USD',
    });
    await saveExtraItem(w.db, w.ctx, {
      category: 'spa',
      nameAr: 'تدليك',
      nameEn: 'Massage',
      price: 4000,
      currency: 'EUR',
    });
    const settings = await getExtrasSettings(w.db, w.ctx);
    expect(settings.items.map((i) => i.nameEn)).toEqual(['Mineral water', 'Shirt', 'Massage']);
    expect(settings.vessels[0]).toMatchObject({ folioEnabled: false, folioCurrency: 'USD' });
  });

  it('posts nothing on a vessel that keeps no folios', async () => {
    const folios = await departureFolios(w.db, w.ctx, legId, office);
    expect(folios.enabled).toBe(false);
    cabins = folios.cabins.map((c) => c.bookingCabinId);
    expect(folios.cabins.map((c) => c.guests)).toEqual([
      ['Klaus Meyer', 'Ute Meyer'],
      ['Jean Martin'],
    ]);
    expect(
      await codeOf(
        postCharge(w.db, w.ctx, { legId, bookingCabinId: cabins[0]!, itemId: water }, office),
      ),
    ).toBe('INVALID_STATE');
    await updateVesselFolio(w.db, w.ctx, { vesselId: w.demo.vesselId, folioEnabled: true });
  });

  it('opens the folio with the first charge and copies the price', async () => {
    const first = await postCharge(
      w.db,
      w.ctx,
      { legId, bookingCabinId: cabins[0]!, itemId: water, quantity: 2, guestName: 'Ute Meyer' },
      office,
    );
    expect(first.folio).toMatchObject({ status: 'open', currency: 'USD', billTo: 'guest' });
    expect(first.charges).toMatchObject([
      { descriptionEn: 'Mineral water', quantity: 2, unitAmount: 300n, amount: 600n },
    ]);
    // A later price change does not touch the charge.
    await saveExtraItem(w.db, w.ctx, {
      id: water,
      category: 'bar',
      nameAr: 'مياه معدنية',
      nameEn: 'Mineral water',
      price: 350,
      currency: 'USD',
    });
    const next = await postCharge(
      w.db,
      w.ctx,
      {
        legId,
        bookingCabinId: cabins[0]!,
        manual: { category: 'other', description: 'Broken glass', unitAmount: 500 },
      },
      office,
    );
    expect(next.charges.map((c) => c.amount)).toEqual([600n, 500n]);
    expect(next.total).toBe(1100n);
    expect(next.byCategory).toEqual({ bar: 600n, other: 500n });
  });

  it('refuses an item in another currency than the folio', async () => {
    const massage = (await getExtrasSettings(w.db, w.ctx)).items.find(
      (i) => i.nameEn === 'Massage',
    )!;
    expect(
      await codeOf(
        postCharge(w.db, w.ctx, { legId, bookingCabinId: cabins[0]!, itemId: massage.id }, office),
      ),
    ).toBe('INVALID_STATE');
  });

  it('voids a charge with a reason and keeps it on the folio', async () => {
    const before = await getFolio(w.db, w.ctx, { legId, bookingCabinId: cabins[0]! }, office);
    const glass = before.charges.find((c) => c.descriptionEn === 'Broken glass')!;
    const after = await voidCharge(
      w.db,
      w.ctx,
      {
        legId,
        bookingCabinId: cabins[0]!,
        chargeId: glass.id,
        reason: 'Posted to the wrong cabin',
      },
      office,
    );
    expect(after.total).toBe(600n);
    expect(after.charges.find((c) => c.id === glass.id)?.voided).toMatchObject({
      reason: 'Posted to the wrong cabin',
    });
    expect(after.byCategory).toEqual({ bar: 600n });
    expect(
      await codeOf(
        voidCharge(
          w.db,
          w.ctx,
          { legId, bookingCabinId: cabins[0]!, chargeId: glass.id, reason: 'Again' },
          office,
        ),
      ),
    ).toBe('INVALID_STATE');
  });

  it('opens one folio when two phones post the first charge at once', async () => {
    await Promise.all(
      [1, 2, 3].map(() =>
        postCharge(w.db, w.ctx, { legId, bookingCabinId: cabins[1]!, itemId: water }, office),
      ),
    );
    const folios = await departureFolios(w.db, w.ctx, legId, office);
    expect(folios.cabins[1]!.folio).toMatchObject({ total: 1050n, charges: 3 });
    expect(folios.cabins[0]!.folio).toMatchObject({ total: 600n, charges: 1 });
    expect(folios.total).toBe(1650n);
    expect(folios.items.map((i) => i.nameEn)).toEqual(['Mineral water', 'Shirt']);
  });

  it('limits an on-board login to its own vessel', async () => {
    const elsewhere = { vesselId: '00000000-0000-7000-8000-000000000000' };
    expect(await codeOf(departureFolios(w.db, w.ctx, legId, elsewhere))).toBe('NOT_FOUND');
    expect(
      await codeOf(
        postCharge(w.db, w.ctx, { legId, bookingCabinId: cabins[0]!, itemId: water }, elsewhere),
      ),
    ).toBe('NOT_FOUND');
  });

  it('keeps the folio currency while folios are open', async () => {
    expect(
      await codeOf(
        updateVesselFolio(w.db, w.ctx, { vesselId: w.demo.vesselId, folioCurrency: 'EUR' }),
      ),
    ).toBe('INVALID_STATE');
  });

  it('lets the database refuse edits, and charges on a closed folio', async () => {
    const db = owner();
    const { rows } = await db.query<{ id: string; folio_id: string }>(
      `select c.id, c.folio_id from vs.folio_charge c join vs.folio f on f.id = c.folio_id
       where f.booking_cabin_id = $1 limit 1`,
      [cabins[1]],
    );
    const charge = rows[0]!;
    await db.query(`update vs.folio set status = 'void', closed_at = now() where id = $1`, [
      charge.folio_id,
    ]);
    expect(
      await codeOf(
        postCharge(w.db, w.ctx, { legId, bookingCabinId: cabins[1]!, itemId: water }, office),
      ),
    ).toBe('INVALID_STATE');
    await expect(
      db.query(
        `insert into vs.folio_charge (operator_id, folio_id, category, description_ar, description_en,
                                      quantity, unit_amount, amount, currency, charged_on)
         select operator_id, id, 'bar', 'x', 'x', 1, 1, 1, currency, current_date from vs.folio where id = $1`,
        [charge.folio_id],
      ),
    ).rejects.toThrow(/closed/);
    await db.query(`update vs.folio set status = 'open', closed_at = null where id = $1`, [
      charge.folio_id,
    ]);
  });

  it('refuses to cancel a booking while a folio holds charges', async () => {
    expect(await codeOf(cancelBooking(w.db, w.ctx, { bookingId, reason: 'Test' }))).toBe(
      'INVALID_STATE',
    );
  });

  it('closes a folio into an invoice of extras, then takes payment at reception', async () => {
    // The folio is in USD, the company's base currency EGP: a rate is needed.
    expect(
      await codeOf(closeFolio(w.db, w.ctx, { legId, bookingCabinId: cabins[0]! }, office)),
    ).toBe('VALIDATION_FAILED');
    const closed = await closeFolio(
      w.db,
      w.ctx,
      { legId, bookingCabinId: cabins[0]!, fxRate: '50' },
      office,
    );
    expect(closed.folio).toMatchObject({
      status: 'closed',
      billTo: 'guest',
      invoice: { total: 600n, balance: 600n, party: 'Klaus Meyer', status: 'issued' },
    });
    const { rows } = await owner().query<{ kind: string; description_en: string; amount: string }>(
      `select kind, description_en, amount::text from vs.invoice_line where invoice_id = $1 order by seq`,
      [closed.folio!.invoice!.id],
    );
    // The voided glass leaves no line; the water is one Bar line for its day.
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'extra', amount: '600' });
    expect(rows[0]!.description_en).toMatch(/^Bar — \d{4}-\d{2}-\d{2} — cabin /);
    expect(
      await codeOf(
        postCharge(w.db, w.ctx, { legId, bookingCabinId: cabins[0]!, itemId: water }, office),
      ),
    ).toBe('INVALID_STATE');
    expect(
      await codeOf(
        payFolio(
          w.db,
          w.ctx,
          { legId, bookingCabinId: cabins[0]!, amount: 700, currency: 'USD', method: 'cash' },
          office,
        ),
      ),
    ).toBe('VALIDATION_FAILED');
    await payFolio(
      w.db,
      w.ctx,
      { legId, bookingCabinId: cabins[0]!, amount: 200, currency: 'USD', method: 'card' },
      office,
    );
    // The rest in Egyptian pounds at the reception's rate: 400 US cents = 20,000 piastres.
    const paid = await payFolio(
      w.db,
      w.ctx,
      {
        legId,
        bookingCabinId: cabins[0]!,
        amount: 20_000,
        currency: 'EGP',
        method: 'cash',
        fxRate: '50',
      },
      office,
    );
    expect(paid.folio!.invoice).toMatchObject({ balance: 0n, status: 'paid' });
    const folios = await departureFolios(w.db, w.ctx, legId, office);
    expect(folios.cabins[0]!.folio).toMatchObject({ status: 'closed', balance: 0n });
    expect(folios.baseCurrency).toBe('EGP');
    expect(folios.lastRate).toBe('50');
  });

  it('bills the agency only where its contract says so', async () => {
    expect(
      await codeOf(
        closeFolio(
          w.db,
          w.ctx,
          { legId, bookingCabinId: cabins[1]!, billTo: 'agency', fxRate: '50' },
          office,
        ),
      ),
    ).toBe('INVALID_STATE');
    const { rows } = await owner().query<{ contract_id: string }>(
      `select contract_id from vs.booking where id = $1`,
      [bookingId],
    );
    await updateContract(w.db, w.ctx, { contractId: rows[0]!.contract_id, folioToAgency: true });
    const closed = await closeFolio(
      w.db,
      w.ctx,
      { legId, bookingCabinId: cabins[1]!, billTo: 'agency', fxRate: '50' },
      office,
    );
    expect(closed.folio).toMatchObject({ billTo: 'agency', invoice: { total: 1050n } });
    expect(closed.agency).toMatchObject({ allowed: true });
    expect(
      await codeOf(
        payFolio(
          w.db,
          w.ctx,
          { legId, bookingCabinId: cabins[1]!, amount: 100, currency: 'USD', method: 'cash' },
          office,
        ),
      ),
    ).toBe('INVALID_STATE');
  });

  it("lists a booking's folios with their invoices and balances", async () => {
    const folios = await bookingFolios(w.db, w.ctx, bookingId);
    expect(folios.map((f) => [f.status, f.billTo, f.total, f.invoice?.balance])).toEqual([
      ['closed', 'guest', 600n, 0n],
      ['closed', 'agency', 1050n, 1050n],
    ]);
  });

  it('counts extras in revenue analytics, the revenue report and the journal', async () => {
    const { rows } = await owner().query<{ depart: string; today: string }>(
      `select depart_date::text as depart, (now() at time zone 'Africa/Cairo')::date::text as today
       from vs.leg where id = $1`,
      [legId],
    );
    const { depart, today } = rows[0]!;
    const analytics = await revenueReport(w.db, w.ctx, {
      basis: 'sailing',
      from: depart,
      to: depart,
      groupBy: 'vessel',
      vesselId: w.demo.vesselId,
    });
    expect(analytics.extras.rows).toEqual([
      expect.objectContaining({ currency: 'USD', charged: 1650n, invoiced: 1650n }),
    ]);
    const extras = analytics.extras.rows[0]!;
    expect(extras.guestNights).toBeGreaterThan(0);
    expect(extras.perGuestNight).toBe(
      (1650n + BigInt(extras.guestNights) / 2n) / BigInt(extras.guestNights),
    );
    expect(analytics.extras.byCategory.map((c) => [c.category, c.amount])).toEqual([
      ['bar', 1650n],
    ]);

    const report = await getFinanceReport(w.db, w.ctx, {
      report: 'revenue',
      from: today,
      to: today,
      vesselId: w.demo.vesselId,
      currency: 'USD',
    });
    const total = report.rows.reduce((sum, r) => sum + BigInt(r.extras as bigint), 0n);
    expect(total).toBe(1650n);

    const journal = await getAccountantExport(w.db, w.ctx, {
      content: 'journal',
      from: today,
      to: today,
    });
    const extraLines = journal.rows.filter((r) => r.account === 'revenue_extras');
    expect(extraLines.map((r) => r.credit)).toEqual([600n, 1050n]);
    expect(journal.unmapped).toContainEqual(expect.objectContaining({ kind: 'revenue_extras' }));
  });

  it('lets the booking be cancelled once its folios are closed', async () => {
    expect(await codeOf(cancelBooking(w.db, w.ctx, { bookingId, reason: 'Test' }))).toBe('ok');
  });
});
