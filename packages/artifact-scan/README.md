# openguardrails-artifact-scan

Fulfil OGR [`scan_artifact` obligations](../../specification/obligations.md):
resolve the artifact, sniff its header, hash it, negotiate ranges with a scanner,
and report the outcome back on the next event.

```python
from ogr_artifact_scan import fulfil, to_obligation_results
from ogr_artifact_scan.adapters import HttpJsonAdapter

adapter = HttpJsonAdapter("https://api.malware0.com", api_key)
fulfilments = fulfil(verdict.get("obligations", []), adapter, on_error="proceed")

if any(f.should_block() for f in fulfilments):
    ...  # do not execute the tool call

next_event["obligation_results"] = to_obligation_results(fulfilments)
```

## Why this exists, and why it is not "the SDK"

`/v1/evaluate` has no SDK and does not need one — two hand-rolled POSTs, which is
what every shipped integration does. **The artifact recipe is different**: header
sniffing, a streaming hash, a server-driven range loop and four scanner dialects.
Getting it wrong fails in the direction that cannot be caught afterwards.

## The rules this library keeps for you

- **It never manufactures a pass.** An unpolled `202`, a non-2xx, an unparseable
  body and a verdict outside `clean|suspicious|malicious` are all `failed`.
- **`on_error` is required.** Fail-open silently removes the control at the moment
  it is needed; fail-closed turns the scanner's outage into yours. There is no
  safe default, so there is no default.
- **It reports skips.** An obligation this integration will not handle comes back
  `skipped` — a decision somebody made. Silence is counted by the runtime as the
  gap in the control, and a deliberate skip must not be mistaken for one.
- **It never decides policy.** `suspicious` is reported as `suspicious`; whether
  it stops an action belongs to the runtime that issued the obligation.
- **It never loads the artifact into memory.** A 300 MB sample is the case this
  exists for.

## `declared_type` vs `detected_type`

The name claims a type; the bytes are the type. A 300 MB executable wearing an
`.mp4` name is exactly that disagreement, and `Fulfilment.type_mismatch` reports
it **even when the scan failed** — it needs the first 4 KiB and a magic table, so
it survives a refused upload, an exhausted quota and an unreachable scanner.

⚠️ A container is not a mismatch: `.docx` really is a zip and `.xlsm` really is an
OLE compound file. Treating those as disagreement flags every Office document ever
opened, which is how a signal gets switched off.

## Adapters

| provider | speaks | note |
|---|---|---|
| `malware0` | the OGR Artifact Scan contract | hash-first + range negotiation |
| `http_generic` | the same contract, your URL | for a service of your own |
| `icap` | RFC 3507 RESPMOD | **what an enterprise AV/DLP appliance already accepts.** Binary by nature: `204` = clean, `200` = blocked. No `suspicious` is invented |
| `clamav` | `INSTREAM` over the daemon socket | the free on-prem floor. Two-valued, same rule |

⚠️ `icap` and `clamav` need the **bytes**, so they only work from a PEP standing
next to the file. A runtime holding a package name or a URL cannot use them, and
offering them there would be a setting that cannot work.
