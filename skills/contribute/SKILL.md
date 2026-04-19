<!--
  Copyright (c) 2026 OpenGuardrails.com
  Author: thomas-security <thomas@openguardrails.com>
  SPDX-License-Identifier: Apache-2.0
-->

---
name: thomas-security-contribute
description: |
  Use this skill when the user asks you to add, draft, or submit a new
  security checkup, red-team test, or integration to the
  `thomas-security` repository. Triggered by phrases like "add a
  checkup for <CVE>", "write a red-team attack for <incident>",
  "contribute this advisory to thomas", "add an integration for
  <agent>", or "open a PR against thomas-security". Walks the agent
  through drafting, validating, and submitting the contribution.
---

# Contribute to thomas-security

The user wants to add new content to the `thomas-security` repo. Your
job is to take a **reference** they provide (a CVE, GHSA advisory,
upstream issue, or threat-intel writeup), turn it into the right kind
of artifact (checkup, red-team attack, or integration), and submit it
as a PR.

The user will almost never type the YAML themselves. They will say:

> "Add a checkup for GHSA-g8p2-7wf7-98mq."

and hand you the link. You do the rest.

## Step 0 — Figure out what kind of contribution this is

| Clue in the request / reference                                     | Kind            | Where it goes                             |
| ------------------------------------------------------------------- | --------------- | ----------------------------------------- |
| Matches a pattern in a file / config / version pin                  | **checkup**     | `checkups/<agent>/<category>.yaml`        |
| A prompt the attacker sends to trick the agent                      | **red-team**    | `redteam/<agent>/<suite>.yaml`            |
| A new hook / plugin / SDK glue for a host agent we don't cover yet  | **integration** | `integrations/<kind>/` (new subdirectory) |

If the reference describes both a static IoC *and* an in-the-wild attack
prompt, split into two PRs — one checkup, one red-team. Reviewers prefer
focused changes.

If it's ambiguous, ask the user which one they want before writing any
files.

## Step 1 — Clone and branch

```bash
# Only if the user doesn't already have a checkout
git clone https://github.com/openguardrails/thomas-security.git
cd thomas-security

git checkout -b add-<short-slug>
```

`<short-slug>` should name the incident, not the file. Good:
`add-ghsa-g8p2-gatewayurl`. Bad: `add-rule`.

## Step 2 — Read the target's README first

Before writing YAML, read the README of the target directory so the new
entry matches local convention (ID prefix, canary prefix, file
organization):

- Checkup: read `checkups/README.md` and `checkups/<agent>/README.md`.
- Red-team: read `redteam/README.md` and `redteam/<agent>/README.md`.
- Integration: read `integrations/README.md`.

Don't skip this. Each target has its own ID prefix (`OGR-OC-*` for
OpenClaw) and file layout.

## Step 3 — Draft the entry

### For a checkup

Append one entry to the appropriate `checkups/<agent>/<category>.yaml`.
Required fields: `id`, `category`, `severity`, `title`, `description`,
`patterns` (or `filename_matches` / `sha256`), `references`, `remediation`.

```yaml
- id: OGR-OC-CFG-NNN                  # next unused number in this file
  category: dangerous-config
  severity: high
  title: "one-line summary"
  description: >-
    Why this matters. Name the actor / advisory. State what the agent
    loses if this fires.
  patterns:
    - "regex_literal"                 # JS RegExp syntax, escape backslashes
  references:
    - "https://..."                   # the link the user gave you
  remediation: "what the operator should do when this fires"
```

Hard rules:

- **`references` is mandatory.** Every rule must cite a CVE, GHSA,
  upstream issue, or named-vendor writeup. If the user's only source
  is their own blog post, stop and ask them to get it upstream first.
- **IDs are unique globally.** Grep the repo for the next free number
  in the prefix range.
- **Test the pattern.** If the user provided a sample, run the regex
  against it before committing. Don't write regex from memory.

### For a red-team attack

Append one entry to `redteam/<agent>/<suite>.yaml`. Required fields:
`id`, `suite`, `severity`, `title`, `prompt`, `hit_patterns`,
`references`, `remediation`.

```yaml
- id: OGR-OC-ATT-NNN
  suite: openclaw-prompt-injection
  severity: high
  title: "one-line summary"
  prompt: |
    The exact text sent to the target. Keep it short.
    Use a unique canary like OGR-OC-CANARY-NNNNN.
  hit_patterns:
    - "OGR-OC-CANARY-NNNNN"
  references:
    - "https://..."
  remediation: "what to change in the target agent"
```

One technique per attack. If your prompt tests two things, split it.

### For an integration

Create `integrations/<host>/` with at minimum:

- A `README.md` explaining install, config, and failure mode
- One source file that wires the host's extension surface to `thomas`
- Reference the SDK at `integrations/sdk/index.ts` rather than
  reimplementing the HTTP client

Keep it small. If it takes more than ~150 lines, you're probably
building too much — ship the minimum and let users fork.

## Step 4 — Validate locally

```bash
# YAML syntax
bunx js-yaml checkups/<agent>/<file>.yaml > /dev/null

# Schema validation (if CI provides a validate script)
bun run validate 2>/dev/null || true
```

If there's a test sample for the rule, grep the sample with the
pattern to prove the regex fires.

## Step 5 — Commit

One contribution per commit. Good commit message:

```
checkups(openclaw): add OGR-OC-CFG-006 for GHSA-xxxx-gateway-bypass
```

Body (optional but nice): one line pointing at the advisory.

## Step 6 — Open the PR

```bash
gh pr create --title "checkups(openclaw): add OGR-OC-CFG-006 — <title>" \
  --body "$(cat <<'EOF'
Adds a checkup for <advisory> published at <URL>.

- **Scope:** <one sentence>
- **Tested against:** <sample / PoC if applicable>
- **Reference:** <URL>

Refs <advisory ID>.
EOF
)"
```

Then show the PR URL to the user and stop. The maintainers review from
there.

## What NOT to do

- **Do not fabricate references.** If the user can't produce a public
  advisory, say so and stop. Don't ship a rule that cites "internal
  research" — the repo's whole value is that every rule is auditable.
- **Do not edit other rules** in the same PR. One contribution per PR.
- **Do not push to `main`.** Open a PR from a branch.
- **Do not commit and push without showing the user the diff first.**
  Confirm before `gh pr create`.
- **Do not embed secrets or API keys** in example configs, even fake
  ones — reviewers will block the PR.

## When the user's reference is thin

If the user says "here's a Twitter thread, add a rule" — push back. Ask
them to either:

1. File an upstream issue with the affected project and link that here, or
2. Provide a CVE / GHSA / named-vendor writeup that already exists.

The reference bar is the whole point. A rule without a citation is a
liability for every future maintainer.
