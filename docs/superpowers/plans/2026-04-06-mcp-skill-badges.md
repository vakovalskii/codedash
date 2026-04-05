# MCP & Skill Badges Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show MCP servers and Skills used in sessions as colored badges on session cards and conversation messages.

**Architecture:** Extend the existing JSONL parsing in `data.js` to extract `tool_use` blocks for MCP (`mcp__*`) and Skill. Pass extracted data through existing API responses. Frontend renders badges using the existing `tool-badge` CSS pattern.

**Tech Stack:** Node.js (backend), plain browser JS (frontend), CSS

---

### Task 1: Backend — Extract MCP/Skill data in loadSessions()

**Files:**
- Modify: `src/data.js:360-384` (Enrich Claude sessions with detail file info)

The existing enrichment loop already reads every JSONL line and parses JSON to count `detail_messages`. We add MCP/Skill extraction to this same loop — zero additional I/O.

- [ ] **Step 1: Add MCP/Skill collection to the enrichment loop**

In `src/data.js`, find the enrichment block (line ~360-384). Replace the inner try block that counts messages:

```js
// Current code (lines 368-378):
      try {
        let msgCount = 0;
        const sLines = fs.readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean);
        for (const sl of sLines) {
          try {
            const entry = JSON.parse(sl);
            if (entry.type === 'user' || entry.type === 'assistant') msgCount++;
          } catch {}
        }
        s.detail_messages = msgCount;
      } catch { s.detail_messages = 0; }
```

Replace with:

```js
      try {
        let msgCount = 0;
        const mcpSet = new Set();
        const skillSet = new Set();
        const sLines = fs.readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean);
        for (const sl of sLines) {
          try {
            const entry = JSON.parse(sl);
            if (entry.type === 'user' || entry.type === 'assistant') msgCount++;
            if (entry.type === 'assistant') {
              const content = (entry.message || {}).content;
              if (Array.isArray(content)) {
                for (const block of content) {
                  if (block.type !== 'tool_use') continue;
                  const name = block.name || '';
                  if (name.startsWith('mcp__')) {
                    const parts = name.split('__');
                    if (parts.length >= 3) mcpSet.add(parts[1]);
                  } else if (name === 'Skill') {
                    const skill = (block.input || {}).skill;
                    if (skill) skillSet.add(skill);
                  }
                }
              }
            }
          } catch {}
        }
        s.detail_messages = msgCount;
        s.mcp_servers = Array.from(mcpSet);
        s.skills = Array.from(skillSet);
      } catch { s.detail_messages = 0; s.mcp_servers = []; s.skills = []; }
```

- [ ] **Step 2: Set defaults for non-Claude sessions**

Right after the `else` branch (line ~380) that sets `s.has_detail = false`, add defaults. Also ensure the defaults exist for Codex/OpenCode/Kiro sessions that skip this loop.

Find this block:

```js
    } else {
      s.has_detail = false;
      s.file_size = 0;
      s.detail_messages = 0;
    }
```

Replace with:

```js
    } else {
      s.has_detail = false;
      s.file_size = 0;
      s.detail_messages = 0;
      s.mcp_servers = [];
      s.skills = [];
    }
```

- [ ] **Step 3: Verify backend output**

Run the server and open in browser:

```bash
cd /Users/apple/Desktop/codedash && node bin/cli.js run
```

Then in another terminal:

```bash
curl -s http://localhost:3456/api/sessions | python3 -c "
import json, sys
sessions = json.load(sys.stdin)
for s in sessions[:50]:
    mcp = s.get('mcp_servers', [])
    skills = s.get('skills', [])
    if mcp or skills:
        print(f\"{s['id'][:8]}: mcp={mcp}, skills={skills}\")
" 
```

Expected: sessions that used MCP/Skill tools show their names in the arrays.

- [ ] **Step 4: Commit**

```bash
git add src/data.js
git commit -m "feat: extract MCP servers and Skills from session JSONL in loadSessions()"
```

---

### Task 2: Backend — Extract tools per message in loadSessionDetail()

