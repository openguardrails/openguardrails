import { DOC_NAV } from "./nav";

const GH = "https://github.com/openguardrails";

function DocsHeader() {
  return (
    <header className="sticky top-0 z-30 backdrop-blur bg-ink/70 border-b border-white/[0.06]">
      <div className="max-w-[1400px] mx-auto px-6 flex items-center justify-between h-16">
        <a href="/" className="flex items-center gap-2.5 font-bold tracking-tight">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="OpenGuardrails" className="h-7 w-auto" />
          <span>Open<span className="text-accent">Guardrails</span></span>
          <span className="ml-2 text-xs font-normal text-zinc-500 border-l border-white/10 pl-2">Docs</span>
        </a>
        <nav className="hidden md:flex items-center gap-7 text-sm text-zinc-400">
          <a href="/" className="hover:text-white transition-colors">Home</a>
          <a href="/blog/" className="hover:text-white transition-colors">Blog</a>
          <a href={`${GH}/openguardrails`} className="hover:text-white transition-colors">Spec</a>
          <a href={`${GH}/openguardrails/tree/main/benchmarks`} className="hover:text-white transition-colors">Benchmark</a>
          <a href={GH} className="hover:text-white transition-colors">GitHub</a>
        </nav>
      </div>
    </header>
  );
}

function Sidebar() {
  return (
    <aside className="hidden lg:block w-64 shrink-0 border-r border-white/[0.06] py-10 pr-6">
      <nav className="sticky top-24 space-y-7 text-sm">
        {DOC_NAV.map((section) => (
          <div key={section.title}>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-500 mb-2.5">
              {section.title}
            </p>
            <ul className="space-y-1.5">
              {section.links.map((link) => (
                <li key={link.href}>
                  <a href={link.href} className="block text-zinc-400 hover:text-accent transition-colors leading-snug">
                    {link.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>
    </aside>
  );
}

export default function DocsLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <DocsHeader />
      <div className="max-w-[1400px] mx-auto px-6 flex gap-10">
        <Sidebar />
        <main className="min-w-0 flex-1 py-10 max-w-3xl">{children}</main>
      </div>
      <footer className="border-t border-white/[0.06] mt-16">
        <div className="max-w-[1400px] mx-auto px-6 py-8 text-sm text-zinc-500 flex flex-wrap justify-between gap-4">
          <span>OpenGuardrails — Apache-2.0 · vendor-neutral</span>
          <a href={GH} className="hover:text-white">github.com/openguardrails</a>
        </div>
      </footer>
    </>
  );
}
