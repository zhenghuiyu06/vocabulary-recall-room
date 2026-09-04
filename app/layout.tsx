import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "词汇回忆室｜英语间隔复习",
  description:
    "一个本地运行的英语词汇主动回忆工具，按 12H、1D、3D、7D 自动安排复习。",
};

export const viewport: Viewport = {
  themeColor: "#f5f0e6",
  colorScheme: "light",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
