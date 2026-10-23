import { afterAll } from 'vitest';
import { closeOwner } from './env';
import { operatorsCreatedHere } from './fixtures';
import { checkInvariantsEverywhere } from './invariants';

// Registered as a Vitest setup file: runs after every integration test file (rule 6) and fails
// the file if vs.check_invariants() returns any row for an operator this file created. Files run
// in parallel, and some break an invariant on purpose to prove it is detected, so another file's
// operators are that file's business (the nightly job still checks every operator).
afterAll(async () => {
  try {
    const mine = operatorsCreatedHere();
    const violations = (await checkInvariantsEverywhere()).filter((v) => mine.has(v.operator_id));
    if (violations.length > 0) {
      throw new Error(
        `check_invariants() returned ${violations.length} violation(s):\n${JSON.stringify(violations, null, 2)}`,
      );
    }
  } finally {
    await closeOwner();
  }
});
