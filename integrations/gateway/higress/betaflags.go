package main

import (
	"strings"

	"github.com/higress-group/proxy-wasm-go-sdk/proxywasm"
	"github.com/higress-group/wasm-go/pkg/wrapper"
)

// The rollout gate complements the legacy OGR v5 connector: legacy OGR skips
// enrolled traffic, while AIRS uses the configured mode for enrolled traffic
// and fire-and-forget observe for everyone else. The decision is
// made from request headers and kept in the exchange context for both halves.
const (
	betaFlagsHeader = "x-higress-ai-beta-flags"
	betaFlagOGR     = "og-airs"
	ctxBetaOptIn    = "ogr_beta_optin"
)

func hasBetaFlag(list string) bool {
	for _, tok := range strings.Split(list, ",") {
		if strings.EqualFold(strings.TrimSpace(tok), betaFlagOGR) {
			return true
		}
	}
	return false
}

// Names are exact and case-sensitive, matching the legacy connector.
func parseStagedRollout(value string) map[string]bool {
	entries := make(map[string]bool)
	for _, entry := range strings.Split(value, ",") {
		if entry = strings.TrimSpace(entry); entry != "" {
			entries[entry] = true
		}
	}
	return entries
}

func rolloutOptIn(flags, consumer, group string, entries map[string]bool) bool {
	consumer = strings.TrimSpace(consumer)
	group = strings.TrimSpace(group)
	return hasBetaFlag(flags) || entries["all_consumers"] ||
		(consumer != "" && entries[consumer]) ||
		(group != "" && entries[group]) ||
		(group == "" && entries["ungrouped"])
}

func stampBetaOptIn(ctx wrapper.HttpContext, cfg Config) bool {
	getHeader := func(name string) string { value, _ := proxywasm.GetHttpRequestHeader(name); return value }
	return stampRollout(ctx, cfg, getHeader)
}

// No response header lookup: the LLM does not carry consumer/beta identity.
func stampRollout(ctx wrapper.HttpContext, cfg Config, getHeader func(string) string) bool {
	in := rolloutOptIn(getHeader(betaFlagsHeader), getHeader("x-mse-consumer"),
		getHeader("x-mse-consumer-group"), cfg.stagedRollout)
	ctx.SetContext(ctxBetaOptIn, in)
	if !in {
		logInfof("[OGR-BETA] outside staged rollout — observing request and response without waiting")
	}
	return in
}

// Enrolled traffic retains the configured mode. Everyone else uses observe
// for both halves: report fire-and-forget, without enforcing verdicts.
func effectiveMode(ctx wrapper.HttpContext, cfg Config) string {
	return gatedMode(ctx.GetBoolContext(ctxBetaOptIn, false), cfg.mode)
}

func gatedMode(optIn bool, configured string) string {
	if optIn {
		return configured
	}
	return modeObserve
}
