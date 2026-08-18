// OpenGuardrails Runtime — a Higress WASM plugin that speaks OGR v0.8 to an
// OpenGuardrails runtime directly.
//
// It implements **the recipe of the v0.8 Runtime API** (specification/runtime-api.md
// — one recipe now, the same for a gateway and for a developer's own loop). One
// proxied model call is one STEP: mint a `step_id`, `step/request` on the request
// flow, `step/response` on the response flow, both to `/v1/evaluate`, both carrying
// the provider body raw — and the runtime classifies, derives session/turn/step,
// and answers with a Verdict this filter enforces. The gateway declares no
// coordinates and keeps no state across requests. `/v1/ingest` and the
// `ogr-partial` header are gone (v0.8): evaluate IS the observation channel, and a
// streamed answer is judged exactly once, whole, behind a held tail (tailhold.go).
//
// One switch decides how much it does:
//
//	mode: observe   report only. Never pauses the request, never touches a body.
//	                Every event still goes to /evaluate — fire-and-forget, verdict
//	                discarded — because evaluate records what it judges, so the
//	                console fills with findings while the gateway stays a mirror.
//	mode: enforce   put each step half to /evaluate, wait for the verdict, and
//	                honour it: refuse, or apply the modification spans and let it
//	                through.
//
// Rolling back is switching the mode, not redeploying.
//
// ⚠️ The two modes compute EVENTS identically; only the dispatch differs. That is
// what makes observe a faithful preview of enforce.
//
// ⚠️ `/evaluate` takes exactly ONE event. There is no batch form: a step half is one
// event, and re-shattering it is the decomposition the spec removed the vocabulary
// for.
package main

