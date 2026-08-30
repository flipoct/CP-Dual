import { NextRequest, NextResponse } from 'next/server';
import { getPlayer } from '@/lib/atcoder';

// pg needs the Node runtime, and every handler reads live request state.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  const handle = request.nextUrl.searchParams.get('handle')?.trim() ?? '';
  if (!/^[A-Za-z0-9_]{1,20}$/.test(handle)) return NextResponse.json({ error: '닉네임 형식을 확인해주세요.' }, { status: 400 });
  try { return NextResponse.json(await getPlayer(handle)); }
  catch (error) { return NextResponse.json({ error: error instanceof Error ? error.message : '확인에 실패했습니다.' }, { status: 404 }); }
}