**Files:**
- Modify: `src/data.js:398-441` (loadSessionDetail function)

- [ ] **Step 1: Add tools extraction to Claude message parsing**

In `loadSessionDetail()`, find the Claude format branch (line ~419-425):

```js
      if (found.format === 'claude') {
        if (entry.type === 'user' || entry.type === 'assistant') {
          const content = extractContent((entry.message || {}).content);
          if (content) {
            messages.push({ role: entry.type, content: content.slice(0, 2000), uuid: entry.uuid || '' });
          }
        }
```

Replace with:

```js
      if (found.format === 'claude') {
        if (entry.type === 'user' || entry.type === 'assistant') {
          const content = extractContent((entry.message || {}).content);
          if (content) {
            const msg = { role: entry.type, content: content.slice(0, 2000), uuid: entry.uuid || '' };
            if (entry.type === 'assistant') {
              const rawContent = (entry.message || {}).content;
              if (Array.isArray(rawContent)) {
                const tools = extractTools(rawContent);
                if (tools.length > 0) msg.tools = tools;
              }
            }
            messages.push(msg);
          }
        }
```

- [ ] **Step 2: Add the extractTools helper function**

Add this function right after the existing `extractContent()` function (after line ~630):

```js
function extractTools(contentBlocks) {
  const tools = [];
  const seen = new Set();
  for (const block of contentBlocks) {
    if (block.type !== 'tool_use') continue;
    const name = block.name || '';
    if (name.startsWith('mcp__')) {
      const parts = name.split('__');
      if (parts.length >= 3) {
        const key = 'mcp:' + parts[1] + ':' + parts.slice(2).join('__');
        if (!seen.has(key)) {
          seen.add(key);
          tools.push({ type: 'mcp', server: parts[1], tool: parts.slice(2).join('__') });
        }
      }
    } else if (name === 'Skill') {
      const skill = (block.input || {}).skill;
      if (skill && !seen.has('skill:' + skill)) {
        seen.add('skill:' + skill);
        tools.push({ type: 'skill', skill: skill });
      }
    }
  }
  return tools;
}
```

- [ ] **Step 3: Verify detail API**

```bash
# Pick a session ID that has MCP/Skill usage from Task 1 verification
curl -s "http://localhost:3456/api/session/<SESSION_ID>?project=<PROJECT>" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for m in data.get('messages', []):
    tools = m.get('tools', [])
    if tools:
        print(f\"{m['role']}: {tools}\")
"
```

Expected: assistant messages that used MCP/Skill tools have a `tools` array.

- [ ] **Step 4: Commit**

```bash
git add src/data.js
git commit -m "feat: extract per-message MCP/Skill tools in loadSessionDetail()"
```

---

### Task 3: CSS — Badge styles

**Files:**
- Modify: `src/frontend/styles.css:1049-1053` (after `.tool-kiro` block)

- [ ] **Step 1: Add badge-mcp, badge-skill, and msg-tools styles**

In `styles.css`, after the `.tool-kiro` block (line ~1049-1052), before the `/* -- Groups */` comment, add:

```css
.badge-mcp {
    background: rgba(251, 146, 60, 0.15);
    color: var(--accent-orange);
}

.badge-skill {
    background: rgba(139, 92, 246, 0.15);
    color: var(--accent-purple);
}

.msg-tools {
    display: flex;
    flex-wrap: wrap;
    gap: 4px;
    margin-top: 4px;
}
```

- [ ] **Step 2: Check that `--accent-orange` and `--accent-purple` CSS variables exist**

Search `styles.css` for these variables. If they don't exist, add them to the `:root` block. If they already exist (used by `.tool-kiro` and `.tool-opencode`), no action needed.

Run:

```bash
grep -n 'accent-orange\|accent-purple' src/frontend/styles.css
```

