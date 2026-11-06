import { CookieNotice } from "@/components/legal/cookie-notice";
import type { Metadata, Viewport } from "next";
import { connection } from "next/server";
import { IBM_Plex_Mono, Instrument_Sans, Instrument_Serif } from "next/font/google";
import "./globals.css";
import { AppProviders } from "@/components/providers/app-providers";
import { cn } from "@/lib/utils";

const instrumentSans = Instrument_Sans({
  subsets: ["latin"],
  variable: "--font-instrument-sans",
  display: "swap"
});

const instrumentSerif = Instrument_Serif({
  subsets: ["latin"],
  weight: "400",
  style: ["normal", "italic"],
  variable: "--font-instrument-serif",
  display: "swap"
});

const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  variable: "--font-ibm-plex-mono",
  display: "swap"
});

export const metadata: Metadata = {
  title: {
    default: "AegisPay — Ledger, risk and approvals for every payment",
    template: "%s · AegisPay"
  },
  description:
    "A workspace for collections, transfers, maker-checker approvals, reconciliation, risk review and audit evidence. Your bank moves the money; AegisPay keeps the proof.",
  applicationName: "AegisPay",
  keywords: ["payments", "ledger", "reconciliation", "fraud", "webhooks", "fintech", "sandbox"],
  openGraph: {
    title: "AegisPay — Ledger, risk and approvals for every payment",
    description:
      "Run collections, approvals and reconciliation on one double-entry ledger.",
    type: "website"
  },
  robots: { index: true, follow: true }
};

export const viewport: Viewport = {
  themeColor: "#080c18",
  colorScheme: "light"
};

export default async function RootLayout({
  children
}: Readonly<{ children: React.ReactNode }>) {
  // Render per request so Next.js can apply the CSP nonce set in src/proxy.ts.
  await connection();
  return (
    <html
      lang="en"
      data-scroll-behavior="smooth"
      className={cn(
        instrumentSans.variable,
        instrumentSerif.variable,
        plexMono.variable,
        "font-sans"
      )}
    >
      <body
        suppressHydrationWarning
        className="min-h-screen bg-background font-sans text-foreground antialiased"
      >
        <AppProviders>
          {children}
          <CookieNotice />
        </AppProviders>
      </body>
    </html>
  );
}
