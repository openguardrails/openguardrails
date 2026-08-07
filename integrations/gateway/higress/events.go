package main

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"

	"github.com/tidwall/gjson"
)

// OpenAI chat traffic -> OGR GuardEvents.
//
// A gateway sees ONE TURN at a time and an OpenAI client re-sends the entire
// conversation on every request. So the only question this file answers is:
// what is NEW in this request, and which OGR kind is it? Agent, Session, Run and
// Turn are the platform's to reconstruct (docs: "Reassembling the layers").
//
// ⚠️ Everything here used to collapse into ONE `user_input` per request. That is
// what made a whole gateway deployment invisible to the tool_call guardrails:
// `permission`, `command-danger` and `command-rules` judge an ACTION, and no
// action was ever reported. A `tool_calls` array in an assistant message IS the
// action, and the copy in the RESPONSE is the only one that can still be stopped.

const (
	ogrVersion       = "0.4"
	sensorName       = "openguardrails-higress-connector"
	sensorClass      = "proxy"
	llmProtocol      = "openai.chat"
	observationPoint = "conversation"
	// Reported in the heartbeat, so it is how a deployment learns which build is
	// in the VM. Kept honest by TestPluginVersionMatchesTheVERSIONFile — 1.3.0
	// and 1.4.0 both shipped while this still said 1.2.0.
	pluginVersion = "1.5.0"

	maxTranscriptEntries = 64
	maxEntryText         = 32768
	maxSystemPrompt      = 16384
	maxInstruction       = 8192
	maxToolsPerRegister  = 64
)

type sensor struct {
	ID    string `json:"id"`
	Class string `json:"class"`
}

type subject struct {
	Principal string `json:"principal,omitempty"`
	// The consumer's group. A runtime EXTENSION, not an OGR v0.4 field: the platform
	// resolves it to a workspace, always within the org the API key proves, so a group
	// name can never reach another tenant's configuration.
	PrincipalGroup string `json:"principal_group,omitempty"`
	AgentID        string `json:"agent_id,omitempty"`
}

type transcriptEntry struct {
	Role    string   `json:"role,omitempty"`
	Text    string   `json:"text,omitempty"`
	ToolUse *toolUse `json:"tool_use,omitempty"`
}

type toolUse struct {
	Name  string `json:"name"`
	Input string `json:"input"`
}

type authzEnvelope struct {
	Instruction       string            `json:"instruction,omitempty"`
	Transcript        []transcriptEntry `json:"transcript,omitempty"`
	AgentSystemPrompt string            `json:"agent_system_prompt,omitempty"`
}

// GuardEvent is the wire unit. A struct, so encoding/json does the escaping:
// the old connector hand-rolled its JSON and every field it interpolated was an
// injection surface.
type GuardEvent struct {
	OGRVersion       string         `json:"ogr_version"`
	EventID          string         `json:"event_id"`
	GuardID          string         `json:"guard_id"`
	SessionID        string         `json:"session_id,omitempty"`
	Timestamp        string         `json:"timestamp"`
	ObservationPoint string         `json:"observation_point"`
	Sensor           sensor         `json:"sensor"`
	Kind             string         `json:"kind"`
	LLMProtocol      string         `json:"llm_protocol,omitempty"`
	Subject          *subject       `json:"subject,omitempty"`
	Payload          map[string]any `json:"payload"`
	Authz            *authzEnvelope `json:"authz,omitempty"`

	// Not on the wire: which payload field the verdict's span offsets index
	// into, and the exact text they index. A verdict carries offsets and no
	// matched text by design, so the PEP slices its OWN copy — anything else
	// (a joined array, an already-masked string) reads at shifted positions.
	textPath string `json:"-"`
	text     string `json:"-"`
}

// --- reading the request ----------------------------------------------------

func textOf(msg gjson.Result) string {
	c := msg.Get("content")
	if c.Type == gjson.String {
		return c.String()
	}
	if c.IsArray() {
		var b strings.Builder
		for _, part := range c.Array() {
			if t := part.Get("text"); t.Exists() {
				if b.Len() > 0 {
					b.WriteString(" ")
				}
				b.WriteString(t.String())
			}
		}
		return b.String()
	}
	return ""
}

func systemPrompt(messages []gjson.Result) string {
	for _, m := range messages {
		role := m.Get("role").String()
		if role == "system" || role == "developer" {
			return truncate(textOf(m), maxSystemPrompt)
		}
	}
	return ""
}

