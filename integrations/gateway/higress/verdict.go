package main

import (
	"strings"

	"github.com/tidwall/gjson"
)

// Reading a Verdict.
//
// ⚠️ Rendering a refusal is NOT here any more. What a refusal looks like is a property
// of the protocol the caller is speaking, so each adapter renders its own
// (`Refuse`/`RefuseStream`/`Retract`). This file had one OpenAI-shaped body and used it
// for every client, which meant a refused `/v1/messages` caller received a `choices[]`
// document its SDK cannot parse — surfacing to its user as the gateway being broken
// rather than as a policy decision, and to its retry logic as a malformed reply worth
// sending again.

// stopsRequest reports whether a decision must not reach the model.
//
// `require_approval` means "the runtime holds the action and asks a human". A gateway
// has nobody to ask, so it degrades to a refusal rather than passing — the conservative
// direction. Nothing in the runtime produces it today (docs/roadmap.md #1), so this is
// a guard against a future producer, not a live branch.
func stopsRequest(decision string) bool {
	return decision == "block" || decision == "require_approval"
}

// refusalReason is what the end user reads. A verdict's `reasons` are written for an
// operator, so the first one is used as-is only when it exists; the fallback says what
// happened without describing what was detected, which would hand an attacker a
// detector oracle.
func refusalReason(v gjson.Result) string {
	for _, r := range v.Get("reasons").Array() {
		if s := strings.TrimSpace(r.String()); s != "" {
			return s
		}
	}
	for _, f := range v.Get("findings").Array() {
		if t := strings.TrimSpace(f.Get("title").String()); t != "" {
			return t
		}
	}
	return "This request was refused by the organization's AI usage policy."
}

// verdict is an answer from `/evaluate`.
//
// ⚠️ ONE event in, one Verdict out. There is no batch form and no composed decision,
// because there is nothing to compose: a gateway phase is one turn, the turn is one
// event, and one event has one verdict. The batch existed only because the plugin used
// to shatter a turn into a `model_output` plus one event per tool call, and then the
// runtime had to rank fragment decisions back into an answer about the turn. Deleting
// the decomposition deleted the need for the machinery that undid it.
type verdict struct {
	root gjson.Result
}

func parseVerdict(body []byte) verdict { return verdict{root: gjson.ParseBytes(body)} }

func (v verdict) Decision() string { return v.root.Get("decision").String() }

// Stops reports whether this turn must not go through.
func (v verdict) Stops() bool { return stopsRequest(v.Decision()) }

// Reason is what the caller is told.
func (v verdict) Reason() string { return refusalReason(v.root) }

// Redacts reports whether the runtime asked for values to be removed.
func (v verdict) Redacts() bool { return v.Decision() == "redact" }

// Result is the raw verdict, for the redaction machinery that reads findings and
// modifications out of it.
func (v verdict) Result() gjson.Result { return v.root }

// Unjudged returns the payload paths that reached a detector and got NO judgement —
// the runtime answered about part of the turn and is saying which part it skipped.
//
// ⚠️ This is what makes a partial verdict distinguishable from a complete one, and
// without it `fail_mode: closed` is a promise the gateway cannot keep. One event carries
// a whole turn, so the runtime fans out per text: a reply with five tool calls is five
// judge calls. If one times out under the runtime's OWN fail-open, it contributes no
// findings and the verdict comes back looking complete — four actions judged, one never
// looked at, `decision: allow`, HTTP 200. Nothing else on the wire separates that from a
// turn where everything was judged and nothing was found.
//
// ⚠️ ABSENT OR EMPTY MEANS EVERY ROUTED TEXT WAS JUDGED. That is the only assertion
// fail-closed hangs on, and it is why this reader is safe to ship before the writer: a
// runtime that does not populate the field behaves exactly as it does today.
//
// ⚠️ COVERAGE, NOT ATTENDANCE. A path appears if ANY guardrail routed to it failed to
// judge it — not only when every one did. So a `payload.tool_calls.0` read by three tool
// judges, one of which hit a capability error, DOES appear: two guardrails answering does
// not make the path covered. That is the guarantee fail-closed is acting on, and the
// weaker reading — "somebody looked at it" — would be the original defect surviving in a
// narrower and much harder-to-find form.
//
// Entries are payload paths, exclusively, in the same vocabulary as a finding's `path`
// (see GuardEvent.at), with `""` for the primary or synthesized text. The runtime tracks
// unjudged CHECKS internally and maps them to the path of the text they were about; its
// `"<unnamed>"` placeholder for a detector that threw before its check could be named is
// internal and never reaches the wire.
//
// ⚠️ THE READER IS STILL DELIBERATELY VOCABULARY-AGNOSTIC. Nothing here parses an entry
// or resolves it against `texts`: the security property rests on NON-EMPTINESS alone, and
// entries are carried to the log verbatim for a human. Being defensive against a
// vocabulary that never arrives costs nothing; interpreting one would break the moment
// the runtime added a kind — and would break by UNDER-reporting, which is the direction
// that silently passes traffic.
func (v verdict) Unjudged() []string {
	raw := v.root.Get("x\\.ogr\\.unjudged")
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

// Partial reports whether the runtime answered about only PART of the turn.
func (v verdict) Partial() bool { return len(v.Unjudged()) > 0 }

// MustRefusePartial is the fail-mode rule for partial coverage, kept here as a pure
// function so it stays testable without a gateway (see the Makefile note).
//
// Under `closed` an unjudged text refuses the turn, which is the whole content of the
// promise: if we could not judge it, it does not go through. Under `open` it passes and
// the caller counts it, exactly as a transport failure does.
func (v verdict) MustRefusePartial(failClosed bool) bool { return failClosed && v.Partial() }

// BuffersOutput reads the response lane off an input judgement.
func (v verdict) BuffersOutput() bool {
	return v.root.Get("x\\.ogr\\.output_mode").String() == "buffer"
}
