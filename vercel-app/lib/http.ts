import { NextResponse } from 'next/server';

/**
 * Turns a thrown error into a JSON body. Without this an expected failure — no
 * unsolved problem in the picked range, AtCoder unreachable — reaches the client
 * as an empty 500 that the UI can only report as "매칭 서버 오류 (500)".
 */
export async function guard(run: () => Promise<Response>) {
  try {
    return await run();
  } catch (error) {
    const message = error instanceof Error ? error.message : '요청을 처리하지 못했습니다.';
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
