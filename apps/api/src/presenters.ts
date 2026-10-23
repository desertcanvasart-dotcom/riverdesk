import {
  eventJson,
  type BookingView,
  type ChannelAvailability,
  type EventView,
  type PortView,
  type Quote,
  type SailingView,
} from '@vs/engine';

/** Engine results → the shapes in packages/contracts/openapi.yaml (snake_case, Money objects). */

export const money = (amount: bigint | string | number, currency: string) => ({
  amount: Number(amount),
  currency,
});

const port = (p: PortView) => ({ code: p.code, name: p.name });

export function sailing(s: SailingView) {
  return {
    id: s.id,
    vessel_id: s.vesselId,
    pattern_code: s.patternCode,
    name: s.name,
    embark_port: port(s.embarkPort),
    disembark_port: port(s.disembarkPort),
    embark_date: s.embarkDate,
    disembark_date: s.disembarkDate,
    nights: s.nights,
    status: s.status,
    legs: s.legs.map((l) => ({
      id: l.id,
      from_port: port(l.fromPort),
      to_port: port(l.toPort),
      depart_date: l.departDate,
      arrive_date: l.arriveDate,
    })),
  };
}

export function availability(a: ChannelAvailability) {
  return {
    as_of: a.asOf.toISOString(),
    sailings: a.sailings.map((s) => ({
      sailing_id: s.sailingId,
      pattern_code: s.patternCode,
      embark_date: s.embarkDate,
      disembark_date: s.disembarkDate,
      nights: s.nights,
      categories: s.categories.map((c) => ({
        category_id: c.categoryId,
        code: c.code,
        status: c.status,
        free: c.free,
        from_price: c.fromPrice ? money(c.fromPrice.amount, c.fromPrice.currency) : null,
      })),
    })),
  };
}

type Policies = Record<string, unknown> & { rate_plan?: Record<string, unknown> };

export function quote(q: Quote) {
  const policies = q.policies as Policies;
  const { rate_plan: ratePlan, contract: _contract, amendment_fees: _fees, ...rest } = policies;
  return {
    id: q.id,
    sailing_id: q.sailingId,
    rate_plan: ratePlan,
    currency: q.currency,
    cabins: (q.cabins as { categoryId: string; adults: number; childAges: number[] }[]).map(
      (c) => ({ category_id: c.categoryId, adults: c.adults, child_ages: c.childAges }),
    ),
    lines: q.lines.map((l) => ({
      cabin: l.cabin,
      kind: l.kind,
      label: l.label,
      basis: l.basis ?? null,
      age: l.age ?? null,
      unit_amount: Number(l.unitAmount),
      quantity: l.quantity,
      amount: Number(l.amount),
      in_total: l.inTotal,
    })),
    total: money(q.total, q.currency),
    net_total: money(q.netTotal, q.currency),
    policies: rest,
    expires_at: q.expiresAt.toISOString(),
  };
}

export function hold(h: {
  id: string;
  kind: string;
  status: string;
  expires_at: Date;
  quote_id: string;
}) {
  return {
    id: h.id,
    kind: h.kind,
    status: h.status,
    expires_at: h.expires_at.toISOString(),
    quote_id: h.quote_id,
  };
}

export function booking(b: BookingView, extra: { reason?: string } = {}) {
  return {
    ref: b.ref,
    channel_ref: b.channelRef,
    status: b.status,
    reason: extra.reason ?? null,
    payment_status: b.paymentStatus,
    revision: b.revision,
    sailing: sailing(b.sailing),
    cabins: b.cabins.map((c) => ({
      index: c.index,
      category_code: c.categoryCode,
      adults: c.adults,
      child_ages: c.childAges,
      guests: c.guests.map((g) => ({
        first_name: g.firstName,
        last_name: g.lastName,
        lead: g.lead,
      })),
    })),
    total: money(b.total, b.currency),
    fees: money(b.fees, b.currency),
    amount_paid: money(b.amountPaid, b.currency),
    payments_due: b.paymentsDue.map((p) => ({
      kind: p.kind,
      amount: money(p.amount, b.currency),
      due_date: p.dueDate,
    })),
    penalty: b.penalty === null ? null : money(b.penalty, b.currency),
    open_offer: b.openOffer
      ? {
          id: b.openOffer.id,
          sailing_id: b.openOffer.sailingId,
          expires_at: b.openOffer.expiresAt.toISOString(),
          total: money(b.openOffer.total, b.openOffer.currency),
        }
      : null,
    request_expires_at: b.requestExpiresAt?.toISOString() ?? null,
    hold_expires_at: b.holdExpiresAt?.toISOString() ?? null,
    created_at: b.createdAt.toISOString(),
  };
}

export const event = (e: EventView) => eventJson(e);
