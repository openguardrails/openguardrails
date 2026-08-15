package protocol

import (
	"strings"
	"testing"

	"github.com/tidwall/gjson"
)

// ONE agent conversation, written three times.
//
// This is the test that makes "multi-protocol" mean something. Each case below is the
// SAME exchange — a system prompt, a question, a tool call, its result, and a follow-up
// — expressed natively in each protocol. Whatever they disagree about on the wire, they
// must agree about here, because everything above this package reads only the neutral
// model and cannot tell them apart.
//
// A contributor adding a protocol adds one row and gets the whole contract checked.

type conformanceCase struct {
	name string
	// path this protocol is served on, for the detection check
	path string
	// the shared conversation, in this protocol
	request string
	// a reply carrying prose AND a tool call
	response string
	// a stream of that same reply
	stream string
	// where masking must reach: values that appear in the request body and must all be
	// gone after Mask
	maskValues []string
}

const sharedSystem = "You are a coding agent."

var conformance = []conformanceCase{
	{
		name: "openai.chat",
		path: "/v1/chat/completions",
		request: `{"model":"m","stream":false,
		  "tools":[{"type":"function","function":{"name":"fetch","description":"get a url","parameters":{"type":"object"}}}],
		  "messages":[
		    {"role":"system","content":"You are a coding agent."},
		    {"role":"user","content":"summarise ticket 1 for ada@example.com"},
		    {"role":"assistant","content":"looking","tool_calls":[
		      {"id":"c1","type":"function","function":{"name":"fetch","arguments":"{\"url\":\"https://tracker/1\"}"}}]},
		    {"role":"tool","tool_call_id":"c1","name":"fetch","content":"the ticket says ada@example.com filed it"},
		    {"role":"user","content":"thanks, now close it"}]}`,
		response: `{"choices":[{"index":0,"message":{"role":"assistant","content":"closing it",
		  "tool_calls":[{"id":"c2","type":"function","function":{"name":"close","arguments":"{\"id\":1}"}}]}}],
		  "usage":{"prompt_tokens":120,"completion_tokens":45,"prompt_tokens_details":{"cached_tokens":30}}}`,
		stream: `data: {"choices":[{"delta":{"role":"assistant","content":"clos"}}]}

data: {"choices":[{"delta":{"content":"ing it"}}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c2","function":{"name":"close","arguments":"{\"id\""}}]}}]}

data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":":1}"}}]}}]}

data: {"choices":[{"delta":{},"finish_reason":"tool_calls"}]}

data: {"choices":[],"usage":{"prompt_tokens":120,"completion_tokens":45,"prompt_tokens_details":{"cached_tokens":30}}}

data: [DONE]

`,
		maskValues: []string{"ada@example.com"},
	},
	{
		name: "anthropic.messages",
		path: "/v1/messages",
		request: `{"model":"m","stream":false,
		  "system":"You are a coding agent.",
		  "tools":[{"name":"fetch","description":"get a url","input_schema":{"type":"object"}}],
		  "messages":[
		    {"role":"user","content":"summarise ticket 1 for ada@example.com"},
		    {"role":"assistant","content":[
		      {"type":"text","text":"looking"},
		      {"type":"tool_use","id":"c1","name":"fetch","input":{"url":"https://tracker/1"}}]},
		    {"role":"user","content":[
		      {"type":"tool_result","tool_use_id":"c1","content":"the ticket says ada@example.com filed it"},
		      {"type":"text","text":"thanks, now close it"}]}]}`,
		response: `{"id":"msg_1","type":"message","role":"assistant","content":[
		  {"type":"text","text":"closing it"},
		  {"type":"tool_use","id":"c2","name":"close","input":{"id":1}}],"stop_reason":"tool_use",
		  "usage":{"input_tokens":120,"output_tokens":45,"cache_read_input_tokens":30}}`,
		stream: `event: message_start
data: {"type":"message_start","message":{"id":"msg_1","role":"assistant","content":[],"usage":{"input_tokens":120,"output_tokens":2,"cache_read_input_tokens":30}}}

event: content_block_start
data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"clos"}}

event: content_block_delta
data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"ing it"}}

event: content_block_stop
data: {"type":"content_block_stop","index":0}

event: content_block_start
data: {"type":"content_block_start","index":1,"content_block":{"type":"tool_use","id":"c2","name":"close","input":{}}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"id\""}}

event: content_block_delta
data: {"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":":1}"}}

event: content_block_stop
data: {"type":"content_block_stop","index":1}

event: message_delta
data: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":45}}

event: message_stop
data: {"type":"message_stop"}

`,
		maskValues: []string{"ada@example.com"},
	},
	{
		name: "openai.responses",
		path: "/v1/responses",
		request: `{"model":"m","stream":false,
		  "instructions":"You are a coding agent.",
		  "tools":[{"type":"function","name":"fetch","description":"get a url","parameters":{"type":"object"}}],
		  "input":[
		    {"type":"message","role":"user","content":[{"type":"input_text","text":"summarise ticket 1 for ada@example.com"}]},
		    {"type":"message","role":"assistant","content":[{"type":"output_text","text":"looking"}]},
		    {"type":"function_call","call_id":"c1","name":"fetch","arguments":"{\"url\":\"https://tracker/1\"}"},
		    {"type":"function_call_output","call_id":"c1","output":"the ticket says ada@example.com filed it"},
		    {"type":"message","role":"user","content":[{"type":"input_text","text":"thanks, now close it"}]}]}`,
		response: `{"id":"resp_1","object":"response","status":"completed","output":[
		  {"type":"message","role":"assistant","content":[{"type":"output_text","text":"closing it"}]},
		  {"type":"function_call","call_id":"c2","name":"close","arguments":"{\"id\":1}"}],
		  "usage":{"input_tokens":120,"output_tokens":45,"input_tokens_details":{"cached_tokens":30}}}`,
		stream: `event: response.output_item.added
data: {"type":"response.output_item.added","output_index":0,"item":{"type":"message","id":"m1","role":"assistant"}}

event: response.output_text.delta
data: {"type":"response.output_text.delta","output_index":0,"delta":"clos"}

event: response.output_text.delta
data: {"type":"response.output_text.delta","output_index":0,"delta":"ing it"}

event: response.output_item.added
data: {"type":"response.output_item.added","output_index":1,"item":{"type":"function_call","call_id":"c2","name":"close"}}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","output_index":1,"delta":"{\"id\""}

event: response.function_call_arguments.delta
data: {"type":"response.function_call_arguments.delta","output_index":1,"delta":":1}"}

event: response.completed
data: {"type":"response.completed","response":{"id":"resp_1","status":"completed","usage":{"input_tokens":120,"output_tokens":45,"input_tokens_details":{"cached_tokens":30}}}}

`,
		maskValues: []string{"ada@example.com"},
	},
}

