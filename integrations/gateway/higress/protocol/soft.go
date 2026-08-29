package protocol

import (
	"sort"
	"strconv"
	"strings"

	"github.com/tidwall/gjson"
)

/*
 * CONTINUATIONS — saying no in a shape an agent loop survives (2026-08-28).
 *
 * ⚠️⚠️ **NOTHING HERE WEAKENS A REFUSAL.** The action does not happen, the withheld
 * content does not reach the model, and the runtime still recorded `decision: block`.
 * What changes is the TOKEN the turn ends on.
 *
 * `Refuse` above renders `finish_reason: "content_filter"` / `stop_reason: "refusal"`,
 * and that was a deliberate choice: "the finish reason states WHY the turn ended, and a
 * client that logs or retries on it must be able to tell a refusal from a completed
 * reply." Correct for a chatbot client. Fatal for an agent, because those two strings
 * are exactly what every harness treats as TERMINAL — measured on hermes, whose
 * `conversation_loop.py` branches on `finish_reason == "content_filter"` alone: never
 * retried, fallback provider attempted, session ended. One refused tool call killed a
 * nine-step task.
 *
 * So the WHY moves off the finish reason and into two places that no loop branches on:
 * the `x_ogr` object these renderers attach to the body, and the notice the model reads.
 * A client that wants to log refusals reads `x_ogr.decision`; a client that wants to
 * keep working reads a normal stop. Both are served, which the single overloaded token
 * could not do.
 *
 * ⚠️ The hard `Refuse` stays and is still the default: a continuation is rendered ONLY
 * when the runtime sent a directive saying which shape is honest for this verdict. No
 * directive ⇒ nothing changed.
 */

// xOGR is the machine-readable marker spliced into every soft rendering — what a
// client that cares about refusals reads now that the finish reason no longer says it.
//
// ⚠️ A body key rather than a header, because the response path rewrites bytes AFTER
// headers have gone out (`ReplaceHttpResponseBody`), so a header is not available at
// the one site that needs this most. One mechanism at both sites beats two that differ.
func xOGR(style string) map[string]any {
	return map[string]any{"decision": "block", "continuation": style}
}

// dropGroups orders the paths so that deleting one cannot shift the offsets of the
// next: within each parent array, DEEPEST INDEX FIRST.
//
// ⚠️⚠️ This is the whole correctness of a multi-call drop. `tool_calls.0` and
// `tool_calls.2` deleted in that order removes the refused call and then the WRONG
// one — the element that slid into index 2 is a call the policy allowed. Same rule the
// span applier already follows for the same reason.
func dropGroups(paths []string) []string {
	type entry struct {
		path   string
		parent string
		idx    int
	}
	entries := make([]entry, 0, len(paths))
	for _, p := range paths {
		cut := strings.LastIndex(p, ".")
		if cut < 0 {
			return nil
		}
		idx, err := strconv.Atoi(p[cut+1:])
		if err != nil {
			// Not an array element. A continuation names whole calls; anything else
			// is a directive we do not understand, and half-understanding it is how a
			// PEP forwards the thing it was told to remove.
			return nil
		}
		entries = append(entries, entry{path: p, parent: p[:cut], idx: idx})
	}
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].parent != entries[j].parent {
			return entries[i].parent < entries[j].parent
		}
		return entries[i].idx > entries[j].idx
	})
	out := make([]string, 0, len(entries))
	for _, e := range entries {
		out = append(out, e.path)
	}
	return out
}

// allResolve reports whether every path names something that is actually there.
//
// ⚠️⚠️ ALL OR NOTHING, and the caller must fall back to a hard refusal on false. A
// partial drop forwards some refused calls under a notice that says they were refused
// — a reply that looks like the control worked. Refusing the whole turn is the worse
// user experience and the only honest one.
func allResolve(body string, paths []string) bool {
	for _, p := range paths {
		if !gjson.Get(body, p).Exists() {
			return false
		}
	}
	return len(paths) > 0
}

// withNotice joins the model's surviving prose and our notice.
//
// ⚠️ The notice goes AFTER, never instead. What the model already said is its own
// output and stays in the record the client renders; replacing it would hide the
// reasoning that led to the refused action from the person reviewing it.
func withNotice(existing, notice string) string {
	if strings.TrimSpace(existing) == "" {
		return notice
	}
	return existing + "\n\n" + notice
}
