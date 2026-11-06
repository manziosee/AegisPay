"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { ChevronDown, Menu } from "lucide-react";
import { Wordmark } from "@/components/brand/logo";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger
} from "@/components/ui/sheet";
import { useSession } from "@/components/providers/session-provider";
import { megaMenus } from "@/lib/marketing";
import { cn } from "@/lib/utils";

export function SiteHeader() {
  const [openMenu, setOpenMenu] = useState<string | null>(null);
  const [mobileOpen, setMobileOpen] = useState(false);
  const [scrolled, setScrolled] = useState(false);
  const { status } = useSession();

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenMenu(null);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  return (
    <header
      className={cn(
        "fixed inset-x-0 top-0 z-50 border-b transition-colors duration-300",
        scrolled || openMenu
          ? "border-white/10 bg-night/95 backdrop-blur-md"
          : "border-transparent bg-transparent"
      )}
    >
      <div className="mx-auto flex h-[72px] w-full max-w-[1320px] items-center gap-4 px-5 sm:px-8">
        <Link href="/" aria-label="AegisPay home" className="shrink-0">
          <Wordmark size="md" />
        </Link>

        <nav
          aria-label="Marketing navigation"
          className="mx-auto hidden items-center gap-0.5 rounded-full border border-white/10 bg-white/[0.04] p-1 lg:flex"
          onMouseLeave={() => setOpenMenu(null)}
        >
          {megaMenus.map((menu) => {
            const open = openMenu === menu.label;
            return (
              <div key={menu.label} className="relative">
                <button
                  type="button"
                  aria-expanded={open}
                  aria-haspopup="true"
                  onMouseEnter={() => setOpenMenu(menu.label)}
                  onClick={() => setOpenMenu(open ? null : menu.label)}
                  className={cn(
                    "inline-flex h-9 items-center gap-1.5 rounded-full px-3.5 text-[13px] font-medium transition-colors",
                    open ? "bg-white/10 text-on-night" : "text-on-night-muted hover:text-on-night"
                  )}
                >
                  {menu.label}
                  <ChevronDown
                    className={cn("size-3.5 transition-transform", open && "rotate-180")}
                  />
                </button>

                {open && (
                  <div
                    className="absolute left-1/2 top-[calc(100%+14px)] w-[660px] -translate-x-1/2 rounded-2xl border border-white/12 bg-night-raised p-5 shadow-lift"
                    onMouseEnter={() => setOpenMenu(menu.label)}
                  >
                    <div className="grid grid-cols-2 gap-6">
                      {menu.columns.map((column) => (
                        <div key={column.heading}>
                          <p className="mb-2.5 font-mono text-[10px] uppercase tracking-[0.12em] text-on-night-muted/70">
                            {column.heading}
                          </p>
                          <ul className="space-y-1">
                            {column.links.map((link) => (
                              <li key={link.label}>
                                <Link
                                  href={link.href}
                                  onClick={() => setOpenMenu(null)}
                                  className="group flex flex-col gap-0.5 rounded-lg px-2.5 py-2 transition-colors hover:bg-white/6"
                                >
                                  <span className="flex items-center gap-2 text-[13px] font-medium text-on-night">
                                    {link.label}
                                    {link.badge && (
                                      <span className="rounded border border-mint/25 bg-mint/10 px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-wide text-mint">
                                        {link.badge}
                                      </span>
                                    )}
                                  </span>
                                  <span className="text-[11.5px] leading-relaxed text-on-night-muted">
                                    {link.description}
                                  </span>
                                </Link>
                              </li>
                            ))}
                          </ul>
                        </div>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
        </nav>

        <div className="ml-auto flex items-center gap-2 lg:ml-0">
          {status === "authenticated" ? (
            <Button
              asChild
              className="h-9 rounded-full bg-primary px-4 text-[13px] font-semibold text-primary-foreground hover:bg-primary/90"
            >
              <Link href="/app">Open workspace</Link>
            </Button>
          ) : (
            <>
              <Button
                asChild
                variant="ghost"
                className="hidden h-9 rounded-full px-3 text-[13px] text-on-night-muted hover:bg-white/8 hover:text-on-night sm:inline-flex"
              >
                <Link href="/login">Log in</Link>
              </Button>
              <Button
                asChild
                className="h-9 rounded-full bg-primary px-3 text-[12px] font-semibold text-primary-foreground hover:bg-primary/90 sm:px-4 sm:text-[13px]"
              >
                <Link href="/register">
                  <span className="hidden sm:inline">Create free account</span>
                  <span className="sm:hidden">Create account</span>
                </Link>
              </Button>
            </>
          )}

          <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
            <SheetTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Open menu"
                className="size-9 rounded-full border border-white/10 text-on-night lg:hidden"
              >
                <Menu className="size-4" />
              </Button>
            </SheetTrigger>
            <SheetContent
              side="left"
              className="w-[88vw] max-w-sm border-white/10 bg-night p-0 text-on-night"
            >
              <SheetHeader className="border-b border-white/10 px-5 py-4">
                <SheetTitle className="sr-only">AegisPay navigation</SheetTitle>
                <Wordmark size="sm" />
              </SheetHeader>
              <div className="space-y-6 overflow-y-auto px-5 py-5">
                {megaMenus.map((menu) => (
                  <div key={menu.label}>
                    <p className="mb-2 font-mono text-[10px] uppercase tracking-[0.12em] text-on-night-muted/70">
                      {menu.label}
                    </p>
                    <ul className="space-y-1">
                      {menu.columns.flatMap((column) =>
                        column.links.map((link) => (
                          <li key={`${menu.label}-${link.label}`}>
                            <Link
                              href={link.href}
                              onClick={() => setMobileOpen(false)}
                              className="block rounded-lg px-2 py-2 text-[14px] text-on-night hover:bg-white/6"
                            >
                              {link.label}
                            </Link>
                          </li>
                        ))
                      )}
                    </ul>
                  </div>
                ))}
                <div className="grid gap-2 border-t border-white/10 pt-5">
                  <Button asChild variant="outline" className="h-10 border-white/15 bg-transparent text-on-night hover:bg-white/8 hover:text-on-night">
                    <Link href="/login" onClick={() => setMobileOpen(false)}>
                      Log in
                    </Link>
                  </Button>
                  <Button asChild className="h-10 bg-primary text-primary-foreground">
                    <Link href="/register" onClick={() => setMobileOpen(false)}>
                      Create free account
                    </Link>
                  </Button>
                </div>
              </div>
            </SheetContent>
          </Sheet>
        </div>
      </div>
    </header>
  );
}
