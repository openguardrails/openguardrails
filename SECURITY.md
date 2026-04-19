# Security Policy

## Reporting a vulnerability in `thomas` or this repository

Email **security@openguardrails.com** with:

- A description of the issue
- Reproduction steps or a PoC
- Your expected impact
- Whether the issue is public or under embargo

We acknowledge within 2 business days. Critical issues are patched on an
accelerated timeline and coordinated with the reporter.

**Do not open a public GitHub issue** for a vulnerability in the
`thomas` CLI, the OpenGuardrails service, or this repository's
infrastructure.

## Scope

In scope:

- The `thomas` CLI (shipped via `@openguardrails/thomas-security`)
- The OpenGuardrails service (`api.openguardrails.com`)
- Any integration source under [`integrations/`](./integrations)
- Any malformed-input parsing issue in `checkups/` or `redteam/` YAML

Out of scope:

- **Vulnerabilities in target agents** (OpenClaw, Claude Code, Cursor,
  etc.). Report those to the upstream project, *then* open a PR here
  adding the public advisory as a new checkup.
- Vulnerabilities in third-party dependencies — report upstream.

## Disclosure policy

We follow coordinated disclosure. We credit reporters in the release
notes unless asked not to. We ask for 90 days before public disclosure,
extendable by mutual agreement if a fix is in progress.

## Signing and integrity

The `thomas` CLI binary is signed. Verify the signature before trusting
an install outside the official channels. See the install instructions
at https://openguardrails.com for current signing keys.
