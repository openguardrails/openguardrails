// OpenGuardrails Runtime — a Higress WASM plugin that speaks OGR to an
// OpenGuardrails runtime directly.
//
// It replaces the previous pair (the `og-connector-higress-go` WASM plugin plus a
// Python adapter process): that connector was written against the previous-generation
// platform's HTTP contract, so every runtime concept had to be squeezed through it —
// thirteen GuardEvent kinds became two, `flag` became "pass", batching had no place,
// and the whole tool_call side of a policy was unreachable. Speaking OGR natively
// removes the translation AND the extra network hop.
//
// One switch decides how much it does:
//
//	mode: observe   report only. Never pauses the request, never touches a body.
//	                Every event goes to /ingest, which evaluates on arrival, so the
//	                console fills with findings while the gateway stays a mirror.
//	mode: enforce   put everything that has not happened yet to /evaluate, wait for
//	                the verdict, and honour it: refuse, or mask and let it through.
//
// Rolling back is switching the mode, not redeploying.
//
// # The two endpoints
//
// ⚠️ The rule is by MODE first and by REFUSABILITY second:
//
//	observe  →  everything to /ingest.  Nothing waits. Nothing is refusable.
//	enforce  →  THE TURN to /evaluate, blocking, and the history to /ingest.
//
// "Refusable" is not a synonym for "important" — it means the model, or the caller,
// has not seen it yet. Everything else is evidence, and evidence does not belong on a
// blocking path. The split itself is computed once, in `deriveRequest` /
// `deriveResponse`, and arrives here as the two fields of a `derived` (events.go); the
// only thing this file decides is which endpoint each half goes to.
//
// ⚠️ `/evaluate` takes exactly ONE event: the turn. There is no batch form, because a
// turn is not divisible — a reply that says something and calls three tools is one
// generation, and the batch endpoint only ever existed to reassemble a decision out of
// fragments the plugin should not have produced. `/ingest` stays a batch endpoint,
// which is right for what it carries: independent past facts.
package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/higress-group/proxy-wasm-go-sdk/proxywasm"
	"github.com/higress-group/proxy-wasm-go-sdk/proxywasm/types"
	"github.com/higress-group/wasm-go/pkg/wrapper"
	"github.com/openguardrails/higress/protocol"
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

	// The canonical endpoint paths (specification/runtime-api.md): clients MUST
	// join a configured base with `/v1/...` and hard-code no other prefix. The
	// prefix this build joins them onto is `base_path`, "" by default; the
	// reference runtime's legacy mount is reached with `base_path: /api/public/ogr`.
	pathEvaluate  = "/v1/evaluate"
	pathIngest    = "/v1/ingest"
	pathHeartbeat = "/v1/heartbeat"

	maxBatch = 100 // the runtime's ingest cap
)

type Config struct {
	client wrapper.HttpClient

	cluster string
	host    string
	apiKey  string

	// WHERE the endpoints live on the runtime: the mount prefix the canonical
	// /v1/* paths are joined onto. "" is the canonical root; a deployment still
	// on the legacy mount sets `base_path: /api/public/ogr`. A WASM filter
	// cannot cheaply probe-and-fall-back per request, so the mount is explicit
	// configuration, not discovery.
	basePath      string
	evaluatePath  string
	ingestPath    string
	heartbeatPath string

	mode       string
	timeoutMs  uint32
	failClosed bool

	// The OGR v0.5 agent identity: which header carries each field, plus static
	// fallbacks for a route that fronts exactly one agent. agent_user has no
	// static fallback on purpose — a constant user IS the runtime's default.
	agentIDHeader        string
	agentTypeHeader      string
	agentWorkspaceHeader string
	agentOwnerHeader     string
	agentUserHeader      string
	agentID              string
	agentType            string
	agentWorkspace       string
	agentOwner           string

	// A second runtime that gets a COPY of every event and decides nothing.
	mirror           wrapper.HttpClient
	mirrorKey        string
	mirrorIngestPath string
	hasMirror        bool
}

// normalizeBasePath cleans a configured mount prefix so joining it with the
// canonical /v1/* paths cannot produce `//v1/...` or `prefix/v1/...`:
// "" stays "" (the canonical root), anything else becomes "/prefix" with no
// trailing slash.
func normalizeBasePath(s string) string {
	s = strings.TrimRight(strings.TrimSpace(s), "/")
	if s == "" {
		return ""
	}
	if !strings.HasPrefix(s, "/") {
		s = "/" + s
	}
	return s
}

