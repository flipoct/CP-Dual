import { NextRequest, NextResponse } from 'next/server';
import { isValidHandle } from '@/lib/identity';
import { ensureTables } from '@/lib/match-db';
import { getProfile } from '@/lib/profile-db';

// pg needs the Node runtime, and every handler reads live request state.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  await ensureTables();
  const handle = request.nextUrl.searchParams.get('handle')?.trim() ?? '';
  if (!isValidHandle(handle)) return NextResponse.json({ error: '닉네임 형식을 확인해주세요.' }, { status: 400 });
  try {
    return NextResponse.json(await getProfile(handle));
  } catch (error) {
    return NextResponse.json({ error: error instanceof Error ? error.message : '전적을 불러오지 못했습니다.' }, { status: 500 });
  }
}