import (
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
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
	// Two paths, not three — v0.8 removed /v1/ingest.
	pathEvaluate  = "/v1/evaluate"
	pathHeartbeat = "/v1/heartbeat"
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
	heartbeatPath string

	mode       string
	timeoutMs  uint32
	failClosed bool

	// How much client-visible content (UTF-8 bytes) the streaming lane withholds
	// until the end-of-stream verdict — see tailhold.go.
	streamTailChars int

	// The OGR agent identity: which header(s) carry each field, plus static
	// fallbacks for a route that fronts exactly one agent. agent_user has no
	// static fallback on purpose — a constant user IS the runtime's default.
	// id and workspace are CHAINS (first non-empty wins): the OGR spelling
	// first, the MSE compatibility spelling second.
	agentIDHeaders        []string
	agentTypeHeader       string
	agentWorkspaceHeaders []string
	agentUserHeader       string
	agentID               string
	agentType             string
	agentWorkspace        string

	// The identity FLOOR: when nothing above named the agent, fingerprint the
	// credential the CLIENT presented. See deriveCallerID.
	callerFallback   bool
	callerKeyHeaders []string

	// A second runtime that gets a COPY of every event and decides nothing.
	mirror             wrapper.HttpClient
	mirrorKey          string
	mirrorEvaluatePath string
	hasMirror          bool
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
	// runtime was still answering, and then nothing can say what was slow.
	//
	// ⚠️ Ordering is bought by lowering the INNER budgets, never by raising this one.
	// Raising it was tried (8s) and reverted: it orders the chain by spending the
	// user's patience, which is the one resource in this chain that is not ours.
	c.timeoutMs = 5000
	if v := j.Get("timeout_ms"); v.Exists() {
		c.timeoutMs = uint32(v.Uint())
	}

	// The fail mode. OPEN unless the deployment says `closed`, and that default is
	// the spec's (degraded-mode.md), not an accident: the minimal integration is an
	// observability instrument first, and an instrument that can halt the agent it
	// observes on a network blip would never be adopted. `closed` is the explicit
	// opt-in for deployments gating dangerous categories, and it covers all three
	// sizes of "could not look": an unreachable/timed-out/429'd runtime, a 200 whose
	// body is not a verdict, and a verdict whose `unjudged` names the enforced path.
	c.failClosed = j.Get("fail_mode").String() == "closed"

	// How much of a streamed answer stays withheld until the end-of-stream verdict
	// (tailhold.go). 200 is the spec's reference default; 0 still gates stream
	// completion on the verdict (the final chunk is never released early); a huge
	// value degenerates to buffering, which the spec names as the limit case.
	c.streamTailChars = 200
	if v := j.Get("stream_tail_chars"); v.Exists() {
		n := int(v.Int())
		if n < 0 {
			n = 0
		}
		c.streamTailChars = n
	}

	/**
	 * The OGR agent identity (agent_id / agent_type / agent_workspace /
	 * agent_user). OGR is agent-centric: the consumer the gateway authenticated IS
	 * the agent, and the consumer-group is the agent's WORKSPACE — a group of agents
	 * plus one policy set. `agent_user` is an attribute the platform records on the
	 * session; it decides nothing.
	 *
	 * ⚠️ There is no `agent_owner` (removed 2026-08-17). A gateway cannot assert
	 * who is ACCOUNTABLE for an agent — it only knows which credential called —
	 * and a runtime cannot rest a read permission on a header a route injects.
	 * Ownership is assigned in the console, against an account it already knows.
	 *
	 * Every field's source header is configurable, because not every deployment
	 * puts these facts in the same headers. Static `agent_id` / `agent_type` /
	 * `agent_workspace` config values back the headers up for a
	 * route that fronts exactly one agent. A deployment that configures nothing
	 * still works: the runtime derives the agent from the API key (one key, one
	 * default agent) and attributes every session to one user.
	 *
	 * The id and workspace defaults are CHAINS — the OGR spelling first, the
	 * MSE spelling second, first non-empty wins. `x-ogr-agent-id` /
	 * `x-ogr-agent-workspace` are OUR names for the gateway-asserted fields;
	 * the `x-mse-*` fallbacks are the spellings existing deployments already
	 * carry. The two arrive differently and that difference matters:
	 * `x-mse-consumer` is written by the AUTHENTICATOR (higress key-auth, on
	 * every authenticated request — and yes, it DOES reach this filter; see
	 * the identity comment in onRequestHeaders), while `x-mse-consumer-group`
	 * is an ADMIN-CONFIGURED header — no authenticator writes it; an operator
	 * decides it (MSE: the console's consumer→group assignment; self-hosted: a
	 * header-injection rule on the route, running early enough for this filter
	 * to see it). Configuring `agent_id_header` / `agent_workspace_header`
	 * replaces the whole chain with that one header.
	 */
	c.agentIDHeaders = []string{"x-ogr-agent-id", "x-mse-consumer"}
	if v := j.Get("agent_id_header").String(); v != "" {
		c.agentIDHeaders = []string{v}
	}
	c.agentWorkspaceHeaders = []string{"x-ogr-agent-workspace", "x-mse-consumer-group"}
	if v := j.Get("agent_workspace_header").String(); v != "" {
		c.agentWorkspaceHeaders = []string{v}
	}
	c.agentTypeHeader = "x-ogr-agent-type"
	if v := j.Get("agent_type_header").String(); v != "" {
		c.agentTypeHeader = v
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

	/**
	 * The identity FLOOR (`caller_fallback`, default ON).
	 *
	 * ⚠️ What it exists to prevent: with no consumer header and no static
	 * `agent_id`, the plugin used to send NO agent identity at all, and the
	 * runtime then fell back to the credential IT could see — the gateway's own
	 * OGR API key. One key per gateway, so **every consumer behind that gateway
	 * collapsed into a single agent row**: one inventory line, one policy
	 * resolution, one blast radius for every "move this agent" click. The
	 * platform has already paid for this exact mistake once (82.3% of 556k real
	 * events attributed to a row whose owner did not produce them).
	 *
	 * So: fingerprint the credential the CLIENT presented instead. Different
	 * callers hold different keys, so they become different agents — which is
	 * the true statement, where the gateway's own key was a false one.
	 *
	 * ⚠️ It is a FLOOR, not a substitute for key-auth. A fingerprint says
	 * "these requests came from one credential"; it cannot say whose it is. The
	 * real answer is higress key-auth writing an authenticated `x-mse-consumer`,
	 * and the `caller-` prefix on the id is there so nobody mistakes one for the
	 * other in the console.
	 */
	c.callerFallback = true
	if v := j.Get("caller_fallback"); v.Exists() && !v.Bool() {
		c.callerFallback = false
	}
	// First non-empty wins, so a deployment putting the key somewhere else names
	// that header alone rather than reordering ours.
	c.callerKeyHeaders = []string{"authorization", "x-api-key", "api-key"}
	if arr := j.Get("caller_key_headers").Array(); len(arr) > 0 {
		c.callerKeyHeaders = nil
		for _, h := range arr {
			if name := strings.TrimSpace(h.String()); name != "" {
				c.callerKeyHeaders = append(c.callerKeyHeaders, name)
			}
		}
	}

	/**
	 * ⚠️ There is deliberately NO consumer map in this plugin — no
	 * credential→name list, no consumer→workspace list. Both existed briefly
	 * (2.1.0 pre-release, 2026-08-14) on the belief that key-auth's
	 * `X-Mse-Consumer` "does not reach a WasmPlugin later in the chain". That
	 * measurement was wrong, and the way it was wrong is worth keeping: the
	 * lab's header-strip transformer was configured `phase: UNSPECIFIED_PHASE,
	 * priority: 400` against key-auth's `phase: AUTHN, priority: 310` — and
	 * Istio orders wasm filters by PHASE first (AUTHN before UNSPECIFIED),
	 * priority only within a phase. So the stripper ran AFTER key-auth and
	 * deleted the authenticated header it was supposed to protect. With the
	 * stripper on `phase: AUTHN, priority: 400` (strip, then authenticate,
	 * then report), key-auth's header arrives here fine — verified live
	 * 2026-08-14 with a consumer name that existed nowhere but key-auth's list.
	 *
	 * A duplicate credential list here would be two places to revoke a key and
	 * a second copy of every secret; the gateway's authenticator is the one
	 * source of the consumer name, and the runtime console owns agent→workspace
	 * placement for gateways that cannot send a group header.
	 */

	c.client = wrapper.NewClusterClient(wrapper.TargetCluster{Cluster: c.cluster, Host: c.host})

	// Traffic mirroring: a candidate runtime sees the same events and answers nothing.
	// Fire-and-forget in EVERY mode, including enforce — the mirror must never be able
	// to slow a request down, let alone stop one, or a shadow deployment becomes an
	// outage the moment the candidate is unhealthy. It rides /evaluate like everything
	// else (v0.8 has no other event channel); the verdict is simply never read.
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
		c.mirrorEvaluatePath = mirrorBase + pathEvaluate
		c.hasMirror = true
		logInfof("[OGR-CONFIG] mirror: cluster=%s host=%s base_path=%q (copies only, never gates)", cluster, host, mirrorBase)
	}

	// The beat is registered here because parseConfig is where a configured client
	// first exists; RegisterTickFunc is idempotent per plugin load.
	startHeartbeat(c)

	// ⚠️ The ONE line that survives `log_level: quiet`, and it is once per plugin LOAD,
	// not per request. An operator has to be able to confirm what actually loaded —
	// silence at startup is indistinguishable from a plugin that never loaded at all,
	// which is the failure this whole integration exists to make visible.
	proxywasm.LogWarnf("[OGR-CONFIG] v%s mode=%s cluster=%s host=%s base_path=%q timeout=%dms fail=%s tail=%d beat=%ds log=%s protocols=%s",
		pluginVersion, c.mode, c.cluster, c.host, c.basePath, c.timeoutMs, failLabel(c.failClosed), c.streamTailChars,
		heartbeatPeriodMs/1000, logLevelName(logLevel), strings.Join(protocolNames(), ","))
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
	ctxAgentUser      = "ogr_agent_user"
	ctxStepID         = "ogr_step_id"
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
	// through it: reassembling the SSE stream, restoring the placeholders, and
	// rendering a refusal.
	//
	// ⚠️ The CLIENT's, never the upstream provider's. This filter runs at priority 200
	// and ai-proxy at 100, so on the request we see the body BEFORE ai-proxy translates
	// it, and on the response we see it AFTER ai-proxy has translated back — both
	// times, the shape the caller chose. Provider independence is what our position
	// buys; client-protocol independence is what it costs, and the protocol package is
	// that cost paid.
	proto protocol.Protocol

	model     string
	streaming bool

	// sentAt is when the request was RELEASED upstream — the moment the model
	// call actually starts. Stamped at every resume point (observe continue,
	// enforce resume, fail-open resume) and consumed by the response side as
	// `timing.started_at`, so TTFT measures the provider, not this filter's
	// verdict wait.
	sentAt time.Time
	// injectedUsage: this plugin opted the stream into usage reporting on the
	// client's behalf, so the terminal usage-only frame is the plugin's to
	// swallow — a client that never asked must not have to parse it.
	injectedUsage bool

	// Whether this filter has taken ownership of the response stream to enforce
	// on it, and the withheld-tail buffer once chunks arrive. Held as the model's
	// own restored bytes so a released tail is byte-identical — re-rendering from
	// the parsed content would drop tool_calls, ids and usage. See tailhold.go.
	owned bool
	hold  *tailHold

	// --- SPECULATIVE EXECUTION (3.1.0, docs/two-lane-streaming.md) -------------
	//
	// The request is forwarded once the FAST lane has masked it, without waiting
	// for the content judges; the deep verdict lands during the response phase and
	// decides whether the stream keeps flowing.

	// spec: this step took the two-lane path. False ⇒ every field below is inert
	// and the response behaves exactly as 3.0.x did.
	spec bool
	// input is the deep request-half verdict: pending → allow | clamped.
	input inputState
	// released counts client-visible content bytes let out while `input` was still
	// pending — bounded by headReleaseBytes, which is what keeps the exposure
	// independent of how slow the judge is.
	released int
	// sp is the stream reassembler, kept so a verdict landing AFTER end-of-stream
	// can still run the final judgement.
	sp *streamProcessor
	// ended: the upstream stream is complete and the final judgement is waiting on
	// `input`. ⚠️ Without this the response half could be put to the PDP while the
	// request half was still in flight — two evaluates for one step, concurrently,
	// which is exactly the case a short refusal ("我不能回答", five tokens) produces.
	ended bool
	// lastOut is when a byte last reached the caller, for the keepalive below.
	lastOut time.Time
}

