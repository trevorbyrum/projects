import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Arbytr — Atomic Gateway",
  description: "The first Atomic Gateway. Wrap any infrastructure as a governed, audited AI tool endpoint.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
