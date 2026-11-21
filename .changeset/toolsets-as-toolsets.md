---
"@ai-patterns/anthropic-provider": minor
---

Anthropic's computer and browser toolsets are now sent as toolsets.

- A call to a member of a toolset keeps the toolset it belongs to, in `call.details.anthropic.toolset_name`. The provider sends it back on the call and on the call's result.
- A result may carry the browser's state, in `result.settings.anthropic.browser_state`. It is the SDK's own block without its `type`, and is sent after the result's other parts.

New types: `AnthropicToolCall`, a call with that detail, and `AnthropicResultHints`, a result's settings for Anthropic.

This breaks code that answers the browser toolset's `list_tabs`, `new_tab`, `switch_tab` or `close_tab` in text. Before, such a call went back with no toolset, and Anthropic took any result for it. Now Anthropic takes the browser's state and nothing else, or an error. A history whose calls have no toolset in their `details` is sent as before.
