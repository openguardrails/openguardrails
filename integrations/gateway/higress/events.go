package main

import (
	"crypto/sha256"
	"encoding/hex"
	"strconv"
	"strings"

	"github.com/openguardrails/higress/protocol"
	"github.com/tidwall/gjson"
)

// A conversation, in whichever protocol it arrived, -> OGR GuardEvents.
//
// A gateway sees ONE TURN at a time and every LLM client re-sends the whole
// conversation on each request, so the only question this file answers is: what is
// NEW here, and CAN WE STILL STOP IT? Agent, Session, Run and Turn are the platform's
// to reconstruct (docs: "Reassembling the layers"); this file's job is the turn and
// the actions inside it.
//
// # ONE TURN IS ONE EVENT
//
// ⚠️ The refusable half of a phase is a SINGLE event carrying the whole turn, and this
// is the design's load-bearing claim. A reply that says "closing it" and calls three
// tools is ONE generation — one round of the client's protocol — and the three calls
// are not three things the model did, they are the shape of the one thing it did.
// Split into four GuardEvents they lose exactly what a judge needs: that the prose and
// the actions were produced together, in that order, from one prompt. "Delete the
// backups" is a different act when the sentence beside it says "as you asked" than
// when it says "I will tidy up first".
//
// That split also forced a batch endpoint to exist, and then forced the batch to
// re-compose a decision out of per-fragment verdicts — a whole mechanism whose only
// job was to undo a decomposition that should never have happened. Both are gone. The
// payload shape here is the one the OGR spec already documents for `model_output`
// (`{text, tool_calls}`); the plugin was the thing not following it.
//
// The itemised events did not disappear, they moved to where they belong: /ingest
// keeps a per-item record of history (actions the client already executed, tools it
// declared), because those ARE independent past facts and nothing composes them.
//
// ⚠️ It reads protocol.Conversation and never a wire body. Which of the three
// protocols carried the turn is settled before anything here runs — that is what the
// protocol package is for — and nothing in this file may reach for a JSON path.
//
// # The agent loop, and why "what is new" is the whole problem
//
// The loop is
//
//	user input → model output → actions → outcomes → model output → …
//
// and ONLY THE FIRST LEG HAS A USER TURN IN IT. Every continuation re-sends the same
// conversation with tool outcomes appended and no new user message. This file used to
// define new input as "the newest user turn", which meant a continuation found a turn
// it had already reported, derived no refusable event, and — in enforce mode — went to
// the model unjudged. Nothing looked wrong: the events still reached the platform as a
// report, the console filled, the counters moved. Enforcement was simply absent for
// every turn of every agent after the first.

