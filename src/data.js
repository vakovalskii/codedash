const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// ── Constants ──────────────────────────────────────────────

const CLAUDE_DIR = path.join(os.homedir(), '.claude');
const CODEX_DIR = path.join(os.homedir(), '.codex');
const HISTORY_FILE = path.join(CLAUDE_DIR, 'history.jsonl');
const PROJECTS_DIR = path.join(CLAUDE_DIR, 'projects');

// ── Helpers ────────────────────────────────────────────────

function scanCodexSessions() {
  const sessions = [];
  const codexHistory = path.join(CODEX_DIR, 'history.jsonl');
  if (fs.existsSync(codexHistory)) {
    const lines = fs.readFileSync(codexHistory, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const d = JSON.parse(line);
        // Codex uses session_id, ts (seconds), text
        const sid = d.session_id || d.sessionId || d.id;
        if (!sid) continue;
        const ts = d.ts ? d.ts * 1000 : (d.timestamp || Date.now());
        if (!sessions.find(s => s.id === sid)) {
          sessions.push({
            id: sid,
            tool: 'codex',
            project: d.project || d.cwd || '',
            project_short: (d.project || d.cwd || '').replace(os.homedir(), '~'),
            first_ts: ts,
            last_ts: ts,
            messages: 1,
            first_message: d.text || d.display || d.prompt || '',
            has_detail: false,
            file_size: 0,
            detail_messages: 0,
          });
        }
      } catch {}
    }
  }

  // Enrich with session files from ~/.codex/sessions/
  const codexSessionsDir = path.join(CODEX_DIR, 'sessions');
  if (fs.existsSync(codexSessionsDir)) {
    try {
      // Walk year/month/day directories
      const files = [];
      const walkDir = (dir) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walkDir(full);
          else if (entry.name.endsWith('.jsonl')) files.push(full);
        }
      };
      walkDir(codexSessionsDir);

      for (const f of files) {
        const stat = fs.statSync(f);
        // Extract session ID from filename (rollout-DATE-UUID.jsonl)
        const basename = path.basename(f, '.jsonl');
        const uuidMatch = basename.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/);
        if (!uuidMatch) continue;
        const sid = uuidMatch[1];
        // Try to extract cwd from session_meta
        let cwd = '';
        try {
          const firstLine = fs.readFileSync(f, 'utf8').split('\n')[0];
          const meta = JSON.parse(firstLine);
          if (meta.type === 'session_meta' && meta.payload && meta.payload.cwd) {
            cwd = meta.payload.cwd;
          }
        } catch {}

        const existing = sessions.find(s => s.id === sid);
        if (existing) {
          existing.has_detail = true;
          existing.file_size = stat.size;
          if (cwd && !existing.project) {
            existing.project = cwd;
            existing.project_short = cwd.replace(os.homedir(), '~');
          }
        } else {
          sessions.push({
            id: sid,
            tool: 'codex',
            project: cwd,
            project_short: cwd ? cwd.replace(os.homedir(), '~') : '',
            first_ts: stat.mtimeMs,
            last_ts: stat.mtimeMs,
            messages: 0,
            first_message: '',
            has_detail: true,
            file_size: stat.size,
            detail_messages: 0,
          });
        }
      }
    } catch {}
  }

  return sessions;
}

// ── Public API ─────────────────────────────────────────────

