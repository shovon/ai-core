# @ai-patterns/anthropic-provider

## 0.2.0

### Minor Changes

- 9e73f46: The provider now calls the SDK's beta namespace, `client.beta.messages.stream`, so Anthropic's betas are in reach. Name a beta in the settings as `betas`, beside the settings it brings, such as `mcp_servers` for the MCP connector. A request that names no beta is answered as before.
  
  This breaks code that made the call itself with the provider's two halves:
  
  - `params` now makes the body `client.beta.messages.stream` takes, and `read` takes that call's stream. `client.messages.stream(params(request))` no longer typechecks: call `client.beta.messages.stream` in its place.
  - The exported types, such as `AnthropicSettings`, `AnthropicBlock`, `AnthropicStream` and `AnthropicResponse`, are now made from the SDK's beta types.
  
  Also new: `AnthropicBody`, the type of what `params` makes. A turn that Anthropic ends with its `compaction` reason ends as `unknown`.
- e1f19a7: Anthropic's computer and browser toolsets are now sent as toolsets.
  
  - A call to a member of a toolset keeps the toolset it belongs to, in `call.details.anthropic.toolset_name`. The provider sends it back on the call and on the call's result.
  - A result may carry the browser's state, in `result.settings.anthropic.browser_state`. It is the SDK's own block without its `type`, and is sent after the result's other parts.
  
  New types: `AnthropicToolCall`, a call with that detail, and `AnthropicResultHints`, a result's settings for Anthropic.
  
  This breaks code that answers the browser toolset's `list_tabs`, `new_tab`, `switch_tab` or `close_tab` in text. Before, such a call went back with no toolset, and Anthropic took any result for it. Now Anthropic takes the browser's state and nothing else, or an error. A history whose calls have no toolset in their `details` is sent as before.
- 40ab209: What only one provider understands now sits in one of two declared fields, under the provider's name. It is no longer a bare field named after the provider.
  
  - `settings` holds what is addressed to a provider, as it already did on a request.
  - `details` holds what a provider said.
  
  Every part, every message, a tool, a shape and the `end` chunk may carry both, so a provider needs nothing added to the core to use either on any of them. `ByProvider` is new in the core: the type of both fields.
  
  Pieces of text, reasoning and tool input now join what they carry in the two fields as well as their text: the entries of both pieces, and for one provider the later piece's.
  
  This breaks code and stored histories that use the bare field. With Anthropic:
  
  - A hint moves from `part.anthropic` to `part.settings.anthropic`. A file's settings and a tool's settings move the same way.
  - A citation moves from `source.anthropic` to `source.details.anthropic`.
  - Anthropic's account of a response moves from `turn.anthropic` to `turn.details.anthropic`.
  
  A bare field is no longer read, and is refused by type where a part, a tool or an `end` is written out. A history stored before this change still loads and sends. Its bare fields are ignored, so its sources are no longer sent back as citations.

### Patch Changes

- Updated dependencies [40ab209]
  - @ai-patterns/core@0.2.0