// inputState is the three-state hold (docs/two-lane-streaming.md §3).
type inputState int

const (
	inputPending inputState = iota
	inputAllow
	inputClamped
)

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
		// notice. Every observable signal said healthy. Measured 2026-08-08.
		ctx.SetContext(ctxSkip, true)
		ctx.DontReadRequestBody()
		ctx.DontReadResponseBody()
		return types.ActionContinue
	}
	// The path is the same signal ai-proxy keys on. Kept for the body phase, where the
	// shape check can refine it.
	ctx.SetContext(ctxPath, path)

	/**
	 * WHO IS THIS, and — the part that matters — WHO GOT TO SAY SO.
	 *
	 * The four identity fields split cleanly in two, and the split is the whole
	 * security model of this filter:
	 *
	 *   THE GATEWAY asserts `agent_id` and `agent_workspace`. These name a party
	 *   and select a POLICY SET, so a client that could set them
	 *   would pick its own identity and its own guardrails. They come from the
	 *   credential this gateway authenticated, or from operator config.
	 *
	 *   THE CLIENT may assert `agent_user` and `agent_type`. Both are
	 *   ATTRIBUTES the platform records and never resolves configuration
	 *   through: who is sitting at the keyboard this request, and which harness
	 *   is running. Only the client can know either, and lying about them costs
	 *   the liar their own audit trail and nothing else.
	 *
	 * ⚠️ Strip the gateway-side headers off client requests at the edge, and
	 * strip them BEFORE the authenticator runs — in higress terms the
	 * transformer must sit in `phase: AUTHN` at a higher priority than
	 * key-auth, because phases order first and priorities only tie-break
	 * within one. The plugin cannot tell a header the gateway wrote from one
	 * the client sent — higress key-auth does not overwrite `x-mse-consumer`,
	 * so a valid credential plus a forged consumer header is attributed to the
	 * forgery. (And a stripper mis-phased to run AFTER key-auth deletes the
	 * authenticated header instead — the failure that briefly convinced us
	 * key-auth's header never propagates at all.)
	 */
	getHeader := func(h string) string {
		v, _ := proxywasm.GetHttpRequestHeader(h)
		return v
	}

	// agent_id: the gateway-written header (`x-ogr-agent-id`, falling back to
	// the `x-mse-consumer` that key-auth/MSE actually write), else the
	// operator's static value, else the anonymous fingerprint floor. Never the
	// runtime API key — that names the SENDER and would make every consumer
	// here one agent.
	agentID := firstHeader(getHeader, cfg.agentIDHeaders)
	if agentID == "" {
		agentID = cfg.agentID
	}
	if agentID == "" && cfg.callerFallback {
		agentID = deriveCallerID(getHeader, cfg.callerKeyHeaders)
	}
	ctx.SetContext(ctxAgentID, agentID)

	// agent_type: the CLIENT's to declare (which harness is running), with a
	// static fallback for a route that fronts exactly one.
	agentType := getHeader(cfg.agentTypeHeader)
	if agentType == "" {
		agentType = cfg.agentType
	}
	ctx.SetContext(ctxAgentType, agentType)

	// agent_workspace — THE POLICY SET, so it is the gateway's to write
	// (`x-ogr-agent-workspace`, falling back to `x-mse-consumer-group`) and the
	// one header a client must never be allowed to reach us with. Unlike the
	// consumer header, no authenticator writes this one: it is ADMIN-CONFIGURED
	// (MSE assigns consumers to groups in its console; a self-hosted gateway
	// injects it per route). A deployment that configures no injection sends
	// nothing here and the runtime console owns placement instead.
	workspace := firstHeader(getHeader, cfg.agentWorkspaceHeaders)
	if workspace == "" {
		workspace = cfg.agentWorkspace
	}
	ctx.SetContext(ctxAgentWorkspace, workspace)

	// agent_user: per-request by nature — for an agent serving many people the
	// value changes with every call, so it can only ever come from the traffic.
	user := getHeader(cfg.agentUserHeader)
	ctx.SetContext(ctxAgentUser, user)

	// The step's ONE coordinate: a fresh opaque id binding this call's two events.
	// Minted here, always — earlier builds preferred `x-request-id`, and that header
	// is client-suppliable: a client retrying with the same id would REUSE a step_id
	// across model calls, which is the one thing the spec forbids about it.
	ctx.SetContext(ctxStepID, mintStepID())

	// The body may be rewritten (masking) and the response must not arrive compressed,
	// or neither restoration nor detection can read it.
	_ = proxywasm.RemoveHttpRequestHeader("content-length")
	_ = proxywasm.RemoveHttpRequestHeader("accept-encoding")
	return types.HeaderStopIteration
}

