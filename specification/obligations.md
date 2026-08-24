# Obligations

This document uses the keywords MUST, MUST NOT, SHOULD, MAY as defined in
RFC 2119. **Status: OGR 1.2, additive-optional.** A 1.0/1.1 producer or
enforcement point is unaffected by everything here.

## What an obligation is, and why the verdict needed a new idea

Every other field a runtime emits describes a decision it already made. An
**obligation** is different: it is something the enforcement point MUST DO before
the action proceeds, carried **alongside** a decision that is still `allow`.

It exists because of a gap no amount of judging closes. A tool call says *"read
`/tmp/report.xlsm`"*, *"npm install left-pad@9.9.9"*, *"git clone http://…"*. The
BYTES are on the agent's host. A decision point standing in the model path has
never seen them and cannot get them — and a 300 MB sample must never be pushed
through a JSON decision endpoint in front of a waiting caller. So the runtime does
the one thing its position lets it do: it **names what is about to be opened, and
requires an answer about it**.

```
step/response  ──▶  verdict: allow + obligations[scan_artifact]
                       │
   PEP ────────────────┤  resolve the artifact · sniff its header · hash it ·
                       │  ask a scanner (see [artifact-scan.md](artifact-scan.md))
step/request   ◀───────┘  tool_results[…]  +  obligation_results[…]
```

## Rules

**An obligation is not a decision.** `decision` stays `allow` | `block`, and
obligations take no part in composition. A PEP that fulfils an obligation and gets
a clean answer proceeds under the `allow` it already had.

**A runtime MUST NOT rest a control on an obligation being fulfilled.** The key is
optional, so a conformant PEP may ignore it entirely — and many will. What an
ignored obligation buys is not enforcement but MEASUREMENT: the next step arrives
with no result, the runtime records the obligation as unfulfilled, and the fraction
that go unfulfilled is the honest statement of how real this control is in a given
deployment. A runtime that treated an ignored obligation as an assurance would be
claiming a coverage nobody provided.

**⚠️ THE VERDICT CARRIES NO ENDPOINT AND NO CREDENTIAL.** `provider_hint` is a
non-secret NAME so a policy can express *"this workspace scans with the corporate
appliance"*. A PEP MAY ignore it and **MUST NOT** treat it as an address to fetch
from. Whoever makes the scan call holds the scan credential: a PEP scanning a local
file holds its own, and a runtime scanning a package name holds its own. The
decision channel is not a credential-distribution channel — a verdict frequently
crosses into a different trust zone from the console that configured the policy.

**⚠️ A LOCATOR IS THE AGENT'S STRING.** `./report.xlsm` means whatever the agent's
working directory makes it mean, and the runtime does not know what that is. A
runtime MUST NOT resolve, normalise or rewrite a locator, and a PEP MUST interpret
it in the agent's own frame.

**⚠️ `declared_type` IS A CLAIM.** It is what the NAME says — an extension, nothing
more. Its value is precisely that the bytes can contradict it: a 300 MB executable
wearing an `.mp4` name is a `declared_type` that the file's first few KiB disagree
with, and that disagreement is a finding on its own.

## Fulfilment

A PEP that acts on an obligation reports the outcome in `obligation_results[]` on
the **next** `step/request` — beside the `tool_results` for the same calls. That is
not a convenience: it is the shape the contract already has, so a fulfilment needs
no extra round trip and no second endpoint on the hot path.

```json
{"obligation_results": [
  {"id": "…", "state": "fulfilled", "verdict": "malicious",
   "provider": "malware0", "analysis_id": "an_9f2c",
   "detected_type": "application/x-dosexec"}]}
```

`state` is `fulfilled` | `failed` | `skipped`. **A PEP that will not scan SHOULD
report `skipped`** rather than staying silent: silence and refusal are different
facts, and only one of them is a decision somebody made.

**⚠️ A RESULT IS SELF-DECLARED.** Nothing bounds what a PEP claims. A PEP that
called no scanner and reported `clean` is byte-identical to one that called and was
told `clean`. Therefore a runtime MUST NOT treat a reported result as verified, MUST
NOT make it an input to authorization, and any surface that displays it MUST
attribute it to the reporter rather than presenting it as established. The only
thing that closes this gap is an ATTESTATION delivered by the scanner itself, out of
band, which only a scanner the operator also runs can offer.

**⚠️ The scanner is a DETECTOR, not the decider.** `suspicious` is an answer, not an
outcome: whether it stops the action is the runtime policy's decision, exactly as a
guardrail's severity is graded by policy rather than by the model that produced it.

## What obligations do NOT do

**Post-hoc blocking is weaker, and an implementation MUST say which it has.** Only a
PEP running inside the agent's process can stop the *read*. A gateway in the model
path can only stop the *next action* — the file is already in the context by then.
Both are useful; describing the second as the first is not.

`require_approval` — the runtime holding an action and asking a person — is the
intended second obligation type and is deliberately **not** specified here. Its
composition question (an approval clears whose findings, exactly?) is unresolved,
and putting the word on the wire before the semantics exist invites a producer to
emit it.
