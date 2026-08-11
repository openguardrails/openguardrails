export type DocLink = { label: string; href: string };
export type DocSection = { title: string; links: DocLink[] };

// IA: get started → concepts → the API reference (the centerpiece) →
// SDKs → plugins → instrumenting guide.
export const DOC_NAV: DocSection[] = [
  {
    title: "Get started",
    links: [
      { label: "Introduction", href: "/docs/" },
      { label: "Quickstart", href: "/docs/quickstart/" },
    ],
  },
  {
    title: "Concepts",
    links: [
      { label: "The three altitudes", href: "/docs/concepts/altitudes/" },
      { label: "Provenance & guard-context", href: "/docs/concepts/provenance/" },
      { label: "Composition", href: "/docs/concepts/composition/" },
      { label: "Policy", href: "/docs/concepts/policy/" },
    ],
  },
  {
    title: "API reference",
    links: [
      { label: "Overview", href: "/docs/api/" },
      { label: "POST /v1/evaluate", href: "/docs/api/evaluate/" },
      { label: "POST /v1/ingest", href: "/docs/api/ingest/" },
      { label: "POST /v1/enroll", href: "/docs/api/enroll/" },
      { label: "POST /v1/heartbeat", href: "/docs/api/heartbeat/" },
      { label: "GET /v1/config", href: "/docs/api/config/" },
      { label: "GET /v1/approvals", href: "/docs/api/approvals/" },
      { label: "GET /v1/health", href: "/docs/api/health/" },
      { label: "The GuardEvent object", href: "/docs/api/objects/guard-event/" },
      { label: "The Verdict object", href: "/docs/api/objects/verdict/" },
    ],
  },
  {
    title: "SDKs",
    links: [
      { label: "Overview", href: "/docs/sdk/" },
      { label: "Python", href: "/docs/sdk/python/" },
      { label: "JavaScript / TypeScript", href: "/docs/sdk/javascript/" },
    ],
  },
  {
    title: "Plugins",
    links: [
      { label: "Overview", href: "/docs/plugins/" },
      { label: "Claude Code", href: "/docs/plugins/claude-code/" },
      { label: "Hermes + srt (personal)", href: "/docs/plugins/hermes-srt/" },
      { label: "Hermes + OpenShell (team)", href: "/docs/plugins/hermes-openshell/" },
    ],
  },
  {
    title: "Guides",
    links: [
      { label: "Instrument your agent", href: "/docs/instrument-your-agent/" },
    ],
  },
];
