import type { Metadata } from "next";
import { LinkCard } from "@/components/Card";

const GH = "https://github.com/openguardrails/openguardrails";

export const metadata: Metadata = {
  title: "Community — OpenGuardrails",
  description:
    "Get involved with OpenGuardrails: GitHub, Discord, contributing, governance, conformance self-certification, and how to add an integration or detector.",
};

export default function CommunityPage() {
  return (
    <main className="container-x py-20">
      <p className="eyebrow mb-4">Resources · Community</p>
      <h1 className="text-4xl font-bold tracking-tight text-zinc-900 mb-5">Community</h1>
      <p className="text-lg text-zinc-600 max-w-2xl leading-relaxed mb-12">
        The specification, schemas, SDKs, integrations, and benchmark are Apache-2.0 and developed
        in the open, in one monorepo. Everything below happens on GitHub or Discord.
      </p>

      <h2 className="text-2xl font-bold text-zinc-900 mb-6">Where things happen</h2>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5 mb-14">
        <LinkCard href={GH} eyebrow="github.com" title="The monorepo" cta="Star it">
          Spec, JSON Schemas, Python and JS SDKs, all integrations, and the benchmark harness in one
          repository.
        </LinkCard>
        <LinkCard href={`${GH}/issues`} eyebrow="GitHub" title="Issues" cta="Report">
          Bugs, spec ambiguities, and feature requests. Small, well-scoped issues get picked up
          fastest.
        </LinkCard>
        <LinkCard href={`${GH}/discussions`} eyebrow="GitHub" title="Discussions" cta="Ask">
          Design questions, integration ideas, and anything that isn&apos;t yet a concrete issue.
        </LinkCard>
        <LinkCard href="https://discord.gg/FfSXd64pGJ" eyebrow="Discord" title="Chat" cta="Join">
          Ask questions and follow development in real time.
        </LinkCard>
        <LinkCard
          href={`${GH}/blob/main/CONTRIBUTING.md`}
          eyebrow="CONTRIBUTING.md"
          title="Contributing"
          cta="Read first"
        >
          How to set up the monorepo, run the test suites, and get a change merged.
        </LinkCard>
        <LinkCard
          href={`${GH}/blob/main/GOVERNANCE.md`}
          eyebrow="GOVERNANCE.md"
          title="Governance"
          cta="Read"
        >
          How decisions about the specification and the project are made, and by whom.
        </LinkCard>
      </div>

      <h2 className="text-2xl font-bold text-zinc-900 mb-4">Build on the contract</h2>
      <div className="space-y-6 max-w-3xl mb-14">
        <div className="card p-6">
          <h3 className="font-semibold text-zinc-900 mb-2">Add an integration</h3>
          <p className="text-sm text-zinc-600 leading-relaxed">
            An integration is a plugin: a hook for one surface (agent, gateway, sandbox, or eBPF)
            built on an SDK — the SDK handles GuardEvent construction, auth, signing, and the wire;
            the plugin never hand-rolls HTTP. Start from the{" "}
            <a href={`${GH}/tree/main/integrations`} className="text-accent hover:underline">
              integrations directory
            </a>{" "}
            and the closest existing example in the{" "}
            <a href="/resources/showcase/" className="text-accent hover:underline">
              showcase
            </a>
            .
          </p>
        </div>
        <div className="card p-6">
          <h3 className="font-semibold text-zinc-900 mb-2">Add a detector</h3>
          <p className="text-sm text-zinc-600 leading-relaxed">
            A detector accepts a GuardEvent, returns a Verdict, and references categories from the
            published taxonomy — that&apos;s the whole interface. Validate against the{" "}
            <a href={`${GH}/tree/main/schema`} className="text-accent hover:underline">
              JSON Schemas
            </a>{" "}
            in your test suite, then run the{" "}
            <a href={`${GH}/tree/main/benchmarks`} className="text-accent hover:underline">
              neutral benchmark
            </a>{" "}
            to see where you land. Detection quality is measured there, not claimed.
          </p>
        </div>
        <div className="card p-6">
          <h3 className="font-semibold text-zinc-900 mb-2">Self-certify conformance</h3>
          <p className="text-sm text-zinc-600 leading-relaxed">
            Conformance is about speaking the wire, not detection quality, and is currently
            self-declared: state the version you target and the role you implement (detector,
            adapter, runtime, …), e.g.{" "}
            <span className="font-mono text-zinc-800">
              &quot;OpenGuardrails v0 — detector + adapter conformant&quot;
            </span>
            . The roles and their requirements are in{" "}
            <a href={`${GH}/blob/main/CONFORMANCE.md`} className="text-accent hover:underline">
              CONFORMANCE.md
            </a>
            .
          </p>
        </div>
      </div>

      <div className="card p-8 bg-zinc-50 max-w-3xl">
        <h2 className="text-xl font-bold text-zinc-900 mb-2">Support the mission</h2>
        <p className="text-sm text-zinc-600 leading-relaxed mb-4">
          Donations keep the protocol and benchmark open, neutral, and Apache-2.0 — never
          paywalled — and fund the research and integrations behind them.
        </p>
        <a
          href="/donate/"
          className="inline-block rounded-lg px-5 py-3 bg-accent text-white font-semibold hover:bg-blue-700 transition"
        >
          Donate
        </a>
      </div>
    </main>
  );
}