const (
	ogrVersion  = "0.4"
	sensorName  = "openguardrails-higress-connector"
	sensorClass = "proxy"
	// ⚠️ There is deliberately no `llmProtocol` constant. It was "openai.chat" and it
	// was stamped on every event this plugin ever sent, so the field could not
	// distinguish a client that spoke something else from one that did not — 693,197
	// stored events, all unfalsifiable. It is detected per request now (the protocol
	// package) and carried on deriveCtx.
	observationPoint = "conversation"
	// Reported in the heartbeat, so it is how a deployment learns which build is in
	// the VM. Kept honest by TestPluginVersionMatchesTheVERSIONFile — 1.3.0 and 1.4.0
	// both shipped while this still said 1.2.0.
	pluginVersion = "1.7.0"

	maxTranscriptEntries = 64
	maxEntryText         = 32768
	maxSystemPrompt      = 16384
	maxInstruction       = 8192
	maxToolsPerRegister  = 64
	maxActionsPerTurn    = 64
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

// transcriptEntry mirrors the runtime's own projection of an event to a transcript
// line (`policy-engine/sessionTranscript.ts`, `projectEventToEntry`). Mirrored rather
// than invented: the judge reads client-supplied envelopes and server-derived ones
// interchangeably, so a line shaped differently here is a line that reads differently
// depending on which path produced it.
//
//	user_input   → {role:"user", text}
//	model_output → {role:"assistant", text}
//	tool_call    → {tool_use:{name, input}}
//	tool_result  → {outcome:{id?, status}}
//
// ⚠️ `role` accepts ONLY "user" and "assistant" — the runtime's zod enum drops
// anything else, and zod strips unknown KEYS silently too. A tool result rendered as
// `{role:"tool", text:…}` would therefore vanish on arrival with no error, which is
// how the tool side of an agent run stayed missing from the judge's transcript while
// the plugin looked like it was sending one.
type transcriptEntry struct {
	Role    string         `json:"role,omitempty"`
	Text    string         `json:"text,omitempty"`
	ToolUse *toolUse       `json:"tool_use,omitempty"`
	Outcome map[string]any `json:"outcome,omitempty"`
}

type toolUse struct {
	Name string `json:"name"`
	// Input is the BARE command when the action carries one, and the JSON arguments
	// otherwise — the same preference the runtime applies, because the judge was
	// trained on command strings rather than on `name {json}` composites.
	Input string `json:"input"`
}

type authzEnvelope struct {
	Instruction       string            `json:"instruction,omitempty"`
	Transcript        []transcriptEntry `json:"transcript,omitempty"`
	AgentSystemPrompt string            `json:"agent_system_prompt,omitempty"`
}

// GuardEvent is the wire unit. A struct, so encoding/json does the escaping: the old
// connector hand-rolled its JSON and every field it interpolated was an injection
// surface.
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

	// Not on the wire: the exact text at each payload path a verdict's span offsets can
	// index. A verdict carries offsets and no matched text by design, so the PEP slices
	// its OWN copy — anything else (a joined array, an already-masked string) reads at
	// shifted positions.
	//
	// ⚠️ A MAP, because one event now carries a whole turn and a turn has more than one
	// text in it: a continuation feeding three tool outcomes back has three, at
	// `payload.tool_results.0.result` and its siblings. A finding names the one it
	// indexes in its own `path` (`verdictFindingSchema.path`); `primaryPath` is what a
	// finding that names none is assumed to mean. Resolving a finding against the wrong
	// text yields a fragment that matches nothing, and the value the verdict asked us
	// to remove then reaches the model while the log says "masked".
	texts       map[string]string `json:"-"`
	primaryPath string            `json:"-"`
	// distinct counts the TEXTS, not the keys. Several paths may name one text — a
	// producer's fallback chain, or a field reachable two ways — and an alias must not
	// make a single-text event look ambiguous, or a plain chat turn stops resolving a
	// pathless span for no reason.
	distinct int `json:"-"`
}

// at returns the text a verdict's offsets index for this path, or "" when the path
// names nothing this event can slice.
//
// ⚠️ It is an EXACT LOOKUP of a key this file wrote, not a JSON path evaluator — the
// only paths that resolve are the ones `withText` registered. Bracket indexing is
// folded to the dotted form first, so a producer emitting `payload.tool_results[0].result`
// and one emitting `payload.tool_results.0.result` land on the same text; anything else
// is unresolvable and the caller drops the span rather than applying it somewhere else.
//
// ⚠️ AN ABSENT PATH RESOLVES ONLY WHEN THERE IS NOTHING TO CONFUSE IT WITH. One event
// now carries a whole turn, so "no path" is genuinely ambiguous the moment the turn has
// more than one text in it — and the tempting reading, "it must mean the primary text",
// is the silent corruption in a new place: a span computed against a synthesized
// `name {json}` composite, or against the third tool outcome, would be sliced out of
// `payload.text` and mask bytes nobody detected while leaving the real value on its way
// to the model. Unresolvable is the safe answer, and it is counted, not swallowed.
func (e *GuardEvent) at(path string) string {
	if path == "" {
		if e.distinct != 1 {
			return ""
		}
		return e.texts[e.primaryPath]
	}
	return e.texts[dottedPath(path)]
}

// dottedPath folds `a[0].b` into `a.0.b`, the form this file registers.
func dottedPath(path string) string {
	if !strings.ContainsRune(path, '[') {
		return path
	}
	out := make([]byte, 0, len(path))
	for i := 0; i < len(path); i++ {
		switch path[i] {
		case '[':
			if len(out) > 0 && out[len(out)-1] != '.' {
				out = append(out, '.')
			}
		case ']':
			// A `]` followed by `.` would double the separator.
			if i+1 < len(path) && path[i+1] == '.' {
				i++
			}
			if i+1 < len(path) {
				out = append(out, '.')
			}
		default:
			out = append(out, path[i])
		}
	}
	return string(out)
}

