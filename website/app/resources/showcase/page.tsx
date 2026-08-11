import type { Metadata } from "next";

const GH = "https://github.com/openguardrails/openguardrails";

export const metadata: Metadata = {
  title: "Showcase — OpenGuardrails",
  description:
    "Every integration built on OpenGuardrails: Claude Code, Codex, opencode, OpenClaw, Hermes, LangGraph agent hooks; OpenAI/Anthropic, Higress, mitmproxy gateway hooks; sandbox hooks; and the eBPF sensor.",
};

type Item = {
  name: string;
  install: string;
  blurb: string;
  dir?: string; // path under integrations/
  blog?: string; // blog slug
};

type Group = {
  id: string;
  title: string;
  intro: string;
  items: Item[];
};

const GROUPS: Group[] = [
  {
    id: "agent",
    title: "Agent hooks",
    intro:
      "Intercept the agent's own tool and lifecycle hooks: every tool call becomes a GuardEvent before it runs.",
    items: [
      {
        name: "Claude Code",
        install: "marketplace plugin",
        dir: "agent/claude-code",
        blog: "guarding-claude-code-with-openguardrails",
        blurb:
          "A PreToolUse hook that judges each risky tool call and returns deny, ask, or allow before it runs. Hooks fire above the permission system, so a deny holds even in bypass mode — the one place the built-in classifier can't reach. Install with /plugin marketplace add openguardrails/openguardrails.",
      },
      {
        name: "Codex",
        install: "marketplace plugin",
        dir: "agent/codex",
        blurb:
          "Two complementary hooks: a PermissionRequest hook that removes prompts for calls the runtime judges safe (auto mode), and a PreToolUse guardrail that blocks dangerous calls even under bypassPermissions. Requires Codex ≥ 0.122.",
      },
      {
        name: "opencode",
        install: "npm · openguardrails-instrumentation-opencode",
        dir: "agent/opencode",
        blog: "guarding-an-opencode-agent-with-openguardrails",
        blurb:
          "A pure opencode plugin on the tool.execute.before hook — no core changes, no fork. Deterministic text/regex rules with no model required, or your own model as an LLM judge. Pulls in @openguardrails/core, the JS core runtime.",
      },
      {
        name: "OpenClaw",
        install: "npm · openguardrails-instrumentation-openclaw",
        dir: "agent/openclaw",
        blog: "guarding-an-openclaw-agent-with-openguardrails",
        blurb:
          "Guards both before_tool_call and outbound message_sending, restrict-only by design. require_approval maps to OpenClaw's native /approve human gate: the plugin decides, the user approves, the host enforces.",
      },
      {
        name: "Hermes",
        install: "PyPI · openguardrails-instrumentation-hermes",
        dir: "agent/hermes",
        blog: "guarding-a-hermes-agent-with-openguardrails",
        blurb:
          "One policy.json enforced across all three altitudes — tool calls, real exec, and the sandbox boundary (srt or OpenShell) — correlated by guard_id and provenance. Pulls in openguardrails, the Python core runtime.",
      },
      {
        name: "LangGraph",
        install: "PyPI · openguardrails-instrumentation-langgraph",
        dir: "agent/langgraph",
        blurb:
          "For hand-rolled agents with no plugin marketplace: a drop-in ToolNode that judges every tool_call before it runs, using LangGraph's own interrupt() as the human-approval gate. A library you import, not a product you configure.",
      },
    ],
  },
  {
    id: "gateway",
    title: "Gateway hooks",
    intro:
      "Intercept the LLM protocol itself: judge prompts, completions, and tool traffic on the wire, before the model or the caller sees them.",
    items: [
      {
        name: "OpenAI / Anthropic proxy",
        install: "PyPI · openguardrails (runnable example)",
        dir: "gateway/openai-anthropic",
        blog: "guarding-your-agent-with-openguardrails-and-openafw",
        blurb:
          "A runnable reference proxy that terminates the OpenAI and Anthropic wire protocols, normalizes each request and response into GuardEvents, and enforces one policy through the Python core. Shows gateway authors how to bind their own gateway to OGR; not a hosted service.",
      },
      {
        name: "Higress",
        install: "WASM plugin · oci://docker.io/openguardrails/higress",
        dir: "gateway/higress",
        blurb:
          "A Higress WASM plugin that speaks OGR directly to a runtime — POST /v1/evaluate on the request path, /v1/ingest for observations. Stateless by design; installs from the Higress console as an OCI artifact.",
      },
      {
        name: "mitmproxy",
        install: "Python addon · pip install from source",
        dir: "gateway/mitmproxy",
        blurb:
          "A mitmproxy addon that puts an OGR runtime on your agent's LLM traffic. Pure PEP: it carries no detection logic and holds no policy — every Verdict comes from the runtime you configure, the same policy your other observation points share.",
      },
    ],
  },
  {
    id: "sandbox",
    title: "Sandbox hooks",
    intro:
      "Enforce policy at the boundary that actually executes: process, filesystem, and network — regardless of what the agent claimed it would do.",
    items: [
      {
        name: "Anthropic srt & NVIDIA OpenShell",
        install: "planned standalone examples",
        dir: "sandbox",
        blurb:
          "Standalone examples for Anthropic's Sandbox Runtime (srt) and NVIDIA OpenShell are planned. Today, the Hermes integration demonstrates both backends end to end: the same declarative OGR policy compiles to srt (OS-level, no containers) or OpenShell (containers + egress proxy).",
      },
    ],
  },
  {
    id: "ebpf",
    title: "eBPF",
    intro:
      "Observe kernel-level activity and map it to the sandbox observation point — no separate wire contract.",
    items: [
      {
        name: "eBPF sensor",
        install: "build from source (CO-RE)",
        dir: "ebpf/sensor",
        blog: "production-agent-security-with-ebpf-and-openguardrails",
        blurb:
          "The native OGR reference at the kernel altitude: a small CO-RE program watches exec, file open, and network connect for one agent process tree; a userspace PEP maps each to a GuardEvent, asks the runtime for a Verdict, and enforces it. Below the harness, so shelling out or spawning a subprocess doesn't bypass it.",
      },
    ],
  },
];

