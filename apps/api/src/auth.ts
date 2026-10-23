import { jwtVerify, SignJWT } from 'jose';
import { DomainError } from '@vs/contracts';

export const TOKEN_TTL_SECONDS = 900;

export interface ChannelPrincipal {
  apiClientId: string;
  operatorId: string;
  channelId: string;
}

/** HS256 access token for one API client (15 minutes). */
export async function issueToken(secret: Uint8Array, principal: ChannelPrincipal): Promise<string> {
  return new SignJWT({ op: principal.operatorId, ch: principal.channelId })
    .setProtectedHeader({ alg: 'HS256' })
    .setSubject(principal.apiClientId)
    .setIssuedAt()
    .setExpirationTime(`${TOKEN_TTL_SECONDS}s`)
    .setAudience('vessel-system-channel-api')
    .sign(secret);
}

export async function verifyToken(
  secret: Uint8Array,
  header: string | undefined,
): Promise<ChannelPrincipal> {
  const token = header?.startsWith('Bearer ') ? header.slice(7) : undefined;
  if (!token) throw new DomainError('UNAUTHENTICATED', { message: 'Missing bearer token' });
  try {
    const { payload } = await jwtVerify(token, secret, {
      algorithms: ['HS256'],
      audience: 'vessel-system-channel-api',
    });
    if (
      typeof payload.sub !== 'string' ||
      typeof payload.op !== 'string' ||
      typeof payload.ch !== 'string'
    )
      throw new Error('claims');
    return { apiClientId: payload.sub, operatorId: payload.op, channelId: payload.ch };
  } catch {
    throw new DomainError('UNAUTHENTICATED', { message: 'Invalid or expired token' });
  }
}