// withText records a judged text and the payload path it lives at. The first one
// recorded is the primary.
func (e *GuardEvent) withText(path, text string) *GuardEvent {
	if text == "" {
		return e
	}
	if e.texts == nil {
		e.texts = map[string]string{}
		e.primaryPath = path
	}
	e.texts[path] = text
	e.distinct++
	return e
}

// alias registers another path for a text already recorded. It does NOT count as a
// distinct text: the producer's path may arrive by a fallback name for the same bytes.
func (e *GuardEvent) alias(path, text string) *GuardEvent {
	if text == "" || e.texts == nil {
		return e
	}
	e.texts[path] = text
	return e
}

// --- reading the conversation ------------------------------------------------

// bareCommand is the shell command an action carries, or "".
//
// ⚠️ Load-bearing, not a nicety: the runtime judges this STRING for a command-bearing
// action rather than the `name {json}` composite, because the Layer-1 gate parses it and
// the judge was trained on command strings. So its offsets index this field, and the
// field needs a registered path or every redaction against a command is dropped.
func bareCommand(a protocol.Action) string {
	if !gjson.Valid(a.Arguments) {
		return ""
	}
	if c := gjson.Get(a.Arguments, "command"); c.Type == gjson.String {
		return c.String()
	}
	return ""
}

// actionInput renders an action the way the runtime's projection does: the bare command
// when the arguments carry one, the raw arguments otherwise.
func actionInput(a protocol.Action) string {
	if c := bareCommand(a); c != "" {
		return c
	}
	return a.Arguments
}

// registerAction records every text a verdict may name for one action, under the paths
// the runtime emits.
//
//	<prefix>                          the synthesized `name {json}` composite —
//	                                  ATTRIBUTION ONLY, never carries offsets
//	<prefix>.arguments.command        the bare command, a real wire field
//	<prefix>.command                  the same, under the name the runtime tries first
//
// `prefix` is `payload.tool_calls.N` inside a turn and "" on an itemised history event,
// where the action IS the payload.
func registerAction(e *GuardEvent, prefix string, a protocol.Action) {
	e.withText(prefix, trimSpace(a.Name+" "+a.Arguments))
	cmd := bareCommand(a)
	if cmd == "" {
		return
	}
	base := prefix
	if base == "" {
		base = "payload"
	}
	e.withText(base+".arguments.command", cmd)
	e.alias(base+".command", cmd)
}

// transcript is the authz envelope's view of the run so far: what the user asked, what
// the model said, what it did, and what came back.
//
// ⚠️ The outcome lines are the ones this used to omit entirely, and they are what make
// the rest legible. A judge asked "does this action follow from what the user wanted?"
// against a transcript of user turns and tool calls with NO results is reading an
// agent that never learned anything — it cannot see that the previous step failed, or
// that a retrieved document is what introduced the instruction the agent is now acting
// on.
//
// ⚠️ The result BODY stays out (`{outcome:{id, status}}`), matching the runtime's
// projection: outcomes are markers here, not content. The body is judged as its own
// tool_result event, where it has span offsets and a redaction path of its own.
func transcriptOf(conv *protocol.Conversation) []transcriptEntry {
	entries := make([]transcriptEntry, 0, len(conv.Turns))
	for _, t := range conv.Turns {
		switch t.Role {
		case protocol.RoleUser:
			if t.Text != "" {
				entries = append(entries, transcriptEntry{Role: "user", Text: truncate(t.Text, maxEntryText)})
			}
		case protocol.RoleAssistant:
			if t.Text != "" {
				entries = append(entries, transcriptEntry{Role: "assistant", Text: truncate(t.Text, maxEntryText)})
			}
			for _, a := range t.Actions {
				entries = append(entries, transcriptEntry{ToolUse: &toolUse{
					Name:  a.Name,
					Input: truncate(actionInput(a), maxEntryText),
				}})
			}
		case protocol.RoleTool:
			if t.Outcome == nil {
				continue
			}
			outcome := map[string]any{"status": outcomeStatus(t.Outcome)}
			if t.Outcome.CallID != "" {
				outcome["id"] = t.Outcome.CallID
			}
			entries = append(entries, transcriptEntry{Outcome: outcome})
		}
	}
	if len(entries) > maxTranscriptEntries {
		entries = entries[len(entries)-maxTranscriptEntries:]
	}
	return entries
}

