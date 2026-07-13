# Gateway integrations

Gateway integrations demonstrate how an existing LLM gateway can normalize
wire-protocol traffic into OGR `GuardEvent`s and enforce the returned
`Verdict`. OpenGuardrails does not operate a gateway service.

| Target | Source | Binding |
|---|---|---|
| OpenAI and Anthropic protocols (reference proxy) | [`openai-anthropic/`](openai-anthropic/) | in-process (`openguardrails` package) |
| [mitmproxy](https://github.com/mitmproxy/mitmproxy) addon | [`mitmproxy/`](mitmproxy/) | PEP → runtime PDP (`POST /evaluate`) |

The two differ by where the policy runs: `openai-anthropic` composes reference
detectors **in-process**; `mitmproxy` is a thin **PEP** that calls a hosted
runtime's `/evaluate` endpoint, so the policy (and its models) live in the runtime.