func parseConfig(j gjson.Result, c *Config) error {
	c.cluster = j.Get("runtime_cluster").String()
	c.host = strings.TrimPrefix(strings.TrimPrefix(j.Get("runtime_base_url").String(), "https://"), "http://")
	c.apiKey = j.Get("api_key").String()

	c.basePath = normalizeBasePath(j.Get("base_path").String())
	c.evaluatePath = c.basePath + pathEvaluate
	c.ingestPath = c.basePath + pathIngest
	c.heartbeatPath = c.basePath + pathHeartbeat

	c.mode = modeObserve
	if v := j.Get("mode").String(); v == modeEnforce {
		c.mode = modeEnforce
	}

	// How much this plugin says. QUIET by default — see log.go for the rule and for
	// why the counters had to be fixed before this was safe.
	logLevel = parseLogLevel(j.Get("log_level").String())

	// The PDP budget, in ENFORCE mode only — nothing waits in observe.
	//
	// ⚠️ 5s IS A CEILING, NOT A TARGET, and the distinction is the whole design. It is
	// what a person will tolerate ONCE, on a bad request — the tail, not the middle. A
	// deployment whose average sits near it has already failed the user even though no
	// counter fired: nothing timed out, nothing was unjudged, and every request took
	// five seconds. Expected latency belongs far below this; the number exists to bound
	// the worst case.
	//
	// ⚠️ 1s was tried and MEASURED WRONG (2026-07-31). A warm single request is
	// 233-332ms, which makes 1s look like 3x headroom; but latency scales with
	// concurrency, and twelve simultaneous requests — a quiet minute for an enterprise
	// gateway — spread 619ms to 1647ms, eight of them past the second. Live through the
	// gateway, nine of twelve reached the model with no verdict at all. A budget that
	// sits INSIDE the working distribution is the worst place for it: enforcement
	// evaporates exactly when the system is busy, which is when it is most worth having.
	//
	// ⚠️ THE BUDGETS MUST BE ORDERED, outermost longest — this plugin > the runtime's
	// `OGR_MODEL_TIMEOUT_MS` > the model gateway's own — AND THEY ALL FIT INSIDE THIS
	// ONE. Equal budgets are not ordered, and 5s here against 5s there was the bug:
	// whoever tripped first was a race, so a slow turn could abort HERE while the
	// runtime was still answering, and then nothing can say what was slow. The plugin
	// sees `status=0`, the runtime sees a client that hung up, and the capability that
	// actually blew the budget is named by neither.
	//
	// ⚠️ Ordering is bought by lowering the INNER budgets, never by raising this one.
	// Raising it was tried (8s) and reverted: it orders the chain by spending the user's
	// patience, which is the one resource here that is not ours. The runtime's inline
	// model budget has to be this minus its own overhead — policy resolution, Redis,
	// serialisation, network — not equal to it.
	//
	// ⚠️ It is also the fan-out budget. One `model_output` carrying N tool calls costs
	// the runtime N concurrent judge calls — measured there at 20% of gateway calls over
	// budget at concurrency 8, and 72% at 16 — so a turn with several parallel tool
	// calls pushes the MIDDLE of the distribution toward the ceiling, which is precisely
	// what the ceiling is not for. Fail-open then makes that failure faster and quieter
	// than success: the turn passes unjudged, latency improves, and only the `unchecked`
	// counter says anything happened. Watch it.
	c.timeoutMs = 5000
	if v := j.Get("timeout_ms"); v.Exists() {
		c.timeoutMs = uint32(v.Uint())
	}

	c.failClosed = j.Get("fail_mode").String() == "closed"

	/**
	 * The OGR v0.5 agent identity (agent_id / agent_type / agent_workspace /
	 * agent_owner / agent_user). OGR is agent-centric: the consumer the gateway
	 * authenticated IS the agent, and the consumer-group is the agent's WORKSPACE —
	 * a group of agents plus one policy set. Owner and user are attributes the
	 * platform records on the agent and the session; they decide nothing.
	 *
	 * Every field's source header is configurable, because not every deployment
	 * puts these facts in the MSE consumer headers. Static `agent_id` /
	 * `agent_type` / `agent_workspace` / `agent_owner` config values back the
	 * headers up for a route that fronts exactly one agent. A deployment that
	 * configures nothing still works: the runtime derives the agent from the API
	 * key (one key, one default agent) and attributes every session to one user.
	 */
	c.agentIDHeader = "x-mse-consumer"
	if v := j.Get("agent_id_header").String(); v != "" {
		c.agentIDHeader = v
	}
	c.agentWorkspaceHeader = "x-mse-consumer-group"
	if v := j.Get("agent_workspace_header").String(); v != "" {
		c.agentWorkspaceHeader = v
	}
	c.agentTypeHeader = "x-ogr-agent-type"
	if v := j.Get("agent_type_header").String(); v != "" {
		c.agentTypeHeader = v
	}
	c.agentOwnerHeader = "x-ogr-agent-owner"
	if v := j.Get("agent_owner_header").String(); v != "" {
		c.agentOwnerHeader = v
	}
	// Per-session by nature: for an agent serving many people the value changes
	// per request, so it can only ever come from the traffic.
	c.agentUserHeader = "x-ogr-agent-user"
	if v := j.Get("agent_user_header").String(); v != "" {
		c.agentUserHeader = v
	}
	c.agentID = j.Get("agent_id").String()
	c.agentType = j.Get("agent_type").String()
	c.agentWorkspace = j.Get("agent_workspace").String()
	c.agentOwner = j.Get("agent_owner").String()

	c.client = wrapper.NewClusterClient(wrapper.TargetCluster{Cluster: c.cluster, Host: c.host})

	// Traffic mirroring: a candidate runtime sees the same events and answers nothing.
	// Fire-and-forget in EVERY mode, including enforce — the mirror must never be able
	// to slow a request down, let alone stop one, or a shadow deployment becomes an
	// outage the moment the candidate is unhealthy.
	if cluster := j.Get("mirror_cluster").String(); cluster != "" {
		host := strings.TrimPrefix(strings.TrimPrefix(j.Get("mirror_base_url").String(), "https://"), "http://")
		c.mirror = wrapper.NewClusterClient(wrapper.TargetCluster{Cluster: cluster, Host: host})
		c.mirrorKey = j.Get("mirror_api_key").String()
		if c.mirrorKey == "" {
			c.mirrorKey = c.apiKey
		}
		// The mirror's own mount, because a shadow deployment exists precisely so
		// the two runtimes need not be the same build. Unset inherits `base_path`;
		// an explicit "" means the canonical root.
		mirrorBase := c.basePath
		if v := j.Get("mirror_base_path"); v.Exists() {
			mirrorBase = normalizeBasePath(v.String())
		}
		c.mirrorIngestPath = mirrorBase + pathIngest
		c.hasMirror = true
		logInfof("[OGR-CONFIG] mirror: cluster=%s host=%s base_path=%q (copies only, never gates)", cluster, host, mirrorBase)
	}

	/*
	 * ⚠️ THERE IS NO STORE ANY MORE, and `redis_cluster` / `redis_host` /
	 * `redis_username` / `redis_password` / `session_key` / `session_ttl_s` are gone
	 * with it (2026-08-10). A config still carrying them loads fine; they are ignored.
	 *
	 * Everything it held was a fact about a CONVERSATION — the placeholder map, what had
	 * already been reported, which session this request continued — and a data-plane
	 * filter had to keep it across requests because Envoy gives every worker thread its
	 * own Wasm VM. All of it moved to the runtime, which already knew the session and
	 * already numbered the placeholders: the verdict now carries `x.ogr.session_id` and
	 * `x.ogr.redaction_map`, history events carry deterministic ids, and the tool-set
	 * digest is the runtime's. See docs/proposals/stateless-pep.md.
	 *
	 * ⚠️ Requires a runtime new enough to return those fields. Against an older one the
	 * plugin still masks and restores WITHIN a request, but a value first detected on an
	 * earlier turn is no longer re-masked — so deploy the runtime FIRST.
	 */

	// The beat is registered here because parseConfig is where a configured client
	// first exists; RegisterTickFunc is idempotent per plugin load.
	startHeartbeat(c)

	// ⚠️ The ONE line that survives `log_level: quiet`, and it is once per plugin LOAD,
	// not per request. An operator has to be able to confirm what actually loaded —
	// silence at startup is indistinguishable from a plugin that never loaded at all,
	// which is the failure this whole integration exists to make visible.
	proxywasm.LogWarnf("[OGR-CONFIG] mode=%s cluster=%s host=%s base_path=%q timeout=%dms fail=%s beat=%ds log=%s protocols=%s",
		c.mode, c.cluster, c.host, c.basePath, c.timeoutMs, failLabel(c.failClosed), heartbeatPeriodMs/1000,
		logLevelName(logLevel), strings.Join(protocolNames(), ","))
	return nil
}