Expected: variables are already defined (used by `.tool-kiro` and `.tool-opencode`). If not, add to `:root`.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/styles.css
git commit -m "feat: add CSS for MCP and Skill badge styles"
```

---

### Task 4: Frontend — Badges on session cards

**Files:**
- Modify: `src/frontend/app.js:466-474` (renderCard function, card-top section)
- Modify: `src/frontend/app.js:523-524` (renderListCard function)

- [ ] **Step 1: Add badges to renderCard()**

In `renderCard()`, find line ~468 where `tool-badge` is rendered:

```js
  html += '<span class="tool-badge ' + toolClass + '">' + escHtml(s.tool) + '</span>';
```

Right after this line, add:

```js
  if (s.mcp_servers && s.mcp_servers.length > 0) {
    s.mcp_servers.forEach(function(m) {
      html += '<span class="tool-badge badge-mcp">' + escHtml(m) + '</span>';
    });
  }
  if (s.skills && s.skills.length > 0) {
    s.skills.forEach(function(sk) {
      html += '<span class="tool-badge badge-skill">' + escHtml(sk) + '</span>';
    });
  }
```

- [ ] **Step 2: Add badges to renderListCard()**

In `renderListCard()`, find line ~524:

```js
  html += '<span class="tool-badge tool-' + s.tool + '">' + escHtml(s.tool) + '</span>';
```

Right after this line, add the same badge code:

```js
  if (s.mcp_servers && s.mcp_servers.length > 0) {
    s.mcp_servers.forEach(function(m) {
      html += '<span class="tool-badge badge-mcp">' + escHtml(m) + '</span>';
    });
  }
  if (s.skills && s.skills.length > 0) {
    s.skills.forEach(function(sk) {
      html += '<span class="tool-badge badge-skill">' + escHtml(sk) + '</span>';
    });
  }
```

- [ ] **Step 3: Verify in browser**

Reload the dashboard. Session cards that used MCP/Skills should show orange/purple badges next to the tool badge (e.g., `CLAUDE` `CHROME-DEVTOOLS` `FIGMA-USE`).

- [ ] **Step 4: Commit**

```bash
git add src/frontend/app.js
git commit -m "feat: render MCP/Skill badges on session cards"
```

---

### Task 5: Frontend — Badges in conversation view

**Files:**
- Modify: `src/frontend/app.js:1128-1135` (showDetail message rendering)

- [ ] **Step 1: Add tool badges to assistant messages in conversation view**

In the `showDetail()` function, find the message rendering loop (line ~1128-1135):

```js
        data.messages.forEach(function(m) {
          var roleClass = m.role === 'user' ? 'msg-user' : 'msg-assistant';
          var roleLabel = m.role === 'user' ? 'You' : 'Assistant';
          msgsHtml += '<div class="message ' + roleClass + '">';
          msgsHtml += '<div class="msg-role">' + roleLabel + '</div>';
          msgsHtml += '<div class="msg-content">' + escHtml(m.content) + '</div>';
          msgsHtml += '</div>';
        });
```

Replace with:

```js
        data.messages.forEach(function(m) {
          var roleClass = m.role === 'user' ? 'msg-user' : 'msg-assistant';
          var roleLabel = m.role === 'user' ? 'You' : 'Assistant';
          msgsHtml += '<div class="message ' + roleClass + '">';
          msgsHtml += '<div class="msg-role">' + roleLabel + '</div>';
          if (m.tools && m.tools.length > 0) {
            msgsHtml += '<div class="msg-tools">';
            m.tools.forEach(function(t) {
              if (t.type === 'mcp') {
                msgsHtml += '<span class="tool-badge badge-mcp">' + escHtml(t.tool) + '</span>';
              } else if (t.type === 'skill') {
                msgsHtml += '<span class="tool-badge badge-skill">' + escHtml(t.skill) + '</span>';
              }
            });
            msgsHtml += '</div>';
          }
          msgsHtml += '<div class="msg-content">' + escHtml(m.content) + '</div>';
          msgsHtml += '</div>';
        });
```

- [ ] **Step 2: Verify in browser**

Click on a session that used MCP/Skill tools. In the conversation view, assistant messages should show tool badges between the role label and message content.

- [ ] **Step 3: Commit**

```bash
git add src/frontend/app.js
git commit -m "feat: render MCP/Skill badges in conversation view"
```
