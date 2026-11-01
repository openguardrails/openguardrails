package protocol

import (
	"github.com/tidwall/gjson"
	"strings"
	"testing"
)

func TestHeldStreamMasksAcrossDeltasAndReasoning(t *testing.T) {
	raw := "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"call 138\",\"reasoning_content\":\"13800138000\"}}]}\n\n" +
		"data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"00138000 OGRKR0000001 ${OGR_EMAIL_1}\"}}]}\n\n" + "data: [DONE]\n\n"
	out, err := RewriteHeldSSE(raw, map[string]string{"13800138000": "[REDACTED_PHONE]", "OGRKR0000001": "OGRKR0000002", "OGRKR0000002": "nested"})
	if err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{"13800138000", "nested"} {
		if strings.Contains(out, bad) {
			t.Fatalf("unexpected value %q in output", bad)
		}
	}
	if !strings.Contains(out, "[REDACTED_PHONE]") || !strings.Contains(out, "OGRKR0000002") || !strings.Contains(out, "${OGR_EMAIL_1}") {
		t.Fatal(out)
	}
}

func TestHeldStreamRewritesFinalSnapshots(t *testing.T) {
	raw := "data: {\"type\":\"response.output_text.delta\",\"delta\":\"1380013\"}\n\n" +
		"data: {\"type\":\"response.output_text.delta\",\"delta\":\"8000\"}\n\n" +
		"data: {\"type\":\"response.output_text.done\",\"text\":\"13800138000\"}\n\n" +
		"data: {\"type\":\"response.completed\",\"response\":{\"output_text\":\"13800138000\",\"usage\":{\"output_tokens\":12}}}\n\n"
	out, err := RewriteHeldSSE(raw, map[string]string{"13800138000": "[REDACTED_PHONE]"})
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(out, "13800138000") || strings.Count(out, "REDACTED_PHONE") != 3 || !strings.Contains(out, `"output_tokens":12`) {
		t.Fatal(out)
	}
}

func TestHeldStreamKeepsToolArgumentsValidJSON(t *testing.T) {
	raw := "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"{\\\"key\\\":\\\"OGRKR0000001\\\"}\"}}]}}]}\n\ndata: [DONE]\n\n"
	out, err := RewriteHeldSSE(raw, map[string]string{"OGRKR0000001": `secret-"quoted"`})
	if err != nil {
		t.Fatal(err)
	}
	payload := strings.TrimPrefix(strings.Split(out, "\n\n")[0], "data: ")
	args := gjson.Get(payload, "choices.0.delta.tool_calls.0.function.arguments").String()
	if !gjson.Valid(args) || gjson.Get(args, "key").String() != `secret-"quoted"` {
		t.Fatal(args)
	}
}

func TestHeldStreamFailsClosedForUnsupportedOrTruncatedInput(t *testing.T) {
	for _, raw := range []string{`data: {"choices":[{"delta":{"content":"partial"}}]}` + "\n\n", `data: {"type":"unknown.content","text":"private"}` + "\n\n", `data: {"choices":[{"index":1,"delta":{"content":"private"}}]}` + "\n\ndata: [DONE]\n\n"} {
		if _, err := RewriteHeldSSE(raw, nil); err == nil {
			t.Fatal("unjudgeable stream was released")
		}
	}
	if got := RestoreString("${OGR_EMAIL_1} OGRKR0000001", map[string]string{"${OGR_EMAIL_1}": "private", "OGRKR0000001": "secret"}); got != "${OGR_EMAIL_1} secret" {
		t.Fatal(got)
	}
}

func TestHeldStreamRejectsNewContentInFinalSnapshot(t *testing.T) {
	raw := `data: {"type":"response.output_text.delta","delta":"safe"}` + "\n\n" + `data: {"type":"response.completed","response":{"output_text":"safe and private 13800138000"}}` + "\n\n"
	if _, err := RewriteHeldSSE(raw, nil); err == nil {
		t.Fatal("unjudged snapshot was released")
	}
}
