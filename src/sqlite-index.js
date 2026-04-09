// SQLite + FTS5 index for sessions, messages, and full-text search.
//
// Why SQLite: (1) codedash already shells to `sqlite3` CLI for opencode/kiro,
// zero new deps. (2) FTS5 is built into modern sqlite3 and is the best
// local full-text search engine available. (3) Persistent, mmap'd B-tree —
// billions of rows possible, queries in milliseconds.
//
// Schema:
//   sessions          one row per session (metadata + aggregated cost)
//   messages          one row per user/assistant message, chronological
//   messages_fts      FTS5 virtual table shadowing messages.content
//   files_seen        (path, mtime, size) for incremental ingest
//
// All ingest goes through SQL transactions. Queries avoid Node ↔ child_process
// overhead by using a single sqlite3 invocation per call.

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

const DB_DIR = path.join(os.homedir(), '.codedash', 'cache');
try { fs.mkdirSync(DB_DIR, { recursive: true }); } catch {}
const DB_FILE = path.join(DB_DIR, 'index.sqlite');

// ── sqlite3 CLI helpers ─────────────────────────────────────
// Query path stays sync via spawnSync (fast, small SQL). Write path (large
// batches) goes through async spawn so it doesn't block the event loop.

// Use sqlite3 -cmd to set busy_timeout before running the query. This sets
// it on the connection without producing extra JSON output rows.
const _CMD_BUSY = '.timeout 30000';

function _exec(sql, opts) {
  opts = opts || {};
  // sqlite3 CLI stops option parsing once it sees the database filename, so
  // all flags (including -json) must come BEFORE DB_FILE or they're treated
  // as part of the SQL input and silently ignored.
  const args = ['-cmd', _CMD_BUSY];
  if (opts.json) args.push('-json');
  args.push(DB_FILE, sql);
  const r = spawnSync('sqlite3', args, {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
    timeout: opts.timeout || 60000,
    windowsHide: true,
  });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error('sqlite3 exit ' + r.status + ': ' + r.stderr);
  return r.stdout || '';
}

function _execJson(sql, opts) {
  const out = _exec(sql, Object.assign({}, opts || {}, { json: true })).trim();
  if (!out) return [];
  try { return JSON.parse(out); } catch { return []; }
}

// Async variant: streams SQL to sqlite3 stdin without blocking the event loop.
// Returns a Promise<string> with stdout.
function _execAsync(sql, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    // Options must come BEFORE DB_FILE (see _exec comment)
    const args = ['-cmd', _CMD_BUSY];
    if (opts.json) args.push('-json');
    args.push(DB_FILE);
    const child = spawn('sqlite3', args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    let stdout = '';
    let stderr = '';
    let finished = false;
    const to = setTimeout(() => {
      if (!finished) {
        finished = true;
        try { child.kill('SIGKILL'); } catch {}
        reject(new Error('sqlite3 timeout'));
      }
    }, opts.timeout || 120000);

    child.stdout.on('data', d => { stdout += d.toString('utf8'); });
    child.stderr.on('data', d => { stderr += d.toString('utf8'); });
    child.on('error', e => { if (!finished) { finished = true; clearTimeout(to); reject(e); } });
    child.on('close', code => {
      if (finished) return;
      finished = true;
      clearTimeout(to);
      if (code !== 0) return reject(new Error('sqlite3 exit ' + code + ': ' + stderr));
      resolve(stdout);
    });
    // Write SQL to stdin and close
    try {
      child.stdin.write(sql);
      child.stdin.end();
    } catch (e) {
      if (!finished) { finished = true; clearTimeout(to); reject(e); }
    }
  });
}

// ── Schema ──────────────────────────────────────────────────

