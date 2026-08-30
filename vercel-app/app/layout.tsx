import type { Metadata } from 'next';
import { Geist, Geist_Mono } from 'next/font/google';
import './globals.css';

const geistSans = Geist({
  variable: '--font-geist-sans',
  subsets: ['latin'],
});

const geistMono = Geist_Mono({
  variable: '--font-geist-mono',
  subsets: ['latin'],
});

const deploymentOrigin = process.env.VERCEL_PROJECT_PRODUCTION_URL
  ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
  : 'https://cp-dual-atcoder.jiyecom1.chatgpt.site';

export const metadata: Metadata = {
  metadataBase: new URL(deploymentOrigin),
  title: 'CP Dual — AtCoder 1v1',
  description: '실력대에 맞는 AtCoder 문제로 즐기는 실시간 1대1 승부',
  openGraph: {
    title: 'CP Dual — AtCoder 1v1',
    description: '문제 하나. 승자는 한 명.',
    images: [{ url: new URL('/og.png', deploymentOrigin).toString(), width: 1745, height: 909, alt: 'CP Dual — 문제 하나. 승자는 한 명.' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'CP Dual — AtCoder 1v1',
    description: '문제 하나. 승자는 한 명.',
    images: [new URL('/og.png', deploymentOrigin).toString()],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="ko">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