func failLabel(closed bool) string {
	if closed {
		return "closed"
	}
	return "open"
}

// protocolNames is logged at load so a deployment can see, without reading the build,
// which client protocols this plugin understands.
func protocolNames() []string {
	var out []string
	for _, p := range protocol.All() {
		out = append(out, p.Name())
	}
	return out
}

// --- per-request context ----------------------------------------------------

const (
	ctxAgentID        = "ogr_agent_id"
	ctxAgentType      = "ogr_agent_type"
	ctxAgentWorkspace = "ogr_agent_workspace"
	ctxAgentOwner     = "ogr_agent_owner"
	ctxAgentUser      = "ogr_agent_user"
	ctxViaConsumer    = "ogr_via_consumer"
	ctxReqID          = "ogr_req_id"
	ctxSession        = "ogr_session"
	ctxStreaming      = "ogr_streaming"
	ctxModel          = "ogr_model"
	ctxPath           = "ogr_path"
	ctxBody           = "ogr_body"
	ctxStream         = "ogr_stream_proc"
	ctxAnswered       = "ogr_answered"
	ctxSkip           = "ogr_skip"
	ctxNotModel       = "ogr_not_model"
)

type reqState struct {
	session *sessionState
	derive  *deriveCtx

	// The CLIENT's protocol adapter. Everything that has to know a wire shape goes
	// through it: reading the reply, masking the forwarded body, restoring the
	// placeholders, and rendering a refusal.
	//
	// ⚠️ The CLIENT's, never the upstream provider's. This filter runs at priority 200
	// and ai-proxy at 100, so on the request we see the body BEFORE ai-proxy translates
	// it, and on the response we see it AFTER ai-proxy has translated back — both
	// times, the shape the caller chose. Provider independence is what our position
	// buys; client-protocol independence is what it costs, and the protocol package is
	// that cost paid.
	proto protocol.Protocol
	conv  *protocol.Conversation

	model     string
	streaming bool

	// The turn in flight: the event the verdict is about (so its span offsets can be
	// resolved back to the bytes they name), and the phase it came from, whose session
	// marks may only be committed if the turn goes through.
	judged  *GuardEvent
	pending *derived

	// Which lane the RUNTIME put this answer on (`x.ogr.output_mode`), and whether
	// this filter has taken ownership of the response stream to serve it. See lanes.go.
	bufferOutput bool
	laneOwned    bool
	// The withheld answer, on the buffered lane only. Kept as the model's own bytes so
	// a released answer is byte-identical — re-rendering from the parsed content would
	// drop tool_calls, ids and usage.
	held []byte
}

// --- request path -----------------------------------------------------------

func onRequestHeaders(ctx wrapper.HttpContext, cfg Config) types.Action {
	path, _ := proxywasm.GetHttpRequestHeader(":path")
	if !protocol.IsCompletionPath(path) {
		// Not completion traffic: this plugin has nothing to say about it, and reading
		// the body of an unrelated API would only cost latency.
		//
		// ⚠️ This test used to be `strings.Contains(path, "/chat/completions")`, and that
		// one line was the entire reason a `/v1/messages` or `/v1/responses` client got
		// ZERO guardrail coverage: the body was never opened, so nothing downstream could
		// notice. Every observable signal said healthy — HTTP 200 to the caller, no
		// warning, no error, no counter, no event. Measured 2026-08-08.
		ctx.SetContext(ctxSkip, true)
		ctx.DontReadRequestBody()
		ctx.DontReadResponseBody()
		return types.ActionContinue
	}
	// The path is the same signal ai-proxy keys on. Kept for the body phase, where the
	// shape check can refine it.
	ctx.SetContext(ctxPath, path)

	// The agent identity, header first, static config as fallback. The consumer
	// header is the one identity this gateway itself authenticated; whether
	// agent_id came from it decides the attestation stamp downstream.
	agentID, _ := proxywasm.GetHttpRequestHeader(cfg.agentIDHeader)
	ctx.SetContext(ctxViaConsumer, agentID != "")
	if agentID == "" {
		agentID = cfg.agentID
	}
	ctx.SetContext(ctxAgentID, agentID)
	agentType, _ := proxywasm.GetHttpRequestHeader(cfg.agentTypeHeader)
	if agentType == "" {
		agentType = cfg.agentType
	}
	ctx.SetContext(ctxAgentType, agentType)
	workspace, _ := proxywasm.GetHttpRequestHeader(cfg.agentWorkspaceHeader)
	if workspace == "" {
		workspace = cfg.agentWorkspace
	}
	ctx.SetContext(ctxAgentWorkspace, workspace)
	owner, _ := proxywasm.GetHttpRequestHeader(cfg.agentOwnerHeader)
	if owner == "" {
		owner = cfg.agentOwner
	}
	ctx.SetContext(ctxAgentOwner, owner)
	user, _ := proxywasm.GetHttpRequestHeader(cfg.agentUserHeader)
	ctx.SetContext(ctxAgentUser, user)

	reqID, _ := proxywasm.GetHttpRequestHeader("x-request-id")
	if reqID == "" {
		reqID = strconv.FormatInt(time.Now().UnixNano(), 36)
	}
	ctx.SetContext(ctxReqID, reqID)

	// The body may be rewritten (masking) and the response must not arrive compressed,
	// or neither restoration nor detection can read it.
	_ = proxywasm.RemoveHttpRequestHeader("content-length")
	_ = proxywasm.RemoveHttpRequestHeader("accept-encoding")
	return types.HeaderStopIteration
}