func protoFor(t *testing.T, name string) Protocol {
	t.Helper()
	p := ByName(name)
	if p == nil {
		t.Fatalf("%s is not registered", name)
	}
	return p
}

func TestEveryProtocolIsDetectedFromItsPath(t *testing.T) {
	for _, c := range conformance {
		got := Detect(c.path, gjson.Parse(c.request))
		if got == nil || got.Name() != c.name {
			t.Errorf("Detect(%q) = %v, want %s", c.path, nameOf(got), c.name)
		}
		if !IsCompletionPath(c.path) {
			t.Errorf("IsCompletionPath(%q) = false — the body would never be opened", c.path)
		}
	}
}

func TestEveryProtocolIsDetectedFromItsBodyAlone(t *testing.T) {
	// A deployment may mount a completion API under a path we do not know. The body
	// still has to resolve, and to the RIGHT protocol: `anthropic.messages` and
	// `openai.chat` both carry a `messages` array, so an ordering mistake here silently
	// routes every Anthropic request through the chat reader.
	for _, c := range conformance {
		got := Detect("/some/vendor/path", gjson.Parse(c.request))
		if got == nil || got.Name() != c.name {
			t.Errorf("body detection for %s gave %v", c.name, nameOf(got))
		}
	}
}

func nameOf(p Protocol) string {
	if p == nil {
		return "<nil>"
	}
	return p.Name()
}