func outcomeStatus(o *protocol.Outcome) string {
	if o.IsError {
		return "error"
	}
	return "ok"
}

// instructionOf is the run's goal: the newest thing the USER actually asked for.
//
// ⚠️ Deliberately the user's words even deep inside an agent loop, where the newest
// input is a tool result. The scope guardrails ask "does this action follow from what
// was authorized?", and the answer is anchored on the human's request, not on whatever
// the last tool happened to return — which is the string an injected document controls.
func instructionOf(conv *protocol.Conversation) string {
	for i := len(conv.Turns) - 1; i >= 0; i-- {
		if conv.Turns[i].Role == protocol.RoleUser && conv.Turns[i].Text != "" {
			return conv.Turns[i].Text
		}
	}
	return ""
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
	// The CLIENT's wire protocol, detected per request. Never a constant: it was
	// `openai.chat` for every event this plugin ever sent, which made 693,197 stored
	// events unfalsifiable.
	protocol string
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
		LLMProtocol:      d.protocol,
		Subject:          subjectOf(d.principal, d.principalGroup),
		Payload:          payload,
	}
}

// derived is one gateway phase, split by WHAT THE GATEWAY CAN STILL DO ABOUT IT:
//
//	Judged  THE turn — one event, not yet seen by the model or the caller → /evaluate
//	Report  history: independent past facts nothing composes → /ingest
//
// ⚠️ `Judged` is ONE event because a turn is one thing. It used to be a slice, and
// before that the split was POSITIONAL — `splitJudged` returned the first `user_input`,
// the response phase judged `events[0]` — which encoded two false claims: that a
// request's only refusable event is a user turn (a tool result has not reached the
// model either), and that a reply's first event is its most consequential (in the
// ordinary agent shape of "a sentence plus an action", `model_output` came first and
// the ACTION went to /ingest). The slice fixed the second and kept the deeper mistake:
// that a generation is divisible at all.
//
// ⚠️ In OBSERVE mode nothing is refusable by definition and everything goes to /ingest.
// The split is computed the same way regardless, so the two modes cannot disagree about
// what an event IS; only the caller's dispatch differs.
type derived struct {
	Judged *GuardEvent
	Report []*GuardEvent

	// seen dedupes within ONE derivation pass: a request carrying the same call twice
	// must not derive it twice. Within a pass only — nothing here outlives the request.
	seen map[string]bool
}

// Commit is now a no-op, and the security property it used to carry holds BY
// CONSTRUCTION.
//
// It existed because the marks it applied ("we have now reported this user turn") were
// what made `deriveRequest` skip an input on the next request — so committing them for
// a REFUSED turn meant the retry of a blocked prompt derived nothing refusable,
// `/evaluate` was never called, and the second attempt reached the model. Send it twice
// and the block was gone; the fix was to commit only on the way through.
//
// With no state surviving the request there is nothing to commit and nothing to skip:
// every request re-derives its refusable turn from the conversation it carries, so a
// retry is always judged again. Kept as a call site so the ordering stays legible and
// so re-introducing per-conversation state has an obvious place to hook.
func (dv *derived) Commit(_ *sessionState) {}

// claim reports whether this pass has already handled an id, so one request carrying
// the same call twice does not derive it twice.
func (dv *derived) claim(id string) bool {
	if dv.seen == nil {
		dv.seen = map[string]bool{}
	}
	if dv.seen[id] {
		return false
	}
	dv.seen[id] = true
	return true
}

func (dv *derived) report(e *GuardEvent) { dv.Report = append(dv.Report, e) }

// All returns every event of the phase, the judged turn first.
func (dv *derived) All() []*GuardEvent {
	if dv.Judged == nil {
		return dv.Report
	}
	return append([]*GuardEvent{dv.Judged}, dv.Report...)
}

