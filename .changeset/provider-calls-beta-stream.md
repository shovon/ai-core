---
"@ai-patterns/anthropic-provider": minor
---

The provider now calls the SDK's beta namespace, `client.beta.messages.stream`, so Anthropic's betas are in reach. Name a beta in the settings as `betas`, beside the settings it brings, such as `mcp_servers` for the MCP connector. A request that names no beta is answered as before.

This breaks code that made the call itself with the provider's two halves:

- `params` now makes the body `client.beta.messages.stream` takes, and `read` takes that call's stream. `client.messages.stream(params(request))` no longer typechecks: call `client.beta.messages.stream` in its place.
- The exported types, such as `AnthropicSettings`, `AnthropicBlock`, `AnthropicStream` and `AnthropicResponse`, are now made from the SDK's beta types.

Also new: `AnthropicBody`, the type of what `params` makes. A turn that Anthropic ends with its `compaction` reason ends as `unknown`.
