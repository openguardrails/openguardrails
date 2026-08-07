// OpenGuardrails Runtime — a Higress WASM plugin that speaks OGR to an
// OpenGuardrails runtime directly.
//
// It replaces the previous pair (the `og-connector-higress-go` WASM plugin plus
// a Python adapter process): that connector was written against the
// previous-generation platform's HTTP contract, so every runtime concept had to be squeezed through it — thirteen
// GuardEvent kinds became two, `flag` became "pass", batching had no place, and
// the whole tool_call side of a policy was unreachable. Speaking OGR natively
// removes the translation AND the extra network hop.
//
// One switch decides how much it does:
//
//	mode: observe   report only. Never pauses the request, never touches a body.
//	                Detection still runs (the runtime evaluates on ingest), so the
//	                console fills with findings while the gateway stays a mirror.
//	mode: enforce   evaluate before the model sees the prompt and honour the
//	                verdict: refuse, or mask and let it through.
//
// Rolling back is switching the mode, not redeploying.
package main

import (
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/higress-group/proxy-wasm-go-sdk/proxywasm"
	"github.com/higress-group/proxy-wasm-go-sdk/proxywasm/types"
	"github.com/higress-group/wasm-go/pkg/wrapper"
	"github.com/tidwall/gjson"
)

func main() {}

func init() {
	wrapper.SetCtx(
		"openguardrails-runtime",
		wrapper.ParseConfig(parseConfig),
		wrapper.ProcessRequestHeaders(onRequestHeaders),
		wrapper.ProcessRequestBody(onRequestBody),
		wrapper.ProcessResponseHeaders(onResponseHeaders),
		wrapper.ProcessResponseBody(onResponseBody),
		wrapper.ProcessStreamingResponseBody(onStreamingResponseBody),
	)
}

// --- configuration ----------------------------------------------------------

const (
	modeObserve = "observe"
	modeEnforce = "enforce"

	pathEvaluate  = "/api/public/ogr/v1/evaluate"
	pathIngest    = "/api/public/ogr/v1/ingest"
	pathHeartbeat = "/api/public/ogr/v1/heartbeat"

	maxBatch = 100 // the runtime's ingest cap
)

type Config struct {
	client wrapper.HttpClient

	cluster string
	host    string
	apiKey  string

	mode                 string
	timeoutMs            uint32
	failClosed           bool
	principalHeader      string
	principalGroupHeader string
	agentID              string
	store                *store

	// Judging a STREAMED answer as it grows (streamjudge.go). Enforce only:
	// observe never touches a body and never waits for anything.
	streamJudge      bool
	streamJudgeChars int
	streamJudgeMax   int

	// A second runtime that gets a COPY of every event and decides nothing.
	mirror    wrapper.HttpClient
	mirrorKey string
	hasMirror bool
}

