# Gateway plugins

A gateway plugin runs **inside a product that is itself the LLM byte path** — an
enterprise API gateway, a local agent firewall, a debugging proxy. The product
already terminates the client, forwards to the provider and carries the stream; the
plugin uses that product's extension point to put the OGR decision on the path: one
proxied model call = one step, provider bodies forwarded verbatim, the identity
four-tuple filled from the product's own caller authentication. Every one of them is
a thin PEP speaking the [Runtime API](../../specification/runtime-api.md)
(`POST /v1/evaluate`); the policy and its models live in the runtime. OpenGuardrails
does not operate a gateway service.

| Product | Seat | Source |
|---|---|---|
| [Higress](https://github.com/alibaba/higress) — enterprise API gateway | a native WASM plugin, **OpenGuardrails AIRS** in the Higress console | [`higress/`](higress/) — **the reference gateway plugin** |
| [OpenAFW](https://github.com/openguardrails/openafw) — the local AI firewall for coding agents | the OGR connection inside the proxy (Rust, in that repository) | [`openafw/`](openafw/) |
| [mitmproxy](https://github.com/mitmproxy/mitmproxy) — debugging proxy | an addon | [`mitmproxy/`](mitmproxy/) |
| — | a readable single-file proxy that shows the whole recipe, streaming included | [`openai-anthropic/`](openai-anthropic/) — documentation that runs, not a product |

Being in the data path is what lets a gateway plugin do the two things a
[standalone bridge](../bridge/) cannot — carry out redaction spans in full (the
runtime returns span offsets and never plaintext) and refuse a request before the
model sees it, streaming included (head-hold: a bounded head of the streamed answer
is released and the rest withheld until the one whole-response verdict lands).

Higress and OpenAFW sit at opposite ends of the same channel: Higress in front of an
organization's models, OpenAFW on the developer's own machine in front of a coding
agent. Same seat, same recipe, same category. What differs is who authenticates the
caller — a gateway consumer there, a local per-agent token here — and that only the
local one can mask secrets before they leave the host, because only it runs on that
host.

`higress` supersedes an earlier pair — the published `og-connector-higress-go`
plugin plus a Python adapter that served that plugin's own HTTP contract. Speaking
OGR natively removed both the translation loss and a network hop.

⚠️ **A proxy the organization wrote itself is not a gateway plugin** — it has no
extension point of ours to plug into, and the code around it is code this project
will never see. It gets a [bridge](../bridge/): a standalone process its service
posts messages to. The bridge's [`DESIGN.md`](../bridge/java/DESIGN.md) is the
protocol-conversion write-up — what the conversion has to do, job by job, with the
failure each rule prevents — and is worth reading before building a plugin in this
directory too.
