import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { owner } from '@vs/db/testing';
import { isDomainError } from '@vs/contracts';
import {
  createApiClient,
  createWebhookEndpoint,
  getOperatorSettings,
  inviteStaff,
  listChannelsDetail,
  listPayments,
  listStaff,
  listWebhookDeliveries,
  recordPayment,
  revokeInvitation,
  staffBook,
  todayInCairo,
  updateOperatorSettings,
  updateStaff,
} from '../src/index';
import { bookingWorld, lead, type BookingWorld } from './helpers/booking-world';

const codeOf = (promise: Promise<unknown>) =>
  promise.then(
    () => 'ok',
    (e: unknown) => (isDomainError(e) ? e.code : Promise.reject(e)),
  );

describe('settings, channels and payments ledger', () => {
  let w: BookingWorld;
  let ownerId: string;

  beforeAll(async () => {
    w = await bookingWorld();
    const { rows } = await owner().query<{ id: string }>(
      `insert into vs.staff_user (operator_id, auth_user_id, email, display_name, role)
       values ($1, gen_random_uuid(), $2, 'Owner', 'owner') returning id`,
      [w.ctx.operatorId, `owner-${w.ctx.operatorId.slice(-8)}@example.test`],
    );
    ownerId = rows[0]!.id;
  }, 120_000);

  afterAll(async () => {
    await w.close();
  });

  it('invites staff once per email, revokes, and keeps at least one active owner', async () => {
    const email = `res-${w.ctx.operatorId.slice(-8)}@example.test`;
    const { invitationId } = await inviteStaff(w.db, w.ctx, {
      email,
      displayName: 'Res',
      role: 'reservations',
    });
    expect(
      await codeOf(inviteStaff(w.db, w.ctx, { email, displayName: 'Again', role: 'finance' })),
    ).toBe('INVALID_STATE');
    expect((await listStaff(w.db, w.ctx)).invitations.map((i) => i.id)).toContain(invitationId);
    await revokeInvitation(w.db, w.ctx, { invitationId });
    expect((await listStaff(w.db, w.ctx)).invitations.map((i) => i.id)).not.toContain(invitationId);

    expect(await codeOf(updateStaff(w.db, w.ctx, { staffUserId: ownerId, role: 'finance' }))).toBe(
      'INVALID_STATE',
    );
    expect(await codeOf(updateStaff(w.db, w.ctx, { staffUserId: ownerId, active: false }))).toBe(
      'INVALID_STATE',
    );
  });

  it('refuses a change to one’s own role, even with another owner left', async () => {
    const { rows } = await owner().query<{ id: string }>(
      `insert into vs.staff_user (operator_id, auth_user_id, email, display_name, role)
       values ($1, gen_random_uuid(), $2, 'Second owner', 'owner') returning id`,
      [w.ctx.operatorId, `owner2-${w.ctx.operatorId.slice(-8)}@example.test`],
    );
    const self = { ...w.ctx, actor: { type: 'staff' as const, id: ownerId } };
    expect(await codeOf(updateStaff(w.db, self, { staffUserId: ownerId, role: 'manager' }))).toBe(
      'INVALID_STATE',
    );
    // The other owner may still do it.
    const other = { ...w.ctx, actor: { type: 'staff' as const, id: rows[0]!.id } };
    expect(await updateStaff(w.db, other, { staffUserId: ownerId, role: 'manager' })).toMatchObject(
      { role: 'manager' },
    );
    await updateStaff(w.db, other, { staffUserId: ownerId, role: 'owner' });
  });

  it('updates operator defaults and audits only what changed', async () => {
    const before = await getOperatorSettings(w.db, w.ctx);
    const result = await updateOperatorSettings(w.db, w.ctx, {
      optionHoldHours: before.optionHoldHours + 1,
      requestSlaHours: before.requestSlaHours,
    });
    expect(result.updated).toEqual(['optionHoldHours']);
    expect((await getOperatorSettings(w.db, w.ctx)).optionHoldHours).toBe(
      before.optionHoldHours + 1,
    );
  });

  it('lists channels with contracts, API clients (hints only) and webhook endpoints', async () => {
    await createApiClient(w.db, w.ctx, { channelId: w.channels.nilecrz, name: 'nilecrz prod' });
    const { endpointId } = await createWebhookEndpoint(w.db, w.ctx, {
      channelId: w.channels.nilecrz,
      url: 'https://example.test/hooks',
    });
    const channels = await listChannelsDetail(w.db, w.ctx);
    const nilecrz = channels.find((c) => c.id === w.channels.nilecrz)!;
    expect(nilecrz.contracts.length).toBeGreaterThan(0);
    expect(nilecrz.clients[0]!.secrets[0]!.hint).toHaveLength(4);
    expect(
      JSON.stringify(channels, (_k, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
    ).not.toMatch(/vss_|whsec_|secret_hash/);
    expect(nilecrz.endpoints.map((e) => e.id)).toContain(endpointId);
    expect(await listWebhookDeliveries(w.db, w.ctx, { endpointId })).toEqual([]);
  });

  it('shows the payments ledger with totals per currency and kind', async () => {
    const sailingId = await w.sailing('LXR-4', 35);
    const booking = await staffBook(w.db, w.ctx, {
      channelId: w.channels.backOffice,
      sailingId,
      market: 'international',
      cabins: [{ categoryId: w.demo.categories.STD, adults: 2 }],
      guests: lead,
      requestKey: 'ledger-booking-0001',
    });
    await recordPayment(w.db, w.ctx, {
      bookingId: booking.bookingId,
      kind: 'deposit',
      method: 'cash',
      amount: 10_000n,
      currency: booking.currency,
      reference: 'R-1',
      receivedOn: await todayInCairo(w.db),
    });
    const ledger = await listPayments(w.db, w.ctx, {});
    expect(ledger.payments[0]).toMatchObject({
      ref: booking.ref,
      amount: 10_000n,
      kind: 'deposit',
    });
    expect(ledger.totals).toContainEqual({
      currency: booking.currency,
      kind: 'deposit',
      amount: 10_000n,
    });
  });
});
