# @ai-patterns/core

## 0.2.0

### Minor Changes

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