// subjectFromCtx assembles the request's agent identity from what the header
// phase stored. nil when the request carried nothing — the key-only floor.
func subjectFromCtx(ctx wrapper.HttpContext, cfg Config) identity {
	return subjectOf(
		ctx.GetStringContext(ctxAgentID, ""),
		ctx.GetStringContext(ctxAgentType, ""),
		ctx.GetStringContext(ctxAgentWorkspace, ""),
		ctx.GetStringContext(ctxAgentOwner, ""),
		ctx.GetStringContext(ctxAgentUser, ""),
		ctx.GetBoolContext(ctxViaConsumer, false),
	)
}

func onRequestBody(ctx wrapper.HttpContext, cfg Config, body []byte) types.Action {
	if ctx.GetBoolContext(ctxSkip, false) || len(body) == 0 {
		return types.ActionContinue
	}
	parsed := gjson.ParseBytes(body)
	subj := subjectFromCtx(ctx, cfg)
	reqID := ctx.GetStringContext(ctxReqID, "")
	now := time.Now().UTC().Format("2006-01-02T15:04:05Z")

	// WHICH PROTOCOL. The path first (the same signal ai-proxy keys on), the body shape
	// as a fallback.
	proto := protocol.Detect(ctx.GetStringContext(ctxPath, ""), parsed)

	var conv *protocol.Conversation
	readable := false
	if proto != nil {
		conv, readable = proto.ParseRequest(parsed)
	}
	if !readable {
		// ⚠️ We recognised a completion request and could not read a conversation out of
		// it. SAY SO. The alternative is what shipped until now: `batchPayload` returns
		// nil for an empty slice, the post is skipped, and the traffic leaves no trace
		// anywhere — indistinguishable from a healthy gateway with nothing to report.
		name := ""
		if proto != nil {
			name = proto.Name()
		}
		bump(cntUnreadable, 1)
		logInfof("[OGR-REQ] unreadable body: protocol=%q bytes=%d — reporting an unparsed signal, this request is NOT judged",
			name, len(body))
		d := &deriveCtx{
			subj:    subj,
			guardID: "gw-" + reqID, reqID: reqID, now: now, protocol: name,
		}
		ingest(ctx, cfg, []*GuardEvent{unparsedEvent(d, "user_input", "protocol not readable by this plugin", len(body))})
		return types.ActionContinue
	}

	rs := &reqState{
		derive: &deriveCtx{
			subj:     subj,
			guardID:  "gw-" + reqID,
			reqID:    reqID,
			now:      now,
			protocol: proto.Name(),
		},
		proto:     proto,
		conv:      conv,
		model:     conv.Model,
		streaming: conv.Stream,
	}
	ctx.SetContext(ctxSession, rs)
	ctx.SetContext(ctxStreaming, rs.streaming)
	ctx.SetContext(ctxModel, rs.model)
	ctx.SetContext(ctxBody, string(body))

	// WHICH CONVERSATION — resolved before anything else, because the session is what
	// the state below is keyed by.
	//
	// ⚠️ This is a Redis round trip, where it used to be a hash of the first turn. The
	// anchor was stateless and wrong in a way no amount of care could fix: a scheduled
	// job repeats its opening message verbatim, so every execution hashed to one id —
	// 5337 events over 98 hours in one "session" on the real traffic. See
	// conversation.go. The trip is one GET-equivalent against a Redis this request was
	// already going to talk to, in front of a model call measured in seconds.
	/*
	 * ⚠️ NO SESSION LOOKUP, and `session_id` is deliberately left EMPTY on the event.
	 *
	 * This used to be a Redis round trip that chained the conversation by prefix digest,
	 * and then a second one to load the session. Both are gone: the runtime derives the
	 * session from `authz.transcript`, which this plugin was already sending, and it is
	 * the only party that should — two implementations of one algorithm is how they
	 * drift. It answers with `x.ogr.session_id`, which is read back for the log line.
	 *
	 * What this removes from the request path is not only the state: it is two
	 * synchronous callbacks, so what follows is now straight-line code.
	 */
	rs.session = newSessionState("")
	dv := deriveRequest(rs.derive, rs.session, conv)
	if cfg.mode == modeObserve {
		// Nothing is refusable in observe: the request is already gone.
		ingest(ctx, cfg, dv.All())
		return types.ActionContinue
	}
	enforceRequest(ctx, cfg, rs, dv, string(body))
	return types.ActionPause
}

// enforceRequest re-masks the history from what we already know and puts everything
// the model has not seen yet to the PDP.
func enforceRequest(ctx wrapper.HttpContext, cfg Config, rs *reqState, dv *derived, body string) {
	/*
	 * ⚠️ THE HISTORY RE-MASK MOVED PAST THE VERDICT (2026-08-10), and it had to.
	 *
	 * It used to happen HERE, before `/evaluate`, out of the session map this plugin
	 * kept. There is no such map before the call any more — the runtime holds it and
	 * returns the part that applies to this request — so all masking now happens once,
	 * in `onInputVerdict`, over both halves at once: the values this turn detected and
	 * the values earlier turns bound that are still in the resent conversation.
	 *
	 * Nothing is masked LATER than it was: the body still reaches the model only after
	 * the verdict, because enforce mode pauses the request either way.
	 */
	outBody := body

	ingest(ctx, cfg, dv.Report)
	// The primary sees the turn through /evaluate; the mirror only ever ingests, so it
	// still needs its own copy or a shadow deployment is comparing against a hole.
	mirrorEvents(cfg, judgedOnly(dv))

	rs.judged = dv.Judged
	rs.pending = dv
	if dv.Judged == nil {
		dv.Commit(rs.session)
		finishRequest(ctx, cfg, rs, outBody)
		return
	}
	payload, err := json.Marshal(dv.Judged)
	if err != nil {
		dv.Commit(rs.session)
		finishRequest(ctx, cfg, rs, outBody)
		return
	}
	err = cfg.client.Post(cfg.evaluatePath, ogrHeaders(cfg), payload,
		func(status int, _ http.Header, respBody []byte) {
			onInputVerdict(ctx, cfg, rs, outBody, status, respBody)
		}, cfg.timeoutMs)
	if err != nil {
		logConditionf("req.dispatch", "[OGR-REQ] evaluate dispatch failed: %v", err)
		applyFail(ctx, cfg, rs, "evaluate dispatch failed")
	}
}

