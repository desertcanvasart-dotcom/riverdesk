import { addDays, type BusinessDate } from '@vs/shared';

/** Pure schedule arithmetic: which legs a template produces, and which legs a pattern sells. */

export interface PlanStop {
  seq: number;
  portId: string;
  dayOffset: number;
  boarding: boolean;
}

export interface PlannedLeg {
  cycleStart: BusinessDate;
  fromSeq: number;
  toSeq: number;
  fromPortId: string;
  toPortId: string;
  departDate: BusinessDate;
  arriveDate: BusinessDate;
}

export interface DateRange {
  from: BusinessDate;
  to: BusinessDate;
}

/** Cycle start dates from validFrom, every cycleDays, up to validTo and until (inclusive). */
export function cycleStarts(
  validFrom: BusinessDate,
  validTo: BusinessDate | null,
  cycleDays: number,
  until: BusinessDate,
): BusinessDate[] {
  const starts: BusinessDate[] = [];
  for (
    let start = validFrom;
    start <= until && (!validTo || start <= validTo);
    start = addDays(start, cycleDays)
  ) {
    starts.push(start);
  }
  return starts;
}

/** A leg's nights [depart, arrive) overlap a dry-dock range of whole days [from, to]. */
export function overlapsRange(
  departDate: BusinessDate,
  arriveDate: BusinessDate,
  range: DateRange,
): boolean {
  return departDate <= range.to && arriveDate > range.from;
}

/**
 * Legs between consecutive boarding stops for every cycle, keeping legs that depart between
 * `today` and `until` and that miss every dry-dock range.
 */
export function planLegs(options: {
  stops: PlanStop[];
  validFrom: BusinessDate;
  validTo: BusinessDate | null;
  cycleDays: number;
  today: BusinessDate;
  until: BusinessDate;
  dryDocks: DateRange[];
}): PlannedLeg[] {
  const boarding = options.stops.filter((stop) => stop.boarding).sort((a, b) => a.seq - b.seq);
  const legs: PlannedLeg[] = [];
  for (const cycleStart of cycleStarts(
    options.validFrom,
    options.validTo,
    options.cycleDays,
    options.until,
  )) {
    for (let i = 0; i + 1 < boarding.length; i += 1) {
      const from = boarding[i]!;
      const to = boarding[i + 1]!;
      const departDate = addDays(cycleStart, from.dayOffset);
      const arriveDate = addDays(cycleStart, to.dayOffset);
      if (departDate < options.today || departDate > options.until) continue;
      if (options.dryDocks.some((range) => overlapsRange(departDate, arriveDate, range))) continue;
      legs.push({
        cycleStart,
        fromSeq: from.seq,
        toSeq: to.seq,
        fromPortId: from.portId,
        toPortId: to.portId,
        departDate,
        arriveDate,
      });
    }
  }
  return legs;
}

export interface ChainLeg {
  id: string;
  cycleStart: BusinessDate;
  fromSeq: number;
  toSeq: number;
  status: string;
}

/**
 * The ordered legs a pattern sells for one cycle start: from the embark stop in that cycle to the
 * disembark stop `cycleOffset` cycles later, crossing into the next cycle after the last stop.
 * Returns null if any leg is missing (not generated yet, dry dock) or not open.
 */
export function chainLegs(options: {
  cycleStart: BusinessDate;
  cycleDays: number;
  lastSeq: number;
  embarkSeq: number;
  disembarkSeq: number;
  cycleOffset: number;
  legs: Map<string, ChainLeg>;
}): ChainLeg[] | null {
  const chain: ChainLeg[] = [];
  let cycle = options.cycleStart;
  let cycleIndex = 0;
  let fromSeq = options.embarkSeq;
  for (let guard = 0; guard < 200; guard += 1) {
    const leg = options.legs.get(`${cycle}|${fromSeq}`);
    if (!leg || leg.status !== 'open') return null;
    chain.push(leg);
    if (cycleIndex === options.cycleOffset && leg.toSeq === options.disembarkSeq) return chain;
    if (cycleIndex === options.cycleOffset && leg.toSeq > options.disembarkSeq) return null;
    if (leg.toSeq === options.lastSeq) {
      cycle = addDays(cycle, options.cycleDays);
      cycleIndex += 1;
      fromSeq = 0;
      if (cycleIndex > options.cycleOffset) return null;
    } else {
      fromSeq = leg.toSeq;
    }
  }
  return null;
}