// unparsedEvent is what the plugin sends when it recognised a completion request but
// could not read a conversation out of it.
//
// ⚠️ It exists because the alternative is SILENCE, and silence here is
// indistinguishable from health. `batchPayload` returns nil for an empty slice and the
// post is then skipped entirely — so before this, an unreadable protocol produced no
// request to the runtime at all: HTTP 200 to the client, no warning, no error, no
// counter, and no row anywhere saying traffic had passed unjudged.
//
// ⚠️ It carries NO text. We could not read the body; inventing a payload would make the
// guardrails judge a fiction. What it carries is the fact of the traffic — protocol,
// size, and why. The `kind` is `user_input` for a request we could not read and
// `model_output` for a reply we could not reassemble, because the OGR enum is closed
// and those are the two altitudes this happens at; the `unparsed` flag is what stops
// either being read as somebody's words.
func unparsedEvent(d *deriveCtx, kind, reason string, bodyBytes int) *GuardEvent {
	e := d.event(kind, map[string]any{
		"text":     "",
		"unparsed": true,
		"reason":   reason,
		"bytes":    bodyBytes,
	})
	if d.protocol == "" {
		e.Payload["protocol_detected"] = "unknown"
	}
	return e
}

func subjectOf(principal, group string) *subject {
	// ⚠️ agent_id is deliberately left unset. The runtime recognises the agent from the
	// system prompt's self-definition, and naming the gateway consumer as the agent
	// would collapse every agent behind one API key into one row.
	if principal == "" && group == "" {
		return nil
	}
	// ⚠️ The group is sent even when the consumer header is absent: it still says which
	// workspace's policy set this traffic belongs under, which is the half that decides
	// what the guardrails do.
	return &subject{Principal: principal, PrincipalGroup: group}
}

