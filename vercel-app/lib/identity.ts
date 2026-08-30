import { db } from '@/lib/db';
import { getProfileHtml } from '@/lib/atcoder';

export const HANDLE_PATTERN = /^[A-Za-z0-9_]{1,20}$/;
export const VERIFICATION_TTL_MS = 30 * 60 * 1000;

export const isValidHandle = (handle: string) => HANDLE_PATTERN.test(handle);
export const isValidIdentity = (identity: string) => /^[A-Za-z0-9-]{8,64}$/.test(identity);

const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function newCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `CPD-${[...bytes].map((byte) => ALPHABET[byte % ALPHABET.length]).join('')}`;
}

export async function verificationStatus(handle: string, identity: string) {
  const [verified, pending] = await Promise.all([
    db.prepare('SELECT identity, verified_at FROM verified_handles WHERE handle = ?').bind(handle).first<{ identity: string; verified_at: number }>(),
    db.prepare('SELECT code, created_at FROM verification_challenges WHERE identity = ? AND handle = ?').bind(identity, handle).first<{ code: string; created_at: number }>(),
  ]);
  const fresh = pending && Date.now() - pending.created_at < VERIFICATION_TTL_MS ? pending : null;
  return {
    handle,
    verified: verified?.identity === identity,
    claimedByOther: Boolean(verified && verified.identity !== identity),
    code: fresh?.code ?? null,
    expiresAt: fresh ? fresh.created_at + VERIFICATION_TTL_MS : null,
  };
}

/** Issues (or reuses) the one-time code the player pastes into their AtCoder affiliation. */
export async function startVerification(handle: string, identity: string) {
  const status = await verificationStatus(handle, identity);
  if (status.verified) return status;
  if (status.code) return status;
  const code = newCode();
  const createdAt = Date.now();
  await db.prepare(`INSERT INTO verification_challenges(identity, handle, code, created_at) VALUES (?, ?, ?, ?)
    ON CONFLICT(identity, handle) DO UPDATE SET code = EXCLUDED.code, created_at = EXCLUDED.created_at`)
    .bind(identity, handle, code, createdAt).run();
  return { ...status, code, expiresAt: createdAt + VERIFICATION_TTL_MS };
}

export async function confirmVerification(handle: string, identity: string) {
  const pending = await db.prepare('SELECT code, created_at FROM verification_challenges WHERE identity = ? AND handle = ?')
    .bind(identity, handle).first<{ code: string; created_at: number }>();
  if (!pending) throw new Error('인증 코드를 먼저 발급받아 주세요.');
  if (Date.now() - pending.created_at >= VERIFICATION_TTL_MS) throw new Error('인증 코드가 만료되었습니다. 다시 발급받아 주세요.');
  const html = await getProfileHtml(handle);
  if (!html.includes(pending.code)) throw new Error('프로필에서 코드를 찾지 못했습니다. Affiliation 저장 후 다시 시도해주세요.');
  await db.batch([
    db.prepare(`INSERT INTO verified_handles(handle, identity, verified_at) VALUES (?, ?, ?)
      ON CONFLICT(handle) DO UPDATE SET identity = EXCLUDED.identity, verified_at = EXCLUDED.verified_at`).bind(handle, identity, Date.now()),
    db.prepare('DELETE FROM verification_challenges WHERE identity = ? AND handle = ?').bind(identity, handle),
  ]);
  return verificationStatus(handle, identity);
}