func parseConfig(j gjson.Result, c *Config) error {
	c.cluster = j.Get("runtime_cluster").String()
	c.host = strings.TrimPrefix(strings.TrimPrefix(j.Get("runtime_base_url").String(), "https://"), "http://")
	c.apiKey = j.Get("api_key").String()

	c.mode = modeObserve
	if v := j.Get("mode").String(); v == modeEnforce {
		c.mode = modeEnforce
	}

	// The PDP budget, in ENFORCE mode only — nothing waits in observe.
	//
	// ⚠️ 1s was tried and MEASURED WRONG (2026-07-31). A warm single request is
	// 233-332ms, which makes 1s look like 3x headroom; but latency scales with
	// concurrency, and twelve simultaneous requests — a quiet minute for an
	// enterprise gateway — spread 619ms to 1647ms, eight of them past the second.
	// Live through the gateway, nine of twelve reached the model with no verdict
	// at all. A budget that sits INSIDE the working distribution is the worst
	// place for it: enforcement evaporates exactly when the system is busy, which
	// is when it is most worth having.
	//
	// 5s clears the measured tail with room, and still bounds the wait. Lower it
	// against numbers from YOUR runtime, not from a single-request benchmark —
	// and watch the `unchecked` counter, which is what this trade actually costs.
	c.timeoutMs = 5000
	if v := j.Get("timeout_ms"); v.Exists() {
		c.timeoutMs = uint32(v.Uint())
	}

	c.failClosed = j.Get("fail_mode").String() == "closed"

	// WHO the gateway authenticated this call as. In IAM terms the principal, and in
	// the platform the agent's OWNER — an identity the customer's IT admin issued and
	// can trace back to a person or a project.
	c.principalHeader = "x-mse-consumer"
	if v := j.Get("principal_header").String(); v != "" {
		c.principalHeader = v
	}
	/**
	 * The consumer's GROUP, which the platform maps onto a workspace — a group of
	 * agents plus one policy set.
	 *
	 * Separate from the principal on purpose, and the IAM precedent is exact: AWS
	 * refuses to let a group be a Principal because "groups relate to permissions, not
	 * authentication". The consumer authenticates; the group is where policy attaches.
	 */
	c.principalGroupHeader = "x-mse-consumer-group"
	if v := j.Get("principal_group_header").String(); v != "" {
		c.principalGroupHeader = v
	}
	c.agentID = j.Get("agent_id").String()

	/**
	 * Streaming output detection. ON by default in enforce mode: without it the
	 * model's output side is judged only for a BUFFERED reply, and the ordinary
	 * shape of chat traffic — an SSE stream — reaches the caller whole no matter
	 * what the verdict says. It costs one PDP call per `stream_judge_chars` of
	 * answer and nothing in TTFT; `false` restores the report-only behaviour.
	 */
	c.streamJudge = c.mode == modeEnforce
	if v := j.Get("stream_judge"); v.Exists() {
		c.streamJudge = v.Bool() && c.mode == modeEnforce
	}
	c.streamJudgeChars = defaultStreamJudgeChars
	if v := j.Get("stream_judge_chars"); v.Exists() && v.Int() > 0 {
		c.streamJudgeChars = int(v.Int())
	}
	c.streamJudgeMax = defaultStreamJudgeMax
	if v := j.Get("stream_judge_max"); v.Exists() && v.Int() > 0 {
		c.streamJudgeMax = int(v.Int())
	}

	c.client = wrapper.NewClusterClient(wrapper.TargetCluster{Cluster: c.cluster, Host: c.host})

	// Traffic mirroring: a candidate runtime sees the same events and answers
	// nothing. Fire-and-forget in EVERY mode, including enforce — the mirror must
	// never be able to slow a request down, let alone stop one, or a shadow
	// deployment becomes an outage the moment the candidate is unhealthy.
	if cluster := j.Get("mirror_cluster").String(); cluster != "" {
		host := strings.TrimPrefix(strings.TrimPrefix(j.Get("mirror_base_url").String(), "https://"), "http://")
		c.mirror = wrapper.NewClusterClient(wrapper.TargetCluster{Cluster: cluster, Host: host})
		c.mirrorKey = j.Get("mirror_api_key").String()
		if c.mirrorKey == "" {
			c.mirrorKey = c.apiKey
		}
		c.hasMirror = true
		proxywasm.LogWarnf("[OGR-CONFIG] mirror: cluster=%s host=%s (copies only, never gates)", cluster, host)
	}

	// The shared session store. Optional — without it the plugin still masks and
	// restores WITHIN one request, but a conversation whose next turn lands on
	// another Envoy worker re-masks nothing, because that worker's Wasm VM has
	// its own empty memory. See session.go.
	if cluster := j.Get("redis_cluster").String(); cluster != "" {
		key, err := parseSessionKey(j.Get("session_key").String())
		if err != nil {
			// ⚠️ Refuse to load rather than fall back to storing the map in the
			// clear: the only reason this store is allowed to hold the session at
			// all is that what it holds is sealed.
			return fmt.Errorf("redis_cluster is set but %w", err)
		}
		client := wrapper.NewRedisClusterClient(wrapper.TargetCluster{
			Cluster: cluster,
			Host:    j.Get("redis_host").String(),
		})
		ttl := int(sessionTTL.Seconds())
		if v := j.Get("session_ttl_s"); v.Exists() {
			ttl = int(v.Uint())
		}
		if err := client.Init(j.Get("redis_username").String(), j.Get("redis_password").String(),
			int64(c.timeoutMs)); err != nil {
			return fmt.Errorf("redis init: %w", err)
		}
		c.store = &store{redis: client, key: key, ttlS: ttl}
		proxywasm.LogWarnf("[OGR-CONFIG] session store: redis cluster=%s ttl=%ds (sealed)", cluster, ttl)
	} else {
		// ⚠️ In BOTH modes. The store is not only the masking map: `deriveRequest`
		// reads it to know what has already been reported, so without it every
		// worker re-reports the whole conversation as new. Measured on this box:
		// six identical requests produced four user_input and four tool_call
		// events instead of one each. Observe mode used to say nothing at all
		// here, which is how a duplicated event stream gets mistaken for traffic.
		what := "history is re-reported per worker, so events duplicate"
		if c.mode == modeEnforce {
			what += "; masking is per-worker, so a conversation's later turns may reach the model unmasked"
		}
		proxywasm.LogWarnf("[OGR-CONFIG] ⚠️ no redis_cluster: %s", what)
	}

	// The beat is registered here because parseConfig is where a configured client
	// first exists; RegisterTickFunc is idempotent per plugin load.
	startHeartbeat(c)

	proxywasm.LogWarnf("[OGR-CONFIG] mode=%s cluster=%s host=%s timeout=%dms fail=%s beat=%ds stream_judge=%s",
		c.mode, c.cluster, c.host, c.timeoutMs, failLabel(c.failClosed), heartbeatPeriodMs/1000,
		streamJudgeLabel(c))
	return nil
}