func latestUserText(messages []gjson.Result) string {
	for i := len(messages) - 1; i >= 0; i-- {
		if messages[i].Get("role").String() == "user" {
			return textOf(messages[i])
		}
	}
	return ""
}

// transcript is the authz envelope's view: user turns, assistant prose, and the
// tool calls the agent already made. The tool_call judges read this to decide
// whether the NEXT action follows from what the user actually asked for.
func transcriptOf(messages []gjson.Result) []transcriptEntry {
	entries := make([]transcriptEntry, 0, len(messages))
	for _, m := range messages {
		switch m.Get("role").String() {
		case "user":
			if t := textOf(m); t != "" {
				entries = append(entries, transcriptEntry{Role: "user", Text: truncate(t, maxEntryText)})
			}
		case "assistant":
			if t := textOf(m); t != "" {
				entries = append(entries, transcriptEntry{Role: "assistant", Text: truncate(t, maxEntryText)})
			}
			for _, tc := range m.Get("tool_calls").Array() {
				entries = append(entries, transcriptEntry{ToolUse: &toolUse{
					Name:  tc.Get("function.name").String(),
					Input: truncate(tc.Get("function.arguments").String(), maxEntryText),
				}})
			}
		}
	}
	if len(entries) > maxTranscriptEntries {
		entries = entries[len(entries)-maxTranscriptEntries:]
	}
	return entries
}

// --- deriving the events ----------------------------------------------------

type deriveCtx struct {
	principal      string
	principalGroup string
	sessionID      string
	guardID        string
	reqID          string
	seq            int
	now            string
}

func (d *deriveCtx) event(kind string, payload map[string]any) *GuardEvent {
	d.seq++
	return &GuardEvent{
		OGRVersion:       ogrVersion,
		EventID:          "evt-" + d.reqID + "-" + strconv.Itoa(d.seq),
		GuardID:          d.guardID,
		SessionID:        d.sessionID,
		Timestamp:        d.now,
		ObservationPoint: observationPoint,
		Sensor:           sensor{ID: sensorName, Class: sensorClass},
		Kind:             kind,
		LLMProtocol:      llmProtocol,
		Subject:          subjectOf(d.principal, d.principalGroup),
		Payload:          payload,
	}
}

func subjectOf(principal, group string) *subject {
	// ⚠️ agent_id is deliberately left unset. The runtime recognises the agent
	// from the system prompt's self-definition, and naming the gateway consumer
	// as the agent would collapse every agent behind one API key into one row.
	if principal == "" && group == "" {
		return nil
	}
	// ⚠️ The group is sent even when the consumer header is absent: it still says
	// which workspace's policy set this traffic belongs under, which is the half that
	// decides what the guardrails do.
	return &subject{Principal: principal, PrincipalGroup: group}
}

// deriveRequest returns the events that are NEW in this request, oldest first.
// The user_input (if any) is last, because it is the one an enforcing gateway
// judges before letting the request through.
func deriveRequest(d *deriveCtx, st *sessionState, body gjson.Result) []*GuardEvent {
	messages := body.Get("messages").Array()
	prompt := systemPrompt(messages)
	entries := transcriptOf(messages)

	var out []*GuardEvent

	attach := func(e *GuardEvent, instruction string) *GuardEvent {
		az := &authzEnvelope{Transcript: entries, AgentSystemPrompt: prompt}
		if instruction != "" {
			az.Instruction = truncate(instruction, maxInstruction)
		}
		e.Authz = az
		// ⚠️ The system prompt goes in the PAYLOAD too, not only the envelope:
		// agent recognition reads payload.system and never looks at authz.
		if prompt != "" {
			e.Payload["system"] = prompt
		}
		return e
	}

	// tool_register — the DEFINITION of a tool is an attack surface of its own
	// (description injection, rug-pulls), detectable before any call. Re-emitted
	// when the declared set CHANGES, which is exactly what a rug-pull looks like.
	if tools := body.Get("tools"); tools.IsArray() && len(tools.Array()) > 0 {
		if h := hashOf(tools.Raw); h != st.ToolsHash {
			st.ToolsHash = h
			for i, t := range tools.Array() {
				if i >= maxToolsPerRegister {
					break
				}
				out = append(out, attach(d.event("tool_register", map[string]any{
					"name":        t.Get("function.name").String(),
					"description": t.Get("function.description").String(),
					"schema":      rawJSON(t.Get("function.parameters")),
				}), ""))
			}
		}
	}

	// tool_call / tool_result out of the re-sent history: everything the client
	// executed since we last saw this conversation. Post-hoc — the enforceable
	// copy is the one in the RESPONSE — but they are what a run's evidence is
	// made of, and `tool_result` is a surface the privacy guardrail must read.
	for _, m := range messages {
		switch m.Get("role").String() {
		case "assistant":
			for _, tc := range toolCallsOf(m) {
				if tc.ID == "" || st.seenCall(tc.ID) {
					continue
				}
				st.markCall(tc.ID)
				out = append(out, attach(toolCallEvent(d, tc), ""))
			}
		case "tool":
			id := m.Get("tool_call_id").String()
			if id == "" || st.seenResult(id) {
				continue
			}
			st.markResult(id)
			text := textOf(m)
			e := attach(d.event("tool_result", map[string]any{
				"name":   m.Get("name").String(),
				"result": text,
			}), "")
			e.textPath, e.text = "payload.result", text
			out = append(out, e)
		}
	}

	// user_input — the newest user turn only. Every earlier turn was scanned
	// when IT was new; re-scanning history would double-count findings on every
	// turn of a long conversation. History still gets MASKED, from the session's
	// accumulated map, with no second detector pass.
	if text := latestUserText(messages); text != "" && !st.sawUserText(text) {
		st.markUserText(text)
		e := attach(d.event("user_input", map[string]any{"text": text}), text)
		e.textPath, e.text = "payload.text", text
		out = append(out, e)
	}

	return out
}

