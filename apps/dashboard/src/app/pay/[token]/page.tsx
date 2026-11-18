import type { Metadata } from "next";
import { PublicInvoiceView } from "@/components/invoices/public-invoice";

export const metadata: Metadata = {
  title: "Invoice",
  // The link is the only key to this page: keep it out of search engines and
  // out of the Referer header of any link clicked from it.
  robots: { index: false, follow: false },
  referrer: "no-referrer"
};

export default async function PayPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return <PublicInvoiceView token={token} />;
}