// deriveRequest builds the ONE event for what is entering the model this turn, plus
// the itemised record of history.
//
// ⚠️ The judged event carries the WHOLE turn's input: the user's new words, the tool
// outcomes being fed back, and the tool set when it changed. Not one event per piece —
// a continuation that returns three tool outcomes returned them to ONE prompt, and a
// judge asked "is this safe to show the model" is being asked about all three together.
// Splitting them also meant a batch call, and a batch call meant the runtime composing
// a decision out of fragments of one turn.
//
// Each text is at a named payload path, and `texts` records which, so a verdict finding
// carrying `path` resolves back to exactly the bytes its offsets index.
func deriveRequest(d *deriveCtx, st *sessionState, conv *protocol.Conversation) *derived {
	prompt := truncate(conv.System, maxSystemPrompt)
	entries := transcriptOf(conv)
	instruction := instructionOf(conv)

	attach := func(e *GuardEvent) *GuardEvent {
		e.Authz = &authzEnvelope{
			Transcript:        entries,
			AgentSystemPrompt: prompt,
			Instruction:       truncate(instruction, maxInstruction),
		}
		// ⚠️ The system prompt goes in the PAYLOAD too, not only the envelope: agent
		// recognition reads payload.system and never looks at authz.
		if prompt != "" {
			e.Payload["system"] = prompt
		}
		return e
	}

	dv := &derived{}
	newInput := conv.NewInput()
	newFrom := len(conv.Turns) - len(newInput)

	// --- the turn ------------------------------------------------------------
	payload := map[string]any{}
	var userText string
	var results []map[string]any
	var resultTexts []string

	for _, t := range newInput {
		switch t.Role {
		case protocol.RoleUser:
			// The newest user turn only, and only once. Re-scanning history would
			// double-count findings on every turn of a long conversation; history still
			// gets MASKED, from the session's accumulated map, with no second detector
			// pass.
			if t.Text == "" {
				continue
			}
			userText = t.Text

		case protocol.RoleTool:
			// ⚠️ THE AGENT LOOP'S REFUSABLE INPUT. The tool has already run — we cannot
			// unrun it — but its output has NOT yet reached the model, which is exactly
			// where indirect prompt injection is still stoppable. This is what used to go
			// to /ingest and be judged minutes later by a worker, for 56% of the stream.
			if t.Outcome == nil {
				continue
			}
			id := t.Outcome.CallID
			if id != "" && !dv.claim("r:"+id) {
				continue
			}
			results = append(results, outcomePayload(t.Outcome))
			resultTexts = append(resultTexts, t.Outcome.Text)
		}
	}

	// The tool set, when it CHANGED — a description that moved under us is what a
	// rug-pull looks like, and it is refusable because the model has not read the new
	// list yet. It rides the turn rather than becoming its own judged event: it is
	// context for this turn, not a separate thing happening.
	/*
	 * ⚠️ SENT ON EVERY TURN NOW, and the "did it change" question moved to the runtime
	 * (`policy-engine/toolsFingerprint.ts`). It is a fact about a CONVERSATION, so
	 * answering it here required remembering a hash across requests — one of the four
	 * things that made this filter stateful. The runtime holds the session, so it holds
	 * the digest, and it drops `payload.tools` from what it judges when nothing moved.
	 *
	 * ⚠️ The rug-pull surface is unaffected: a description rewritten under a running
	 * agent still reaches the judge the turn it changes, and it now also survives this
	 * plugin restarting or its store being unavailable, neither of which it used to.
	 */
	toolsChanged := ""
	if len(conv.Tools) > 0 {
		toolsChanged = hashOf(toolsFingerprint(conv.Tools))
		payload["tools"] = toolsPayload(conv.Tools)
	}

	// Every tool DESCRIPTION is its own text: a description rewritten under us is the
	// rug-pull surface, and it is judged before the model reads the new list.
	registerTools := func(e *GuardEvent) {
		if payload["tools"] == nil {
			return
		}
		for i, t := range conv.Tools {
			if i >= maxToolsPerRegister {
				break
			}
			e.withText("payload.tools."+strconv.Itoa(i)+".description", t.Description)
		}
	}

	if userText != "" || len(results) > 0 {
		// ⚠️ The kind names what DOMINATES, and the runtime targets each text by its own
		// path rather than by the kind. A person's instruction outranks a tool outcome:
		// it is the thing the run is for.
		kind := "tool_result"
		if userText != "" {
			kind = "user_input"
			payload["text"] = userText
		}
		if len(results) > 0 {
			payload["tool_results"] = results
		}
		e := attach(d.event(kind, payload))
		e.withText("payload.text", userText)
		for i, text := range resultTexts {
			e.withText("payload.tool_results."+strconv.Itoa(i)+".result", text)
		}
		registerTools(e)
		dv.Judged = e
	} else if toolsChanged != "" {
		// Nothing new was said and nothing came back, but the tool list moved. That is
		// still refusable, and still one event.
		e := attach(d.event("tool_register", payload))
		registerTools(e)
		dv.Judged = e
	}

	// --- history -------------------------------------------------------------
	//
	// Everything the client executed since we last saw this conversation: post-hoc by
	// construction — the enforceable copy of an action was the one in the response — but
	// it is what a run's evidence is made of. Itemised, because these ARE independent
	// past facts: nothing composes an action the client ran an hour ago with one it ran
	// a minute ago.
	for _, t := range conv.Turns[:newFrom] {
		switch t.Role {
		case protocol.RoleAssistant:
			for _, a := range t.Actions {
				id := a.ID
				if id == "" || !dv.claim("c:"+id) {
					continue
				}
				dv.report(attach(toolCallEvent(d, a)))
			}
		case protocol.RoleTool:
			if t.Outcome == nil {
				continue
			}
			id := t.Outcome.CallID
			if id == "" || !dv.claim("r:"+id) {
				continue
			}
			dv.report(attach(toolResultEvent(d, t.Outcome)))
		}
	}

	// The itemised tool inventory, for the record. The judged turn already carries the
	// same definitions for the decision; these are what a console lists.
	if toolsChanged != "" {
		for i, t := range conv.Tools {
			if i >= maxToolsPerRegister {
				break // already reported by toolsPayload, which saw the same set
			}
			dv.report(attach(d.event("tool_register", map[string]any{
				"name":        t.Name,
				"description": t.Description,
				"schema":      rawJSONText(t.Schema),
			})))
		}
	}

	return dv
}

