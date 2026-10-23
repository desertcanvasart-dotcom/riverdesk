// The only write path (rule 1). Apps call these functions; they never query the database.
export { openDatabase, type VsDatabase } from '@vs/db';
export * from './audit';
export * from './invariants';
export * from './staff';
