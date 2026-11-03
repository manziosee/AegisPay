import { SiteHeader } from "@/components/marketing/site-header";
import { Hero } from "@/components/marketing/hero";
import { TransactionStory } from "@/components/marketing/transaction-story";
import { PlatformRows } from "@/components/marketing/platform-rows";
import { IntelligenceSection } from "@/components/marketing/intelligence-section";
import { DeveloperSection } from "@/components/marketing/developer-section";
import {
  CtaSection,
  SandboxSection,
  SiteFooter
} from "@/components/marketing/closing-sections";

export default function LandingPage() {
  return (
    <div className="min-h-screen overflow-x-clip bg-paper">
      <SiteHeader />
      <main>
        <Hero />
        <TransactionStory />
        <PlatformRows />
        <IntelligenceSection />
        <DeveloperSection />
        <SandboxSection />
        <CtaSection />
      </main>
      <SiteFooter />
    </div>
  );
}
