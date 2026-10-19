# Changelog

## 3.16.0

- Honor the runtime response privacy policy before releasing streamed output. PII redaction holds all content, reasoning and tool arguments until final judgement, then applies permanent masks and restores secret placeholders.
- Restore only secret-format placeholders, with safe JSON argument and final-snapshot handling across OpenAI Chat, Responses and Anthropic streams.
- Use fail_mode for every processing failure, defaulting to open. PII does not override it; explicit policy blocks remain enforced in either mode.
- Refuse invalid request spans under closed before arming the response hold, preventing a synthetic refusal from hanging.
- Pin a minimal SDK patch that ignores duplicate HTTP callbacks after timeouts, preventing a worker VM panic and later evaluation bypass. Include SDK regression tests in CI and release checks.

Upgrade AIRS to 0.9.20 before upgrading this plugin. Existing runtime, identity, timeout and fail_mode configuration remains applicable.
