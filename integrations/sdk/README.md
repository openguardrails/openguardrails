# SDK — TypeScript client

Thin HTTP client for the OpenGuardrails service. Use it when you're
writing your own agent in TypeScript and want to embed a security check
at specific points in the loop — not via a plugin, but via direct code.

## Install

```bash
npm install @openguardrails/thomas-security
```

The SDK is re-exported from the main package:

```ts
import { OpenGuardrailsClient } from "@openguardrails/thomas-security/sdk";
```

Or copy [`index.ts`](./index.ts) into your project — it has no
dependencies beyond `fetch`.

## Usage

```ts
import { OpenGuardrailsClient } from "@openguardrails/thomas-security/sdk";

const guardrails = new OpenGuardrailsClient({
  apiKey: process.env.OPENGUARDRAILS_API_KEY!,
  timeoutMs: 3000,
});

const verdict = await guardrails.check({
  prompt: userMessage,
  toolCall: { name: "web_fetch", args: { url: candidateUrl } },
});

if (!verdict.allow) {
  throw new ToolBlocked(verdict.reason ?? "policy violation");
}
```

## Fail-open default

On timeout or network failure the client returns `{ allow: true, reason:
"guardrails-unreachable: ..." }`. This is deliberate — reliability
matters and a blocked agent is a visibly broken agent. Check `reason` if
you need fail-closed semantics.

## Source

[`index.ts`](./index.ts) is the whole client. ~100 lines, no
dependencies.