// finishRequest lets the request go, with whatever masking this turn decided.
func finishRequest(ctx wrapper.HttpContext, cfg Config, rs *reqState, outBody string) {
	if outBody != ctx.GetStringContext(ctxBody, "") {
		if err := proxywasm.ReplaceHttpRequestBody([]byte(outBody)); err != nil {
			// ⚠️ If the buffer is no longer writable here the prompt reaches the model
			// UNMASKED while every log says "masked". Fail loudly.
			proxywasm.LogErrorf("[OGR-REQ] request body replace FAILED: %v", err)
		}
		ctx.SetContext(ctxBody, outBody)
	}
	proxywasm.ResumeHttpRequest()
}

func onInputVerdict(ctx wrapper.HttpContext, cfg Config, rs *reqState,
	outBody string, status int, respBody []byte) {
	if status != 200 {
		logConditionf("req.status", "[OGR-REQ] evaluate status=%d body=%s", status, truncate(string(respBody), 256))
		why := "evaluate returned " + strconv.Itoa(status)
		if status == 0 {
			why += " (timeout or unreachable)" + unorderedBudgetHint
		}
		applyFail(ctx, cfg, rs, why)
		return
	}
	v := parseVerdict(respBody)
	/*
	 * ⚠️ **A 200 IS NOT A VERDICT.** Until 2026-08-11 anything that parsed to an empty
	 * decision — an empty body, an HTML error page from a proxy in front of the runtime,
	 * a JSON document of some other shape — fell through every branch below and reached
	 * `rs.commit()`, i.e. the model, as an ALLOW. `fail_mode` never saw it, because
	 * fail_mode is only consulted on a non-200 or a transport failure.
	 *
	 * That is the worst shape a guardrail failure can take: the caller pays the latency,
	 * the counter records an evaluation that happened, and the traffic goes through
	 * unjudged. Found by pointing the plugin at a cluster with nothing behind it and
	 * watching the request succeed with `decision=` empty.
	 *
	 * A verdict must SAY something. No decision ⇒ treat it exactly like an unreachable
	 * runtime: honour `fail_mode`, and count it as unchecked rather than as evaluated.
	 */
	if v.Decision() == "" {
		logConditionf("req.nodecision",
			"[OGR-REQ] evaluate returned 200 with no decision (%d bytes) — treating as a FAILURE, not an allow: %s",
			len(respBody), truncate(string(respBody), 200))
		applyFail(ctx, cfg, rs, "evaluate returned 200 with no decision")
		return
	}
	bump(cntEvaluated, 1)
	// The runtime's answer for which conversation this was. Diagnostics only.
	rs.session.ID = v.SessionID()
	logInfof("[OGR-REQ] decision=%s kind=%s session=%s",
		v.Decision(), rs.judged.Kind, rs.session.ID)

	if v.Stops() {
		bump(cntRefused, 1)
		answer(ctx, rs, v.Reason())
		return
	}
	if partiallyJudged("REQ", v, cfg.failClosed) {
		answer(ctx, rs, partialMessage)
		return
	}
	rs.commit()

	// Decide the response lane before the request goes anywhere: arming the pause has
	// to happen before the response phase begins.
	armLanes(ctx, cfg, rs, v)

	// ⚠️ Each finding is resolved against the text ITS OWN `path` names. The judged
	// event carries the whole turn, so it has several — the user's words and each tool
	// outcome — and slicing one finding's offsets out of the wrong one yields a fragment
	// that matches nothing, leaving the value the verdict asked us to remove on its way
	// to the model while the log says "masked".
	/*
	 * ⚠️ THE GATE IS THE MAP, NOT THE DECISION, and that distinction is the whole point
	 * of the sticky half.
	 *
	 * `v.Redacts()` asks whether THIS turn detected something. But the case that needs
	 * masking most is the one where it did not: turn 4 says `allow` and detects nothing,
	 * while the conversation the client just re-sent still contains the number turn 1
	 * bound. Gating on the decision would send that history to the model in the clear —
	 * a leak with a green verdict in front of it. So: mask whenever there is anything to
	 * mask with.
	 */
	if m := v.RedactionMap(); len(m) > 0 {
		rs.session.adopt(m)
	} else if v.Redacts() {
		// No map — an older runtime. Recover THIS turn's values from the span offsets;
		// history stays unmasked, which is why the runtime ships first.
		_, unresolved := learnFromVerdict(rs.session, v.Result(), rs.judged)
		logUnresolvedSpans(unresolved)
	}
	if len(rs.session.Mapping) > 0 {
		if masked, n := rs.proto.Mask(outBody, rs.session.redactions()); n > 0 {
			outBody = masked
			logInfof("[OGR-REQ] masked %d strings, %d tokens live", n, len(rs.session.Mapping))
		}
	}

	finishRequest(ctx, cfg, rs, outBody)
}

// --- response path ----------------------------------------------------------

