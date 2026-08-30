'use client';

import { useState } from 'react';
import { GhostButton, PrimaryButton, Request } from '@/app/components/ui';

export type VerificationStatus = {
  handle: string;
  verified: boolean;
  claimedByOther: boolean;
  code: string | null;
  expiresAt: number | null;
};

export function VerifyPanel({ handle, identity, status, request, onStatus, onClose }: {
  handle: string;
  identity: string;
  status: VerificationStatus | null;
  request: Request;
  onStatus: (status: VerificationStatus) => void;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const call = async (action: 'start' | 'confirm') => {
    setBusy(true); setError('');
    try {
      const data = await request('/api/verify', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ action, handle, identity }),
      });
      onStatus(data as VerificationStatus);
    } catch (verifyError) {
      setError(verifyError instanceof Error ? verifyError.message : '인증에 실패했습니다.');
    } finally { setBusy(false); }
  };

  if (status?.verified) {
    return <div className="rounded-2xl border border-[#c8ff46]/25 bg-[#c8ff46]/[.06] p-5">
      <p className="font-mono text-xs tracking-[.2em] text-[#c8ff46]">HANDLE VERIFIED</p>
      <p className="mt-2 text-sm text-slate-300"><b>{handle}</b> 계정 소유가 확인되었습니다. 이제 레이팅이 걸린 매치를 할 수 있습니다.</p>
      <p className="mt-2 text-xs text-slate-500">Affiliation에 넣은 인증 코드는 지워도 됩니다.</p>
      <GhostButton className="mt-4" onClick={onClose}>닫기</GhostButton>
    </div>;
  }

  return <div className="rounded-2xl border border-white/10 bg-[#090e1b] p-5">
    <p className="font-mono text-xs tracking-[.2em] text-[#c8ff46]">HANDLE OWNERSHIP</p>
    <h3 className="mt-2 text-lg font-bold">{handle} 계정이 본인인지 확인합니다</h3>
    <p className="mt-2 text-sm leading-6 text-slate-400">AtCoder 프로필의 <b>Affiliation(소속)</b> 칸에 아래 코드를 넣고 저장한 뒤 확인을 누르세요. 비밀번호는 필요 없고, 확인 후에는 지워도 됩니다.</p>
    {status?.claimedByOther && <p className="mt-3 rounded-xl border border-amber-400/20 bg-amber-400/10 px-4 py-3 text-xs text-amber-300">이미 다른 브라우저에서 인증된 핸들입니다. 여기서 다시 인증하면 소유가 이 브라우저로 옮겨집니다.</p>}

    {status?.code
      ? <>
        <div className="mt-4 flex items-center justify-between gap-3 rounded-xl border border-[#c8ff46]/30 bg-[#c8ff46]/5 px-4 py-3">
          <code className="font-mono text-lg font-bold tracking-widest text-[#c8ff46]">{status.code}</code>
          <button type="button" onClick={() => navigator.clipboard?.writeText(status.code ?? '')} className="rounded-lg border border-white/10 px-3 py-1.5 text-xs text-slate-300 hover:border-white/30">복사</button>
        </div>
        <ol className="mt-4 space-y-1.5 text-xs leading-5 text-slate-500">
          <li>1. <a className="text-slate-300 underline" href="https://atcoder.jp/settings" target="_blank" rel="noreferrer">atcoder.jp/settings ↗</a> 를 엽니다.</li>
          <li>2. Affiliation 칸에 위 코드를 붙여넣고 Update 를 누릅니다.</li>
          <li>3. 아래 확인 버튼을 누릅니다.</li>
        </ol>
        <PrimaryButton className="mt-5 py-3.5 text-sm" disabled={busy} onClick={() => void call('confirm')}>{busy ? '프로필 확인 중…' : '인증 확인'}</PrimaryButton>
      </>
      : <PrimaryButton className="mt-5 py-3.5 text-sm" disabled={busy} onClick={() => void call('start')}>{busy ? '코드 발급 중…' : '인증 코드 받기'}</PrimaryButton>}

    {error && <p role="alert" className="mt-3 text-xs text-red-300">{error}</p>}
    <GhostButton className="mt-3" onClick={onClose}>나중에 하기</GhostButton>
  </div>;
}
