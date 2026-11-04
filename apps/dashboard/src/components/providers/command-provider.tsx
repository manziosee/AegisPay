"use client";

import { createContext, useContext, useEffect, useMemo, useState } from "react";
import { usePathname } from "next/navigation";
import { CommandPalette } from "@/components/command/command-palette";

type CommandContextValue = {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
};

const CommandContext = createContext<CommandContextValue | null>(null);

export function CommandProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpen] = useState(false);
  // The palette searches workspace pages and records, so it only exists
  // inside the signed-in workspace, not on the public site.
  const inWorkspace = usePathname()?.startsWith("/app") ?? false;

  useEffect(() => {
    if (!inWorkspace) {
      setOpen(false);
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [inWorkspace]);

  const value = useMemo(
    () => ({ open, setOpen, toggle: () => setOpen((current) => !current) }),
    [open]
  );

  return (
    <CommandContext.Provider value={value}>
      {children}
      {open && inWorkspace && <CommandPalette />}
    </CommandContext.Provider>
  );
}

export function useCommand() {
  const context = useContext(CommandContext);
  if (!context) throw new Error("useCommand must be used inside CommandProvider");
  return context;
}