// toolCallOut is one tool call, however it arrived: an object in a request's
// history, an object in a buffered response, or deltas concatenated out of an
// SSE stream. One type so the three paths cannot drift.
type toolCallOut struct {
	ID        string
	Name      string
	Arguments string
}

func toolCallsOf(msg gjson.Result) []toolCallOut {
	var out []toolCallOut
	for _, tc := range msg.Get("tool_calls").Array() {
		out = append(out, toolCallOut{
			ID:        tc.Get("id").String(),
			Name:      tc.Get("function.name").String(),
			Arguments: tc.Get("function.arguments").String(),
		})
	}
	return out
}

func toolCallEvent(d *deriveCtx, tc toolCallOut) *GuardEvent {
	e := d.event("tool_call", map[string]any{
		"name":      tc.Name,
		"arguments": tc.Arguments,
		"call_id":   tc.ID,
	})
	// The judge reads name+arguments as one action; offsets index that rendering.
	e.textPath, e.text = "", strings.TrimSpace(tc.Name+" "+tc.Arguments)
	return e
}

// deriveResponse builds the events for what the model produced. `content` is the
// assembled assistant text (the streaming path accumulates it chunk by chunk).
//
// ⚠️ The tool_calls here are the ones that have NOT run yet — the only copy a
// gateway can still refuse. They are returned after model_output so a caller
// that stops at the first refusal stops on the action, not on the prose.
func deriveResponse(d *deriveCtx, st *sessionState, content string, toolCalls []toolCallOut,
	messages []gjson.Result) []*GuardEvent {
	prompt := systemPrompt(messages)
	entries := transcriptOf(messages)
	if content != "" {
		entries = append(entries, transcriptEntry{Role: "assistant", Text: truncate(content, maxEntryText)})
	}
	attach := func(e *GuardEvent) *GuardEvent {
		e.Authz = &authzEnvelope{
			Transcript:        entries,
			AgentSystemPrompt: prompt,
			Instruction:       truncate(latestUserText(messages), maxInstruction),
		}
		if prompt != "" {
			e.Payload["system"] = prompt
		}
		return e
	}

	var out []*GuardEvent
	if content != "" {
		e := attach(d.event("model_output", map[string]any{"text": content}))
		e.textPath, e.text = "payload.text", content
		out = append(out, e)
	}
	for _, tc := range toolCalls {
		if tc.ID != "" {
			if st.seenCall(tc.ID) {
				continue
			}
			st.markCall(tc.ID)
		}
		out = append(out, attach(toolCallEvent(d, tc)))
	}
	return out
}

// --- small helpers ----------------------------------------------------------

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func hashOf(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])[:16]
}

// rawJSON keeps an object/array as structured JSON and degrades anything else to
// a string, so a malformed tool schema cannot break the whole batch.
func rawJSON(r gjson.Result) any {
	if r.IsObject() || r.IsArray() {
		return jsonRaw(r.Raw)
	}
	if r.Exists() {
		return r.String()
	}
	return nil
}

// jsonRaw is a pre-serialized JSON fragment that marshals as itself.
type jsonRaw string

func (j jsonRaw) MarshalJSON() ([]byte, error) {
	if j == "" {
		return []byte("null"), nil
	}
	return []byte(j), nil
}
