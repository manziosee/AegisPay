"use client";

import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import { SessionProvider } from "./session-provider";
import { CommandProvider } from "./command-provider";

export function AppProviders({ children }: { children: React.ReactNode }) {
  return (
    <SessionProvider>
      <CommandProvider>
        <TooltipProvider delayDuration={200}>
          {children}
          <Toaster position="top-right" richColors closeButton />
        </TooltipProvider>
      </CommandProvider>
    </SessionProvider>
  );
}
