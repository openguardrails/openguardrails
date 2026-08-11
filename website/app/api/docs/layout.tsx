import { DOC_NAV } from "./nav";

function Sidebar() {
  return (
    <aside className="hidden lg:block w-64 shrink-0 border-r border-zinc-200 py-10 pr-6">
      <nav className="sticky top-24 space-y-7 text-sm">
        {DOC_NAV.map((section) => (
          <div key={section.title}>
            <p className="text-xs font-semibold uppercase tracking-[0.2em] text-zinc-400 mb-2.5">
              {section.title}
            </p>
            <ul className="space-y-1.5">
              {section.links.map((link) => (
                <li key={link.href}>
                  <a
                    href={link.href}
                    className="block text-zinc-600 hover:text-accent transition-colors leading-snug"
                  >
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
    <div className="max-w-[1400px] mx-auto px-6 flex gap-10">
      <Sidebar />
      <main className="min-w-0 flex-1 py-10 max-w-3xl">{children}</main>
    </div>
  );
}
