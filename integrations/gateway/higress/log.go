package main

import (
	"encoding/binary"
	"time"

	"github.com/higress-group/proxy-wasm-go-sdk/proxywasm"
)

// How much this plugin says, and why the default is almost nothing.
//
// Every line here used to be `LogWarnf`, and Envoy shows warn by default — so a
// gateway running this printed several lines PER REQUEST forever. On a busy
// deployment that is the largest thing in the access log, it buries the lines that
// mean something, and the container's json-file driver fills the disk with it.
//
// The rule, and it is one sentence:
//
//	quiet prints only what says the DEPLOYMENT IS BROKEN. Everything that describes a
//	REQUEST moves behind `info`.
//
// So `LogErrorf` — a dispatch that never left, a body we could not replace, an
// injection that failed — is never silenced: those are the failures no counter can
// carry, because the process that would carry them is the one that is broken. A
// runtime that has been unreachable for a week is still loud at quiet, from
// `post()` and from the evaluate callback.
//
// ⚠️ **A warning silenced by default MUST have a counter that is actually sent.**
// That is the condition that makes this safe rather than convenient, and it was not
// met when this was written: `cntStreamStopped` and `cntUnresolvedSpans` were bumped
// and then dropped on the floor by `counters()`, which exported the first four slots
// only. Both are reported now, and the signals this change moves behind `info` —
// unreadable bodies, capped turns, partial verdicts, fail-open passes, refusals — got
// slots of their own. If you silence another line, give it a slot first.
const (
	logQuiet = iota // errors only, plus one config line at load
	logInfo         // + one line per request, and every incident warning
	logDebug        // + payload-shaped detail; for a lab, never for production
)

// ⚠️ A PACKAGE-LEVEL GLOBAL, which this codebase otherwise refuses (see session.go).
// The distinction is what the value is a property OF. Session state is per
// CONVERSATION, and a conversation's turns land in different Wasm VMs, so a Go global
// held one worker's idea of it and re-masked nothing on turn 2. The log level is a
// property of the CONFIG: every VM runs parseConfig over the same yaml, so a per-VM
// copy is a per-VM IDENTICAL copy. Nothing observes it across a request boundary.
var logLevel = logQuiet

func parseLogLevel(s string) int {
	switch s {
	case "debug":
		return logDebug
	case "info":
		return logInfo
	default:
		// Anything unrecognised — including the empty string — is quiet. A typo must
		// not turn logging ON: the failure mode of this setting is disk, and an
		// operator who meant `info` will notice silence far sooner than a fleet will
		// notice a full volume.
		return logQuiet
	}
}

func logLevelName(l int) string {
	switch l {
	case logDebug:
		return "debug"
	case logInfo:
		return "info"
	default:
		return "quiet"
	}
}

// logInfof is the per-request narration: decisions, mask counts, and the incident
// warnings that can repeat once per request when something upstream is wrong.
func logInfof(format string, args ...any) {
	if logLevel >= logInfo {
		proxywasm.LogWarnf(format, args...)
	}
}

// logDebugf is for detail that is only ever wanted while reproducing something.
func logDebugf(format string, args ...any) {
	if logLevel >= logDebug {
		proxywasm.LogWarnf(format, args...)
	}
}

// --- throttling a CONDITION, as opposed to an incident ---------------------------

/*
 * ⚠️ **A MISSING RUNTIME IS ONE FACT, NOT ONE FACT PER REQUEST**, and getting that
 * wrong turns the plugin into the load it was supposed to stop adding.
 *
 * `quiet` deliberately never silences an error, because the errors are what say the
 * deployment is broken. But the commonest broken deployment — the plugin installed
 * before the runtime exists, or the runtime down for an hour — makes EVERY request
 * fail, and each failure was writing 2-4 error lines. A customer running 1.7.1 against
 * no runtime at all reported exactly this: the gateway's own log became the load.
 *
 * So the transport failures are throttled process-wide: the first one is immediate, the
 * rest are suppressed for `logThrottleSeconds`. Nothing is lost that matters — the
 * CONDITION is still reported every 30s, and its MAGNITUDE was never in the log
 * anyway, it is in the heartbeat's `unchecked` counter.
 *
 * ⚠️ **What is NEVER throttled**: a failure that leaks or corrupts. An injection that
 * did not happen, a request body we could not rewrite after deciding to mask it — those
 * are per-incident, each one is a distinct piece of traffic that went out wrong, and one
 * suppressed line is one leak nobody hears about. Only "we could not reach the PDP"
 * collapses, because the second occurrence tells you nothing the first did not.
 *
 * ⚠️ Process-wide via shared data, not a Go global: every worker thread has its own Wasm
 * VM, so a per-VM throttle still emits once per VM per period — eighteen lines on this
 * box. Same reason the heartbeat claims its turn through `claimBeat`.
 */
const logThrottleSeconds = 30

func claimLog(key string) bool {
	k := "ogr.log." + key
	now := time.Now().Unix()
	for i := 0; i < casRetries; i++ {
		data, cas, err := proxywasm.GetSharedData(k)
		var last int64
		if err == nil && len(data) == 8 {
			last = int64(binary.LittleEndian.Uint64(data))
		}
		if now-last < logThrottleSeconds {
			return false
		}
		buf := make([]byte, 8)
		binary.LittleEndian.PutUint64(buf, uint64(now))
		if proxywasm.SetSharedData(k, buf, cas) == nil {
			return true
		}
	}
	// Could not claim under contention: stay quiet. Another VM is logging this same
	// condition right now, which is the whole point.
	return false
}

// logConditionf reports a failure that describes the DEPLOYMENT rather than the
// request. Always at error level — `log_level` does not silence it — but at most once
// per 30s across the process.
func logConditionf(key string, format string, args ...any) {
	if claimLog(key) {
		proxywasm.LogErrorf(format+" [further identical errors suppressed for %ds; magnitude is in the heartbeat's `unchecked` counter]",
			append(args, logThrottleSeconds)...)
	}
}