function loadSessions() {
  const sessions = {};

  // Load Claude Code sessions
  if (fs.existsSync(HISTORY_FILE)) {
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const d = JSON.parse(line);
        const sid = d.sessionId;
        if (!sid) continue;

        if (!sessions[sid]) {
          sessions[sid] = {
            id: sid,
            tool: 'claude',
            project: d.project || '',
            project_short: (d.project || '').replace(os.homedir(), '~'),
            first_ts: d.timestamp,
            last_ts: d.timestamp,
            messages: 0,
            first_message: '',
          };
        }

        const s = sessions[sid];
        s.last_ts = Math.max(s.last_ts, d.timestamp);
        s.first_ts = Math.min(s.first_ts, d.timestamp);
        s.messages++;

        if (d.display && d.display !== 'exit' && !s.first_message) {
          s.first_message = d.display.slice(0, 200);
        }
      } catch {}
    }
  }

  // Load Codex sessions
  if (fs.existsSync(CODEX_DIR)) {
    try {
      const codexSessions = scanCodexSessions();
      for (const cs of codexSessions) {
        sessions[cs.id] = cs;
      }
    } catch {}
  }

  // Enrich Claude sessions with detail file info
  for (const [sid, s] of Object.entries(sessions)) {
    if (s.tool !== 'claude') continue;
    const projectKey = s.project.replace(/[\/\.]/g, '-');
    const sessionFile = path.join(PROJECTS_DIR, projectKey, `${sid}.jsonl`);
    if (fs.existsSync(sessionFile)) {
      s.has_detail = true;
      s.file_size = fs.statSync(sessionFile).size;
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
    } else {
      s.has_detail = false;
      s.file_size = 0;
      s.detail_messages = 0;
    }
  }

  const result = Object.values(sessions).sort((a, b) => b.last_ts - a.last_ts);

  for (const s of result) {
    s.first_time = new Date(s.first_ts).toLocaleString('sv-SE').slice(0, 16);
    s.last_time = new Date(s.last_ts).toLocaleString('sv-SE').slice(0, 16);
    s.date = new Date(s.last_ts).toISOString().slice(0, 10);
  }

  return result;
}

function loadSessionDetail(sessionId, project) {
  const found = findSessionFile(sessionId, project);
  if (!found) return { error: 'Session file not found', messages: [] };

  const messages = [];
  const lines = fs.readFileSync(found.file, 'utf8').split('\n').filter(Boolean);

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);

      if (found.format === 'claude') {
        if (entry.type === 'user' || entry.type === 'assistant') {
          const content = extractContent((entry.message || {}).content);
          if (content) {
            messages.push({ role: entry.type, content: content.slice(0, 2000), uuid: entry.uuid || '' });
          }
        }
      } else {
        if (entry.type === 'response_item' && entry.payload) {
          const role = entry.payload.role;
          if (role === 'user' || role === 'assistant') {
            const content = extractContent(entry.payload.content);
            if (content && !isSystemMessage(content)) {
              messages.push({ role: role, content: content.slice(0, 2000), uuid: '' });
            }
          }
        }
      }
    } catch {}
  }

  return { messages: messages.slice(0, 200) };
}

function deleteSession(sessionId, project) {
  const deleted = [];

  // 1. Remove session JSONL file from project dir
  const projectKey = project.replace(/[\/\.]/g, '-');
  const sessionFile = path.join(PROJECTS_DIR, projectKey, `${sessionId}.jsonl`);
  if (fs.existsSync(sessionFile)) {
    fs.unlinkSync(sessionFile);
    deleted.push('session file');
  }

  // Also remove companion directory if exists (some sessions have one)
  const sessionDir = path.join(PROJECTS_DIR, projectKey, sessionId);
  if (fs.existsSync(sessionDir) && fs.statSync(sessionDir).isDirectory()) {
    fs.rmSync(sessionDir, { recursive: true });
    deleted.push('session dir');
  }

  // 2. Remove entries from history.jsonl
  if (fs.existsSync(HISTORY_FILE)) {
    const lines = fs.readFileSync(HISTORY_FILE, 'utf8').split('\n').filter(Boolean);
    const filtered = lines.filter(line => {
      try {
        const d = JSON.parse(line);
        return d.sessionId !== sessionId;
      } catch { return true; }
    });
    if (filtered.length < lines.length) {
      fs.writeFileSync(HISTORY_FILE, filtered.join('\n') + '\n');
      deleted.push(`${lines.length - filtered.length} history entries`);
    }
  }

  // 3. Remove session-env file if exists
  const envFile = path.join(CLAUDE_DIR, 'session-env', `${sessionId}.json`);
  if (fs.existsSync(envFile)) {
    fs.unlinkSync(envFile);
    deleted.push('env file');
  }

  return deleted;
}

