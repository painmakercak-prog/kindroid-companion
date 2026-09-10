import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Companion · Your space to talk",
  description: "Talk to your Kindroid with continuous listening and your Cartesia voice.",
  other: {
    "codex-preview": "development",
  },
  icons: {
    icon: "/favicon.svg",
    shortcut: "/favicon.svg",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className="antialiased">{children}</body>
    </html>
  );
}