const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA synchronous  = NORMAL;
PRAGMA temp_store   = MEMORY;
PRAGMA mmap_size    = 268435456;
PRAGMA busy_timeout = 30000;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS sessions (
  id                  TEXT PRIMARY KEY,
  tool                TEXT NOT NULL,
  project             TEXT,
  project_short       TEXT,
  first_ts            REAL,
  last_ts             REAL,
  messages            INTEGER DEFAULT 0,
  user_messages       INTEGER DEFAULT 0,
  file_size           INTEGER DEFAULT 0,
  cost                REAL DEFAULT 0,
  input_tokens        INTEGER DEFAULT 0,
  output_tokens       INTEGER DEFAULT 0,
  cache_read_tokens   INTEGER DEFAULT 0,
  cache_create_tokens INTEGER DEFAULT 0,
  model               TEXT,
  first_message       TEXT,
  mcp_servers         TEXT,      -- JSON array
  skills              TEXT,      -- JSON array
  source_file         TEXT,
  source_mtime        REAL,
  source_size         INTEGER,
  indexed_at          INTEGER
);
CREATE INDEX IF NOT EXISTS idx_sessions_tool    ON sessions(tool);
CREATE INDEX IF NOT EXISTS idx_sessions_last_ts ON sessions(last_ts DESC);
CREATE INDEX IF NOT EXISTS idx_sessions_project ON sessions(project);

CREATE TABLE IF NOT EXISTS messages (
  rowid      INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  seq        INTEGER NOT NULL,
  role       TEXT NOT NULL,
  ts         REAL,
  content    TEXT,
  FOREIGN KEY (session_id) REFERENCES sessions(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);

CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
  content,
  session_id UNINDEXED,
  role       UNINDEXED,
  seq        UNINDEXED,
  tokenize = 'porter unicode61'
);

CREATE TABLE IF NOT EXISTS daily_stats (
  session_id TEXT NOT NULL,
  day        TEXT NOT NULL,
  messages   INTEGER DEFAULT 0,
  hours      REAL DEFAULT 0,
  tool       TEXT,
  PRIMARY KEY (session_id, day)
);
CREATE INDEX IF NOT EXISTS idx_daily_day ON daily_stats(day);

CREATE TABLE IF NOT EXISTS files_seen (
  path       TEXT PRIMARY KEY,
  mtime      REAL,
  size       INTEGER,
  session_id TEXT,
  indexed_at INTEGER
);