function getGitCommits(projectDir, fromTs, toTs) {
  try {
    if (!projectDir || !fs.existsSync(projectDir)) {
      return [];
    }

    const afterDate = new Date(fromTs).toISOString();
    const beforeDate = new Date(toTs).toISOString();

    const output = execSync(
      `git log --oneline --after="${afterDate}" --before="${beforeDate}"`,
      { cwd: projectDir, encoding: 'utf8', timeout: 5000, stdio: ['pipe', 'pipe', 'pipe'] }
    ).trim();

    if (!output) return [];

    return output.split('\n').map(line => {
      const spaceIdx = line.indexOf(' ');
      if (spaceIdx === -1) return { hash: line, message: '' };
      return {
        hash: line.slice(0, spaceIdx),
        message: line.slice(spaceIdx + 1),
      };
    });
  } catch {
    return [];
  }
}

function exportSessionMarkdown(sessionId, project) {
  const projectKey = project.replace(/[\/\.]/g, '-');
  const sessionFile = path.join(PROJECTS_DIR, projectKey, `${sessionId}.jsonl`);

  if (!fs.existsSync(sessionFile)) {
    return `# Session ${sessionId}\n\nSession file not found.\n`;
  }

  const lines = fs.readFileSync(sessionFile, 'utf8').split('\n').filter(Boolean);
  const parts = [`# Session ${sessionId}\n\n**Project:** ${project}\n`];

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === 'user' || entry.type === 'assistant') {
        const msg = entry.message || {};
        let content = msg.content || '';
        if (Array.isArray(content)) {
          content = content
            .map(b => (typeof b === 'string' ? b : (b.type === 'text' ? b.text : '')))
            .filter(Boolean)
            .join('\n');
        }
        const header = entry.type === 'user' ? '## User' : '## Assistant';
        parts.push(`\n${header}\n\n${content}\n`);
      }
    } catch {}
  }

  return parts.join('');
}

// ── Session Preview (first N messages, lightweight) ────────

function findSessionFile(sessionId, project) {
  // Try Claude projects dir
  if (project) {
    const projectKey = project.replace(/[\/\.]/g, '-');
    const claudeFile = path.join(PROJECTS_DIR, projectKey, `${sessionId}.jsonl`);
    if (fs.existsSync(claudeFile)) return { file: claudeFile, format: 'claude' };
  }

  // Try all Claude project dirs
  if (fs.existsSync(PROJECTS_DIR)) {
    for (const proj of fs.readdirSync(PROJECTS_DIR)) {
      const f = path.join(PROJECTS_DIR, proj, `${sessionId}.jsonl`);
      if (fs.existsSync(f)) return { file: f, format: 'claude' };
    }
  }

  // Try Codex sessions dir (walk year/month/day)
  const codexSessionsDir = path.join(CODEX_DIR, 'sessions');
  if (fs.existsSync(codexSessionsDir)) {
    const walkDir = (dir) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          const result = walkDir(full);
          if (result) return result;
        } else if (entry.name.includes(sessionId) && entry.name.endsWith('.jsonl')) {
          return full;
        }
      }
      return null;
    };
    const codexFile = walkDir(codexSessionsDir);
    if (codexFile) return { file: codexFile, format: 'codex' };
  }

  return null;
}

function isSystemMessage(text) {
  if (!text) return true;
  var t = text.trim();
  if (t === 'exit' || t === 'quit' || t === '/exit') return true;
  if (t.startsWith('<permissions')) return true;
  if (t.startsWith('<environment_context')) return true;
  if (t.startsWith('<collaboration_mode')) return true;
  if (t.startsWith('# AGENTS.md')) return true;
  if (t.startsWith('<INSTRUCTIONS>')) return true;
  // Codex developer role system prompts
  if (t.startsWith('You are Codex')) return true;
  if (t.startsWith('Filesystem sandboxing')) return true;
  return false;
}

function extractContent(raw) {
  if (!raw) return '';
  if (typeof raw === 'string') return raw;
  if (Array.isArray(raw)) {
    return raw
      .map(b => (typeof b === 'string' ? b : (b.text || b.input_text || '')))
      .filter(Boolean)
      .join('\n');
  }
  return String(raw);
}

