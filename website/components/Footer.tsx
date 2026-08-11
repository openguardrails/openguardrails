const GH = "https://github.com/openguardrails/openguardrails";

type Column = { title: string; links: { label: string; href: string }[] };

const COLUMNS: Column[] = [
  {
    title: "API",
    links: [
      { label: "Quickstart", href: "/api/docs/quickstart/" },
      { label: "API reference", href: "/api/docs/reference/" },
      { label: "Concepts", href: "/api/docs/concepts/altitudes/" },
      { label: "Instrument your agent", href: "/api/docs/instrument-your-agent/" },
    ],
  },
  {
    title: "Runtime",
    links: [
      { label: "Overview", href: "/runtime/" },
      { label: "openguardrails on PyPI", href: "https://pypi.org/project/openguardrails/" },
      { label: "@openguardrails/core on npm", href: "https://www.npmjs.com/package/@openguardrails/core" },
    ],
  },
  {
    title: "Resources",
    links: [
      { label: "Overview", href: "/resources/" },
      { label: "Showcase", href: "/resources/showcase/" },
      { label: "Blog", href: "/blog/" },
      { label: "Benchmarks", href: `${GH}/tree/main/benchmarks` },
    ],
  },
  {
    title: "Project",
    links: [
      { label: "Spec on GitHub", href: `${GH}/tree/main/specification` },
      { label: "Governance", href: `${GH}/blob/main/GOVERNANCE.md` },
      { label: "Mission", href: "/mission/" },
      { label: "Donate", href: "/donate/" },
      { label: "For agents", href: "/agent/" },
      { label: "Discord community", href: "https://discord.gg/FfSXd64pGJ" },
      { label: "Telegram", href: "https://t.me/openguardrailscommunity" },
    ],
  },
];

export default function Footer() {
  return (
    <footer className="border-t border-zinc-200 bg-zinc-50">
      <div className="container-x py-14 grid gap-10 sm:grid-cols-2 lg:grid-cols-5">
        <div className="max-w-xs">
          <a href="/" className="flex items-center gap-2.5 font-bold mb-3 text-zinc-900">
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src="/logo.svg" alt="OpenGuardrails" className="h-6 w-auto" />
            <span>
              Open<span className="text-accent">Guardrails</span>
            </span>
          </a>
          <p className="text-sm text-zinc-600 mb-4">
            Open runtime guardrails for AI agents — small models supervising models 100× their
            size, on every action, while it runs.
          </p>
          <p className="text-sm text-zinc-600 mb-4">
            Sister experiments:{" "}
            <a href="https://flaw0.com" className="hover:text-zinc-900 underline underline-offset-2" target="_blank" rel="noopener noreferrer">
              flaw0.com
            </a>{" "}
            (red team) ·{" "}
            <a href="https://malware0.com" className="hover:text-zinc-900 underline underline-offset-2" target="_blank" rel="noopener noreferrer">
              malware0.com
            </a>{" "}
            (malware analysis)
          </p>
          <p className="text-sm text-zinc-500">
            <a href="mailto:thomas@openguardrails.com" className="hover:text-zinc-900">
              thomas@openguardrails.com
            </a>
          </p>
        </div>
        {COLUMNS.map((col) => (
          <div key={col.title} className="text-sm">
            <div className="text-zinc-900 font-semibold mb-3">{col.title}</div>
            <ul className="space-y-2 text-zinc-600">
              {col.links.map((l) => (
                <li key={l.label}>
                  <a className="hover:text-zinc-900 transition-colors" href={l.href}>
                    {l.label}
                  </a>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
      <div className="border-t border-zinc-200">
        <div className="container-x py-6 flex flex-wrap items-center justify-between gap-3 text-xs text-zinc-500">
          <span>
            © 2026 OpenGuardrails · Apache-2.0 · 30 North Gould Street, STE R, Sheridan, WY 82801
          </span>
          <a href="/mission/" className="hover:text-zinc-900 transition-colors">
            Weak over Strong — controllable weak intelligence, supervising strong intelligence →
          </a>
        </div>
      </div>
    </footer>
  );
}
