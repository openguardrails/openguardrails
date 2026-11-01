package main

import (
	"testing"

	"github.com/higress-group/wasm-go/pkg/wrapper"
)

func TestStagedRolloutMembership(t *testing.T) {
	cases := []struct {
		name, config, flags, consumer, group string
		want                                 bool
	}{
		{"disabled", "", "", "alice", "team", false},
		{"beta only", "", "other, OG-AIRS ", "alice", "team", true},
		{"beta substring", "", "og-airs-extra", "alice", "team", false},
		{"group", "other, team", "", "alice", "team", true},
		{"consumer", "alice", "", "alice", "team", true},
		{"union beta", "other", "og-airs", "alice", "team", true},
		{"union config", "team", "other", "alice", "team", true},
		{"ungrouped", "ungrouped", "", "alice", "", true},
		{"blank group", "ungrouped", "", "alice", "  ", true},
		{"grouped excluded", "ungrouped", "", "alice", "team", false},
		{"all", "all_consumers", "", "alice", "team", true},
		{"all anonymous", "all_consumers", "", "", "", true},
		{"empty entries", " , , ", "", "", "", false},
		{"exact", "ali, tea", "", "alice", "team", false},
		{"case sensitive", "Team", "", "alice", "team", false},
		{"trim", " , team , alice,", "", "bob", "team", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			if got := rolloutOptIn(tc.flags, tc.consumer, tc.group, parseStagedRollout(tc.config)); got != tc.want {
				t.Fatalf("got %v want %v", got, tc.want)
			}
		})
	}
}

type rolloutContext struct {
	wrapper.HttpContext
	values                    map[string]interface{}
	skipRequest, skipResponse bool
}

func (c *rolloutContext) SetContext(k string, v interface{}) { c.values[k] = v }
func (c *rolloutContext) GetBoolContext(k string, fallback bool) bool {
	if v, ok := c.values[k].(bool); ok {
		return v
	}
	return fallback
}
func (c *rolloutContext) DontReadRequestBody()  { c.skipRequest = true }
func (c *rolloutContext) DontReadResponseBody() { c.skipResponse = true }

func TestRolloutPersistsToRepliesAndIsolatesRequests(t *testing.T) {
	for _, mode := range []string{modeEnforce, modeObserve} {
		cfg := Config{mode: mode, stagedRollout: parseStagedRollout("gray-group")}
		for _, group := range []string{"ordinary", "gray-group", "ordinary"} {
			ctx := &rolloutContext{values: map[string]interface{}{}}
			headers := map[string]string{"x-mse-consumer": "alice", "x-mse-consumer-group": group}
			enrolled := stampRollout(ctx, cfg, func(k string) string { return headers[k] })
			clear(headers) // LLM responses carry none of these headers.
			if enrolled != (group == "gray-group") {
				t.Fatal("incorrect membership")
			}
			if ctx.GetBoolContext(ctxBetaOptIn, false) != enrolled {
				t.Fatal("membership not persisted")
			}
			wantMode := modeObserve
			if enrolled {
				wantMode = mode
			}
			if effectiveMode(ctx, cfg) != wantMode {
				t.Fatal("wrong mode inherited by response")
			}
			if ctx.skipRequest || ctx.skipResponse || ctx.GetBoolContext(ctxSkip, false) {
				t.Fatal("observe must still report both halves")
			}
		}
	}
}
