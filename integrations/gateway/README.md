# Gateway integrations

Gateway integrations demonstrate how an existing LLM gateway can normalize
wire-protocol traffic into OGR `GuardEvent`s and enforce the returned
`Verdict`. OpenGuardrails does not operate a gateway service.

| Target | Source | Binding |
|---|---|---|
| OpenAI and Anthropic protocols (reference proxy) | [`openai-anthropic/`](openai-anthropic/) | in-process (`openguardrails` package) |
| [mitmproxy](https://github.com/mitmproxy/mitmproxy) addon | [`mitmproxy/`](mitmproxy/) | PEP → runtime PDP (`POST /evaluate`) |
| [Higress](https://github.com/alibaba/higress), as a native WASM plugin | [`higress/`](higress/) | PEP → runtime PDP (`POST /evaluate` + `/ingest`) |

They differ by where the policy runs: `openai-anthropic` composes reference
detectors **in-process**; the other two are thin **PEP**s that call a hosted
runtime's `/evaluate` endpoint, so the policy (and its models) live in the runtime.

`higress` is the one that runs INSIDE the gateway: a WASM plugin, called
**OpenGuardrails Runtime** in the Higress console. Being in the data path is what
lets it do the two things an out-of-band integration cannot — carry out local
redaction in full (placeholder masking on the way in, restoration on the way back,
streaming included, because the runtime returns span offsets and never plaintext)
and refuse a request before the model sees it.

It supersedes an earlier pair — the published `og-connector-higress-go` plugin
plus a Python adapter that served that plugin's own HTTP contract. Speaking OGR
natively removed both the translation loss (thirteen event kinds collapsed into
two, streaming replies never reported at all) and a network hop.
