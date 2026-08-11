import type { Metadata } from "next";
import { LinkCard } from "@/components/Card";

const GH = "https://github.com/openguardrails/openguardrails";

export const metadata: Metadata = {
  title: "Resources — OpenGuardrails",
  description:
    "OpenGuardrails resources: the integration showcase, blog, community, neutral benchmark, the specification, and the agent skill.",
};

export default function ResourcesPage() {
  return (
    <main className="container-x py-20">
      <p className="eyebrow mb-4">Resources</p>
      <h1 className="text-4xl font-bold tracking-tight text-zinc-900 mb-5">Resources</h1>
      <p className="text-lg text-zinc-600 max-w-2xl leading-relaxed mb-10">
        Integrations, guides, benchmarks, and the community around OpenGuardrails.
      </p>
      <div className="grid sm:grid-cols-2 lg:grid-cols-3 gap-5">
        <LinkCard href="/resources/showcase/" eyebrow="Integrations" title="Showcase" cta="Browse">
          Every integration built on OGR — agent hooks, gateway hooks, sandbox hooks, and the eBPF
          sensor — with install hints and source links.
        </LinkCard>
        <LinkCard href="/blog/" eyebrow="Writing" title="Blog" cta="Read">
          Operational guides and notes on guarding real agents: Claude Code, opencode, OpenClaw,
          Hermes, and a real malware incident.
        </LinkCard>
        <LinkCard href="/resources/community/" eyebrow="Get involved" title="Community" cta="Join">
          GitHub, Discord, contributing, governance, and how to add your own integration or
          detector.
        </LinkCard>
        <LinkCard
          href={`${GH}/tree/main/benchmarks`}
          eyebrow="Neutral benchmark"
          title="Benchmark &amp; leaderboard"
          cta="Reproduce"
        >
          The neutral detector benchmark: shared corpora, an open harness, and a leaderboard.
          Detectors compete, we referee.
        </LinkCard>
        <LinkCard
          href={`${GH}/tree/main/specification`}
          eyebrow="Apache-2.0"
          title="Specification on GitHub"
          cta="Read the spec"
        >
          GuardEvent, Verdict, provenance, composition, attestation, degraded mode, and the Runtime
          API binding — the normative sources.
        </LinkCard>
        <LinkCard href="/agent/" eyebrow="For agents" title="The agent skill" cta="Install">
          OGR is designed to be installed and operated by an agent: draft a policy, get human
          approval, enforce. The skill packages the whole procedure.
        </LinkCard>
      </div>
    </main>
  );
}