function ItemCard({ item }: { item: Item }) {
  return (
    <div className="card p-6 flex flex-col">
      <div className="flex items-start justify-between gap-3 mb-2">
        <h3 className="font-semibold text-zinc-900">{item.name}</h3>
      </div>
      <p className="text-xs font-mono text-zinc-500 mb-3">{item.install}</p>
      <p className="text-sm text-zinc-600 leading-relaxed flex-1">{item.blurb}</p>
      <div className="mt-4 flex flex-wrap gap-x-5 gap-y-1 text-sm font-semibold">
        {item.dir && (
          <a href={`${GH}/tree/main/integrations/${item.dir}`} className="text-accent hover:underline">
            Source →
          </a>
        )}
        {item.blog && (
          <a href={`/blog/${item.blog}/`} className="text-accent hover:underline">
            Write-up →
          </a>
        )}
      </div>
    </div>
  );
}

export default function ShowcasePage() {
  return (
    <main className="container-x py-20">
      <p className="eyebrow mb-4">Resources · Showcase</p>
      <h1 className="text-4xl font-bold tracking-tight text-zinc-900 mb-5">Integration showcase</h1>
      <p className="text-lg text-zinc-600 max-w-2xl leading-relaxed mb-4">
        Every integration below is a <strong>plugin</strong> in the API → SDK → Plugin stack: a hook
        for one surface that turns actions into GuardEvents and enforces Verdicts, with an SDK doing
        the wire work underneath. Same contract everywhere; pick the surfaces you have.
      </p>
      <p className="text-sm text-zinc-500 mb-12">
        Built something OGR-conformant?{" "}
        <a href="/resources/community/" className="text-accent hover:underline">
          Add it to this page
        </a>
        .
      </p>
      {GROUPS.map((g) => (
        <section key={g.id} className="mb-14 last:mb-0">
          <h2 className="text-2xl font-bold text-zinc-900 mb-2">{g.title}</h2>
          <p className="text-zinc-600 max-w-2xl mb-6">{g.intro}</p>
          <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
            {g.items.map((item) => (
              <ItemCard key={item.name} item={item} />
            ))}
          </div>
        </section>
      ))}
    </main>
  );
}
