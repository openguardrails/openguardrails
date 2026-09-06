package main

import (
	"strings"

	"github.com/higress-group/proxy-wasm-go-sdk/proxywasm"
	"github.com/higress-group/wasm-go/pkg/wrapper"
)

/*
 * ⚠️ **TEMPORARY — A GRAY-RELEASE GATE, NOT PART OF THE PROTOCOL.** This whole file
 * exists so MCD can turn enforcement on for a named slice of traffic and nothing
 * else; when the rollout is done it is DELETED, along with the two `effectiveMode`
 * call sites in main.go. Nothing in the spec, the wire, or the runtime knows about
 * it: it only ever narrows what this filter does.
 *
 * The rule, in one line:
 *
 *	no `og-airs` beta flag ⇒ OBSERVE, whatever `mode:` says.
 *
 * With the flag the configured mode applies unchanged (`enforce` enforces,
 * `observe` observes). So the gate can only ever move a request TOWARD observe —
 * it can never turn an observe deployment into an enforcing one, which is what
 * makes it safe to ship ahead of the traffic it is meant to catch.
 *
 * ⚠️ **THE DEFAULT DIRECTION IS DELIBERATE AND IT IS "OFF".** A missing header, an
 * empty header, a header this filter never got to read (the request-headers hook
 * skipped the path, a VM that lost its context) all read as "not in the gray set"
 * and observe. During a rollout the failure we can afford is a request that was
 * only reported; the one we cannot is a request refused for a caller who was never
 * enrolled.
 *
 * The carrier is higress's own beta-flag header — a comma-separated token list
 * written at the edge, e.g.
 *
 *	x-higress-ai-beta-flags: some-other-beta,og-airs
 *
 * Membership is exact per token after trimming (case-insensitively): `og-airs`
 * enrolls, `og-airs-v2` or `xog-airs` do not. A substring test would enroll every
 * future flag that merely CONTAINS our name.
 */
const (
	betaFlagsHeader = "x-higress-ai-beta-flags"
	betaFlagOGR     = "og-airs"

	// Per-request: did this request carry the og-airs beta flag? Absent ⇒ false
	// ⇒ observe.
	ctxBetaOptIn = "ogr_beta_optin"
)

// hasBetaFlag reports whether a comma-separated beta-flag list carries `og-airs`
// as one of its tokens.
func hasBetaFlag(list string) bool {
	for _, tok := range strings.Split(list, ",") {
		if strings.EqualFold(strings.TrimSpace(tok), betaFlagOGR) {
			return true
		}
	}
	return false
}

// stampBetaOptIn reads the beta-flag header once, in the request-headers hook, and
// records membership for the rest of the request. Read HERE because it is a header
// fact: by the body phase the headers are gone.
func stampBetaOptIn(ctx wrapper.HttpContext) {
	flags, _ := proxywasm.GetHttpRequestHeader(betaFlagsHeader)
	in := hasBetaFlag(flags)
	ctx.SetContext(ctxBetaOptIn, in)
	if !in {
		logInfof("[OGR-BETA] no %q flag in %q — this request is OBSERVE regardless of configured mode", betaFlagOGR, flags)
	}
}

// effectiveMode is the mode THIS REQUEST runs in: the configured mode for a request
// in the gray set, observe for everything else. Every decision that used to read
// `cfg.mode` on the request path reads this instead.
func effectiveMode(ctx wrapper.HttpContext, cfg Config) string {
	return gatedMode(ctx.GetBoolContext(ctxBetaOptIn, false), cfg.mode)
}

// gatedMode is that rule with the context taken out of it, which is the whole of
// the gate: membership decides whether the configured mode survives.
func gatedMode(optIn bool, configured string) string {
	if optIn {
		return configured
	}
	return modeObserve
}