// THE conformance assertion: three wire formats, one reading.
func TestOneConversationReadsIdenticallyInEveryProtocol(t *testing.T) {
	for _, c := range conformance {
		t.Run(c.name, func(t *testing.T) {
			p := protoFor(t, c.name)
			conv, ok := p.ParseRequest(gjson.Parse(c.request))
			if !ok {
				t.Fatal("the request parsed to no conversation")
			}
			if conv.System != sharedSystem {
				t.Errorf("System = %q — agent recognition matches on this, so losing it "+
					"drops every client of this protocol into the promptless bucket", conv.System)
			}
			if len(conv.Tools) != 1 || conv.Tools[0].Name != "fetch" {
				t.Errorf("Tools = %+v", conv.Tools)
			}

			want := []struct {
				role Role
				text string
			}{
				{RoleUser, "summarise ticket 1 for ada@example.com"},
				{RoleAssistant, "looking"},
				{RoleTool, "the ticket says ada@example.com filed it"},
				{RoleUser, "thanks, now close it"},
			}
			if len(conv.Turns) != len(want) {
				t.Fatalf("got %d turns, want %d: %+v", len(conv.Turns), len(want), conv.Turns)
			}
			for i, w := range want {
				got := conv.Turns[i]
				if got.Role != w.role {
					t.Errorf("turn %d role = %q, want %q", i, got.Role, w.role)
				}
				text := got.Text
				if got.Role == RoleTool && got.Outcome != nil {
					text = got.Outcome.Text
				}
				if text != w.text {
					t.Errorf("turn %d text = %q, want %q", i, text, w.text)
				}
			}
			// The action, and the pairing that makes the loop legible.
			a := conv.Turns[1].Actions
			if len(a) != 1 || a[0].Name != "fetch" || a[0].ID != "c1" {
				t.Fatalf("actions = %+v", a)
			}
			if got := gjson.Get(a[0].Arguments, "url").String(); got != "https://tracker/1" {
				t.Errorf("arguments did not survive as an argument OBJECT: %q", a[0].Arguments)
			}
			if conv.Turns[2].Outcome.CallID != "c1" {
				t.Errorf("outcome does not name the action it answers: %+v", conv.Turns[2].Outcome)
			}
		})
	}
}

// The agent-loop boundary, in every protocol.
func TestNewInputIsTheSameQuestionInEveryProtocol(t *testing.T) {
	for _, c := range conformance {
		t.Run(c.name, func(t *testing.T) {
			p := protoFor(t, c.name)
			conv, _ := p.ParseRequest(gjson.Parse(c.request))
			in := conv.NewInput()
			// Everything after the model's last turn: the outcome it has not read, and
			// the user's follow-up.
			if len(in) != 2 {
				t.Fatalf("NewInput = %+v", in)
			}
			if in[0].Role != RoleTool || in[1].Role != RoleUser {
				t.Fatalf("NewInput roles = %q,%q", in[0].Role, in[1].Role)
			}
		})
	}
}

func TestABufferedReplyReadsIdenticallyInEveryProtocol(t *testing.T) {
	for _, c := range conformance {
		t.Run(c.name, func(t *testing.T) {
			out := protoFor(t, c.name).ParseResponse(gjson.Parse(c.response))
			if out.Text != "closing it" {
				t.Errorf("Text = %q", out.Text)
			}
			if len(out.Actions) != 1 || out.Actions[0].Name != "close" || out.Actions[0].ID != "c2" {
				t.Fatalf("Actions = %+v", out.Actions)
			}
			if got := gjson.Get(out.Actions[0].Arguments, "id").Int(); got != 1 {
				t.Errorf("arguments = %q", out.Actions[0].Arguments)
			}
			assertSharedUsage(t, out.Usage)
		})
	}
}

// assertSharedUsage pins the token accounting every fixture carries: whatever
// counter names a protocol uses on its wire, the neutral model must read the
// same numbers out of all of them.
func assertSharedUsage(t *testing.T, u *Usage) {
	t.Helper()
	if u == nil {
		t.Fatal("the provider reported usage and the adapter dropped it")
	}
	if u.InputTokens != 120 || u.OutputTokens != 45 || u.CacheReadTokens != 30 {
		t.Errorf("usage = %+v, want input=120 output=45 cache_read=30", u)
	}
}

