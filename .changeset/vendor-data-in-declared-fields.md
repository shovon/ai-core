---
"@ai-patterns/core": minor
"@ai-patterns/anthropic-provider": minor
---

What only one provider understands now sits in one of two declared fields, under the provider's name. It is no longer a bare field named after the provider.

- `settings` holds what is addressed to a provider. A text part, a file, a tool call, a tool result and a tool may carry it, as a request already did.
- `details` holds what a provider said. A source, the `end` chunk and the model turn made from it may carry it.

`ByProvider` is new in the core: the type of both fields.

This breaks code and stored histories that use the bare field. With Anthropic:

- A hint moves from `part.anthropic` to `part.settings.anthropic`. A file's settings and a tool's settings move the same way.
- A citation moves from `source.anthropic` to `source.details.anthropic`.
- Anthropic's account of a response moves from `turn.anthropic` to `turn.details.anthropic`.

A bare field is no longer read, and is refused by type where a part, a tool or an `end` is written out. A history stored before this change still loads and sends. Its bare fields are ignored, so its sources are no longer sent back as citations.
