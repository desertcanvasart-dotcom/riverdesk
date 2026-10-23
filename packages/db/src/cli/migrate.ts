import { migrate } from '../migrate';
import { adminOptions } from './env';

const { adminUrl, ssl, passwords } = adminOptions();
const applied = await migrate({ adminUrl, ssl, passwords, log: (line) => console.log(line) });
console.log(applied.length ? `applied ${applied.length} migration(s)` : 'database up to date');