// deriveResponse builds the ONE event for what the model produced.
//
// ⚠️ Text, reasoning and every tool call in a single `model_output`, which is the
// payload shape the OGR spec documents for this kind (`{text, tool_calls}`) and which
// the plugin was not following. A reply that says "closing it" and calls three tools is
// one generation; as four events a judge cannot see that the sentence and the actions
// came from the same prompt, which is most of what tells an authorized action from a
// hijacked one.
func deriveResponse(d *deriveCtx, st *sessionState, out protocol.Output,
	conv *protocol.Conversation) *derived {
	dv := &derived{}
	if out.Empty() && out.Reasoning == "" {
		return dv
	}

	prompt := truncate(conv.System, maxSystemPrompt)
	entries := transcriptOf(conv)
	if out.Text != "" {
		entries = append(entries, transcriptEntry{Role: "assistant", Text: truncate(out.Text, maxEntryText)})
	}

	payload := map[string]any{"text": out.Text}
	if out.Reasoning != "" {
		// ⚠️ Beside the text, never folded into it. Reasoning is content a guardrail
		// should read — it is where a hijacked plan states itself before any action
		// exists — but it is not what the model SAID, and concatenating the two would
		// make a verdict's span offsets index a string that exists nowhere on the wire,
		// so every redaction would write at a shifted position.
		payload["reasoning"] = truncate(out.Reasoning, maxEntryText)
	}

	e := d.event("model_output", payload)
	// Registered FIRST so the primary is the model's own words when it said any: a
	// pathless finding on a text-only reply still resolves, which is the common case.
	e.withText("payload.text", out.Text)
	e.withText("payload.reasoning", out.Reasoning)

	var calls []map[string]any
	if len(out.Actions) > maxActionsPerTurn {
		// ⚠️ Said out loud. A dropped action is an action nobody judged, and a reply
		// carrying more than this is either a runaway or an attack — either way not
		// something to trim quietly.
		logActionCap(len(out.Actions), maxActionsPerTurn)
	}
	for i, a := range out.Actions {
		if i >= maxActionsPerTurn {
			break
		}
		calls = append(calls, actionPayload(a))
		// ⚠️ Registered so a finding ABOUT AN ACTION has somewhere to resolve to — both
		// the synthesized composite (attribution only) and the bare command, which is a
		// real wire field and the one a command judge's offsets actually index.
		registerAction(e, "payload.tool_calls."+strconv.Itoa(i), a)
	}
	if len(calls) > 0 {
		payload["tool_calls"] = calls
	}

	e.Authz = &authzEnvelope{
		Transcript:        entries,
		AgentSystemPrompt: prompt,
		Instruction:       truncate(instructionOf(conv), maxInstruction),
	}
	if prompt != "" {
		e.Payload["system"] = prompt
	}
	dv.Judged = e
	return dv
}

// actionPayload renders one tool call.
//
// ⚠️ `arguments` is the argument OBJECT, not a JSON string of it. The runtime reads
// `arguments.command` to recover the bare command a shell action carries, and renders
// the composite with `JSON.stringify(arguments)` otherwise — so a string here defeats
// the first and double-encodes the second, handing the judge
// `"{\"command\":\"rm -rf /\"}"` where it was trained on `rm -rf /`.
func actionPayload(a protocol.Action) map[string]any {
	return map[string]any{
		"id":        a.ID,
		"name":      a.Name,
		"arguments": rawJSONText(a.Arguments),
	}
}

// outcomePayload renders one tool result.
//
// ⚠️ `tool_call_id` and `status` are not decoration: the runtime projects a tool result
// to `{outcome:{id, status}}`, so without the id the outcome line cannot be paired with
// the tool_use it answers, and the judge sees an agent whose calls never returned.
func outcomePayload(o *protocol.Outcome) map[string]any {
	return map[string]any{
		"tool_call_id": o.CallID,
		"name":         o.Name,
		"status":       outcomeStatus(o),
		"result":       o.Text,
	}
}

