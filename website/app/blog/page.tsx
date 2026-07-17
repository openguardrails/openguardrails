export const metadata = {
  title: "Blog — OpenGuardrails",
  description: "Operational guides and notes on vendor-neutral agent safety & security with OpenGuardrails (OGR).",
};

const POSTS = [
  {
    slug: "production-agent-security-with-ebpf-and-openguardrails",
    title: "Production agent security with eBPF and OpenGuardrails",
    date: "2026-07-16",
    blurb:
      "A vendor-neutral reference architecture for turning kernel exec, file, and network activity into OGR GuardEvents, composing multiple security providers, and enforcing one auditable decision across an enterprise fleet.",
  },
  {
    slug: "guarding-your-agent-with-openguardrails-and-openafw",
    title: "Guarding your working agent with OpenGuardrails and openafw",
    date: "2026-06-29",
    blurb:
      "Standard security tools tell you a request happened. But an agent's two dangerous moments — reading untrusted content, and handing a key to an invisible middleman — need an agent-specific probe on the wire. A walkthrough of the OGR gateway altitude, landed locally as openafw, with a familiar OpenTelemetry analogy.",
  },
  {
    slug: "when-your-coding-agent-installs-malware",
    title: "When your coding agent installs the malware",
    date: "2026-06-29",
    blurb:
      "A real incident: a coding agent in bypass mode ran an obfuscated curl|bash from a phishing site and let in an AMOS Stealer variant. The full attack chain, where OpenGuardrails would have stopped it at the entry point — and, honestly, where it wouldn't (it's not antivirus).",
  },
  {
    slug: "guarding-claude-code-with-openguardrails",
    title: "Guarding Claude Code with OpenGuardrails (even in bypass mode)",
    date: "2026-06-29",
    blurb:
      "Install one plugin and risky Claude Code tool calls are denied before they run — even in bypass mode, because the PreToolUse hook fires above the permission system. The one place the built-in classifier can't reach.",
  },
  {
    slug: "guarding-an-opencode-agent-with-openguardrails",
    title: "Guarding an opencode agent with OpenGuardrails",
    date: "2026-06-29",
    blurb:
      "Guard opencode — a TypeScript coding agent — as a pure plugin on the tool.execute.before hook. The deny-and-continue model, your own model as the judge, and the upstream PR that turns require_approval into a first-class human ask.",
  },
  {
    slug: "guarding-a-kilo-agent-with-openguardrails",
    title: "From AI Gatekeeper to OpenGuardrails: guarding Kilo CLI",
    date: "2026-06-29",
    blurb:
      "Kilo CLI had a bespoke LLM command-approval classifier. We routed it through OpenGuardrails — one GuardEvent → Verdict, composed detectors, reasoning-blind, your own model as judge — and deleted the one-off backend enum.",
  },
  {
    slug: "guarding-an-openclaw-agent-with-openguardrails",
    title: "Guarding an OpenClaw agent with OpenGuardrails",
    date: "2026-06-29",
    blurb:
      "Guard OpenClaw as a pure plugin on its before_tool_call hook — with a first-class human-approval gate. block AND require_approval both work natively, no core change. Published and smoke-verified.",
  },
  {
    slug: "guarding-a-hermes-agent-with-openguardrails",
    title: "Guarding a Hermes agent with OpenGuardrails",
    date: "2026-06-28",
    blurb:
      "Guard a Hermes agent behind one neutral contract — intercept every tool call and real exec, enforce one policy you own, and plug in any vendor's detector without rewiring the agent. What Hermes exposes, what you pip install, the one policy that controls it, and how to verify end to end.",
  },
];

export default function BlogIndex() {
  return (
    <>
      <h1 className="text-3xl font-bold tracking-tight mb-2">Blog</h1>
      <p className="text-zinc-400 mb-10">
        Operational guides for vendor-neutral agent safety &amp; security.
      </p>
      <ul className="space-y-8">
        {POSTS.map((p) => (
          <li key={p.slug} className="border-b border-white/[0.06] pb-8">
            <p className="text-xs uppercase tracking-[0.2em] text-zinc-500 mb-2">{p.date}</p>
            <a href={`/blog/${p.slug}/`} className="block group">
              <h2 className="text-xl font-semibold group-hover:text-accent transition-colors">
                {p.title}
              </h2>
            </a>
            <p className="text-zinc-400 mt-2 leading-relaxed">{p.blurb}</p>
            <a
              href={`/blog/${p.slug}/`}
              className="inline-block mt-3 text-accent text-sm font-semibold hover:underline"
            >
              Read →
            </a>
          </li>
        ))}
      </ul>
    </>
  );
}
