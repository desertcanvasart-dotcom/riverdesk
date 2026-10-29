import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { owner } from '@vs/db/testing';
import { isDomainError, type ErrorCode } from '@vs/contracts';
import {
  departureFolios,
  getExtrasSettings,
  getFolio,
  postCharge,
  saveExtraItem,
  staffBook,
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
  const office = { vesselId: null };

  beforeAll(async () => {
    w = await bookingWorld();
    const sailingId = await w.sailing('LXR-4', 42);
    await staffBook(w.db, w.ctx, {
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
    });
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
    await db.query(`update vs.folio set status = 'closed', closed_at = now() where id = $1`, [
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
});