func onResponseHeaders(ctx wrapper.HttpContext, cfg Config) types.Action {
	if ctx.GetBoolContext(ctxSkip, false) || ctx.GetBoolContext(ctxAnswered, false) {
		return types.ActionContinue
	}
	/*
	 * ⚠️ **ONLY A MODEL REPLY IS OURS TO HOLD**, and getting this wrong turns every
	 * upstream failure into a HANG.
	 *
	 * Enforce mode takes ownership of the response — `BufferResponseBody` +
	 * `HeaderStopIteration` here, and `NeedPauseStreamingResponse` from `armLanes`
	 * during the REQUEST phase, before any status exists to check. That is correct for
	 * a completion the model produced. It is wrong for everything else Envoy can put on
	 * this path: a LOCAL REPLY generated because no route matched the model name, a 503
	 * because the provider refused the connection, a 401 from key-auth, a 429 from the
	 * limiter. None of those is a completion, none parses as one, and none has anything
	 * to judge — but the filter held them all.
	 *
	 * What the caller saw was not an error. It was SILENCE: zero bytes until its own
	 * timeout. Measured on the lab gateway 2026-08-10 with a model name no route
	 * matched — `mode: observe` answered 404 in 3.6ms, `mode: enforce` sent 0 bytes and
	 * the client gave up after 40s (`response_flags: NR,DC`, `upstream_host: -`). An
	 * agent driving this gateway just stops, with no error to retry on and nothing in
	 * the log, and the natural conclusion — "the guardrail blocked it" — is wrong,
	 * which is the expensive part.
	 *
	 * This is the invariant `judgeFinal` already states for the lanes ("a branch that
	 * returns without injecting leaves the caller hanging until its own timeout"),
	 * applied one level up: DO NOT TAKE OWNERSHIP OF A RESPONSE WE CANNOT ANSWER FOR.
	 * Strictly 200 — an error body is not a model output, and a status we cannot read
	 * is not one either.
	 */
	if status, err := proxywasm.GetHttpResponseHeader(":status"); err != nil || status != "200" {
		ctx.SetContext(ctxNotModel, true)
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
	// latency an observer must not add; the streaming hook keeps a bounded copy while
	// the bytes go straight to the caller. Only enforce buffers, because only enforce
	// can still change the reply — refuse it, or restore what we masked on the way in.
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
	// Not a completion — an error Envoy or the provider generated. Nothing to judge,
	// and nothing we may hold. See onResponseHeaders.
	if ctx.GetBoolContext(ctxNotModel, false) {
		return types.ActionContinue
	}
	// ⚠️ Read the reply in the CLIENT's protocol. For every provider that is not
	// Anthropic-native, ai-proxy has already translated the reply back to the client's
	// shape below us, so this is the shape that arrives either way.
	out := rs.proto.ParseResponse(gjson.ParseBytes(body))
	if out.Empty() {
		return types.ActionContinue
	}

	dv := deriveResponse(rs.derive, rs.session, out, rs.conv)
	if cfg.mode == modeObserve {
		ingest(ctx, cfg, dv.All())
		dv.Commit(rs.session)
		return restoreResponse(rs, body)
	}

	// Enforce: judge everything the model produced, then restore our placeholders.
	// ⚠️ Detect BEFORE restoring. The text still carries the placeholders; if we
	// restored first, the privacy guardrail would find the very values we removed and
	// block our own restoration.
	ingest(ctx, cfg, dv.Report)
	mirrorEvents(cfg, judgedOnly(dv))
	rs.judged, rs.pending = dv.Judged, dv
	if dv.Judged == nil {
		rs.commit()
		return restoreResponse(rs, body)
	}
	payload, err := json.Marshal(dv.Judged)
	if err != nil {
		rs.commit()
		return restoreResponse(rs, body)
	}
	err = cfg.client.Post(cfg.evaluatePath, ogrHeaders(cfg), payload,
		func(status int, _ http.Header, respBody []byte) {
			if status == 200 && parseVerdict(respBody).Usable() {
				bump(cntEvaluated, 1)
				v := parseVerdict(respBody)
				if v.Stops() {
					// Refused: the reply never reaches the caller, so nothing about it is
					// recorded as reported.
					_ = proxywasm.ReplaceHttpResponseBody([]byte(rs.proto.Refuse(rs.model, v.Reason())))
					proxywasm.ResumeHttpResponse()
					return
				}
				if partiallyJudged("RESP", v, cfg.failClosed) {
					_ = proxywasm.ReplaceHttpResponseBody([]byte(rs.proto.Refuse(rs.model, partialMessage)))
					proxywasm.ResumeHttpResponse()
					return
				}
				rs.commit()
			} else {
				if status == 200 {
					// A 200 that is not a verdict — see verdict.Usable.
					logConditionf("resp.nodecision", "[OGR-RESP] evaluate returned 200 with no decision (%d bytes)",
						len(respBody))
					status = 0
				}
				evaluateFailed("RESP", status, cfg.failClosed)
				if cfg.failClosed {
					_ = proxywasm.ReplaceHttpResponseBody([]byte(rs.proto.Refuse(rs.model, failMessage)))
					proxywasm.ResumeHttpResponse()
					return
				}
			}
			if next, changed := rs.proto.Restore(string(body), rs.session.Mapping); changed {
				_ = proxywasm.ReplaceHttpResponseBody([]byte(next))
			}
			proxywasm.ResumeHttpResponse()
		}, cfg.timeoutMs)
	if err != nil {
		return restoreResponse(rs, body)
	}
	return types.ActionPause
}

// commit records the in-flight phase, once it is known the turn was not refused.
func (rs *reqState) commit() {
	if rs.pending != nil {
		rs.pending.Commit(rs.session)
		rs.pending = nil
	}
}

func restoreResponse(rs *reqState, body []byte) types.Action {
	if next, changed := rs.proto.Restore(string(body), rs.session.Mapping); changed {
		_ = proxywasm.ReplaceHttpResponseBody([]byte(next))
	}
	return types.ActionContinue
}

func onStreamingResponseBody(ctx wrapper.HttpContext, cfg Config, chunk []byte, isLast bool) []byte {
	rs, ok := ctx.GetContext(ctxSession).(*reqState)
	if !ok || rs == nil {
		return chunk
	}
	// ⚠️ A refusal is OURS, not the model's. `answer` ends the request with a locally
	// generated body, and that body still reaches this hook — so without this the
	// plugin derives a `model_output` from its own refusal text and ingests it. Two
	// costs, both bad for a thing whose output is evidence: the audit trail gains a
	// record of something no model ever said, and the runtime evaluates on ingest, so
	// the refusal is judged by the guardrails that produced it.
	if ctx.GetBoolContext(ctxAnswered, false) {
		return chunk
	}
	/*
	 * An error, not a completion (see onResponseHeaders). Let it through untouched —
	 * but "untouched" is not the same as "return it" once the lanes are armed.
	 *
	 * ⚠️ `armLanes` calls `NeedPauseStreamingResponse` in the REQUEST phase, which is
	 * the only place early enough to arm it and the one place where no status exists
	 * yet. Once armed, every chunk stops at this filter and the returned slice is NOT
	 * written — injection is the only way bytes reach the caller. Returning `chunk`
	 * here would look like a passthrough and deliver nothing, which is the exact hang
	 * this whole branch exists to remove.
	 */
	if ctx.GetBoolContext(ctxNotModel, false) {
		if rs.laneOwned {
			if err := proxywasm.InjectEncodedDataToFilterChain(chunk, isLast); err != nil {
				proxywasm.LogErrorf("[OGR-RESP] passing an upstream error through failed: %v", err)
			}
			return nil
		}
		return chunk
	}
	sp, _ := ctx.GetContext(ctxStream).(*streamProcessor)
	if sp == nil {
		sp = newStreamProcessor(rs.proto, rs.session.Mapping, ctx.GetBoolContext(ctxStreaming, true))
		ctx.SetContext(ctxStream, sp)
	}
	out := sp.ProcessChunk(chunk, isLast)

	// ⚠️ NO MID-STREAM JUDGEMENT. It was here — every `stream_judge_chars`, cutting the
	// rest of the answer on a hit — and the pipeline then measured exactly that
	// (`docs/STREAMING_GUARDRAIL.md`, truncated-agent eval on the trained 35B-A3B):
	//
	//   Agent reply visible   25%     50%     75%    100%
	//   mt_harm_correct FP    0.353   0.294   0.000  0.000
	//
	// Recall barely moves (0.88 @25% vs 0.90 @100%) — violations show up early — but
	// false positives go up 2.3x and ALL of it lands on one shape: the reply that agrees
	// on the surface and corrects underneath. "自杀是对的吗" answered with
	// "是的，很多人有这种念头——但这个想法是错的" reads as agreement until the clause that
	// turns it, and the turn happens at a clause boundary, not a token boundary. Early
	// judgement is a fit PREFILTER and an unfit BLOCKING CRITERION.
	//
	// The replacement is two lanes decided by the INPUT verdict — buffer when the
	// question already looks like it is soliciting something, pass through otherwise —
	// with the real judgement at end of stream in both. If mid-stream detection comes
	// back it may only switch lanes (passthrough -> buffer); it may never cut.

	// Enforcing on a stream: the lanes own the flow from here (lanes.go). Everything the
	// caller receives goes out by injection, including this chunk, and the whole answer
	// is judged once at end of stream.
	if rs.laneOwned {
		return laneChunk(ctx, cfg, rs, out, isLast)
	}

	if isLast {
		// Observe mode: the answer becomes a RECORD and nothing more. There is no
		// verdict to wait for and nothing to stop.
		result := sp.Result()
		switch {
		case !result.Empty():
			dv := deriveResponse(rs.derive, rs.session, result, rs.conv)
			ingest(ctx, cfg, dv.All())
			dv.Commit(rs.session)
		case sp.SawBytes():
			// ⚠️ An empty result here means one of two very different things: the model
			// said nothing, or we could not read a single frame of what it sent. Only the
			// second is a hole, and it must not look like the first.
			reportUnreadableStream(ctx, cfg, rs, sp)
		}
	}
	return out
}

// reportUnreadableStream says, out loud and on the wire, that the model's OUTPUT side
// of this request was never judged because nothing could be reassembled out of the
// bytes that arrived. The request side still was.
//
// ⚠️ The silence this replaces is the expensive kind: the caller gets its answer, the
// gateway logs a clean 200, and the only trace of an unjudged reply is an event that
// was never sent.
func reportUnreadableStream(ctx wrapper.HttpContext, cfg Config, rs *reqState, sp *streamProcessor) {
	bump(cntUnreadable, 1)
	logInfof("[OGR-RESP] %d stream bytes reassembled to nothing on %s — the model's output side of this request is NOT judged",
		sp.Bytes(), rs.proto.Name())
	ingest(ctx, cfg, []*GuardEvent{
		unparsedEvent(rs.derive, "model_output", "stream not reassembled by this build", sp.Bytes()),
	})
}

// --- talking to the runtime -------------------------------------------------

const failMessage = "The AI guardrail service is unavailable and this deployment is configured to fail closed."

// partialMessage is distinct from failMessage on purpose: the guardrail service ANSWERED,
// it just did not answer about all of this turn. Telling an operator "unavailable" would
// send them looking at connectivity for a service that is up.
const partialMessage = "Part of this turn could not be evaluated and this deployment is configured to fail closed."

// unorderedBudgetHint is appended to a `status=0`, because that status is exactly as
// informative as the budget chain is ordered.
//
// ⚠️ As of 2026-08-08 the chain is NOT ordered in the shipped defaults: this plugin's
// `timeout_ms` and the runtime's `OGR_MODEL_TIMEOUT_MS` are both 5000, so which one
// trips first is a race. When this filter wins it, the runtime is still working on an
// answer nobody will read, and neither side can name the slow capability — we log a
// bare 0, and the runtime logs a client that hung up. Lowering the runtime's inline
// budget below this one is the fix; it is pending a measurement of that side's
// non-model overhead.
const unorderedBudgetHint = "; if the runtime's own model budget is not strictly BELOW this plugin's timeout_ms, a 0 may be this filter aborting a runtime that was still answering — the slow capability is then unattributable on either side"

// partiallyJudged reports a verdict that covered only part of the turn, and answers
// whether the caller must refuse it.
//
// ⚠️ This is the fail-closed promise, kept one level deeper than transport. An operator
// who sets `closed` is told: if we could not judge it, it does not go through. Without
// this check that holds only for calls THIS filter makes — the runtime losing one
// action's judge call inside a 200 would pass an unjudged action while the deployment
// believed that impossible, which is worse than fail-open, because the latency was paid
// for a guarantee that was not delivered.
//
// ⚠️ Inert until the runtime populates `x.ogr.unjudged`: absent means everything was
// judged, which is exactly today's behaviour. Reader first, writer second — that is the
// only safe order for a two-sided contract that gates a security property.
func partiallyJudged(phase string, v verdict, failClosed bool) bool {
	if !v.Partial() {
		return false
	}
	unjudged := v.Unjudged()
	if v.MustRefusePartial(failClosed) {
		bump(cntRefused, 1)
		logInfof("[OGR-%s] the runtime judged only part of this turn (%d unjudged: %s) — REFUSING, fail_mode=closed",
			phase, len(unjudged), strings.Join(unjudged, " "))
		return true
	}
	bump(cntUnchecked, 1)
	logInfof("[OGR-%s] the runtime judged only part of this turn (%d unjudged: %s) — passed anyway, fail_mode=open",
		phase, len(unjudged), strings.Join(unjudged, " "))
	return false
}

// evaluateFailed reports an /evaluate call that did not answer, and says what it cost.
//
// ⚠️ The reply-side calls used to take this branch in SILENCE: fail-open let the model's
// answer through unjudged with no log, no counter and a clean 200. That is the same hole
// the request side already had closed, in the direction nobody was looking.
func evaluateFailed(phase string, status int, failClosed bool) {
	why := "evaluate returned " + strconv.Itoa(status)
	if status == 0 {
		why += " (timeout or unreachable)" + unorderedBudgetHint
	}
	if failClosed {
		bump(cntRefused, 1)
		logInfof("[OGR-%s] %s — failing CLOSED", phase, why)
		return
	}
	bump(cntUnchecked, 1)
	logInfof("[OGR-%s] the model's reply reached the caller UNJUDGED (fail-open): %s", phase, why)
}

func ogrHeaders(cfg Config) [][2]string {
	return [][2]string{
		{"Content-Type", "application/json"},
		{"Authorization", "Bearer " + cfg.apiKey},
	}
}

// judgedOnly is the mirror's copy of the turn.
func judgedOnly(dv *derived) []*GuardEvent {
	if dv.Judged == nil {
		return nil
	}
	return []*GuardEvent{dv.Judged}
}

// logToolCap and logActionCap say out loud that a turn was truncated.
//
// ⚠️ A cap that silently drops part of a turn is a cap that silently drops enforcement:
// what is not in the event is not judged, and nothing downstream can tell a short turn
// from a trimmed one.
func logToolCap(declared, limit int) {
	bump(cntTruncated, uint64(declared-limit))
	logInfof("[OGR-REQ] ⚠️ %d tools declared, carrying the first %d — the rest are NOT judged",
		declared, limit)
}

// logUnresolvedSpans reports redaction spans that named a text this event cannot
// slice.
//
// ⚠️ The failure it catches is a path-syntax disagreement between this plugin and the
// runtime, and it is otherwise invisible: every span is dropped, no value is masked, no
// error is raised, and the deployment looks exactly like one with no redaction policy.
func logUnresolvedSpans(n int) {
	if n == 0 {
		return
	}
	bump(cntUnresolvedSpans, uint64(n))
	logInfof("[OGR-REQ] ⚠️ %d redaction spans named a text this event cannot slice — nothing was masked for them; check that the runtime's finding `path` matches a payload path this build registers",
		n)
}

func logActionCap(asked, limit int) {
	bump(cntTruncated, uint64(asked-limit))
	logInfof("[OGR-RESP] ⚠️ the model asked for %d actions, carrying the first %d — the rest are NOT judged",
		asked, limit)
}

// ingest posts events to the async endpoint and does not wait. The runtime evaluates
// them there too, so observe mode still produces findings — it just never makes anyone
// wait for them.
//
// The mirror gets the same batch, always: in enforce mode the primary decides through
// /evaluate and the mirror still needs the whole picture, or a shadow deployment is
// comparing against a hole.
func ingest(ctx wrapper.HttpContext, cfg Config, events []*GuardEvent) {
	payload := batchPayload(events)
	if payload == nil {
		return
	}
	post(cfg.client, cfg.apiKey, cfg.ingestPath, payload, cfg.timeoutMs, "OGR-INGEST")
	bump(cntIngested, uint64(len(events)))
	mirrorAsync(cfg, payload)
}

// mirrorAsync sends a copy to the candidate runtime and forgets about it.
//
// ⚠️ Dispatched, never awaited, in EVERY mode. A mirror exists to answer "what would
// the new policy have said" — it is not in the decision, so a slow or dead candidate
// must cost the caller nothing. That is also why it rides /ingest rather than
// /evaluate: the mirror runtime evaluates on ingest anyway, so its console fills with
// the same findings without anyone waiting for a verdict.
func mirrorAsync(cfg Config, payload []byte) {
	if !cfg.hasMirror || payload == nil {
		return
	}
	post(cfg.mirror, cfg.mirrorKey, cfg.mirrorIngestPath, payload, cfg.timeoutMs, "OGR-MIRROR")
	bump(cntMirrored, 1)
}

// mirrorEvents is the mirror-only path, for events the primary saw through /evaluate
// and must not receive twice.
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
		bump(cntTruncated, uint64(len(events)-maxBatch))
		logInfof("[OGR-INGEST] %d events over the batch cap, sending the newest %d", len(events), maxBatch)
		events = events[len(events)-maxBatch:]
	}
	payload, err := json.Marshal(map[string]any{"batch": events})
	if err != nil {
		return nil
	}
	return payload
}

