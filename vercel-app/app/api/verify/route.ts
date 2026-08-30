import { NextRequest, NextResponse } from 'next/server';
import { confirmVerification, isValidHandle, isValidIdentity, startVerification, verificationStatus } from '@/lib/identity';
import { ensureTables } from '@/lib/match-db';

// pg needs the Node runtime, and every handler reads live request state.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const badRequest = (message: string) => NextResponse.json({ error: message }, { status: 400 });

export async function GET(request: NextRequest) {
  await ensureTables();
  const handle = request.nextUrl.searchParams.get('handle')?.trim() ?? '';
  const identity = request.nextUrl.searchParams.get('identity')?.trim() ?? '';
  if (!isValidHandle(handle) || !isValidIdentity(identity)) return badRequest('잘못된 요청입니다.');
  return NextResponse.json(await verificationStatus(handle, identity));
}

export async function POST(request: NextRequest) {
  await ensureTables();
  const body = await request.json() as { action?: string; handle?: string; identity?: string };
  const handle = body.handle?.trim() ?? '';
  const identity = body.identity?.trim() ?? '';
  if (!isValidHandle(handle) || !isValidIdentity(identity)) return badRequest('잘못된 요청입니다.');
  try {
    if (body.action === 'start') return NextResponse.json(await startVerification(handle, identity));
    if (body.action === 'confirm') return NextResponse.json(await confirmVerification(handle, identity));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '인증에 실패했습니다.' }, { status: 400 });
  }
  return badRequest('지원하지 않는 요청입니다.');
}
