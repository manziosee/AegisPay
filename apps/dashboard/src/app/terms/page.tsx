import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/legal-page";

export const metadata: Metadata = { title: "Terms of Service" };

export default function TermsPage() {
  return (
    <LegalPage
      title="Terms of Service"
      intro="These terms apply when you use AegisPay, a software service for recording, approving and reconciling payments. By creating an account you agree to them."
      sections={[
        {
          heading: "What AegisPay is, and is not",
          paragraphs: [
            "AegisPay is record-keeping and workflow software. It is not a bank, payment institution or money transmitter. It does not hold your money or send payments. Your bank or payment provider moves funds; AegisPay records and checks that activity.",
            "Practice workspaces contain simulated money. Balances in a live workspace are ledger records built from what you import and confirm; they are not deposits or a claim on funds. Your bank statements remain the record of what actually settled."
          ]
        },
        {
          heading: "Your account",
          items: [
            "Give accurate details and keep your password and authenticator codes private.",
            "You are responsible for what happens under your account, API keys and workspaces, including who you invite and the roles you give them.",
            "You must be old enough and authorised to act for any business or organisation you add."
          ]
        },
        {
          heading: "Acceptable use",
          items: [
            "Do not use AegisPay to break the law, launder money, finance terrorism, or evade sanctions.",
            "Do not store full card numbers, card security codes, or banking passwords.",
            "Do not attack, overload, or try to access data that is not yours."
          ]
        },
        {
          heading: "Your data",
          paragraphs: [
            "Your business records stay yours. You can export them at any time from Settings. Our Privacy Policy explains how personal data is handled."
          ]
        },
        {
          heading: "Your responsibilities for financial decisions",
          paragraphs: [
            "Risk rules, approvals and reconciliation help you make decisions; they do not replace your own judgement, accounting, or legal and tax obligations. Check important results against your bank records."
          ]
        },
        {
          heading: "Availability and changes",
          paragraphs: [
            "AegisPay is an early-stage service, provided as it is, and may change. We work to keep it available and your data safe, but cannot promise uninterrupted service. Keep your own copies of records you are legally required to retain."
          ]
        },
        {
          heading: "Limits of liability",
          paragraphs: [
            "To the extent the law allows, we are not liable for indirect losses, or for losses caused by payments, decisions or errors in data you supply. Nothing here limits rights that cannot be limited by law."
          ]
        },
        {
          heading: "Ending your use",
          paragraphs: [
            "You can delete your account in Settings at any time. We may suspend accounts that break these terms or put others at risk. Financial and audit records may be kept where the law or a workspace's other members require it."
          ]
        }
      ]}
    />
  );
}