func post(client wrapper.HttpClient, apiKey, path string, payload []byte, timeoutMs uint32, tag string) {
	headers := [][2]string{
		{"Content-Type", "application/json"},
		{"Authorization", "Bearer " + apiKey},
	}
	if err := client.Post(path, headers, payload,
		func(status int, _ http.Header, body []byte) {
			if status != 200 && status != 207 {
				logConditionf(tag+".status", "[%s] status=%d body=%s", tag, status, truncate(string(body), 256))
			}
		}, timeoutMs); err != nil {
		logConditionf(tag+".dispatch", "[%s] dispatch failed: %v", tag, err)
	}
}

// --- failure handling -------------------------------------------------------

func applyFail(ctx wrapper.HttpContext, cfg Config, rs *reqState, why string) {
	if cfg.failClosed {
		bump(cntRefused, 1)
		answer(ctx, rs, failMessage)
		return
	}
	// ⚠️ NOT committed either, so an exact retry of this turn is judged again rather
	// than skipped as already-reported. The cost is bounded: once the model has
	// answered, the turn is no longer new input (protocol.Conversation.NewInput), so
	// the following turn does not re-report it — only a true replay does, and a replay
	// of traffic nothing judged is precisely what we want a second chance at.
	//
	// ⚠️ Say what actually happened. "fail-open" reads like a setting working as
	// intended; what it means for this request is that nothing judged it. A deployment
	// that never greps for this line cannot tell a healthy gateway from one whose PDP
	// has been unreachable for a week.
	bump(cntUnchecked, 1)
	logInfof("[OGR-REQ] request passed UNCHECKED (fail-open): %s, session=%s",
		why, rs.session.ID)
	proxywasm.ResumeHttpRequest()
}

// answer ends the request with a refusal the caller's client can render, in the shape
// the caller asked for — rendered by the caller's own protocol adapter.
func answer(ctx wrapper.HttpContext, rs *reqState, reason string) {
	ctx.SetContext(ctxAnswered, true)
	if rs.streaming {
		_ = proxywasm.SendHttpResponse(200,
			[][2]string{{"content-type", "text/event-stream"}, {"cache-control", "no-cache"}},
			[]byte(rs.proto.RefuseStream(rs.model, reason)), -1)
		return
	}
	_ = proxywasm.SendHttpResponse(200,
		[][2]string{{"content-type", "application/json"}},
		[]byte(rs.proto.Refuse(rs.model, reason)), -1)
}
