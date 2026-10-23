import { owner } from './env';

export interface InvariantViolation {
  operator_id: string;
  invariant: number;
  entity: string;
  entity_id: string | null;
  detail: unknown;
}

/** Runs vs.check_invariants() as the owner, so it covers every operator. */
export async function checkInvariantsEverywhere(): Promise<InvariantViolation[]> {
  const { rows } = await owner().query<InvariantViolation>('select * from vs.check_invariants()');
  return rows;
}
