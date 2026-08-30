import { NextRequest, NextResponse } from 'next/server';
import { guard } from '@/lib/http';
import { isValidHandle } from '@/lib/identity';
import { ensureTables } from '@/lib/match-db';
import { getLeaderboard } from '@/lib/profile-db';

// pg needs the Node runtime, and every handler reads live request state.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function handleGet(request: NextRequest) {
  await ensureTables();
  const handle = request.nextUrl.searchParams.get('handle')?.trim() ?? '';
  return NextResponse.json(await getLeaderboard(isValidHandle(handle) ? handle : null));
}

export const GET = (request: NextRequest) => guard(() => handleGet(request));