-- Persistent aggregate result cache (analytics, leaderboard, ...)
-- Keyed by query fingerprint; holds a single JSON blob row per kind.
CREATE TABLE IF NOT EXISTS aggregate_cache (
  kind         TEXT NOT NULL,    -- 'analytics' | 'leaderboard' | ...
  fingerprint  TEXT NOT NULL,    -- input hash (filters + data version)
  result_json  TEXT NOT NULL,
  computed_at  INTEGER NOT NULL,
  PRIMARY KEY (kind, fingerprint)
);
`;

let _schemaReady = false;
function ensureSchema() {
  if (_schemaReady) return;
  try {
    _exec(SCHEMA);
    _schemaReady = true;
  } catch (e) {
    throw new Error('Failed to init SQLite index: ' + e.message);
  }
}

// ── Incremental ingest ───────────────────────────────────────

function sqlEscape(s) {
  if (s === null || s === undefined) return 'NULL';
  return "'" + String(s).replace(/'/g, "''") + "'";
}

// Check if a file path is already indexed with matching mtime+size.
function isFileCurrent(filePath) {
  ensureSchema();
  let stat;
  try { stat = fs.statSync(filePath); } catch { return false; }
  const rows = _execJson(
    `SELECT mtime, size FROM files_seen WHERE path = ${sqlEscape(filePath)} LIMIT 1`
  );
  if (rows.length === 0) return false;
  return rows[0].mtime === stat.mtimeMs && rows[0].size === stat.size;
}

// Bulk version: load the entire files_seen map into memory in a single query.
// Used by the backfill loop to avoid an N×sync-SQL fanout.
function loadAllFilesSeen() {
  ensureSchema();
  const rows = _execJson(`SELECT path, mtime, size FROM files_seen`);
  const map = new Map();
  for (const r of rows) map.set(r.path, { mtime: r.mtime, size: r.size });
  return map;
}

// Bulk-index a batch of sessions + messages asynchronously.
// Builds a single transaction SQL blob, pipes to sqlite3 via async spawn.
// Returns a Promise that resolves when sqlite3 finishes writing.
function indexBatchAsync(batch) {
  if (!batch || batch.length === 0) return Promise.resolve();
  ensureSchema();

  const now = Date.now();
  const parts = ['BEGIN;'];

  for (const item of batch) {
    const s = item.session;
    if (!s || !s.id) continue;

    // Delete old rows for this session (re-ingest case)
    parts.push(`DELETE FROM sessions WHERE id = ${sqlEscape(s.id)};`);
    parts.push(`DELETE FROM messages WHERE session_id = ${sqlEscape(s.id)};`);
    parts.push(`DELETE FROM messages_fts WHERE session_id = ${sqlEscape(s.id)};`);
    parts.push(`DELETE FROM daily_stats WHERE session_id = ${sqlEscape(s.id)};`);

    // Insert session
    parts.push(
      `INSERT INTO sessions (id, tool, project, project_short, first_ts, last_ts, messages, user_messages, file_size, cost, input_tokens, output_tokens, cache_read_tokens, cache_create_tokens, model, first_message, mcp_servers, skills, source_file, source_mtime, source_size, indexed_at) VALUES (` +
      [
        sqlEscape(s.id),
        sqlEscape(s.tool || 'unknown'),
        sqlEscape(s.project || ''),
        sqlEscape(s.project_short || ''),
        s.first_ts || 0,
        s.last_ts || 0,
        s.messages || 0,
        s.user_messages || 0,
        s.file_size || 0,
        s.cost || 0,
        s.input_tokens || 0,
        s.output_tokens || 0,
        s.cache_read_tokens || 0,
        s.cache_create_tokens || 0,
        sqlEscape(s.model || ''),
        sqlEscape((s.first_message || '').slice(0, 500)),
        sqlEscape(JSON.stringify(s.mcp_servers || [])),
        sqlEscape(JSON.stringify(s.skills || [])),
        sqlEscape(item.filePath || ''),
        s.source_mtime || 0,
        s.source_size || 0,
        now,
      ].join(', ') + ');'
    );

    // Messages + FTS
    const msgs = item.messages || [];
    for (const m of msgs) {
      if (!m.content) continue;
      const esc = sqlEscape(m.content.slice(0, 8000));
      parts.push(
        `INSERT INTO messages (session_id, seq, role, ts, content) VALUES (` +
        [
          sqlEscape(s.id),
          m.seq || 0,
          sqlEscape(m.role || ''),
          m.ts || 0,
          esc,
        ].join(', ') + ');'
      );
      parts.push(
        `INSERT INTO messages_fts (content, session_id, role, seq) VALUES (` +
        [esc, sqlEscape(s.id), sqlEscape(m.role || ''), m.seq || 0].join(', ') + ');'
      );
    }

    // Daily breakdown
    const daily = item.daily || {};
    for (const day in daily) {
      const d = daily[day];
      parts.push(
        `INSERT INTO daily_stats (session_id, day, messages, hours, tool) VALUES (` +
        [
          sqlEscape(s.id),
          sqlEscape(day),
          d.messages || 0,
          d.hours || 0,
          sqlEscape(s.tool || 'unknown'),
        ].join(', ') + ');'
      );
    }

    // Record file stamp
    if (item.filePath && s.source_mtime && s.source_size) {
      parts.push(
        `INSERT OR REPLACE INTO files_seen (path, mtime, size, session_id, indexed_at) VALUES (` +
        [
          sqlEscape(item.filePath),
          s.source_mtime,
          s.source_size,
          sqlEscape(s.id),
          now,
        ].join(', ') + ');'
      );
    }
  }

  parts.push('COMMIT;');
  return _execAsync(parts.join('\n'), { timeout: 120000 }).catch((e) => {
    // Try to rollback via sync exec (fire and forget)
    try { _exec('ROLLBACK;'); } catch {}
    throw e;
  });
}

// Alias for backward compat — returns the promise.
const indexBatch = indexBatchAsync;

// ── Query API ───────────────────────────────────────────────

function search(query, limit) {
  ensureSchema();
  if (!query || query.trim().length < 2) return [];
  limit = Math.max(1, Math.min(500, limit || 100));

  // Escape FTS5 special chars — we treat the input as a phrase
  const phrase = '"' + query.replace(/"/g, '""') + '"';
  const sql = `
    SELECT session_id, role, seq,
      snippet(messages_fts, 0, '<<', '>>', '...', 20) AS snippet
    FROM messages_fts
    WHERE content MATCH ${sqlEscape(phrase)}
    ORDER BY rank
    LIMIT ${limit};
  `;
  try {
    return _execJson(sql, { timeout: 15000 });
  } catch {
    return [];
  }
}

function getSessionStats() {
  ensureSchema();
  const rows = _execJson(`
    SELECT
      COUNT(*) AS session_count,
      SUM(messages) AS total_messages,
      SUM(user_messages) AS total_user_messages,
      SUM(cost) AS total_cost,
      SUM(input_tokens + output_tokens + cache_read_tokens + cache_create_tokens) AS total_tokens
    FROM sessions;
  `);
  return rows[0] || {};
}

function getDailyStats(limit) {
  ensureSchema();
  limit = limit || 30;
  return _execJson(`
    SELECT day,
           SUM(messages) AS messages,
           SUM(hours) AS hours,
           COUNT(DISTINCT session_id) AS sessions
    FROM daily_stats
    GROUP BY day
    ORDER BY day DESC
    LIMIT ${limit};
  `);
}

function getCountByTool() {
  ensureSchema();
  return _execJson(`SELECT tool, COUNT(*) AS n FROM sessions GROUP BY tool ORDER BY n DESC;`);
}

// ── Aggregate result cache ──────────────────────────────────
// Persistent cache for pre-computed analytics/leaderboard results.
// The caller decides the fingerprint (e.g. max(session.last_ts) + session
// count + filter). On cache hit: O(1) SQL read, milliseconds.

function getAggregateCache(kind, fingerprint) {
  ensureSchema();
  const rows = _execJson(
    `SELECT result_json, computed_at FROM aggregate_cache WHERE kind = ${sqlEscape(kind)} AND fingerprint = ${sqlEscape(fingerprint)} LIMIT 1`
  );
  if (rows.length === 0) return null;
  try {
    return {
      result: JSON.parse(rows[0].result_json),
      computedAt: rows[0].computed_at,
    };
  } catch {
    return null;
  }
}

async function getAggregateCacheAsync(kind, fingerprint) {
  ensureSchema();
  const out = await _execAsync(
    `SELECT result_json, computed_at FROM aggregate_cache WHERE kind = ${sqlEscape(kind)} AND fingerprint = ${sqlEscape(fingerprint)} LIMIT 1`,
    { json: true, timeout: 10000 }
  );
  let rows;
  try { rows = JSON.parse(out.trim() || '[]'); } catch { return null; }
  if (!rows || rows.length === 0) return null;
  try {
    return {
      result: JSON.parse(rows[0].result_json),
      computedAt: rows[0].computed_at,
    };
  } catch {
    return null;
  }
}

async function setAggregateCache(kind, fingerprint, result) {
  ensureSchema();
  const json = JSON.stringify(result);
  const sql =
    `DELETE FROM aggregate_cache WHERE kind = ${sqlEscape(kind)};\n` +  // keep only latest per kind
    `INSERT INTO aggregate_cache (kind, fingerprint, result_json, computed_at) VALUES (` +
    [sqlEscape(kind), sqlEscape(fingerprint), sqlEscape(json), Date.now()].join(', ') +
    `);`;
  try { await _execAsync(sql, { timeout: 30000 }); } catch {}
}

function getIndexStatus() {
  ensureSchema();
  const sess = _execJson(`SELECT COUNT(*) AS n FROM sessions`);
  const msgs = _execJson(`SELECT COUNT(*) AS n FROM messages`);
  const files = _execJson(`SELECT COUNT(*) AS n FROM files_seen`);
  let size = 0;
  try { size = fs.statSync(DB_FILE).size; } catch {}
  return {
    sessions: (sess[0] || {}).n || 0,
    messages: (msgs[0] || {}).n || 0,
    files: (files[0] || {}).n || 0,
    db_bytes: size,
    db_path: DB_FILE,
  };
}

module.exports = {
  DB_FILE,
  ensureSchema,
  isFileCurrent,
  indexBatch,
  indexBatchAsync,
  loadAllFilesSeen,
  search,
  getSessionStats,
  getDailyStats,
  getCountByTool,
  getIndexStatus,
  getAggregateCache,
  getAggregateCacheAsync,
  setAggregateCache,
  _exec,
  _execAsync,
  _execJson,
};
