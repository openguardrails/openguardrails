package main

import (
	"testing"

	"github.com/tidwall/gjson"
)

/*
 * A continuation must never widen what gets through. These cases pin the three ways
 * that could happen — an unknown style honoured, a directive with nothing to act on
 * honoured, and a partial edit forwarded — plus the ordering rule that decides whether
 * a multi-call drop removes the refused calls or their neighbours.
 */

func TestAnAbsentDirectiveLeavesTheHardRefusal(t *testing.T) {
	if parseVerdict([]byte(`{"decision":"block"}`)).Continuation() != nil {
		t.Fatal("a verdict with no directive must render the refusal it always did")
	}
}

func TestAnUnknownStyleIsNotGuessedAt(t *testing.T) {
	// A newer runtime naming a shape this build does not implement. Guessing is how a
	// PEP forwards what it was told to remove.
	v := parseVerdict([]byte(`{"decision":"block","continuation":{"style":"rewrite","notice":"n","paths":["payload.text"]}}`))
	if v.Continuation() != nil {
		t.Fatal("an unrecognised style must fall back to the hard refusal")
	}
}

func TestADirectiveThatActsOnNothingIsRefused(t *testing.T) {
	// `drop_calls` naming no call would append "an action was refused" to a reply in
	// which every action survived.
	v := parseVerdict([]byte(`{"decision":"block","continuation":{"style":"drop_calls","notice":"n","paths":[]}}`))
	if v.Continuation() != nil {
		t.Fatal("drop_calls with no paths must not be honoured")
	}
	// A notice is the whole content of an `answer`; without one there is nothing to say.
	v = parseVerdict([]byte(`{"decision":"block","continuation":{"style":"answer","notice":""}}`))
	if v.Continuation() != nil {
		t.Fatal("a directive with no notice must not be honoured")
	}
}

func TestAnAnswerDirectiveNeedsNoPaths(t *testing.T) {
	c := parseVerdict([]byte(`{"decision":"block","continuation":{"style":"answer","notice":"no"}}`)).Continuation()
	if c == nil || c.Style != contAnswer || c.Notice != "no" {
		t.Fatalf("answer directive not parsed: %+v", c)
	}
}

func TestTheDirectiveNeverTurnsABlockIntoAnAllow(t *testing.T) {
	v := parseVerdict([]byte(`{"decision":"block","continuation":{"style":"answer","notice":"no"}}`))
	if !v.Stops() {
		t.Fatal("a continuation must not change what the decision says")
	}
}

// --- withholding a tool result ----------------------------------------------

const twoResults = `{"messages":[{"role":"tool","content":"secret page"},{"role":"tool","content":"fine"}]}`

func TestWithholdReplacesTheWholeValue(t *testing.T) {
	out, ok := withholdTexts(twoResults, []string{"messages.0.content"}, "WITHHELD")
	if !ok {
		t.Fatal("withhold did not apply")
	}
	if gjson.Get(out, "messages.0.content").String() != "WITHHELD" {
		t.Fatalf("value not replaced: %s", out)
	}
	if gjson.Get(out, "messages.1.content").String() != "fine" {
		t.Fatal("withhold touched a result it was not asked about")
	}
}

func TestWithholdIsAllOrNothing(t *testing.T) {
	// ⚠️ One unresolvable path means this is not the body the runtime judged. A
	// partial withhold forwards the content we refused.
	if _, ok := withholdTexts(twoResults, []string{"messages.0.content", "messages.9.content"}, "W"); ok {
		t.Fatal("an unresolvable path must abort the whole withhold")
	}
	if _, ok := withholdTexts(twoResults, []string{"messages"}, "W"); ok {
		t.Fatal("a non-string target must abort the withhold")
	}
}
