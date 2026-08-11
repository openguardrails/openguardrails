export type DocLink = { label: string; href: string };
export type DocSection = { title: string; links: DocLink[] };

// IA: get started → concepts → the API reference (the centerpiece) →
// SDKs → plugins → instrumenting guide.
export const DOC_NAV: DocSection[] = [
  {
    title: "Get started",
    links: [
      { label: "Introduction", href: "/api/docs/" },
      { label: "Quickstart", href: "/api/docs/quickstart/" },
    ],
  },
  {
    title: "Concepts",
    links: [
      { label: "The three altitudes", href: "/api/docs/concepts/altitudes/" },
      { label: "Provenance & guard-context", href: "/api/docs/concepts/provenance/" },
      { label: "Composition", href: "/api/docs/concepts/composition/" },
      { label: "Policy", href: "/api/docs/concepts/policy/" },
    ],
  },
  {
    title: "API reference",
    links: [
      { label: "Overview", href: "/api/docs/reference/" },
      { label: "POST /v1/evaluate", href: "/api/docs/reference/evaluate/" },
      { label: "POST /v1/ingest", href: "/api/docs/reference/ingest/" },
      { label: "POST /v1/enroll", href: "/api/docs/reference/enroll/" },
      { label: "POST /v1/heartbeat", href: "/api/docs/reference/heartbeat/" },
      { label: "GET /v1/config", href: "/api/docs/reference/config/" },
      { label: "GET /v1/approvals", href: "/api/docs/reference/approvals/" },
      { label: "GET /v1/health", href: "/api/docs/reference/health/" },
      { label: "The GuardEvent object", href: "/api/docs/reference/objects/guard-event/" },
      { label: "The Verdict object", href: "/api/docs/reference/objects/verdict/" },
    ],
  },
  {
    title: "SDKs",
    links: [
      { label: "Overview", href: "/api/docs/sdk/" },
      { label: "Python", href: "/api/docs/sdk/python/" },
      { label: "JavaScript / TypeScript", href: "/api/docs/sdk/javascript/" },
    ],
  },
  {
    title: "Plugins",
    links: [
      { label: "Overview", href: "/api/docs/plugins/" },
      { label: "Claude Code", href: "/api/docs/plugins/claude-code/" },
      { label: "Hermes + srt (personal)", href: "/api/docs/plugins/hermes-srt/" },
      { label: "Hermes + OpenShell (team)", href: "/api/docs/plugins/hermes-openshell/" },
    ],
  },
  {
    title: "Guides",
    links: [
      { label: "Instrument your agent", href: "/api/docs/instrument-your-agent/" },
    ],
  },
];
