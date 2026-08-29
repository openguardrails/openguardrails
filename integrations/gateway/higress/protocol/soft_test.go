package protocol

import (
	"strings"
	"testing"

	"github.com/tidwall/gjson"
)

/*
 * The continuation renderings. What every case here is really guarding is that a
 * refusal stays a refusal: the refused call is gone, the survivors are the ones the
 * policy allowed, and no rendering claims a completion it did not deliver.
 */

const chatTwoCalls = `{"choices":[{"index":0,"finish_reason":"tool_calls","message":{"role":"assistant","content":"working on it","tool_calls":[
{"id":"a","type":"function","function":{"name":"safe","arguments":"{}"}},
{"id":"b","type":"function","function":{"name":"danger","arguments":"{}"}},
{"id":"c","type":"function","function":{"name":"alsosafe","arguments":"{}"}}]}}]}`

func TestDropCallsKeepsTheCallsThePolicyAllowed(t *testing.T) {
	out, ok := openAIChat{}.DropCalls(chatTwoCalls,
		[]string{"choices.0.message.tool_calls.1"}, "NOTICE")
	if !ok {
		t.Fatal("drop failed")
	}
	calls := gjson.Get(out, "choices.0.message.tool_calls").Array()
	if len(calls) != 2 {
		t.Fatalf("want 2 survivors, got %d", len(calls))
	}
	for _, c := range calls {
		if c.Get("function.name").String() == "danger" {
			t.Fatal("the refused call survived")
		}
	}
	// ⚠️ The loop only continues if the finish reason still says there is work.
	if gjson.Get(out, "choices.0.finish_reason").String() != "tool_calls" {
		t.Fatal("surviving calls must keep finish_reason tool_calls")
	}
	if !strings.Contains(gjson.Get(out, "choices.0.message.content").String(), "NOTICE") {
		t.Fatal("the model was not told why")
	}
	// The model's own words stay: they are what a reviewer reads to see the intent.
	if !strings.Contains(gjson.Get(out, "choices.0.message.content").String(), "working on it") {
		t.Fatal("the model's prose was destroyed")
	}
}

/*
 * ⚠️⚠️ THE INDEX-SHIFT TRAP. Dropping 0 and 2 in ascending order deletes the refused
 * first call and then the element that SLID INTO index 2 — which is the one call the
 * policy allowed. The survivor must be `safe2`, never `danger2`.
 */
func TestDroppingSeveralCallsDoesNotRemoveTheirNeighbours(t *testing.T) {
	body := `{"choices":[{"index":0,"finish_reason":"tool_calls","message":{"role":"assistant","content":"","tool_calls":[
{"id":"a","function":{"name":"danger1","arguments":"{}"}},
{"id":"b","function":{"name":"safe2","arguments":"{}"}},
{"id":"c","function":{"name":"danger2","arguments":"{}"}}]}}]}`
	out, ok := openAIChat{}.DropCalls(body,
		[]string{"choices.0.message.tool_calls.0", "choices.0.message.tool_calls.2"}, "N")
	if !ok {
		t.Fatal("drop failed")
	}
	calls := gjson.Get(out, "choices.0.message.tool_calls").Array()
	if len(calls) != 1 || calls[0].Get("function.name").String() != "safe2" {
		t.Fatalf("wrong survivor: %s", gjson.Get(out, "choices.0.message.tool_calls").Raw)
	}
}

func TestDroppingEveryCallEndsTheTurnCleanly(t *testing.T) {
	out, ok := openAIChat{}.DropCalls(chatTwoCalls, []string{
		"choices.0.message.tool_calls.0",
		"choices.0.message.tool_calls.1",
		"choices.0.message.tool_calls.2",
	}, "NOTICE")
	if !ok {
		t.Fatal("drop failed")
	}
	// ⚠️ `tool_calls` with nothing in it leaves a harness waiting for calls that will
	// never arrive.
	if gjson.Get(out, "choices.0.message.tool_calls").Exists() {
		t.Fatal("an empty tool_calls array was left behind")
	}
	if gjson.Get(out, "choices.0.finish_reason").String() != "stop" {
		t.Fatal("a reply with no surviving call must finish on stop")
	}
	if strings.Contains(out, "content_filter") {
		t.Fatal("a continuation must never emit the terminal token")
	}
}