// stepSeq disambiguates step ids minted in the same nanosecond. Per-VM (each Envoy
// worker has its own Wasm VM), which is exactly enough: within a VM the counter
// separates them, across VMs a same-nanosecond collision would also need equal
// counters — negligible without spending entropy the wasm host may not have.
var stepSeq uint32

// mintStepID mints the producer-side coordinate the spec requires: opaque, fresh
// per model call, never reused. Time plus a sequence rather than crypto/rand,
// because the id only needs to be UNIQUE, not unguessable — it never leaves the
// authenticated channel to the runtime.
func mintStepID() string {
	return "st-" + strconv.FormatInt(time.Now().UnixNano(), 36) +
		"-" + strconv.FormatUint(uint64(atomic.AddUint32(&stepSeq, 1)), 36)
}

// subjectFromCtx assembles the request's agent identity from what the header
// phase stored. All-empty is the key-only floor.
func subjectFromCtx(ctx wrapper.HttpContext, cfg Config) identity {
	return subjectOf(
		ctx.GetStringContext(ctxAgentID, ""),
		ctx.GetStringContext(ctxAgentType, ""),
		ctx.GetStringContext(ctxAgentWorkspace, ""),
		ctx.GetStringContext(ctxAgentUser, ""),
	)
}

func onRequestBody(ctx wrapper.HttpContext, cfg Config, body []byte) types.Action {
	if ctx.GetBoolContext(ctxSkip, false) || len(body) == 0 {
		return types.ActionContinue
	}
	parsed := gjson.ParseBytes(body)
	subj := subjectFromCtx(ctx, cfg)

	// WHICH PROTOCOL. The path first (the same signal ai-proxy keys on), the body shape
	// as a fallback.
	proto := protocol.Detect(ctx.GetStringContext(ctxPath, ""), parsed)
	if proto == nil {
		/*
		 * ⚠️ Completion traffic whose protocol this plugin cannot NAME. The v0.8
		 * policy is: SKIP OGR FOR THIS REQUEST, COUNTED — no event is sent for
		 * either half.
		 *
		 * Why not an event: `llm_protocol` is a required closed enum, and the only
		 * value we could put there would be an invention (the exact lie that once
		 * made 693,197 stored events unfalsifiable, now promoted to a schema
		 * violation); the v0.7 `{"unparsed": true}` diagnostic payload is likewise
		 * gone — a fabricated payload makes the guardrails judge a fiction.
		 *
		 * Why not a refusal, even under fail_mode: closed: there is no protocol to
		 * render one in — an unparseable refusal body reads as a broken gateway and
		 * makes agent harnesses retry. And the branch is a defensive backstop more
		 * than a path: IsCompletionPath and Detect walk the same claim table, so a
		 * body that got this far has a protocol unless the two ever drift.
		 *
		 * The gap stays VISIBLE the way the spec keeps every lost observation
		 * visible: the heartbeat's `unreadable` counter, plus this line.
		 */
		bump(cntUnreadable, 1)
		logInfof("[OGR-REQ] unrecognised completion body: bytes=%d — no llm_protocol to state, this request is NOT judged (counted as unreadable)",
			len(body))
		ctx.SetContext(ctxSkip, true)
		return types.ActionContinue
	}

	// step_id is required non-empty; the header phase always minted one, but a
	// missing context entry must not become an invalid event.
	stepID := ctx.GetStringContext(ctxStepID, "")
	if stepID == "" {
		stepID = mintStepID()
	}
	rs := &reqState{
		session: newSessionState(),
		derive: &deriveCtx{
			subj:     subj,
			stepID:   stepID,
			protocol: proto.Name(),
		},
		proto: proto,
		// Read directly rather than through a full conversation parse: a raw
		// forwarder needs the model (to render a refusal) and the stream flag (to
		// pick the response machinery), and the runtime reads everything else.
		model:     parsed.Get("model").String(),
		streaming: parsed.Get("stream").Bool(),
	}
	ctx.SetContext(ctxSession, rs)
	ctx.SetContext(ctxStreaming, rs.streaming)
	ctx.SetContext(ctxModel, rs.model)
	ctx.SetContext(ctxBody, string(body))

	e := requestEvent(rs.derive, body)
	if cfg.mode == modeObserve {
		// Nothing is refusable in observe: the request is already gone. The event
		// still rides /evaluate — the only channel v0.8 has — fire-and-forget, the
		// verdict discarded, because evaluate records what it judges.
		report(cfg, e)
		rs.sentAt = time.Now()
		return types.ActionContinue
	}
	if speculative(cfg, rs) {
		startSpeculative(ctx, cfg, rs, e, string(body))
		return types.ActionPause
	}
	enforceRequest(ctx, cfg, rs, e, string(body))
	return types.ActionPause
}

/*
 * SPECULATIVE EXECUTION — three conditions, and each one is load-bearing.
 *
 *   enforce   observe already answers instantly and holds nothing; there is no
 *             latency here to remove.
 *   streaming a buffered reply has no head to release early, so the whole thing
 *             would be held anyway — the spec's own `tail = ∞` limit case — and
 *             the caller waits for the full generation either way. Serial is
 *             simpler and costs that caller nothing.
 *   fail-OPEN ⚠️ THE ONE THAT IS ABOUT SAFETY. Releasing the head puts unjudged
 *             bytes on the wire on the HAPPY PATH, on every request — which is
 *             the literal thing `closed` says must not happen. The fast lane
 *             also reports its deferrals in `x.ogr.unjudged`, so a fail-closed
 *             deployment would refuse every request anyway. Binding both to
 *             `fail_mode` is why this feature adds no configuration of its own:
 *             the setting that already means "may unjudged content proceed"
 *             answers here too.
 */
func speculative(cfg Config, rs *reqState) bool {
	return cfg.mode == modeEnforce && rs.streaming && !cfg.failClosed
}

/*
 * The FAST lane: deterministic detection only (regex + checksums, no model call
 * in the runtime at all), awaited because MASKING CANNOT BE APPLIED LATE — once
 * the body is forwarded, `ReplaceHttpRequestBody` is gone and the raw prompt is
 * in the model's context. Everything else waits beside the model instead.
 */
