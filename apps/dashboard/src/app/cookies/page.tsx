import type { Metadata } from "next";
import { LegalPage } from "@/components/legal/legal-page";

export const metadata: Metadata = { title: "Cookie Notice" };

export default function CookiesPage() {
  return (
    <LegalPage
      title="Cookie Notice"
      intro="AegisPay uses only what it needs to work. There are no advertising or analytics cookies, so there is nothing to opt out of."
      sections={[
        {
          heading: "The cookie we set",
          items: ["aegis_session: keeps you signed in for up to 12 hours. It is strictly necessary, cannot be read by page scripts, and is not used for tracking."]
        },
        {
          heading: "Information stored in your browser",
          items: [
            "Your selected workspace, so you return to the same one.",
            "Whether you dismissed this notice or the getting-started checklist."
          ]
        },
        {
          heading: "Your choices",
          paragraphs: ["You can clear these in your browser settings at any time. Without the session cookie you cannot stay signed in."]
        }
      ]}
    />
  );
}
