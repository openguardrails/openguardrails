package main

import (
	"strconv"
	"strings"

	"github.com/tidwall/gjson"
	"github.com/tidwall/sjson"
)

/*
 * THE RENDERING DIRECTIVE — how the runtime asks us to say no (OGR 1.3, 2026-08-28).
 *
 * ⚠️⚠️ **IT NEVER TURNS A REFUSAL INTO AN ALLOW.** `decision` is still `block` and
 * `Stops()` still answers true; this only selects WHICH refusal shape the caller gets.
 * The runtime derives the style from where the blocking findings sat — see the
 * platform's `policy-engine/continuation.ts` — because the position is what decides
 * whether a partial rendering is honest at all.
 *
 * ⚠️ **ABSENT IS THE NORMAL CASE AND MEANS "REFUSE AS YOU ALWAYS DID".** An older
 * runtime sends nothing, a runtime that could not name an honest shape sends nothing,
 * and both must land on the hard refusal. Every reader here therefore tests for a
 * style it KNOWS, never for "not empty" — an unrecognised style is a directive from a
 * newer runtime, and guessing at it is how a PEP forwards what it was told to remove.
 */

// continuationStyle values this build understands. Anything else falls back to a hard
// refusal, which is the strict side.
const (
	contDropCalls = "drop_calls"
	contWithhold  = "withhold"
	contAnswer    = "answer"
)

type continuation struct {
	Style  string
	Notice string
	Paths  []string
}

// Continuation returns the rendering directive, or nil when there is none or it names
// a style this build does not implement.
//
// ⚠️ A directive with a style we know but NO paths is rejected for the two styles that
// act on paths. A `drop_calls` naming nothing would append a notice saying an action
// was refused to a reply in which every action survived — the shape that reads as a
// working control and is not one.
func (v verdict) Continuation() *continuation {
	raw := v.root.Get("continuation")
	if !raw.Exists() {
		return nil
	}
	c := &continuation{
		Style:  raw.Get("style").String(),
		Notice: raw.Get("notice").String(),
	}
	for _, p := range raw.Get("paths").Array() {
		if s := p.String(); s != "" {
			c.Paths = append(c.Paths, s)
		}
	}
	if c.Notice == "" {
		return nil
	}
	switch c.Style {
	case contAnswer:
		return c
	case contDropCalls, contWithhold:
		if len(c.Paths) == 0 {
			return nil
		}
		return c
	default:
		return nil
	}
}

// StrippedPaths are the directive's paths in the form gjson/sjson address the body
// with — the same `payload.` strip the span applier does, for the same reason: the
// runtime speaks payload paths and this body has no `payload` wrapper.
func (c *continuation) StrippedPaths() []string {
	out := make([]string, 0, len(c.Paths))
	for _, p := range c.Paths {
		if s := stripPayloadPrefix(p); s != "" {
			out = append(out, s)
		}
	}
	return out
}

/*
 * DroppedOrdinals are the tool-call positions this directive refuses, read off the
 * trailing index of each path.
 *
 * ⚠️ The STREAM lane has no body to address, only the reassembled call list, so the
 * only thing a path can contribute there is WHICH call. A path whose tail is not an
 * integer contributes nothing rather than being guessed at — and the caller treats an
 * empty result as "cannot render survivors", which falls back to dropping the tail
 * whole. Guessing here would keep a refused call.
 */
func (c *continuation) DroppedOrdinals() []int {
	out := make([]int, 0, len(c.Paths))
	for _, p := range c.Paths {
		cut := strings.LastIndex(p, ".")
		if cut < 0 {
			return nil
		}
		n, err := strconv.Atoi(p[cut+1:])
		if err != nil || n < 0 {
			return nil
		}
		out = append(out, n)
	}
	return out
}

/*
 * withholdTexts replaces the text at each path with the notice and returns the new
 * body — the REQUEST-side continuation, and the only shape here that gives an agent
 * loop the same thing Claude Code's classifier gives it: a tool result that says why
 * it is not there, in a request that then proceeds normally.
 *
 * ⚠️⚠️ **NOTHING IS LEARNED INTO THE SESSION MAPPING, and that is the load-bearing
 * difference from `applySpans`.** A redaction's replacement is a placeholder the PEP
 * puts BACK on the way home; a withheld tool result must never come back. Feeding this
 * to the restore map would have the model's own reply rehydrate the exfiltrated page
 * we just removed — the control inverted, silently, on the return path.
 *
 * ⚠️ WHOLE-VALUE replacement, never a span. The runtime judged the entire tool result,
 * so offsets into it name nothing we want to keep; and a partial replacement would
 * leave the untrusted remainder in front of the model under a notice claiming it was
 * withheld.
 *
 * ⚠️ ALL OR NOTHING, like every other multi-path edit here. A path that does not
 * resolve means the body is not the one the runtime judged, and a partial withhold
 * forwards the content we refused.
 */
func withholdTexts(body string, paths []string, notice string) (string, bool) {
	if len(paths) == 0 {
		return body, false
	}
	for _, p := range paths {
		if gjson.Get(body, p).Type != gjson.String {
			return body, false
		}
	}
	out := body
	for _, p := range paths {
		next, err := sjson.Set(out, p, notice)
		if err != nil {
			return body, false
		}
		out = next
	}
	return out, true
}