func startSpeculative(ctx wrapper.HttpContext, cfg Config, rs *reqState, e *GuardEvent, body string) {
	rs.spec = true
	mirrorEvent(cfg, e)

	payload, err := json.Marshal(e)
	if err != nil {
		finishRequest(ctx, rs, body)
		return
	}
	err = cfg.client.Post(cfg.evaluatePath, laneHeaders(cfg, laneFast), payload,
		func(status int, _ http.Header, respBody []byte) {
			onFastVerdict(ctx, cfg, rs, payload, body, status, respBody)
		}, cfg.timeoutMs)
	if err != nil {
		logConditionf("req.dispatch", "[OGR-FAST] dispatch failed: %v", err)
		// Fail-OPEN by construction here (speculative implies it): forward unmasked
		// and let the deep lane still judge the step. ⚠️ Unmasked is the honest cost
		// of a PDP we could not reach — say so rather than logging "masked".
		bump(cntUnchecked, 1)
		logInfof("[OGR-FAST] request forwarded UNMASKED (fast lane unreachable)")
		startDeepLane(ctx, cfg, rs, payload)
		armTailHold(ctx, cfg, rs)
		finishRequest(ctx, rs, body)
	}
}

func onFastVerdict(ctx wrapper.HttpContext, cfg Config, rs *reqState,
	payload []byte, outBody string, status int, respBody []byte) {
	v := parseVerdict(respBody)
	if status != 200 || !v.Usable() {
		logConditionf("fast.status", "[OGR-FAST] status=%d usable=%v — forwarding UNMASKED",
			status, v.Usable())
		bump(cntUnchecked, 1)
	} else {
		bump(cntEvaluated, 1)
		/*
		 * ⚠️ A fast-lane BLOCK still blocks, and this is the one place speculation
		 * does not defer. The deterministic detectors answer about VALUES — a secret,
		 * a national id — and "this must not reach the model" is a decision that has
		 * to be made before the body is forwarded or it cannot be made at all. The
		 * content judges are the ones whose refusal a stream can carry out later.
		 */
		if v.Stops() {
			bump(cntRefused, 1)
			answer(ctx, rs, v.Reason())
			return
		}
		if spans := v.Spans(); len(spans) > 0 {
			masked, applied, unresolved, learned := applySpans(outBody, spans)
			logUnresolvedSpans(unresolved)
			if applied > 0 {
				outBody = masked
				rs.session.adopt(learned)
				logInfof("[OGR-FAST] applied %d spans, %d tokens live", applied, len(rs.session.Mapping))
			}
		}
	}

	// The judges run BESIDE the model from here. Dispatched before the resume so the
	// two really do start together — a dispatch after `ResumeHttpRequest` is a
	// dispatch after the host may already have begun the upstream call.
	startDeepLane(ctx, cfg, rs, payload)
	armTailHold(ctx, cfg, rs)

	if inj, ok := rs.proto.(protocol.StreamUsageEnsurer); ok {
		if next, injected := inj.EnsureStreamUsage(outBody); injected {
			outBody = next
			rs.injectedUsage = true
		}
	}
	finishRequest(ctx, rs, outBody)
}

/*
 * The DEEP lane: a normal, full evaluate of the SAME request event, in flight while
 * the model prefills. It is the call that RECORDS the step — it re-runs the
 * deterministic detectors (microseconds) so one verdict holds both families of
 * finding, which is why the fast lane above records nothing.
 *
 * ⚠️ Its callback lands in the RESPONSE phase, and that is supported rather than
 * lucky: the SDK restores the caller's stream context by `callerContextID` and drops
 * the callback outright if that context is already destroyed
 * (proxy-wasm-go-sdk `abi_callback_l7.go`).
 */
func startDeepLane(ctx wrapper.HttpContext, cfg Config, rs *reqState, payload []byte) {
	err := cfg.client.Post(cfg.evaluatePath, ogrHeaders(cfg), payload,
		func(status int, _ http.Header, respBody []byte) {
			onDeepVerdict(ctx, cfg, rs, status, respBody)
		}, cfg.timeoutMs)
	if err != nil {
		logConditionf("deep.dispatch", "[OGR-DEEP] dispatch failed: %v", err)
		bump(cntUnchecked, 1)
		settleInput(ctx, cfg, rs, inputAllow)
	}
}

/*
 * The deep verdict decides whether the stream KEEPS FLOWING. It never refuses on its
 * own: the request is already with the model, so what a block buys here is that the
 * answer stops leaking and is judged WHOLE at end of stream — the spec's measured
 * position (whole-reply false positives 0.000 against 0.353 at 25% visibility).
 */
func onDeepVerdict(ctx wrapper.HttpContext, cfg Config, rs *reqState, status int, respBody []byte) {
	v := parseVerdict(respBody)
	if status != 200 || !v.Usable() {
		evaluateFailed("DEEP", status, cfg.failClosed)
		// Speculative implies fail-open; keep the stream flowing and let the
		// end-of-stream judgement be the enforcement point it already is.
		settleInput(ctx, cfg, rs, inputAllow)
		return
	}
	bump(cntEvaluated, 1)
	if v.Stops() {
		logInfof("[OGR-DEEP] request judged block — clamping the stream, judging the whole answer")
		settleInput(ctx, cfg, rs, inputClamped)
		return
	}
	settleInput(ctx, cfg, rs, inputAllow)
}

// enforceRequest puts the step's request half to the PDP, holding the request.
func enforceRequest(ctx wrapper.HttpContext, cfg Config, rs *reqState, e *GuardEvent, body string) {
	// The primary sees the event through the awaited /evaluate; the mirror gets its
	// own fire-and-forget copy or a shadow deployment is comparing against a hole.
	mirrorEvent(cfg, e)

	payload, err := json.Marshal(e)
	if err != nil {
		finishRequest(ctx, rs, body)
		return
	}
	err = cfg.client.Post(cfg.evaluatePath, ogrHeaders(cfg), payload,
		func(status int, _ http.Header, respBody []byte) {
			onInputVerdict(ctx, cfg, rs, body, status, respBody)
		}, cfg.timeoutMs)
	if err != nil {
		logConditionf("req.dispatch", "[OGR-REQ] evaluate dispatch failed: %v", err)
		applyFail(ctx, cfg, rs, "evaluate dispatch failed")
	}
}

