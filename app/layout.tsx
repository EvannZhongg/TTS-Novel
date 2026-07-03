import './globals.css';
import type { Metadata } from 'next';
import Script from 'next/script';

export const metadata: Metadata = {
  title: 'TTS Pipeline 全流程可视化',
  description: 'Next.js single-app TTS pipeline inspector',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>
        {children}
        <Script src="/app.js" strategy="afterInteractive" />
      </body>
    </html>
  );
}
