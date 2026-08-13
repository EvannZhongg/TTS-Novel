import './globals.css';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: '多播电子书测试系统',
  description: '小说章节拆分与多角色对白抽取',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