// finishRequest lets the request go, with whatever masking this step decided.
func finishRequest(ctx wrapper.HttpContext, rs *reqState, outBody string) {
	if outBody != ctx.GetStringContext(ctxBody, "") {
		if err := proxywasm.ReplaceHttpRequestBody([]byte(outBody)); err != nil {
			// ⚠️ If the buffer is no longer writable here the prompt reaches the model
			// UNMASKED while every log says "masked". Fail loudly.
			proxywasm.LogErrorf("[OGR-REQ] request body replace FAILED: %v", err)
		}
		ctx.SetContext(ctxBody, outBody)
	}
	rs.sentAt = time.Now()
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
	// ⚠️ A 200 IS NOT A VERDICT. An empty body, an HTML error page, or a JSON document
	// of another shape must be treated exactly like an unreachable runtime — honour
	// `fail_mode`, count it as unchecked — never as an allow nobody decided.
	if !v.Usable() {
		logConditionf("req.nodecision",
			"[OGR-REQ] evaluate returned 200 with no decision (%d bytes) — treating as a FAILURE, not an allow: %s",
			len(respBody), truncate(string(respBody), 200))
		applyFail(ctx, cfg, rs, "evaluate returned 200 with no decision")
		return
	}
	bump(cntEvaluated, 1)
	logInfof("[OGR-REQ] decision=%s", v.Decision())

	if v.Stops() {
		bump(cntRefused, 1)
		answer(ctx, rs, v.Reason())
		return
	}
	if partiallyJudged("REQ", v, cfg.failClosed) {
		answer(ctx, rs, partialMessage)
		return
	}

	// Take ownership of a streaming response before the request goes anywhere:
	// arming the pause has to happen before the response phase begins (tailhold.go).
	armTailHold(ctx, cfg, rs)

	// ⚠️ The verdict's spans name paths INSIDE THE BODY WE SENT (`payload.messages.3.
	// content`, …) and their offsets index those strings as transported. The runtime
	// holds the session, so the spans cover everything in this body that must not
	// reach the model — this turn's findings AND the values earlier turns bound, which
	// the client re-sent in the clear. Applying them is the whole masking story; what
	// each splice displaced becomes the token→value map that restores the reply.
	if spans := v.Spans(); len(spans) > 0 {
		masked, applied, unresolved, learned := applySpans(outBody, spans)
		logUnresolvedSpans(unresolved)
		if applied > 0 {
			outBody = masked
			rs.session.adopt(learned)
			logInfof("[OGR-REQ] applied %d modification spans, %d tokens live", applied, len(rs.session.Mapping))
		}
	}

	// Ask the provider to report token usage on a stream that would otherwise
	// omit it (openai.chat's `include_usage`). ENFORCE ONLY — enforce already
	// rewrites bodies, observe never touches one — and AFTER the spans, so their
	// offsets were resolved against the body the runtime counted.
	if rs.streaming {
		if inj, ok := rs.proto.(protocol.StreamUsageEnsurer); ok {
			if next, injected := inj.EnsureStreamUsage(outBody); injected {
				outBody = next
				rs.injectedUsage = true
			}
		}
	}

	finishRequest(ctx, rs, outBody)
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
	 * `HeaderStopIteration` here, and `NeedPauseStreamingResponse` from `armTailHold`
	 * during the REQUEST phase, before any status exists to check. That is correct for
	 * a completion the model produced. It is wrong for everything else Envoy can put on
	 * this path: a LOCAL REPLY because no route matched, a 503, a 401 from key-auth, a
	 * 429 from the limiter. None of those is a completion and none has anything to
	 * judge — but a filter that held them gave the caller SILENCE: zero bytes until its
	 * own timeout (measured 2026-08-10, `response_flags: NR,DC`). Strictly 200 — an
	 * error body is not a model output, and a status we cannot read is not one either.
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

	// ⚠️ The step's second half is the RAW REPLY, as the CLIENT's protocol shaped it
	// (ai-proxy has already translated back below us). Detection happens on these
	// bytes — they still carry our placeholders, and detecting on the restored text
	// would find the very values we removed and block our own restoration.
	// Timing is the one fact the raw body cannot carry (usage already rides it,
	// put there by the provider): spliced in as a top-level key, byte-preserving.
	// No first_token_at — buffering is exactly the mode that hides it.
	e := responseEventTimed(rs.derive, body, bufferedTiming(rs.sentAt))
	if cfg.mode == modeObserve {
		report(cfg, e)
		return restoreResponse(rs, body)
	}

	mirrorEvent(cfg, e)
	payload, err := json.Marshal(e)
	if err != nil {
		return restoreResponse(rs, body)
	}
	err = cfg.client.Post(cfg.evaluatePath, ogrHeaders(cfg), payload,
		func(status int, _ http.Header, respBody []byte) {
			if status == 200 && parseVerdict(respBody).Usable() {
				bump(cntEvaluated, 1)
				v := parseVerdict(respBody)
				if v.Stops() {
					// Refused: the reply never reaches the caller.
					//
					// ⚠️ COUNT IT. Until 3.0.1 this branch bumped nothing, so a refused
					// BUFFERED reply was invisible in the heartbeat — `refused` meant
					// "every refusal except a verdict-blocked reply", which is not a
					// sentence anyone reading the console would have guessed. Found by
					// the lab's smoke assertions on 2026-08-15: one refusal, zero
					// counters.
					bump(cntRefused, 1)
					_ = proxywasm.ReplaceHttpResponseBody([]byte(rs.proto.Refuse(rs.model, v.Reason())))
					proxywasm.ResumeHttpResponse()
					return
				}
				if partiallyJudged("RESP", v, cfg.failClosed) {
					_ = proxywasm.ReplaceHttpResponseBody([]byte(rs.proto.Refuse(rs.model, partialMessage)))
					proxywasm.ResumeHttpResponse()
					return
				}
				// Spans on the reply: the model itself said something that must not
				// reach the caller in the clear.
				next := string(body)
				if spans := v.Spans(); len(spans) > 0 {
					masked, applied, unresolved, learned := applySpans(next, spans)
					logUnresolvedSpans(unresolved)
					if applied > 0 {
						next = masked
						rs.session.adopt(learned)
					}
				}
				if restored, changed := rs.proto.Restore(next, rs.session.Mapping); changed {
					next = restored
				}
				if next != string(body) {
					_ = proxywasm.ReplaceHttpResponseBody([]byte(next))
				}
				proxywasm.ResumeHttpResponse()
				return
			}
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
	// plugin derives a step/response from its own refusal text and reports it: the
	// audit trail gains a record of something no model ever said, and the refusal is
	// judged by the guardrails that produced it.
	if ctx.GetBoolContext(ctxAnswered, false) {
		return chunk
	}
	/*
	 * An error, not a completion (see onResponseHeaders). Let it through untouched —
	 * but "untouched" is not the same as "return it" once the pause is armed.
	 *
	 * ⚠️ `armTailHold` calls `NeedPauseStreamingResponse` in the REQUEST phase, which
	 * is the only place early enough to arm it and the one place where no status
	 * exists yet. Once armed, every chunk stops at this filter and the returned slice
	 * is NOT written — injection is the only way bytes reach the caller. Returning
	 * `chunk` here would look like a passthrough and deliver nothing, which is the
	 * exact hang this whole branch exists to remove.
	 */
	if ctx.GetBoolContext(ctxNotModel, false) {
		if rs.owned {
			if err := proxywasm.InjectEncodedDataToFilterChain(chunk, isLast); err != nil {
				proxywasm.LogErrorf("[OGR-RESP] passing an upstream error through failed: %v", err)
			}
			return nil
		}
		return chunk
	}
	sp, _ := ctx.GetContext(ctxStream).(*streamProcessor)
	if sp == nil {
		sp = newStreamProcessor(rs.proto, rs.session.Mapping, ctx.GetBoolContext(ctxStreaming, true),
			rs.sentAt, rs.injectedUsage)
		ctx.SetContext(ctxStream, sp)
	}
	out := sp.ProcessChunk(chunk, isLast)

	// ⚠️ NO MID-STREAM JUDGEMENT. It was here — every `stream_judge_chars`, cutting the
	// rest of the answer on a hit — and the pipeline measured exactly that
	// (`docs/STREAMING_GUARDRAIL.md`): false positives 2.3x at 25% visibility, all of
	// it the reply that agrees on the surface and corrects underneath. Early judgement
	// is a fit PREFILTER and an unfit BLOCKING CRITERION. v0.8 codified the
	// replacement: forward the stream behind a withheld tail and judge the answer
	// ONCE, whole, at end of stream (tailhold.go). If mid-stream detection ever comes
	// back it may only grow the hold; it may never cut.

	// Enforcing on a stream: the tail-hold owns the flow from here. Everything the
	// caller receives goes out by injection, and the whole answer is judged once at
	// end of stream.
	if rs.owned {
		return holdChunk(ctx, cfg, rs, sp, out, isLast)
	}

	if isLast {
		// Observe mode: the answer becomes a RECORD and nothing more. There is no
		// verdict to wait for and nothing to stop.
		result := sp.Result()
		switch {
		case !result.Empty():
			report(cfg, responseEventCanonical(rs.derive, canonicalOf(rs, result, sp.Timing())))
		case sp.SawBytes():
			// ⚠️ An empty result here means one of two very different things: the model
			// said nothing, or we could not read a single frame of what it sent. Only
			// the second is a hole, and it must not look like the first.
			reportUnreadableStream(rs, sp)
		}
	}
	return out
}

// canonicalOf renders a reassembled stream as the spec's canonical response payload.
func canonicalOf(rs *reqState, out protocol.Output, timing *canonicalTiming) canonicalPayload {
	calls := make([]canonicalToolCall, 0, len(out.Actions))
	for _, a := range out.Actions {
		calls = append(calls, canonicalToolCall{ID: a.ID, Name: a.Name, Arguments: jsonRaw(a.Arguments)})
	}
	p := canonicalPayload{
		Text:      out.Text,
		Reasoning: out.Reasoning,
		ToolCalls: calls,
		Model:     rs.model,
		Timing:    timing,
	}
	// The provider's own counters, transcribed — nil stays absent, never zeros.
	if u := out.Usage; u != nil {
		p.Usage = &canonicalUsage{
			InputTokens:      u.InputTokens,
			OutputTokens:     u.OutputTokens,
			ReasoningTokens:  u.ReasoningTokens,
			CacheReadTokens:  u.CacheReadTokens,
			CacheWriteTokens: u.CacheWriteTokens,
		}
	}
	return p
}

// bufferedTiming is what a buffered reply lets the gateway observe: when the
// request was released and when the whole body had arrived. A zero sentAt (a
// path that never stamped it) reports completion alone rather than inventing a
// start.
func bufferedTiming(sentAt time.Time) *canonicalTiming {
	t := &canonicalTiming{CompletedAt: time.Now().UTC().Format(time.RFC3339Nano)}
	if !sentAt.IsZero() {
		t.StartedAt = sentAt.UTC().Format(time.RFC3339Nano)
	}
	return t
}

// reportUnreadableStream says, out loud, that the model's OUTPUT side of this
// request was never judged because nothing could be reassembled out of the bytes
// that arrived. The request side still was.
//
// ⚠️ The silence this replaces is the expensive kind: the caller gets its answer,
// the gateway logs a clean 200, and nothing anywhere says a reply passed unjudged.
// v0.7 also sent an `{"unparsed": true}` diagnostic event; v0.8's required
// `llm_protocol` + honest-payload rules removed the room for it (see events.go),
// so the counter and this line ARE the record — and under `fail_mode: closed` the
// enforcing caller refuses the reply outright (tailhold.go), because a reply we
// could not read is a reply we could not judge.
func reportUnreadableStream(rs *reqState, sp *streamProcessor) {
	bump(cntUnreadable, 1)
	logInfof("[OGR-RESP] %d stream bytes reassembled to nothing on %s — the model's output side of this request is NOT judged (counted as unreadable)",
		sp.Bytes(), rs.proto.Name())
}

// --- talking to the runtime -------------------------------------------------

const failMessage = "The AI guardrail service is unavailable and this deployment is configured to fail closed."

// partialMessage is distinct from failMessage on purpose: the guardrail service ANSWERED,
// it just did not answer about all of this step. Telling an operator "unavailable" would
// send them looking at connectivity for a service that is up.
const partialMessage = "Part of this request could not be evaluated and this deployment is configured to fail closed."

// unreadMessage is the third distinct failure: the model answered, and THIS PLUGIN
// could not reassemble the answer to judge it. Neither an outage nor a partial
// verdict — an operator debugging it looks at the stream decoding, not at
// connectivity.
const unreadMessage = "This response could not be read for evaluation and this deployment is configured to fail closed."

// unorderedBudgetHint is appended to a `status=0`, because that status is exactly as
// informative as the budget chain is ordered.
const unorderedBudgetHint = "; if the runtime's own model budget is not strictly BELOW this plugin's timeout_ms, a 0 may be this filter aborting a runtime that was still answering — the slow capability is then unattributable on either side"

// partiallyJudged reports a verdict that covered only part of the event, and answers
// whether the caller must refuse it.
//
// ⚠️ This is the fail-closed promise, kept one level deeper than transport. An operator
// who sets `closed` is told: if we could not judge it, it does not go through. Without
// this check that holds only for calls THIS filter makes — the runtime losing one
// action's judge call inside a 200 would pass an unjudged action while the deployment
// believed that impossible, which is worse than fail-open, because the latency was paid
// for a guarantee that was not delivered.
func partiallyJudged(phase string, v verdict, failClosed bool) bool {
	if !v.Partial() {
		return false
	}
	unjudged := v.Unjudged()
	if v.MustRefusePartial(failClosed) {
		bump(cntRefused, 1)
		logInfof("[OGR-%s] the runtime judged only part of this event (%d unjudged: %s) — REFUSING, fail_mode=closed",
			phase, len(unjudged), strings.Join(unjudged, " "))
		return true
	}
	bump(cntUnchecked, 1)
	logInfof("[OGR-%s] the runtime judged only part of this event (%d unjudged: %s) — passed anyway, fail_mode=open",
		phase, len(unjudged), strings.Join(unjudged, " "))
	return false
}

// evaluateFailed reports an /evaluate call that did not answer, and says what it cost.
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

/*
 * THE LANE HEADER. `ogr-lane: fast` asks the runtime for the deterministic half only —
 * regex and checksums, no model call — and it answers in ~50ms with the spans this
 * filter must splice before forwarding.
 *
 * ⚠️ A HEADER rather than a body field, because the lane is a property of THIS CALL and
 * not of the event: the two lanes send byte-identical payloads, which is what lets the
 * fast lane's marshalled bytes be reused for the deep one instead of re-serialising a
 * 40 KB prompt.
 *
 * ⚠️ There is no `deep` value, on purpose. The second call is an ORDINARY evaluate: it
 * re-runs the deterministic detectors (microseconds) so that one verdict — the recorded
 * one — carries both families of finding. A runtime that has never heard of lanes
 * therefore treats the deep call correctly and only mis-handles the fast one, which is
 * the safe direction for a half-upgraded deployment: it judges MORE than asked, slowly.
 */
const laneFast = "fast"

func laneHeaders(cfg Config, lane string) [][2]string {
	return append(ogrHeaders(cfg), [2]string{"ogr-lane", lane})
}

func ogrHeaders(cfg Config) [][2]string {
	return [][2]string{
		{"Content-Type", "application/json"},
		{"Authorization", "Bearer " + cfg.apiKey},
	}
}

// logUnresolvedSpans reports modification spans that named nothing this body holds.
//
// ⚠️ The failure it catches is a path or offset disagreement between this plugin and
// the runtime, and it is otherwise invisible: every span is dropped, no value is
// masked, no error is raised, and the deployment looks exactly like one with no
// redaction policy.
func logUnresolvedSpans(n int) {
	if n == 0 {
		return
	}
	bump(cntUnresolvedSpans, uint64(n))
	logInfof("[OGR-REQ] ⚠️ %d modification spans named nothing this body holds — nothing was masked for them; check that the runtime's span `path` and offsets match the payload as transported",
		n)
}

// report posts ONE event to /evaluate and does not wait — observe mode's whole
// dispatch. Evaluate records everything it judges (it is the observation channel
// since v0.8 removed /ingest), so observe still produces findings; it just never
// makes anyone wait for them, and the verdict is deliberately never read — a mode
// that cannot act on a decision must not be tempted by one.
func report(cfg Config, e *GuardEvent) {
	payload, err := json.Marshal(e)
	if err != nil {
		return
	}
	post(cfg.client, cfg.apiKey, cfg.evaluatePath, payload, cfg.timeoutMs, "OGR-REPORT")
	bump(cntReported, 1)
	mirrorEvent(cfg, e)
}

// mirrorEvent sends a copy of one event to the candidate runtime and forgets it.
//
// ⚠️ Dispatched, never awaited, in EVERY mode. A mirror exists to answer "what would
// the new policy have said" — it is not in the decision, so a slow or dead candidate
// must cost the caller nothing.
func mirrorEvent(cfg Config, e *GuardEvent) {
	if !cfg.hasMirror {
		return
	}
	payload, err := json.Marshal(e)
	if err != nil {
		return
	}
	post(cfg.mirror, cfg.mirrorKey, cfg.mirrorEvaluatePath, payload, cfg.timeoutMs, "OGR-MIRROR")
	bump(cntMirrored, 1)
}

func post(client wrapper.HttpClient, apiKey, path string, payload []byte, timeoutMs uint32, tag string) {
	headers := [][2]string{
		{"Content-Type", "application/json"},
		{"Authorization", "Bearer " + apiKey},
	}
	if err := client.Post(path, headers, payload,
		func(status int, _ http.Header, body []byte) {
			if status != 200 {
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
	// ⚠️ Say what actually happened. "fail-open" reads like a setting working as
	// intended; what it means for this request is that nothing judged it. A deployment
	// that never greps for this line cannot tell a healthy gateway from one whose PDP
	// has been unreachable for a week. (No state was written, so an exact retry is
	// judged again — the plugin keeps nothing across requests by construction.)
	bump(cntUnchecked, 1)
	logInfof("[OGR-REQ] request passed UNCHECKED (fail-open): %s", why)
	// The RESPONSE half is still enforceable — the two step halves are judged
	// independently, and losing the request's verdict is no reason to stream the
	// answer back unenforced. Armed here because this callback is still the request
	// phase, the last moment the pause can be set.
	armTailHold(ctx, cfg, rs)
	rs.sentAt = time.Now()
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
