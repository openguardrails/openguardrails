# Contributing

Three kinds of contribution land in this repo:

- **Checkups** — static security signatures → [`checkups/`](../checkups)
- **Red-team tests** — attack suites with detectors → [`redteam/`](../redteam)
- **Integrations** — glue for host agents → [`integrations/`](../integrations)

Each directory has its own `README.md` with the schema. This document is
the human-facing entry point that routes you there.

## The fast path: let your agent do it

You (a human) will almost never hand-edit YAML. Instead, open any
agent with filesystem access and say:

> "Use the `contribute` skill at `skills/contribute/SKILL.md` in the
> `thomas-security` repo to add a new checkup for this advisory: `<URL>`."

The agent will:

1. Clone or navigate to the repo
2. Read the relevant README for schema + conventions
3. Draft the new entry
4. Validate locally
5. Show you the diff
6. Open a PR when you confirm

You confirm the URL, the diff, and the PR text. That's the whole
interaction.

## The reference bar

Every checkup and every red-team entry must cite **at least one public
reference**. Accepted, in order of preference:

1. CVE / NVD entry
2. Published GHSA advisory (upstream project's security tab)
3. Upstream GitHub issue with engagement from maintainers
4. Named-vendor threat-intel writeup (Trend Micro, Bitdefender,
   SentinelOne, Snyk, The Hacker News, etc.) that cites original
   research
5. Academic or coordinated-disclosure paper

A Medium post, a screenshot-only tweet, or a self-authored blog post
does **not** qualify on its own. If the only source is your own
analysis, file upstream with the affected project first, then come back
here with the link.

A rule without `references` is rejected at load time. This bar is the
project's whole value proposition — every rule is auditable by anyone
reading the PR.

## Checklist before opening a PR

- [ ] One contribution per PR (exception: a single campaign batch is OK)
- [ ] The `id` is globally unique and uses the target's prefix
      (`OGR-OC-*` for openclaw)
- [ ] `references` points at something the affected project or a named
      research team published
- [ ] The pattern / prompt was tested against a real sample, not written
      from memory
- [ ] `remediation` says what to actually do — not just "remove it"
- [ ] The target directory's `README.md` still describes the layout
      correctly after your change

## Adding a new target agent

To audit an agent the repo doesn't cover yet (e.g., `cursor`, `hermes`):

1. `mkdir checkups/<agent>/` and `mkdir redteam/<agent>/`
2. Add a `README.md` to each with the agent's upstream URL, install
   locations the scanner should walk, and any maintainer notes
3. Add at least one rule and one attack
4. Open a PR

The agent directory name is lowercase, dash-separated, and matches the
agent's canonical name upstream.

## Code of conduct and license

By contributing you agree that your contribution is released under the
[Apache-2.0](../LICENSE) license and that you have the right to make it.
Be kind in reviews. Disagree in public; resolve in private.

## Security issues

Do not open a public issue for a vulnerability in `thomas` itself. See
[`SECURITY.md`](../SECURITY.md) for the disclosure process.
