import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/legal-page";

export const metadata: Metadata = { title: "Privacy Policy" };

export default function PrivacyPage() {
  return (
    <LegalPage
      title="Privacy Policy"
      intro="This policy explains what personal data AegisPay handles, why, who it is shared with, and the choices you have."
      sections={[
        {
          heading: "What we collect",
          items: [
            "Account details: your name, email address, a one-way hash of your password, and your authenticator secret (encrypted) if you turn on two-step sign-in.",
            "Workspace details: names, country, members and their roles.",
            "Business records you add: customers, payments, statements, beneficiaries, approvals, notes and audit history.",
            "Security data: IP address, browser or device description, and sign-in times, used to protect accounts and show your active sessions."
          ]
        },
        {
          heading: "Why we use it",
          items: [
            "To provide the service you signed up for and keep it secure (for example rate limits, sessions and audit logs).",
            "To send emails you need: confirmations, password resets, invitations and approval requests. We do not send marketing email without asking.",
            "To meet legal obligations and to respond to your support requests."
          ]
        },
        {
          heading: "Who we share it with",
          paragraphs: ["We do not sell personal data. We use these service providers to run AegisPay, and only for that purpose:"],
          items: [
            "Fly.io: hosting of the API and database.",
            "Upstash: rate-limit counters.",
            "Netlify: hosting of the website.",
            "Brevo: sending email.",
            "Chat apps or webhook addresses that a workspace connects itself receive the notifications that workspace chooses."
          ]
        },
        {
          heading: "Where data is stored",
          paragraphs: ["The database runs in Paris, France. Some providers may process data in other countries under their own safeguards."]
        },
        {
          heading: "How long we keep it",
          items: [
            "Active account data: for as long as the account exists.",
            "Ended sessions: about 30 days after they expire or are revoked.",
            "Financial and audit records: kept with their workspace, because businesses are usually required to retain them. After you delete your account they no longer show your name or email."
          ]
        },
        {
          heading: "Your rights",
          paragraphs: [
            "Depending on where you live (for example under the GDPR or the data-protection laws of Rwanda or Kenya), you may have rights to access, correct, export or delete your data, and to object or complain to your data-protection authority.",
            "You can export your data and delete your account yourself under Settings. For anything else, contact us at the address below."
          ]
        },
        {
          heading: "Security",
          paragraphs: ["Passwords and tokens are stored as hashes, secrets are encrypted, sessions use protected cookies, and audit logs are tamper-evident. No system is perfectly secure; please tell us immediately if you suspect a problem."]
        },
        {
          heading: "Children",
          paragraphs: ["AegisPay is for business use and is not intended for children."]
        }
      ]}
    />
  );
}
