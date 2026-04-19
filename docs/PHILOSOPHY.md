# Why thomas-security is partly open and partly closed

This document exists because the question comes up often: *"If you care
about agent security, why don't you open-source all of it?"*

The short answer: because that would help attackers more than it helps
you.

## Security is asymmetric

The attacker and the defender are not playing the same game.

- **Attacker's goal:** find *one* path that works. Cost grows roughly with
  the cost of the cheapest surviving path.
- **Defender's goal:** close *every* path. Cost grows with the size of the
  attack surface.

The surface is always larger than any single attack. Therefore the
defender's structural cost is higher. Defense only wins by *raising the
attacker's cost* — not by matching it one-for-one.

An attacker abandons a target when either:

1. The cost of attacking it exceeds the expected reward, or
2. The cost of attacking it exceeds what they could earn attacking
   something else of similar value.

So every security decision we make is really a question of: *does this
move raise the attacker's cost, lower it, or leave it unchanged?*

## Applied to open-sourcing

Open-sourcing has two effects at once:

- It lowers cost for **defenders**: more users can patch, more
  researchers can find bugs, more integrators can embed protection.
- It lowers cost for **attackers**: the attack surface and the defensive
  countermeasures become public and inspectable.

Whether a given component should be open therefore depends on which of
those two effects dominates for *that* component.

### Offensive and discovery tooling → open-source

A checkup that detects a known-malicious skill, or a red-team attack
that replays a known prompt-injection, is almost all upside when opened:

- Defenders who run it find real problems and patch them.
- Researchers who read it contribute new checkups and attacks.
- Attackers learn almost nothing: the attacks were already known, and
  knowing that defenders can *detect* a thing does not lower the cost of
  *doing* the thing. If anything it raises it, because a detected attack
  is a spent attack.

This is the part of thomas-security in this repository.

### CLI engine, detection rules, runtime policy → proprietary

The `thomas` CLI binary, the live ruleset it loads, the policy engine,
and the threat-intel feed are the opposite:

- Open-sourcing the engine gives defenders something they could also
  obtain as a managed binary. Marginal defender upside is small.
- Open-sourcing the rules and feed tells attackers exactly what is being
  looked for, which directly lowers attacker cost: they can develop
  variants that evade each published rule, and they can do so offline
  against our own test fixtures.

Publishing those is not an act of transparency; it's an act of subsidy
to the attacker. We don't.

## Parallel to `anthropics/claude-code`

The layout mirrors Claude Code's open-source footprint on purpose:

| Claude Code                               | thomas-security                           |
| ----------------------------------------- | ----------------------------------------- |
| `claude` CLI — closed, shipped as binary  | `thomas` CLI — closed, shipped as binary  |
| `anthropics/claude-code` repo — plugins + skills + examples | `thomas-security` repo — checkups + redteam + integrations |

In both cases the **product that enforces policy** is closed and the
**ecosystem around it or offensive and discovery tooling** is open. That's 
not a cynical split — it's the split that keeps the attacker's cost high.

## What this means for you

- If you want to **find** problems in your agent stack — run `thomas
  scan` and `thomas redteam`. The content they load is this repo.
- If you want **runtime protection** against live attacks — install the
  `thomas` plugin, skill, or SDK under [`integrations/`](../integrations).
  That talks to the closed side.
- If you want to **contribute** — PRs against `checkups/`, `redteam/`,
  and `integrations/` are all welcome. PRs that ask us to publish
  detection internals will be politely declined.

## A note on "security through obscurity"

The usual objection is: "keeping defenses secret is security through
obscurity, which is bad practice."

That objection conflates two different things:

1. Relying on the *secrecy of a mechanism* for the mechanism to work —
   e.g., a custom cipher that only works because nobody has seen it.
   This is bad and we don't do it.
2. Keeping the *current parameters* of a mechanism private — e.g., the
   specific regex a WAF uses this week, the specific behavioral
   signature a detector uses this week. This is normal defensive
   practice and is used by essentially every commercial security
   product.

Our protocols, our integration surface, our checkups, and our red-team
corpus are all public. Our live ruleset is not. That is the correct
tradeoff.
