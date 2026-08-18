# Gateway integrations

Gateway integrations put the OGR decision in the traffic path: one proxied
model call = one step, raw provider bodies forwarded untouched, the identity
four-tuple filled from the gateway's own caller authentication. All three
are thin PEPs speaking the
[v0.8 Runtime API](../../specification/runtime-api.md) (`POST /v1/evaluate`);
the policy and its models live in the runtime. OpenGuardrails does not
operate a gateway service.

| Target | Source |
|---|---|
| [Higress](https://github.com/alibaba/higress), as a native WASM plugin | [`higress/`](higress/) — the reference gateway integration |
| [mitmproxy](https://github.com/mitmproxy/mitmproxy) addon | [`mitmproxy/`](mitmproxy/) |
| OpenAI + Anthropic protocols, a readable single-file proxy | [`openai-anthropic/`](openai-anthropic/) |

`higress` is the one that runs INSIDE the gateway: a WASM plugin, called
**OpenGuardrails Runtime** in the Higress console. Being in the data path is
what lets it do the two things an out-of-band integration cannot — carry out
redaction spans in full (the runtime returns span offsets and never
plaintext) and refuse a request before the model sees it, streaming
included (tail-hold: the stream's final characters are withheld until the
one whole-response verdict lands).

It supersedes an earlier pair — the published `og-connector-higress-go`
plugin plus a Python adapter that served that plugin's own HTTP contract.
Speaking OGR natively removed both the translation loss and a network hop.
