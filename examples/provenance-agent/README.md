# provenance-agent — judge the EDGE, not the text

The runnable form of [`specification/provenance.md`](../../specification/provenance.md):
the control that still holds **after injection detection has failed**, because the
content it fires on carried nothing to detect.

```bash
cd examples/provenance-agent && ./demo.sh     # offline, stdlib only
```

## The episode

Three steps across four days, in [`episode.json`](episode.json). Every step passes
on its own merits:

```
2026-03-02  an email says the vendor's bank details changed after a restructure
            → no imperative aimed at the agent, no jailbreak, no signature.
              It is an ordinary business message. Its DMARC failed.
2026-03-02  the agent files the account in memory
            → no external content in THIS step. Nothing to judge.
2026-03-06  NEW SESSION: "Pay the March invoice for Acme."
            → the payload contains no external content at all.
              The only route back to the email is the memory key.
```

A point detector sees three clean steps. A single-session tracker loses the thread
at the session boundary. The violation is in the **edge**, and the edge is four days
long.

## What the demo shows

| Mode | Payment | Why |
|---|---|---|
| `--no-provenance` | `ALLOW` | Nothing in that payload looks like an attack, because nothing in it is one |
| `--no-sources` | `FLAG` | Trust derived from message roles alone: the action descends from `untrusted` content |
| *(default)* | `BLOCK` | `sources` says the tool result was an email nobody vouched for → `hostile` |

Note the direction of the `sources` conformance rule, which this demo is built to
make visible: **with** the field a runtime MUST NOT reach a **less strict** decision
than without it. Dropping it turns the `BLOCK` into a `FLAG` — permissive, which is
the safe way to be wrong about a self-declared label. A forged `"dmarc": "pass"` must
be unable to buy anything, or asserting good provenance becomes the cheapest attack
on the control.

## Files

```
episode.json              three GuardEvents; the third is a new session
policy.json               runtime configuration, never on the wire:
                          bindings (tool -> capability) + provenance rules
evaluate_provenance.py    ~200-line reference evaluator
demo.sh                   runs all three modes side by side
```

## What the evaluator implements

- **Role derivation** — `system`/`user`/`tool` → `trusted`/`user`/`untrusted`, with no
  help from the wire. A runtime MUST do this itself; `sources` is only for what it
  cannot derive.
- **Rule 1, the context floor** — derived content takes the lowest trust in context.
  A model does not report which tokens it drew on, so attributing an action to
  specific content would be a guess. This over-taints **by construction**.
- **Rule 2, sinks inherit** — the `memory_write` in step 1 carries the floor into the
  ledger under its key.
- **The cross-session edge** — the `memory_read` in step 3 restores it. This is the
  one part that needs runtime state beyond the turn, and the one part no single
  integration can supply: the write arrives through one channel and the read through
  another.
- **Enforcement at the sink** — rules read the capabilities `bindings` defines, never
  tool names. An unbound tool is reported `unjudged`, never guessed.

Why over-tainting is affordable: in `policy.json` **no rule names** `memory.write`,
`memory.read`, `mail.read` or `message.reply`. Almost every action an agent takes
never reaches a rule, so the false positives land where nothing is listening.

## What it is not

⚠️ A teaching implementation, not a conformance target. Its injection detector is a
**stub that always abstains** — deliberately: the tainting email has no injection
signature, and the demo would prove nothing if a detector caught it. A real runtime
runs detectors at that point and lowers `untrusted` to `hostile` on a hit.

It also implements no clearing. A real deployment needs one
([provenance.md § Clearing](../../specification/provenance.md#clearing)) — a control
with no exit gets switched off — and it must not be expressible in a `GuardEvent`,
since an agent that can launder its own context has no provenance control at all.
