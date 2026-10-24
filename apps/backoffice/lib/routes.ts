/** Route helpers for the screen; the engine checks the same rules again on save. */
export interface EditStop {
  portId: string;
  dayOffset: number;
  /** Guests can board and leave here (both flags in the engine). */
  boarding: boolean;
}

/** The departures one cycle makes: from each boarding stop to the next one. */
export function routeLegs(stops: EditStop[]): { from: string; to: string; nights: number }[] {
  const boarding = stops.filter((s) => s.boarding);
  return boarding.slice(1).map((to, i) => ({
    from: boarding[i]!.portId,
    to: to.portId,
    nights: to.dayOffset - boarding[i]!.dayOffset,
  }));
}

export interface LeaveOption {
  seq: number;
  /** 0 = this cycle; 1 = the next one (e.g. a full week from Aswan back to Aswan). */
  offset: number;
  dayOffset: number;
  nights: number;
}

/**
 * Where guests who board at `embarkSeq` can leave: a later boarding stop in the same cycle, or
 * one in the next cycle up to the stop they boarded at. Stop 0 of the next cycle is the last stop
 * of this one, so it is not offered twice.
 */
export function leaveOptions(
  stops: { dayOffset: number; disembarkAllowed: boolean }[],
  cycleDays: number,
  embarkSeq: number,
): LeaveOption[] {
  const from = stops[embarkSeq];
  if (!from) return [];
  const options: LeaveOption[] = [];
  stops.forEach((stop, seq) => {
    if (seq > embarkSeq && stop.disembarkAllowed)
      options.push({
        seq,
        offset: 0,
        dayOffset: stop.dayOffset,
        nights: stop.dayOffset - from.dayOffset,
      });
  });
  stops.forEach((stop, seq) => {
    if (seq > 0 && seq <= embarkSeq && stop.disembarkAllowed)
      options.push({
        seq,
        offset: 1,
        dayOffset: cycleDays + stop.dayOffset,
        nights: cycleDays + stop.dayOffset - from.dayOffset,
      });
  });
  return options.filter((o) => o.nights > 0);
}

/** A starting code for an itinerary, e.g. LXR-4. */
export function itineraryCode(portCode: string, nights: number): string {
  return `${portCode}-${nights}`.toUpperCase().slice(0, 24);
}
