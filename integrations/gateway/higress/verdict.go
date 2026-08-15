package main

import (
	"github.com/tidwall/gjson"
)

// Reading a v0.8 Verdict: {event_id, provider, decision, findings?,
// modifications?, unjudged?, latency_ms?}.
//
// Two decisions: `allow` | `block`. Redaction is not a decision — a non-empty
// `modifications.spans` on an allow says it, and the spans are applied to the body
// before it is forwarded (redact.go). This reader reads ONLY the v0.8 names, by
// design — the runtime ships in lockstep on the same branch, and a reader that
// quietly accepted retired names would hide a half-upgraded deployment forever.
//
// What v0.8 removed from the verdict, and why nothing here misses it: the
// `session_id`/`turn`/`step` echo and `attribution` (the ledger lives entirely in
// the runtime; this gateway had no decision to make from them), and `output_mode`
// (streaming enforcement is now the gateway's own held-back tail — tailhold.go —
// so the runtime no longer selects a lane to report).
//
// Rendering a refusal is NOT here. What a refusal looks like is a property of the
// protocol the caller is speaking, so each adapter renders its own
// (`Refuse`/`RefuseStream`/`Retract`).

// verdict is an answer from `/evaluate`.
//
// ⚠️ ONE event in, one Verdict out. There is no batch form and no composed decision:
// a step half is one event, and one event has one verdict.
type verdict struct {
	root gjson.Result
}

func parseVerdict(body []byte) verdict { return verdict{root: gjson.ParseBytes(body)} }

func (v verdict) Decision() string { return v.root.Get("decision").String() }

// Stops reports whether this event must not go through. v0.8 has exactly one
// stopping decision.
func (v verdict) Stops() bool { return v.Decision() == "block" }

// Reason is what the caller is told. The verdict deliberately carries no prose
// `reasons` — findings are structured, and describing what was detected would hand an
// attacker a detector oracle — so the refusal is a fixed sentence.
func (v verdict) Reason() string {
	return "This request was refused by the organization's AI usage policy."
}

// Spans returns the modification spans the runtime asks this PEP to apply in place:
// {path, start, end, replacement}, offsets counted in characters against the payload
// AS TRANSPORTED.
func (v verdict) Spans() []Span {
	raw := v.root.Get("modifications.spans")
	if !raw.IsArray() {
		return nil
	}
	items := raw.Array()
	out := make([]Span, 0, len(items))
	for _, s := range items {
		out = append(out, Span{
			Path:        s.Get("path").String(),
			Start:       int(s.Get("start").Int()),
			End:         int(s.Get("end").Int()),
			Replacement: s.Get("replacement").String(),
		})
	}
	return out
}

// Unjudged returns the payload paths that reached a detector and got NO judgement —
// the runtime answered about part of the event and is saying which part it skipped.
//
// ⚠️ This is what makes a partial verdict distinguishable from a complete one, and
// without it `fail_mode: closed` is a promise the gateway cannot keep. The runtime
// fans out per text — a reply with five tool calls is five judge calls — and one
// failing under the runtime's OWN fail-open contributes no findings while the verdict
// comes back looking complete.
//
// ⚠️ ABSENT OR EMPTY MEANS EVERY ROUTED TEXT WAS JUDGED. That is the only assertion
// fail-closed hangs on.
//
// ⚠️ COVERAGE, NOT ATTENDANCE. A path appears if ANY guardrail routed to it failed to
// judge it — two others answering does not make the path covered.
//
// ⚠️ THE READER IS DELIBERATELY VOCABULARY-AGNOSTIC. Nothing here parses an entry or
// resolves it against the payload: the security property rests on NON-EMPTINESS
// alone, and entries are carried to the log verbatim for a human. Interpreting them
// would break the moment the runtime added a kind — and would break by
// UNDER-reporting, which is the direction that silently passes traffic.
func (v verdict) Unjudged() []string {
	raw := v.root.Get("unjudged")
	if !raw.IsArray() {
		return nil
	}
	items := raw.Array()
	out := make([]string, 0, len(items))
	for _, p := range items {
		out = append(out, p.String())
	}
	return out
}

// Partial reports whether the runtime answered about only PART of the event.
func (v verdict) Partial() bool { return len(v.Unjudged()) > 0 }

// MustRefusePartial is the fail-mode rule for partial coverage, kept as a pure
// function so it stays testable without a gateway.
//
// Under `closed` an unjudged text refuses the event, which is the whole content of
// the promise: if we could not judge it, it does not go through. Under `open` it
// passes and the caller counts it, exactly as a transport failure does.
func (v verdict) MustRefusePartial(failClosed bool) bool { return failClosed && v.Partial() }

// Usable reports whether this is a VERDICT at all.
//
// ⚠️ A 200 is not a verdict. An empty body, an HTML error page from something in
// front of the runtime, or a JSON document of another shape all parse without error
// and answer `""` to every question — so every "did it stop?" test says no and the
// traffic goes through as an ALLOW that nobody made. `fail_mode` does not cover it,
// because fail_mode is consulted on non-200 and transport failures only. Every caller
// of `parseVerdict` on a 200 must gate on this and route a false through the same
// failure path as an unreachable runtime.
func (v verdict) Usable() bool { return v.Decision() != "" }
