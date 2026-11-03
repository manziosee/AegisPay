"use client";

import { useState } from "react";
import { Check, Copy, ExternalLink } from "lucide-react";
import { toast } from "sonner";
import { Reveal } from "./reveal";
import { codeSamples, developerEndpoints } from "@/lib/marketing";
import { cn } from "@/lib/utils";

const tabs = [
  { id: "request", label: "Request" },
  { id: "response", label: "Response" },
  { id: "envelope", label: "Webhook envelope" }
] as const;

type TabId = (typeof tabs)[number]["id"];

export function DeveloperSection() {
  const [tab, setTab] = useState<TabId>("request");
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(codeSamples[tab]);
      setCopied(true);
      toast.success("Copied to clipboard");
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      toast.error("Clipboard access is unavailable in this browser.");
    }
  };

  return (
    <section id="developers" className="scroll-mt-24 border-t border-white/10 bg-ink-950">
      <div className="mx-auto w-full max-w-[1240px] px-5 py-20 sm:px-8 lg:py-24">
        <Reveal className="flex flex-col gap-4 md:flex-row md:items-end md:justify-between">
          <div>
            <h2 className="font-display text-[38px] leading-[1.05] tracking-[-0.03em] text-on-night sm:text-[46px]">
              Developer surface
            </h2>
            <p className="mt-4 max-w-[520px] text-[15px] leading-[1.7] text-on-night-muted">
              Authenticated JSON endpoints for the financial record, with idempotency on writes and
              signed webhook deliveries. The OpenAPI contract in the repository is the source of
              truth.
            </p>
          </div>
          <a
            href="https://github.com/manziosee/AegisPay/blob/main/docs/api/openapi.yaml"
            className="inline-flex items-center gap-1.5 text-[12.5px] text-on-night-muted transition-colors hover:text-white"
            target="_blank"
            rel="noreferrer"
          >
            Read the API contract
            <ExternalLink className="h-3.5 w-3.5" />
          </a>
        </Reveal>

        <div className="mt-10 grid min-w-0 gap-8 lg:grid-cols-[0.85fr_1.15fr] lg:gap-12">
          <Reveal className="min-w-0">
            <ul className="divide-y divide-white/10 border-y border-white/10">
              {developerEndpoints.map((endpoint) => (
                <li key={endpoint.path} className="py-4">
                  <div className="flex items-center gap-2.5">
                    <span
                      className={cn(
                        "rounded border px-1.5 py-0.5 font-mono text-[9.5px] font-medium",
                        endpoint.method === "GET"
                          ? "border-mint/25 bg-mint/10 text-mint"
                          : "border-primary/30 bg-primary/15 text-[#b3abff]"
                      )}
                    >
                      {endpoint.method}
                    </span>
                    <span className="break-all font-mono text-[12px] text-on-night/90">
                      {endpoint.path}
                    </span>
                  </div>
                  <p className="mt-1.5 text-[12px] leading-relaxed text-on-night-muted">
                    {endpoint.description}
                  </p>
                </li>
              ))}
            </ul>
            <p className="mt-4 font-mono text-[10.5px] leading-relaxed text-on-night-muted/70">
              Webhook requests carry X-AegisPay-Event-ID, X-AegisPay-Timestamp and
              X-AegisPay-Signature: v1=&lt;HMAC-SHA256&gt;.
            </p>
          </Reveal>

          <Reveal delay={0.08} className="min-w-0">
            <div className="min-w-0 overflow-hidden rounded-xl border border-white/12 bg-[#060a14]">
              <div className="flex items-center justify-between gap-3 border-b border-white/10 px-3 py-2">
                <div role="tablist" aria-label="API example" className="flex gap-1">
                  {tabs.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      role="tab"
                      aria-selected={tab === item.id}
                      onClick={() => setTab(item.id)}
                      className={cn(
                        "rounded-md px-2.5 py-1.5 text-[11.5px] transition-colors",
                        tab === item.id
                          ? "bg-white/10 text-on-night"
                          : "text-on-night-muted hover:text-on-night"
                      )}
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
                <button
                  type="button"
                  onClick={() => void copy()}
                  className="inline-flex items-center gap-1.5 rounded-md border border-white/10 px-2 py-1.5 text-[11px] text-on-night-muted transition-colors hover:text-on-night"
                >
                  {copied ? <Check className="size-3.5 text-mint" /> : <Copy className="size-3.5" />}
                  {copied ? "Copied" : "Copy"}
                </button>
              </div>
              <pre
                role="tabpanel"
                className="min-h-[330px] overflow-x-auto p-5 font-mono text-[11.5px] leading-[1.85] text-on-night/85"
              >
                {codeSamples[tab]}
              </pre>
              <div className="flex items-center justify-between gap-3 border-t border-white/10 px-4 py-2.5">
                <span className="font-mono text-[10px] text-on-night-muted/60">
                  {tab === "envelope" ? "delivery.txt" : "collections.sh"}
                </span>
                <span className="text-[10.5px] text-on-night-muted/60">Static example</span>
              </div>
            </div>
          </Reveal>
        </div>
      </div>
    </section>
  );
}