// ⚠️ The gap this closes: reassembly used to be openai.chat only, so on the other two
// the model's whole output side was reported as empty — the reply reached the caller
// and nothing was ever judged or recorded about it.
func TestAStreamedReplyReassemblesInEveryProtocol(t *testing.T) {
	for _, c := range conformance {
		t.Run(c.name, func(t *testing.T) {
			p := protoFor(t, c.name)
			scan := NewScanner(p.NewDecoder(NewRestorer(nil)))
			// Split at an awkward boundary: a chunk edge falls wherever TCP puts it,
			// including inside a JSON string.
			half := len(c.stream) / 2
			scan.Chunk([]byte(c.stream[:half]), false)
			scan.Chunk([]byte(c.stream[half:]), true)

			out := scan.Output()
			if out.Text != "closing it" {
				t.Errorf("reassembled text = %q", out.Text)
			}
			if len(out.Actions) != 1 {
				t.Fatalf("reassembled actions = %+v", out.Actions)
			}
			if out.Actions[0].Arguments != `{"id":1}` {
				t.Errorf("reassembled arguments = %q", out.Actions[0].Arguments)
			}
			if !gjson.Valid(out.Actions[0].Arguments) {
				t.Error("reassembled arguments are not valid JSON")
			}
			// The stream reports the same accounting as the buffered reply —
			// anthropic splits it across message_start and message_delta, the
			// OpenAI family puts it on one terminal frame; the merge must not
			// let one half zero the other.
			assertSharedUsage(t, out.Usage)
		})
	}
}

func TestMaskingReachesEveryTextSurfaceInEveryProtocol(t *testing.T) {
	red := []Redaction{{Token: "${OGR_EMAIL_1}", Value: "ada@example.com"}}
	for _, c := range conformance {
		t.Run(c.name, func(t *testing.T) {
			out, n := protoFor(t, c.name).Mask(c.request, red)
			if n == 0 {
				t.Fatal("nothing was masked")
			}
			if !gjson.Valid(out) {
				t.Fatalf("masking produced invalid JSON:\n%s", out)
			}
			for _, v := range c.maskValues {
				if strings.Contains(out, v) {
					// ⚠️ The worst failure available: the log says "masked N strings" while
					// the value travels to the model in the clear.
					t.Errorf("plaintext %q survived masking:\n%s", v, out)
				}
			}
			// The tool RESULT is where retrieved data arrives — the surface indirect
			// injection travels on, and the one each protocol nests differently.
			if strings.Count(out, "${OGR_EMAIL_1}") < 2 {
				t.Errorf("the value was masked in the question but not in the tool result:\n%s", out)
			}
		})
	}
}

func TestRestorationRoundTripsInEveryProtocol(t *testing.T) {
	mapping := map[string]string{"${OGR_EMAIL_1}": "ada@example.com"}
	for _, c := range conformance {
		t.Run(c.name, func(t *testing.T) {
			p := protoFor(t, c.name)
			// A reply that carries the placeholder in BOTH places it can appear.
			masked := strings.ReplaceAll(c.response, "closing it", "closing it for ${OGR_EMAIL_1}")
			masked = strings.ReplaceAll(masked, `"id":1`, `"id":"${OGR_EMAIL_1}"`)
			masked = strings.ReplaceAll(masked, `{\"id\":1}`, `{\"id\":\"${OGR_EMAIL_1}\"}`)

			out, changed := p.Restore(masked, mapping)
			if !changed {
				t.Fatal("nothing was restored — the caller would read a placeholder where its own data belongs")
			}
			if !gjson.Valid(out) {
				t.Fatalf("restoration produced invalid JSON:\n%s", out)
			}
			if strings.Contains(out, "${OGR_EMAIL_1}") {
				t.Errorf("a placeholder escaped to the caller:\n%s", out)
			}
			// The arguments half is the one that MATTERS: an unrestored line of prose is
			// cosmetic, an unrestored argument is an agent acting on a value that names
			// nothing.
			readback := p.ParseResponse(gjson.Parse(out))
			if !strings.Contains(readback.Actions[0].Arguments, "ada@example.com") {
				t.Errorf("tool arguments were not restored: %q", readback.Actions[0].Arguments)
			}
		})
	}
}

func TestAnEmptyRestoreMapChangesNothing(t *testing.T) {
	for _, c := range conformance {
		out, changed := protoFor(t, c.name).Restore(c.response, nil)
		if changed || out != c.response {
			t.Errorf("%s: an empty mapping rewrote the body", c.name)
		}
	}
}

