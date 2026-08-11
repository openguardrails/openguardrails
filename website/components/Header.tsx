"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";

const GH = "https://github.com/openguardrails/openguardrails";

type Tab = { label: string; href: string; isActive: (pathname: string) => boolean };

const TABS: Tab[] = [
  { label: "Home", href: "/", isActive: (p) => p === "/" },
  { label: "API", href: "/api/docs/", isActive: (p) => p.startsWith("/api/docs") },
  { label: "Runtime", href: "/runtime/", isActive: (p) => p.startsWith("/runtime") },
  {
    label: "Resources",
    href: "/resources/",
    isActive: (p) => p.startsWith("/resources") || p.startsWith("/blog"),
  },
];

function GitHubIcon() {
  return (
    <svg viewBox="0 0 16 16" width="20" height="20" fill="currentColor" aria-hidden="true">
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

export default function Header() {
  const pathname = usePathname() ?? "/";
  const [open, setOpen] = useState(false);

  return (
    <header className="sticky top-0 z-30 bg-white/85 backdrop-blur border-b border-zinc-200">
      <div className="container-x flex items-center justify-between h-16">
        <div className="flex items-center gap-8 min-w-0">
          <a href="/" className="flex items-center gap-2.5 font-bold tracking-tight shrink-0">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.svg" alt="OpenGuardrails" className="h-6 w-auto" />
            <span className="text-zinc-900">
              Open<span className="text-accent">Guardrails</span>
            </span>
          </a>
          <nav className="hidden md:flex items-stretch self-stretch">
            {TABS.map((tab) => {
              const active = tab.isActive(pathname);
              return (
                <a
                  key={tab.label}
                  href={tab.href}
                  aria-current={active ? "page" : undefined}
                  className={`relative flex items-center px-3.5 text-sm transition-colors ${
                    active
                      ? "text-zinc-900 font-semibold"
                      : "text-zinc-600 hover:text-zinc-900"
                  }`}
                >
                  {tab.label}
                  {active && (
                    <span className="absolute inset-x-3 -bottom-px h-0.5 rounded-full bg-accent" />
                  )}
                </a>
              );
            })}
          </nav>
        </div>

        <div className="hidden md:flex items-center gap-4">
          <a
            href={GH}
            className="text-zinc-500 hover:text-zinc-900 transition-colors"
            aria-label="OpenGuardrails on GitHub"
          >
            <GitHubIcon />
          </a>
          <a
            href="/api/docs/quickstart/"
            className="text-sm font-semibold rounded-lg px-4 py-2 bg-accent text-white hover:bg-blue-700 transition"
          >
            Get started
          </a>
        </div>

        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          className="md:hidden inline-flex items-center justify-center w-10 h-10 -mr-2 rounded-lg text-zinc-600 hover:text-zinc-900 hover:bg-zinc-100 transition"
          aria-expanded={open}
          aria-label={open ? "Close menu" : "Open menu"}
        >
          {open ? (
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
              <path d="M4 7h16M4 12h16M4 17h16" />
            </svg>
          )}
        </button>
      </div>

      {open && (
        <div className="md:hidden border-t border-zinc-200 bg-white">
          <nav className="container-x py-3 flex flex-col">
            {TABS.map((tab) => {
              const active = tab.isActive(pathname);
              return (
                <a
                  key={tab.label}
                  href={tab.href}
                  aria-current={active ? "page" : undefined}
                  className={`rounded-lg px-3 py-2.5 text-sm ${
                    active
                      ? "text-zinc-900 font-semibold bg-zinc-50"
                      : "text-zinc-600 hover:text-zinc-900 hover:bg-zinc-50"
                  }`}
                >
                  {tab.label}
                </a>
              );
            })}
            <a
              href={GH}
              className="rounded-lg px-3 py-2.5 text-sm text-zinc-600 hover:text-zinc-900 hover:bg-zinc-50 flex items-center gap-2"
            >
              <GitHubIcon />
              GitHub
            </a>
            <a
              href="/api/docs/quickstart/"
              className="mt-2 mb-1 text-sm font-semibold rounded-lg px-4 py-2.5 bg-accent text-white text-center hover:bg-blue-700 transition"
            >
              Get started
            </a>
          </nav>
        </div>
      )}
    </header>
  );
}
