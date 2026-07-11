const GH = "https://github.com/openguardrails";

function BlogHeader() {
  return (
    <header className="sticky top-0 z-30 backdrop-blur bg-ink/70 border-b border-white/[0.06]">
      <div className="max-w-[1400px] mx-auto px-6 flex items-center justify-between h-16">
        <a href="/" className="flex items-center gap-2.5 font-bold tracking-tight">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.svg" alt="OpenGuardrails" className="h-7 w-auto" />
          <span>Open<span className="text-accent">Guardrails</span></span>
          <span className="ml-2 text-xs font-normal text-zinc-500 border-l border-white/10 pl-2">Blog</span>
        </a>
        <nav className="hidden md:flex items-center gap-7 text-sm text-zinc-400">
          <a href="/" className="hover:text-white transition-colors">Home</a>
          <a href="/docs/" className="hover:text-white transition-colors">Docs</a>
          <a href={`${GH}/openguardrails`} className="hover:text-white transition-colors">Spec</a>
          <a href={GH} className="hover:text-white transition-colors">GitHub</a>
        </nav>
      </div>
    </header>
  );
}

export default function BlogLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <BlogHeader />
      <div className="max-w-[1400px] mx-auto px-6">
        <main className="min-w-0 mx-auto py-12 max-w-3xl">{children}</main>
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