func toolsPayload(tools []protocol.ToolDef) []map[string]any {
	if len(tools) > maxToolsPerRegister {
		logToolCap(len(tools), maxToolsPerRegister)
	}
	out := make([]map[string]any, 0, len(tools))
	for i, t := range tools {
		if i >= maxToolsPerRegister {
			break
		}
		out = append(out, map[string]any{
			"name":        t.Name,
			"description": t.Description,
			"schema":      rawJSONText(t.Schema),
		})
	}
	return out
}

// toolCallEvent and toolResultEvent are the ITEMISED history events, for /ingest only.
// The turn's own actions and outcomes ride the judged event instead; these record what
// the client executed while we were not looking, which are independent past facts.

// stableID gives a HISTORY event an identity derived from the fact it reports, not from
// the request that happened to carry it.
//
// ⚠️ This is what replaced the plugin's cross-request "already reported" set. A client
// re-sends its whole conversation every turn, so the same executed action is carried by
// every subsequent request; the plugin used to remember which ids it had reported, in
// Redis, which is one of the four things that made it stateful. A deterministic id makes
// the re-report IDEMPOTENT instead: `/ingest` keys its queue job on
// (workspace, event_id) and the analytics row is merge-on-write on the same id, so the
// tenth report of one action collapses onto the first.
//
// ⚠️ Only for facts that are IMMUTABLE once they happen — an executed call, its outcome,
// a declared tool. The JUDGED turn keeps a per-request id on purpose: a retry of a
// refused prompt is a NEW decision and must be judged again, and giving it a stable id
// would let the store treat the second attempt as a duplicate of the first.
func stableID(kind, key string) string { return "evt-" + kind + "-" + hashOf(key) }

func toolCallEvent(d *deriveCtx, a protocol.Action) *GuardEvent {
	p := actionPayload(a)
	// The itemised kind names the id `call_id`, matching the OGR payload sketch for
	// `tool_call`; inside a turn it is `id`, matching the protocols themselves.
	p["call_id"] = a.ID
	delete(p, "id")
	e := d.event("tool_call", p)
	e.EventID = stableID("tc", a.ID)
	// Here the action IS the payload, so the composite sits at the empty path and the
	// bare command at `payload.arguments.command`.
	registerAction(e, "", a)
	return e
}

func toolResultEvent(d *deriveCtx, o *protocol.Outcome) *GuardEvent {
	e := d.event("tool_result", outcomePayload(o))
	e.EventID = stableID("tr", o.CallID)
	e.withText("payload.result", o.Text)
	return e
}

// toolsFingerprint is what a change to the declared tool set is detected against.
// Built from the parsed definitions rather than from the raw body, so the same tools
// re-serialised in a different key order do not read as a rug-pull.
func toolsFingerprint(tools []protocol.ToolDef) string {
	var b []byte
	for _, t := range tools {
		b = append(b, t.Name...)
		b = append(b, 0)
		b = append(b, t.Description...)
		b = append(b, 0)
		b = append(b, t.Schema...)
		b = append(b, 0)
	}
	return string(b)
}

// --- small helpers ----------------------------------------------------------

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

func trimSpace(s string) string {
	for len(s) > 0 && (s[0] == ' ' || s[0] == '\t' || s[0] == '\n' || s[0] == '\r') {
		s = s[1:]
	}
	for len(s) > 0 {
		c := s[len(s)-1]
		if c != ' ' && c != '\t' && c != '\n' && c != '\r' {
			break
		}
		s = s[:len(s)-1]
	}
	return s
}

func hashOf(s string) string {
	sum := sha256.Sum256([]byte(s))
	return hex.EncodeToString(sum[:])[:16]
}

// rawJSONText keeps an object/array as structured JSON and degrades anything else to a
// string, so a malformed tool schema or a truncated argument stream cannot break the
// whole batch.
func rawJSONText(raw string) any {
	if raw == "" {
		return nil
	}
	if gjson.Valid(raw) {
		if r := gjson.Parse(raw); r.IsObject() || r.IsArray() {
			return jsonRaw(raw)
		}
	}
	return raw
}

// jsonRaw is a pre-serialized JSON fragment that marshals as itself.
type jsonRaw string

func (j jsonRaw) MarshalJSON() ([]byte, error) {
	if j == "" {
		return []byte("null"), nil
	}
	return []byte(j), nil
}