func TestAnUnresolvablePathAbortsTheWholeDrop(t *testing.T) {
	// ⚠️ A partial drop forwards refused calls under a notice claiming they were
	// refused. The caller falls back to a hard refusal on false.
	if _, ok := (openAIChat{}).DropCalls(chatTwoCalls,
		[]string{"choices.0.message.tool_calls.1", "choices.0.message.tool_calls.9"}, "N"); ok {
		t.Fatal("an unresolvable path must abort the drop")
	}
	if _, ok := (openAIChat{}).DropCalls(chatTwoCalls,
		[]string{"choices.0.message.content"}, "N"); ok {
		t.Fatal("a non-element path must abort the drop")
	}
}

// --- anthropic ---------------------------------------------------------------

const msgWithCall = `{"type":"message","role":"assistant","stop_reason":"tool_use","content":[
{"type":"text","text":"let me look"},
{"type":"tool_use","id":"a","name":"danger","input":{}},
{"type":"tool_use","id":"b","name":"safe","input":{}}]}`

func TestAnthropicDropCallsAppendsItsOwnBlock(t *testing.T) {
	out, ok := anthropicMessages{}.DropCalls(msgWithCall, []string{"content.1"}, "NOTICE")
	if !ok {
		t.Fatal("drop failed")
	}
	blocks := gjson.Get(out, "content").Array()
	for _, b := range blocks {
		if b.Get("name").String() == "danger" {
			t.Fatal("the refused call survived")
		}
	}
	last := blocks[len(blocks)-1]
	if last.Get("type").String() != "text" || last.Get("text").String() != "NOTICE" {
		t.Fatalf("notice not appended as its own block: %s", last.Raw)
	}
	if gjson.Get(out, "stop_reason").String() != "tool_use" {
		t.Fatal("a surviving call must keep stop_reason tool_use")
	}
}

func TestAnthropicDropOfEveryCallEndsTheTurn(t *testing.T) {
	out, ok := anthropicMessages{}.DropCalls(msgWithCall, []string{"content.1", "content.2"}, "N")
	if !ok {
		t.Fatal("drop failed")
	}
	if gjson.Get(out, "stop_reason").String() != "end_turn" {
		t.Fatal("no surviving call must end the turn, not refuse it")
	}
	if strings.Contains(out, `"refusal"`) {
		t.Fatal("a continuation must never emit the terminal stop reason")
	}
	// The model's prose survived the drop.
	if gjson.Get(out, "content.0.text").String() != "let me look" {
		t.Fatal("the model's prose was destroyed")
	}
}

// --- the soft refusals -------------------------------------------------------

/*
 * ⚠️⚠️ THE WHOLE POINT, in one assertion per protocol: the terminal token is what
 * every agent harness branches on, so a soft rendering that still carries it fixes
 * nothing. Measured on hermes: `finish_reason == "content_filter"` alone ends the
 * session.
 */
func TestNoSoftRenderingCarriesATerminalToken(t *testing.T) {
	for _, p := range []Protocol{openAIChat{}, anthropicMessages{}, openAIResponses{}} {
		for _, out := range []string{
			p.SoftRefuse("m", "NOTICE"),
			p.SoftRefuseStream("m", "NOTICE"),
		} {
			if strings.Contains(out, "content_filter") || strings.Contains(out, `"refusal"`) {
				t.Fatalf("%s emitted a terminal token: %s", p.Name(), out)
			}
			if !strings.Contains(out, "NOTICE") {
				t.Fatalf("%s dropped the notice", p.Name())
			}
			// The refusal is still SAYABLE — just not on the finish reason.
			if !strings.Contains(out, `"decision":"block"`) && !strings.Contains(out, "x_ogr") {
				t.Fatalf("%s lost the machine-readable marker: %s", p.Name(), out)
			}
		}
	}
}

