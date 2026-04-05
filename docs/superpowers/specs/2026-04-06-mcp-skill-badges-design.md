# MCP & Skill Badges

Display MCP servers and Skills used in sessions as colored badges — on session cards (list view) and on individual messages (conversation view).

## Data sources

Session JSONL files already contain `tool_use` content blocks in assistant messages:

- **MCP**: `{ "type": "tool_use", "name": "mcp__<server>__<tool>", "input": {...} }`
- **Skill**: `{ "type": "tool_use", "name": "Skill", "input": { "skill": "<name>" } }`

Both `loadSessions()` and `loadSessionDetail()` already read these JSONL files — the tool_use blocks are just currently discarded by `extractContent()`.

## Backend changes (data.js)

### loadSessions() — session enrichment (~line 284)

Where `detail_messages` is counted by iterating JSONL lines, additionally collect:

- `s.mcp_servers: string[]` — unique MCP server names extracted from tool names matching `mcp__<server>__<tool>` (take `<server>` part)
- `s.skills: string[]` — unique skill names from `Skill` tool_use blocks via `input.skill`

Both arrays default to `[]`.

### loadSessionDetail() — message-level tools

When parsing assistant messages, for each message additionally collect a `tools` array:

```js
{
  role: 'assistant',
  content: '...',
  tools: [
    { type: 'mcp', server: 'chrome-devtools-mcp', tool: 'take_screenshot' },
    { type: 'skill', skill: 'figma:figma-use' }
  ]
}
```

Only include tools where `name.startsWith('mcp__')` or `name === 'Skill'`. Deduplicate within a single message (same tool name = one entry).

## Frontend changes (app.js)

### Session cards — card-top badges

After the existing `tool-badge tool-<tool>` span, render all MCP servers and skills:

```html
<span class="tool-badge badge-mcp">chrome-devtools</span>
<span class="tool-badge badge-skill">figma-use</span>
```

Show all badges, no limit.

### Conversation view — message badges

On each assistant message that has `tools.length > 0`, render a badge row under `msg-role`:

```html
<div class="msg-tools">
  <span class="tool-badge badge-mcp">take_screenshot</span>
  <span class="tool-badge badge-mcp">navigate_page</span>
  <span class="tool-badge badge-skill">figma-use</span>
</div>
```

Card-level badges show server name (compact). Message-level badges show tool/skill name (detailed).

## CSS (styles.css)

Two new badge variants using existing `tool-badge` base class:

```css
.badge-mcp { background: rgba(251, 146, 60, 0.2); color: #fb923c; border-color: #fb923c; }
.badge-skill { background: rgba(139, 92, 246, 0.2); color: #8b5cf6; border-color: #8b5cf6; }
.msg-tools { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 4px; }
```

Orange for MCP, purple for Skills. Both follow the existing `tool-badge` pattern (small, rounded, border).

## Scope

- Only MCP and Skill badges. No Agent, no built-in tools (Bash, Read, etc.).
- No new API endpoints — data added to existing responses.
- No new dependencies.
