---
"@ai-patterns/anthropic-provider": minor
---

The provider now takes the clients Anthropic's SDKs make for its clouds: `AnthropicBedrock`, `AnthropicBedrockMantle`, `AnthropicVertex` and `AnthropicFoundry`.

Before, `anthropic()` asked for a whole `Anthropic` client, and none of these is one. It now asks for the one call it makes, `client.beta.messages.stream`, as the SDK types it.

New type: `AnthropicClient`, what the provider needs of a client. A provider of your own, made from `params` and `read`, can take it in place of `Anthropic`.

Nothing breaks: an `Anthropic` client is taken as before.