function getSessionPreview(sessionId, project, limit) {
  limit = limit || 10;
  const found = findSessionFile(sessionId, project);
  if (!found) return [];

  const messages = [];
  const lines = fs.readFileSync(found.file, 'utf8').split('\n').filter(Boolean);

  for (const line of lines) {
    if (messages.length >= limit) break;
    try {
      const entry = JSON.parse(line);

      if (found.format === 'claude') {
        // Claude: {type: "user"|"assistant", message: {content: ...}}
        if (entry.type === 'user' || entry.type === 'assistant') {
          const content = extractContent((entry.message || {}).content);
          if (content) {
            messages.push({ role: entry.type, content: content.slice(0, 300) });
          }
        }
      } else {
        // Codex: {type: "response_item", payload: {role: "user"|"assistant", content: [...]}}
        if (entry.type === 'response_item' && entry.payload) {
          const role = entry.payload.role;
          if (role === 'user' || role === 'assistant') {
            const content = extractContent(entry.payload.content);
            // Skip system-like messages
            if (content && !isSystemMessage(content)) {
              messages.push({ role: role, content: content.slice(0, 300) });
            }
          }
        }
      }
    } catch {}
  }

  return messages;
}

// ── Full-text search index ─────────────────────────────────
//
// Built once on first search, then cached in memory.
// Each entry: { sessionId, texts: [{role, content}] }
// Total text is kept lowercase for fast substring matching.

let searchIndex = null;
let searchIndexBuiltAt = 0;
const INDEX_TTL = 60000; // rebuild every 60s

function buildSearchIndex(sessions) {
  const startMs = Date.now();
  const index = [];

  for (const s of sessions) {
    if (!s.has_detail) continue;

    const found = findSessionFile(s.id, s.project);
    if (!found) continue;

    try {
      const lines = fs.readFileSync(found.file, 'utf8').split('\n').filter(Boolean);
      const texts = [];

      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          let role, content;

          if (found.format === 'claude') {
            if (entry.type !== 'user' && entry.type !== 'assistant') continue;
            role = entry.type;
            content = extractContent((entry.message || {}).content);
          } else {
            if (entry.type !== 'response_item' || !entry.payload) continue;
            role = entry.payload.role;
            if (role !== 'user' && role !== 'assistant') continue;
            content = extractContent(entry.payload.content);
          }

          if (content && !isSystemMessage(content)) {
            texts.push({ role, content: content.slice(0, 500) });
          }
        } catch {}
      }

      if (texts.length > 0) {
        // Pre-compute lowercase full text for fast matching
        const fullText = texts.map(t => t.content).join(' ').toLowerCase();
        index.push({ sessionId: s.id, texts, fullText });
      }
    } catch {}
  }

  const elapsed = Date.now() - startMs;
  console.log(`  \x1b[2mSearch index: ${index.length} sessions, ${elapsed}ms\x1b[0m`);
  return index;
}

function getSearchIndex(sessions) {
  const now = Date.now();
  if (!searchIndex || (now - searchIndexBuiltAt) > INDEX_TTL) {
    searchIndex = buildSearchIndex(sessions);
    searchIndexBuiltAt = now;
  }
  return searchIndex;
}

function searchFullText(query, sessions) {
  if (!query || query.length < 2) return [];
  const q = query.toLowerCase();
  const index = getSearchIndex(sessions);
  const results = [];

  for (const entry of index) {
    if (entry.fullText.indexOf(q) === -1) continue;

    // Find matching messages with snippets
    const matches = [];
    for (const t of entry.texts) {
      if (matches.length >= 3) break;
      const idx = t.content.toLowerCase().indexOf(q);
      if (idx >= 0) {
        const start = Math.max(0, idx - 50);
        const end = Math.min(t.content.length, idx + q.length + 50);
        matches.push({
          role: t.role,
          snippet: (start > 0 ? '...' : '') + t.content.slice(start, end) + (end < t.content.length ? '...' : ''),
        });
      }
    }

    if (matches.length > 0) {
      results.push({ sessionId: entry.sessionId, matches });
    }
  }

  return results;
}

// ── Exports ────────────────────────────────────────────────

module.exports = {
  loadSessions,
  loadSessionDetail,
  deleteSession,
  getGitCommits,
  exportSessionMarkdown,
  getSessionPreview,
  searchFullText,
  CLAUDE_DIR,
  CODEX_DIR,
  HISTORY_FILE,
  PROJECTS_DIR,
};
