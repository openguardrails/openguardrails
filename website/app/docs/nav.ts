export type DocLink = { label: string; href: string };
export type DocSection = { title: string; links: DocLink[] };

// IA: concepts first, then role-based getting-started,
// then per-integration guides, then how-to (policy) and reference.
export const DOC_NAV: DocSection[] = [
  {
    title: "Introduction",
    links: [
      { label: "What is OpenGuardrails", href: "/docs/" },
      { label: "Getting started", href: "/docs/getting-started/" },
    ],
  },
  {
    title: "Concepts",
    links: [
      { label: "The three altitudes", href: "/docs/concepts/altitudes/" },
      { label: "GuardEvent & Verdict", href: "/docs/concepts/event-verdict/" },
      { label: "Provenance & guard-context", href: "/docs/concepts/provenance/" },
      { label: "Composition", href: "/docs/concepts/composition/" },
    ],
  },
  {
    title: "Integrations",
    links: [
      { label: "Overview", href: "/docs/integrations/" },
      { label: "Claude Code", href: "/docs/integrations/claude-code/" },
      { label: "Hermes + srt (personal)", href: "/docs/integrations/hermes-srt/" },
      { label: "Hermes + OpenShell (team)", href: "/docs/integrations/hermes-openshell/" },
    ],
  },
  {
    title: "How-to",
    links: [
      { label: "Configure a policy", href: "/docs/configuring-policy/" },
      { label: "Instrument your own agent", href: "/docs/instrument-your-agent/" },
    ],
  },
];