func streamJudgeLabel(c *Config) string {
	if !c.streamJudge {
		return "off"
	}
	return "every " + strconv.Itoa(c.streamJudgeChars) + " chars, max " + strconv.Itoa(c.streamJudgeMax)
}

func failLabel(closed bool) string {
	if closed {
		return "closed"
	}
	return "open"
}

// --- per-request context ----------------------------------------------------

const (
	ctxPrincipal      = "ogr_principal"
	ctxPrincipalGroup = "ogr_principal_group"
	ctxReqID          = "ogr_req_id"
	ctxSession        = "ogr_session"
	ctxStreaming      = "ogr_streaming"
	ctxModel          = "ogr_model"
	ctxMessages       = "ogr_messages"
	ctxStream         = "ogr_stream_proc"
	ctxStreamGuard    = "ogr_stream_guard"
	ctxAnswered       = "ogr_answered"
	ctxSkip           = "ogr_skip"
)

type reqState struct {
	session   *sessionState
	derive    *deriveCtx
	messages  []gjson.Result
	model     string
	streaming bool
}

// --- request path -----------------------------------------------------------

func onRequestHeaders(ctx wrapper.HttpContext, cfg Config) types.Action {
	path, _ := proxywasm.GetHttpRequestHeader(":path")
	if !strings.Contains(path, "/chat/completions") {
		// Not chat traffic: this plugin has nothing to say about it, and reading
		// the body of an unrelated API would only cost latency.
		ctx.SetContext(ctxSkip, true)
		ctx.DontReadRequestBody()
		ctx.DontReadResponseBody()
		return types.ActionContinue
	}

	principal, _ := proxywasm.GetHttpRequestHeader(cfg.principalHeader)
	ctx.SetContext(ctxPrincipal, principal)
	group, _ := proxywasm.GetHttpRequestHeader(cfg.principalGroupHeader)
	ctx.SetContext(ctxPrincipalGroup, group)

	reqID, _ := proxywasm.GetHttpRequestHeader("x-request-id")
	if reqID == "" {
		reqID = strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	ctx.SetContext(ctxReqID, reqID)

	// The body may be rewritten (masking) and the response must not arrive
	// compressed, or neither restoration nor detection can read it.
	_ = proxywasm.RemoveHttpRequestHeader("content-length")
	_ = proxywasm.RemoveHttpRequestHeader("accept-encoding")
	return types.HeaderStopIteration
}

func onRequestBody(ctx wrapper.HttpContext, cfg Config, body []byte) types.Action {
	if ctx.GetBoolContext(ctxSkip, false) || len(body) == 0 {
		return types.ActionContinue
	}
	parsed := gjson.ParseBytes(body)
	messages := parsed.Get("messages").Array()
	if len(messages) == 0 {
		return types.ActionContinue
	}

	principal := ctx.GetStringContext(ctxPrincipal, "")
	group := ctx.GetStringContext(ctxPrincipalGroup, "")
	reqID := ctx.GetStringContext(ctxReqID, "")
	sessionID := conversationKey(principal, messages)

	rs := &reqState{
		derive: &deriveCtx{
			principal:      principal,
			principalGroup: group,
			sessionID:      sessionID,
			guardID:        "gw-" + reqID,
			reqID:          reqID,
			now:            time.Now().UTC().Format("2006-01-02T15:04:05Z"),
		},
		messages:  messages,
		model:     parsed.Get("model").String(),
		streaming: parsed.Get("stream").Bool(),
	}
	ctx.SetContext(ctxSession, rs)
	ctx.SetContext(ctxStreaming, rs.streaming)
	ctx.SetContext(ctxModel, rs.model)
	ctx.SetContext(ctxMessages, string(body))

	// ⚠️ Everything below needs the session first: what is NEW in this request is
	// only knowable against what we already reported, and history can only be
	// re-masked from the map. In OBSERVE mode the load happens off the critical
	// path — the request is already on its way to the model by the time the
	// callback runs — which is what keeps observe mode free.
	if cfg.mode == modeObserve {
		cfg.store.load(sessionID, sessionID, func(st *sessionState) {
			rs.session = st
			reportAsync(ctx, cfg, deriveRequest(rs.derive, st, parsed))
			cfg.store.save(sessionID, st)
		})
		return types.ActionContinue
	}

	cfg.store.load(sessionID, sessionID, func(st *sessionState) {
		rs.session = st
		enforceRequest(ctx, cfg, rs, parsed, string(body))
	})
	return types.ActionPause
}

// enforceRequest runs once the session is in hand: derive, re-mask the history
// from what we already know, and put the newest user turn to the PDP.
func enforceRequest(ctx wrapper.HttpContext, cfg Config, rs *reqState, parsed gjson.Result, body string) {
	st := rs.session
	events := deriveRequest(rs.derive, st, parsed)

	// Re-mask everything this session already knows about, on EVERY turn. Not a
	// plugin setting: WHETHER to redact is the runtime's decision, carried by the
	// verdict. A gateway that could switch it off locally would be a second place
	// policy lives, and the harder one to change.
	//
	// The
	// client's own history holds the original plaintext — it never saw our
	// placeholders, because we restored them on the way back — so a value masked
	// in turn 1 arrives in the clear again in turn 2.
	outBody := body
	{
		if masked, n := maskMessages(outBody, st.redactions()); n > 0 {
			outBody = masked
			proxywasm.LogWarnf("[OGR-REQ] re-masked %d history strings", n)
		}
	}

	judged, rest := splitJudged(events)
	reportAsync(ctx, cfg, rest)
	// The primary sees `judged` through /evaluate; the mirror only ever ingests.
	if judged != nil {
		mirrorEvents(cfg, []*GuardEvent{judged})
	}
	if judged == nil {
		finishRequest(ctx, cfg, rs, outBody)
		return
	}

	payload, err := json.Marshal(judged)
	if err != nil {
		finishRequest(ctx, cfg, rs, outBody)
		return
	}
	err = cfg.client.Post(pathEvaluate, ogrHeaders(cfg), payload,
		func(status int, _ http.Header, respBody []byte) {
			onInputVerdict(ctx, cfg, rs, judged, outBody, status, respBody)
		}, cfg.timeoutMs)
	if err != nil {
		proxywasm.LogErrorf("[OGR-REQ] evaluate dispatch failed: %v", err)
		applyFail(ctx, cfg, rs, "evaluate dispatch failed")
	}
}

// finishRequest writes the session back and lets the request go.
func finishRequest(ctx wrapper.HttpContext, cfg Config, rs *reqState, outBody string) {
	cfg.store.save(rs.derive.sessionID, rs.session)
	if outBody != ctx.GetStringContext(ctxMessages, "") {
		if err := proxywasm.ReplaceHttpRequestBody([]byte(outBody)); err != nil {
			// ⚠️ If the buffer is no longer writable here the prompt reaches the
			// model UNMASKED while every log says "masked". Fail loudly.
			proxywasm.LogErrorf("[OGR-REQ] request body replace FAILED: %v", err)
		}
		ctx.SetContext(ctxMessages, outBody)
	}
	proxywasm.ResumeHttpRequest()
}

// splitJudged separates the one event an enforcing gateway can still stop from
// the ones it can only report. Everything in a request's history has already
// run on the client; the newest user turn has not reached the model yet.
func splitJudged(events []*GuardEvent) (*GuardEvent, []*GuardEvent) {
	for i, e := range events {
		if e.Kind == "user_input" {
			rest := append(append([]*GuardEvent{}, events[:i]...), events[i+1:]...)
			return e, rest
		}
	}
	return nil, events
}

func onInputVerdict(ctx wrapper.HttpContext, cfg Config, rs *reqState, judged *GuardEvent,
	outBody string, status int, respBody []byte) {
	if status != 200 {
		proxywasm.LogErrorf("[OGR-REQ] evaluate status=%d", status)
		applyFail(ctx, cfg, rs, "evaluate returned "+strconv.Itoa(status)+" (0 = timeout or unreachable)")
		return
	}
	bump(cntEvaluated, 1)
	v := gjson.ParseBytes(respBody)
	decision := v.Get("decision").String()
	proxywasm.LogWarnf("[OGR-REQ] decision=%s findings=%d session=%s",
		decision, len(v.Get("findings").Array()), rs.session.ID)

	if stopsRequest(decision) {
		cfg.store.save(rs.derive.sessionID, rs.session)
		answer(ctx, rs, refusalReason(v))
		return
	}

	if decision == "redact" {
		if red := learnFromVerdict(rs.session, v, judged.text); len(red) > 0 {
			if masked, n := maskMessages(outBody, red); n > 0 {
				outBody = masked
				proxywasm.LogWarnf("[OGR-REQ] masked %d strings, %d tokens live", n, len(rs.session.Mapping))
			}
		}
	}

	finishRequest(ctx, cfg, rs, outBody)
}

// --- response path ----------------------------------------------------------

func onResponseHeaders(ctx wrapper.HttpContext, cfg Config) types.Action {
	if ctx.GetBoolContext(ctxSkip, false) || ctx.GetBoolContext(ctxAnswered, false) {
		return types.ActionContinue
	}
	_ = proxywasm.RemoveHttpResponseHeader("content-length")

	contentType, _ := proxywasm.GetHttpResponseHeader("content-type")
	sse := strings.Contains(contentType, "text/event-stream")
	ctx.SetContext(ctxStreaming, sse)
	if sse {
		return types.ActionContinue // chunks flow through onStreamingResponseBody
	}
	// ⚠️ OBSERVE NEVER BUFFERS. Holding the whole reply to read it is exactly the
	// latency an observer must not add; the streaming hook keeps a bounded copy
	// while the bytes go straight to the caller. Only enforce buffers, because
	// only enforce can still change the reply — refuse it, or restore what we
	// masked on the way in.
	if cfg.mode == modeObserve {
		return types.ActionContinue
	}
	ctx.BufferResponseBody()
	return types.HeaderStopIteration
}

func onResponseBody(ctx wrapper.HttpContext, cfg Config, body []byte) types.Action {
	rs, ok := ctx.GetContext(ctxSession).(*reqState)
	if !ok || rs == nil || ctx.GetBoolContext(ctxAnswered, false) {
		return types.ActionContinue
	}
	parsed := gjson.ParseBytes(body)
	content := parsed.Get("choices.0.message.content").String()
	calls := toolCallsOf(parsed.Get("choices.0.message"))
	if content == "" && len(calls) == 0 {
		return types.ActionContinue
	}

	events := deriveResponse(rs.derive, rs.session, content, calls, rs.messages)
	if cfg.mode == modeObserve {
		reportAsync(ctx, cfg, events)
		return restoreResponse(rs, body)
	}

	// Enforce: judge the model's own output, then restore our placeholders.
	// ⚠️ Detect BEFORE restoring. The text still carries the placeholders; if we
	// restored first, the privacy guardrail would find the very values we
	// removed and block our own restoration.
	judged := events[0]
	rest := events[1:]
	reportAsync(ctx, cfg, rest)
	mirrorEvents(cfg, []*GuardEvent{judged})
	payload, err := json.Marshal(judged)
	if err != nil {
		return restoreResponse(rs, body)
	}
	err = cfg.client.Post(pathEvaluate, ogrHeaders(cfg), payload,
		func(status int, _ http.Header, respBody []byte) {
			if status == 200 {
				bump(cntEvaluated, 1)
				v := gjson.ParseBytes(respBody)
				if stopsRequest(v.Get("decision").String()) {
					_ = proxywasm.ReplaceHttpResponseBody([]byte(refusalBody(rs.model, refusalReason(v))))
					proxywasm.ResumeHttpResponse()
					return
				}
			} else if cfg.failClosed {
				_ = proxywasm.ReplaceHttpResponseBody([]byte(refusalBody(rs.model, failMessage)))
				proxywasm.ResumeHttpResponse()
				return
			}
			if next, changed := restoreBody(string(body), rs.session.Mapping); changed {
				_ = proxywasm.ReplaceHttpResponseBody([]byte(next))
			}
			proxywasm.ResumeHttpResponse()
		}, cfg.timeoutMs)
	if err != nil {
		return restoreResponse(rs, body)
	}
	return types.ActionPause
}

func restoreResponse(rs *reqState, body []byte) types.Action {
	if next, changed := restoreBody(string(body), rs.session.Mapping); changed {
		_ = proxywasm.ReplaceHttpResponseBody([]byte(next))
	}
	return types.ActionContinue
}

func onStreamingResponseBody(ctx wrapper.HttpContext, cfg Config, chunk []byte, isLast bool) []byte {
	rs, ok := ctx.GetContext(ctxSession).(*reqState)
	if !ok || rs == nil {
		return chunk
	}
	// ⚠️ A refusal is OURS, not the model's. `answer` ends the request with a
	// locally generated body, and that body still reaches this hook — so without
	// this the plugin derives a `model_output` from its own refusal text and
	// ingests it. Two costs, both bad for a thing whose output is evidence: the
	// audit trail gains a record of something no model ever said, and the runtime
	// evaluates on ingest, so the refusal is judged by the guardrails that
	// produced it. `onResponseHeaders` and `onResponseBody` have always checked
	// this; the streaming hook was the hole, and it swallowed BOTH response
	// shapes, because a locally generated JSON body arrives here too.
	if ctx.GetBoolContext(ctxAnswered, false) {
		return chunk
	}
	sp, _ := ctx.GetContext(ctxStream).(*streamProcessor)
	if sp == nil {
		sp = newStreamProcessor(rs.session.Mapping, ctx.GetBoolContext(ctxStreaming, true))
		ctx.SetContext(ctxStream, sp)
	}
	out := sp.ProcessChunk(chunk, isLast)

	// Judge the answer AS IT GROWS (streamjudge.go). The chunk above is already
	// restored and on its way; this only decides whether the REST of the answer
	// gets to follow it, so nothing here can delay the first token.
	sg, _ := ctx.GetContext(ctxStreamGuard).(*streamGuard)
	if cfg.streamJudge && sp.sse {
		if sg == nil {
			sg = &streamGuard{}
			ctx.SetContext(ctxStreamGuard, sg)
		}
		switch {
		case sg.cut:
			// The rest of the answer is dropped. The upstream keeps sending and
			// we keep ACCUMULATING it — what the model produced is evidence, and
			// the report at end of stream is where it belongs — but none of it
			// reaches the caller.
			out = sg.tail(rs.model)
		case !isLast:
			if runes := sp.ContentRunes(); sg.dueForJudgment(runes, cfg.streamJudgeChars, cfg.streamJudgeMax) {
				content, _ := sp.Result()
				judgeStream(cfg, rs, sg, content, runes)
			}
		}
	}

	if isLast {
		// ⚠️ This is the REPORT, and it is where the answer becomes a record: one
		// event for the whole reply, whatever the stream was judged in between
		// (those calls carry `ogr-partial` and store nothing). What cannot be
		// retracted here is the text already delivered — cutting is the streaming
		// guard's job, above, while bytes are still flowing.
		content, calls := sp.Result()
		if content != "" || len(calls) > 0 {
			events := deriveResponse(rs.derive, rs.session, content, calls, rs.messages)
			// The same id the interim judgments used, so the answer is ONE row
			// in the store rather than one per window.
			if sg != nil && sg.eventID != "" && len(events) > 0 && events[0].Kind == "model_output" {
				events[0].EventID = sg.eventID
			}
			reportAsync(ctx, cfg, events)
		}
	}
	return out
}

// --- talking to the runtime -------------------------------------------------

const failMessage = "The AI guardrail service is unavailable and this deployment is configured to fail closed."

func ogrHeaders(cfg Config) [][2]string {
	return [][2]string{
		{"Content-Type", "application/json"},
		{"Authorization", "Bearer " + cfg.apiKey},
	}
}

// reportAsync posts events to the async ingest endpoint and does not wait. The
// runtime evaluates them there too, so observe mode still produces findings —
// it just never makes anyone wait for them.
//
// The mirror gets the same batch, always: in enforce mode the primary decides
// through /evaluate and the mirror still needs the whole picture, or a shadow
// deployment is comparing against a hole.
func reportAsync(ctx wrapper.HttpContext, cfg Config, events []*GuardEvent) {
	payload := batchPayload(events)
	if payload == nil {
		return
	}
	post(cfg.client, cfg.apiKey, payload, cfg.timeoutMs, "OGR-INGEST")
	bump(cntIngested, uint64(len(events)))
	mirrorAsync(cfg, payload)
}

// mirrorAsync sends a copy to the candidate runtime and forgets about it.
//
// ⚠️ Dispatched, never awaited, in EVERY mode. A mirror exists to answer "what
// would the new policy have said" — it is not in the decision, so a slow or dead
// candidate must cost the caller nothing. That is also why it rides /ingest
// rather than /evaluate: the mirror runtime evaluates on ingest anyway, so its
// console fills with the same findings without anyone waiting for a verdict.
func mirrorAsync(cfg Config, payload []byte) {
	if !cfg.hasMirror || payload == nil {
		return
	}
	post(cfg.mirror, cfg.mirrorKey, payload, cfg.timeoutMs, "OGR-MIRROR")
	bump(cntMirrored, 1)
}

// mirrorEvents is the mirror-only path, for events the primary saw through a
// different endpoint (the enforce-mode /evaluate) and must not receive twice.
func mirrorEvents(cfg Config, events []*GuardEvent) {
	if !cfg.hasMirror {
		return
	}
	mirrorAsync(cfg, batchPayload(events))
}

func batchPayload(events []*GuardEvent) []byte {
	if len(events) == 0 {
		return nil
	}
	if len(events) > maxBatch {
		proxywasm.LogWarnf("[OGR-INGEST] %d events over the batch cap, sending the newest %d", len(events), maxBatch)
		events = events[len(events)-maxBatch:]
	}
	payload, err := json.Marshal(map[string]any{"batch": events})
	if err != nil {
		return nil
	}
	return payload
}

func post(client wrapper.HttpClient, apiKey string, payload []byte, timeoutMs uint32, tag string) {
	headers := [][2]string{
		{"Content-Type", "application/json"},
		{"Authorization", "Bearer " + apiKey},
	}
	if err := client.Post(pathIngest, headers, payload,
		func(status int, _ http.Header, body []byte) {
			if status != 200 && status != 207 {
				proxywasm.LogErrorf("[%s] status=%d body=%s", tag, status, truncate(string(body), 256))
			}
		}, timeoutMs); err != nil {
		proxywasm.LogErrorf("[%s] dispatch failed: %v", tag, err)
	}
}

// --- failure handling -------------------------------------------------------

func failAction(ctx wrapper.HttpContext, cfg Config, rs *reqState, why string) types.Action {
	if !cfg.failClosed {
		return types.ActionContinue
	}
	answer(ctx, rs, failMessage)
	return types.ActionPause
}

func applyFail(ctx wrapper.HttpContext, cfg Config, rs *reqState, why string) {
	if cfg.failClosed {
		answer(ctx, rs, failMessage)
		return
	}
	// ⚠️ Say what actually happened. "fail-open" reads like a setting working as
	// intended; what it means for this request is that nothing judged it. A
	// deployment that never greps for this line cannot tell a healthy gateway
	// from one whose PDP has been unreachable for a week.
	bump(cntUnchecked, 1)
	proxywasm.LogWarnf("[OGR-REQ] request passed UNCHECKED (fail-open): %s, session=%s",
		why, rs.session.ID)
	proxywasm.ResumeHttpRequest()
}

// answer ends the request with a refusal the caller's client can render, in the
// shape the caller asked for.
func answer(ctx wrapper.HttpContext, rs *reqState, reason string) {
	ctx.SetContext(ctxAnswered, true)
	if rs.streaming {
		_ = proxywasm.SendHttpResponse(200,
			[][2]string{{"content-type", "text/event-stream"}, {"cache-control", "no-cache"}},
			[]byte(refusalStream(rs.model, reason)), -1)
		return
	}
	_ = proxywasm.SendHttpResponse(200,
		[][2]string{{"content-type", "application/json"}},
		[]byte(refusalBody(rs.model, reason)), -1)
}
