# Artifact Scan API

This document uses the keywords MUST, MUST NOT, SHOULD, MAY as defined in
RFC 2119. **Status: OGR 1.2.** This is a SIBLING contract to the
[Runtime API](runtime-api.md), not part of it.

## Why this is a separate API

A runtime decides about EVENTS: a bounded JSON document, judged in front of a
caller who is waiting. A scanner decides about ARTIFACTS: an opaque byte stream
of unknown size, judged on its own clock. Pushing the second through the first —
a 300 MB sample base64'd into a decision endpoint — is the mistake this split
exists to prevent, and it is why an [obligation](obligations.md) names an
artifact rather than carrying it.

**A runtime MUST NOT proxy artifact bytes.** Whoever holds the bytes calls the
scanner directly: an enforcement point standing next to a file, or a runtime that
holds only a package name or a URL.

## The interface is pluggable, and that is the point

Nothing here requires a particular vendor. The customers who most need artifact
scanning are frequently the ones whose traffic may not leave their building, and
they usually already own a scanner they are contractually required to use. A
client MUST therefore treat the address, the credential and the provider as
CONFIGURATION.

**⚠️ The credential lives with the caller.** It is never carried in a
[Verdict](verdict.md); an obligation's `provider_hint` is a non-secret NAME and a
PEP MUST NOT treat it as an address to fetch from.

## POST /v1/analyze

```jsonc
{
  "kind": "file",              // file | package | url | text
  "source": {
    // exactly one shape, matching `kind`:
    "sha256": "b1e4…",         // file: ALWAYS sent, and often sufficient on its own
    "size": 314572800,
    "declared_type": "video/mp4",
    "head_b64": "TVqQAAMA…"    // the first 4 KiB, base64
    // "package": "npm:left-pad@9.9.9"
    // "url": "https://cdn.example.com/report.xlsm"
    // "text": "…instructions an agent pulled into context…"
  },
  "model": "",                 // OPTIONAL: the vendor's own service-level selector
  "context": {                 // OPTIONAL, sharpens the verdict, never required
    "agent_id": "invoice-bot",
    "reason": "about to open an email attachment"
  }
}
```

**`kind: package` MUST be ecosystem-qualified** (`npm:`, `pypi:`, `rubygems:`,
`crates:`, `go:`). `left-pad` names a different thing on npm and on PyPI, and a
reputation answer about the wrong registry is worse than no answer.

**`model` is the vendor's SERVICE-LEVEL selector**, passed through untouched — a
scanner offering a fast tier and a deep tier names them the way a model gateway
does. It is OPTIONAL and defaults to `""`; an adapter in front of a scanner that
has no such notion MUST leave it empty rather than invent a value.

### Responses

```jsonc
200 {"id": "an_9f2c8b1e", "verdict": "malicious",   // clean | suspicious | malicious
     "confidence": 0.97, "family": "downloader/vba",
     "reasoning": "Auto-open macro decodes a base64 blob and runs it…",
     "detected_type": "application/x-dosexec",
     "iocs": {"sha256": "b1e4…", "hosts": ["a3f2c9d1.top"]},
     "report_url": "https://…/r/an_9f2c8b1e"}

206 {"status": "need_ranges", "id": "an_9f2c8b1e",  // send these byte ranges
     "ranges": [{"start": 0, "end": 1048576}, {"start": 314572800, "end": -1}]}

202 {"status": "queued", "id": "an_9f2c8b1e"}       // poll GET /v1/analysis/{id}

413 {"error": "artifact_too_large", "limit_bytes": 268435456}
```

**⚠️ THE VERDICT IS A DETECTION, NOT AN OUTCOME.** `suspicious` is an answer;
whether it stops an action is the calling policy's decision. A scanner MUST NOT
be given, and MUST NOT assume, authority over what happens next.

**⚠️ A client MUST NOT manufacture a pass.** A `202` it does not poll, a non-2xx,
an unparseable body and a verdict outside the three-state vocabulary are all
FAILURES, and a caller MUST record them as such. "We asked and could not find
out" is a fact worth keeping; converting it to `clean` is the one error in this
protocol that cannot be detected afterwards.

## Hash first, then only the ranges the server asks for

This is what lets a 300 MB sample be answered without a 300 MB upload, and it is
part of the contract rather than each integrator's private optimisation.

1. The client computes `sha256` while streaming the artifact **locally** and sends
   the hash, the size, the declared type and the first 4 KiB.
2. A known hash — or a head that settles it — answers at step 1, with no upload.
3. Otherwise the server replies `206 need_ranges` naming the byte ranges it wants;
   the client PUTs them and re-asks.

A client MUST bound the loop (**≤3 rounds**) and MUST honour its own configured
upload ceiling. A server MAY answer at any round.

**⚠️ Range negotiation is OPTIONAL for a server.** An adapter in front of a
signature scanner cannot do it and answers `need_ranges: [{start: 0, end: -1}]` —
send everything, up to the cap. Making it mandatory would exclude exactly the
on-premise scanners this pluggability exists to admit.

**⚠️ The client MUST NOT decide an artifact is "small enough to just upload".**
Head-first is the path for every artifact; a small file simply has one range and
the loop ends immediately. Two code paths is where the 300 MB one goes untested.

## `declared_type` vs `detected_type`

The name claims a type; the bytes are the type. A server that identifies the
bytes SHOULD return `detected_type`, and a client SHOULD report a disagreement as
a finding in its own right — a 300 MB executable wearing an `.mp4` name is
exactly that disagreement.

**⚠️ It is the cheapest and most durable signal in this contract.** It needs the
first few KiB and a magic-number table, and it survives a refused upload, an
exhausted quota and an unreachable server. A client SHOULD compute it locally and
report it even when no analysis completed.

## Errors, and the posture in front of them

A caller MUST choose what happens when the scanner does not answer, and an
implementation MUST make that choice explicit rather than defaulting to one:

- **proceed** — the action goes ahead; the failure is recorded.
- **refuse** — the action is stopped.

Neither is safe in general: failing open silently removes the control at exactly
the moment it is needed, and failing closed turns the scanner's outage into the
customer's outage. This is the same trade the runtime's own detector fail-mode
makes, and the same reason it is configured rather than assumed.

## What a scanner is not told

A request carries the artifact and, optionally, a `context` that helps
attribution. It MUST NOT be sent the agent's conversation, its system prompt, or
its user's identity: none of that changes whether a file is hostile, and a
malware pipeline is not a place a customer's prompts belong.
