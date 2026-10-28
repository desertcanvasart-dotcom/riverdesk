import { getReceiptAttachment, type EngineContext } from '@vs/engine';
import { isDomainError } from '@vs/contracts';
import { backofficeDb } from '../../../../server/db';
import { can } from '../../../../server/permissions';
import { getSession } from '../../../../server/session';

export const dynamic = 'force-dynamic';

/** A receipt's photo or PDF: same session, MFA and permission checks as every procedure. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^[0-9a-f-]{36}$/.test(id)) return new Response('Not found', { status: 404 });
  const session = await getSession();
  const staff = session?.staff;
  if (!staff) return new Response('Unauthorized', { status: 401 });
  if (session.needsMfa) return new Response('MFA required', { status: 403 });
  if (!can(staff.role, 'finance')) return new Response('Forbidden', { status: 403 });
  const ctx: EngineContext = {
    operatorId: staff.operatorId,
    actor: { type: 'staff', id: staff.staffUserId },
  };
  try {
    const file = await getReceiptAttachment(backofficeDb(), ctx, { receiptId: id });
    return new Response(new Uint8Array(file.content), {
      headers: {
        'Content-Type': file.contentType,
        'Content-Disposition': `inline; filename="${file.filename.replace(/[^\w.-]/g, '_')}"`,
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    });
  } catch (error) {
    if (isDomainError(error, 'NOT_FOUND')) return new Response('Not found', { status: 404 });
    throw error;
  }
}