func TestSoftRefusalsEndOnANormalCompletion(t *testing.T) {
	if gjson.Get(openAIChat{}.SoftRefuse("m", "n"), "choices.0.finish_reason").String() != "stop" {
		t.Fatal("chat soft refusal did not finish on stop")
	}
	if gjson.Get(anthropicMessages{}.SoftRefuse("m", "n"), "stop_reason").String() != "end_turn" {
		t.Fatal("messages soft refusal did not end the turn")
	}
	if gjson.Get(openAIResponses{}.SoftRefuse("m", "n"), "status").String() != "completed" {
		t.Fatal("responses soft refusal did not complete")
	}
}

func TestASoftStreamIsComplete(t *testing.T) {
	// A truncated event sequence leaves an SDK waiting rather than rendering anything.
	out := openAIChat{}.SoftRefuseStream("m", "n")
	if !strings.Contains(out, "[DONE]") {
		t.Fatal("chat soft stream never terminated")
	}
	out = anthropicMessages{}.SoftRefuseStream("m", "n")
	for _, ev := range []string{"message_start", "content_block_delta", "message_delta", "message_stop"} {
		if !strings.Contains(out, ev) {
			t.Fatalf("messages soft stream missing %s", ev)
		}
	}
}

// --- the streaming survivor rendering ----------------------------------------

func TestDropCallsStreamReEmitsOnlyTheSurvivors(t *testing.T) {
	out, ok := openAIChat{}.DropCallsStream("m", []Action{
		{ID: "a", Name: "run", Arguments: `{"command":"echo alpha"}`},
		{ID: "c", Name: "run", Arguments: `{"command":"echo gamma"}`},
	}, "NOTICE")
	if !ok {
		t.Fatal("chat could not render survivors")
	}
	if !strings.Contains(out, "echo alpha") || !strings.Contains(out, "echo gamma") {
		t.Fatal("a surviving call was not re-emitted")
	}
	// ⚠️ The loop only continues if the finish reason says there is work left.
	if !strings.Contains(out, `"finish_reason":"tool_calls"`) {
		t.Fatal("survivors must finish on tool_calls")
	}
	if !strings.Contains(out, "NOTICE") {
		t.Fatal("the agent was not told why the other call is missing")
	}
	if strings.Contains(out, "content_filter") {
		t.Fatal("a continuation must never emit the terminal token")
	}
	if !strings.Contains(out, "[DONE]") {
		t.Fatal("the stream never terminated")
	}
	/*
	 * ⚠️ Indexes renumbered from zero. Index is the client's accumulator key, so
	 * keeping call 2's original index after call 0 was refused leaves a hole that
	 * some clients render as an empty call.
	 */
	if !strings.Contains(out, `"index":0`) || !strings.Contains(out, `"index":1`) {
		t.Fatalf("survivors were not renumbered: %s", out)
	}
}

func TestDropCallsStreamWithNoSurvivorsStillEndsCleanly(t *testing.T) {
	out, ok := openAIChat{}.DropCallsStream("m", nil, "NOTICE")
	if !ok {
		t.Fatal("render failed")
	}
	if !strings.Contains(out, `"finish_reason":"stop"`) {
		t.Fatal("nothing surviving must finish on stop, not tool_calls")
	}
	if strings.Contains(out, "content_filter") {
		t.Fatal("a continuation must never emit the terminal token")
	}
}

// The two that cannot express it say so, rather than emitting something wrong.
func TestProtocolsThatCannotRenderSurvivorsDecline(t *testing.T) {
	for _, p := range []Protocol{anthropicMessages{}, openAIResponses{}} {
		if _, ok := p.DropCallsStream("m", []Action{{ID: "a", Name: "run"}}, "N"); ok {
			t.Fatalf("%s claimed a rendering it cannot address safely", p.Name())
		}
	}
}
