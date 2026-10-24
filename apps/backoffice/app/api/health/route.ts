import { pingDatabase } from '@vs/engine';
import { backofficeDb } from '../../../server/db';

export const dynamic = 'force-dynamic';

/** Railway's health check: the app answers, and says whether the database does. */
export async function GET() {
  const database = await pingDatabase(backofficeDb()).catch(() => false);
  return Response.json(
    { status: database ? 'ok' : 'unavailable', database },
    { status: database ? 200 : 503 },
  );
}