// --- refusals ----------------------------------------------------------------

// ⚠️ A refusal is only useful if the caller's own SDK can render it. This used to be
// one OpenAI-shaped body for every client, so a refused `/v1/messages` caller received
// a `choices[]` document its SDK cannot parse — which surfaces to its user as the
// gateway being broken rather than as a policy decision.
func TestARefusalIsReadableByTheProtocolThatAskedForIt(t *testing.T) {
	for _, c := range conformance {
		t.Run(c.name, func(t *testing.T) {
			p := protoFor(t, c.name)
			body := p.Refuse("some-model", "refused by policy")
			if !gjson.Valid(body) {
				t.Fatalf("refusal is not valid JSON: %s", body)
			}
			out := p.ParseResponse(gjson.Parse(body))
			if out.Text != "refused by policy" {
				t.Errorf("this protocol's own reader cannot find the reason in its own "+
					"refusal: %q from %s", out.Text, body)
			}
		})
	}
}

func TestARefusedStreamCarriesTheReasonAndEnds(t *testing.T) {
	for _, c := range conformance {
		t.Run(c.name, func(t *testing.T) {
			p := protoFor(t, c.name)
			sse := p.RefuseStream("some-model", "refused by policy")

			// Read it back through this protocol's own decoder: whatever the frame names
			// are, the client's reassembly has to arrive at the reason.
			scan := NewScanner(p.NewDecoder(NewRestorer(nil)))
			scan.Chunk([]byte(sse), true)
			if got := scan.Output().Text; got != "refused by policy" {
				t.Errorf("a client reassembling this stream gets %q:\n%s", got, sse)
			}
			for _, block := range strings.Split(sse, "\n\n") {
				if block == "" {
					continue
				}
				for _, line := range strings.Split(block, "\n") {
					if payload, ok := SSEData(line); ok && payload != "[DONE]" && !gjson.Valid(payload) {
						t.Errorf("frame is not valid JSON: %s", payload)
					}
				}
			}
		})
	}
}

func TestARetractionAddsNoProse(t *testing.T) {
	// The passthrough lane has already delivered the text. All a retraction can do is
	// tell the client to take the message back — appending prose would land it under an
	// answer the user already read.
	for _, c := range conformance {
		t.Run(c.name, func(t *testing.T) {
			p := protoFor(t, c.name)
			scan := NewScanner(p.NewDecoder(NewRestorer(nil)))
			scan.Chunk([]byte(p.Retract("some-model")), true)
			if got := scan.Output(); !got.Empty() {
				t.Errorf("a retraction carried content: %+v", got)
			}
		})
	}
}

// --- registry ------------------------------------------------------------------

func TestTheCatchAllRegistersLast(t *testing.T) {
	all := All()
	if len(all) == 0 {
		t.Fatal("no protocols registered")
	}
	// ⚠️ Order is precedence for body matching. `openai.chat` matches any body with a
	// `messages` array, so it must be tested last or it swallows Anthropic.
	if last := all[len(all)-1].Name(); last != "openai.chat" {
		t.Errorf("last registered is %q, want the openai.chat catch-all", last)
	}
	var anthropicAt, chatAt = -1, -1
	for i, p := range all {
		switch p.Name() {
		case "anthropic.messages":
			anthropicAt = i
		case "openai.chat":
			chatAt = i
		}
	}
	if anthropicAt < 0 || chatAt < 0 || anthropicAt > chatAt {
		t.Errorf("anthropic.messages (%d) must be tested before openai.chat (%d)", anthropicAt, chatAt)
	}
}

func TestEveryProtocolNamesAValueTheSchemaAllows(t *testing.T) {
	// schema/guard-event.schema.json, `llm_protocol`. A name that is not in the enum is
	// rejected by the runtime for every event this protocol ever produces.
	allowed := map[string]bool{
		"openai.chat": true, "openai.responses": true, "anthropic.messages": true,
	}
	for _, p := range All() {
		if !allowed[p.Name()] {
			t.Errorf("%q is not an llm_protocol the OGR schema accepts — add it to "+
				"schema/guard-event.schema.json in the same change", p.Name())
		}
	}
}
