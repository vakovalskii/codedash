// Memento-style 6-stage hybrid RAG search pipeline.
//
// Based on the Memento paper (arXiv 2603.18743) retrieval pipeline (Figure 8):
//   Stage 1: FTS5 sparse recall (top-20)
//   Stage 2: Dense embedding recall (top-20)
//   Stage 3: Reciprocal Rank Fusion (k=60)
//   Stage 4: Utility reranking (per-entry success/failure rate)
//   Stage 5: Threshold filter
//   Stage 6: Top-k
//
// Provider chain (matches codex-git kb_embedding_store.rs):
//   1. Local: MiniLM-L6-v2 (default, 384d, 23MB) or Qwen3-Embedding-0.6B (1024d)
//   2. API: OpenAI-compatible /embeddings endpoint (GitHub Models, Copilot proxy, etc)
//   3. TF-IDF fallback: bag-of-words 256-dim hashed vectors (always available)
//
// Weights from Memento paper results:
//   BM25 Recall@1 = 0.32 → weight 0.3
//   Embedding Recall@1 = 0.54 → weight 0.7
//   Utility reranking: final = rrf * (0.7 + 0.3 * utility_rate)

const https = require('https');
const http = require('http');
const path = require('path');
const os = require('os');
const fs = require('fs');

// ── Constants (Memento paper) ─────────────────────────────────
const RRF_K = 60;                // Standard RRF smoothing (Cormack et al. 2009)
const STAGE_CANDIDATE_K = 20;    // Candidates per retrieval stage
const BM25_WEIGHT = 0.3;         // Weaker lexical signal
const EMBEDDING_WEIGHT = 0.7;    // Stronger dense signal
const UTILITY_BASE = 0.7;        // Minimum influence even for zero-utility
const UTILITY_SCALE = 0.3;       // Scale factor for utility rate
const TFIDF_DIM = 256;           // TF-IDF fallback bucket count

// ── Model configuration ──────────────────────────────────────
const MODELS = {
  'minilm': {
    id: 'Xenova/all-MiniLM-L6-v2',
    dim: 384,
    description: 'Fast, English-optimized (23MB)',
  },
  'qwen3': {
    id: 'onnx-community/Qwen3-Embedding-0.6B-ONNX',
    dim: 1024,
    description: 'Best quality, multilingual (600MB)',
  },
};

// Config file at ~/.codedash/embedding-config.json
const CONFIG_FILE = path.join(os.homedir(), '.codedash', 'embedding-config.json');

function loadConfig() {
  try {
    if (fs.existsSync(CONFIG_FILE)) return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  } catch {}
  return {};
}

function getModelId() {
  const cfg = loadConfig();
  const key = cfg.model || 'minilm';
  return (MODELS[key] || MODELS.minilm).id;
}

function getModelDim() {
  const cfg = loadConfig();
  const key = cfg.model || 'minilm';
  return (MODELS[key] || MODELS.minilm).dim;
}

// ── Provider 1: Local (transformers.js ONNX) ─────────────────
let _extractor = null;
let _loadPromise = null;
let _localAvailable = null;

async function _ensureLocalModel() {
  if (_extractor) return _extractor;
  if (_loadPromise) return _loadPromise;
  _loadPromise = (async () => {
    const { pipeline } = await import('@huggingface/transformers');
    _extractor = await pipeline('feature-extraction', getModelId(), {
      device: 'cpu', dtype: 'fp32',
    });
    _localAvailable = true;
    return _extractor;
  })();
  return _loadPromise;
}

async function embedLocal(texts) {
  const extractor = await _ensureLocalModel();
  const dim = getModelDim();
  if (!Array.isArray(texts)) texts = [texts];
  const results = [];
  // Process in batches of 32
  for (let i = 0; i < texts.length; i += 32) {
    const batch = texts.slice(i, i + 32);
    const out = await extractor(batch, { pooling: 'mean', normalize: true });
    for (let j = 0; j < batch.length; j++) {
      const start = j * dim;
      results.push(Array.from(out.data.slice(start, start + dim)));
    }
  }
  return results;
}

// ── Copilot token exchange (for automatic API embeddings) ────
// Reads GitHub Copilot OAuth credentials and exchanges for a
// short-lived session token, exactly like copilot-client.js does
// for chat completions.

const COPILOT_TOKEN_ENDPOINT = 'https://api.github.com/copilot_internal/v2/token';
const COPILOT_DEFAULT_API_BASE = 'https://api.individual.githubcopilot.com';
const COPILOT_USER_AGENT = `copilot/1.0.14 (client/github/cli ${process.platform} v24.11.1) term/${process.env.TERM_PROGRAM || 'xterm'}`;
const COPILOT_TOKEN_REFRESH_MARGIN_SEC = 60;

let _copilotSessionToken = null;
let _copilotSessionExpiresAt = 0;
let _copilotApiBase = COPILOT_DEFAULT_API_BASE;

/**
 * Load the Copilot OAuth token from known credential locations.
 * @returns {string|null} The gho_... token, or null
 */
function _loadCopilotOAuthToken() {
  // 1. ~/.copilot/auth/credential.json
  try {
    const credPath = path.join(os.homedir(), '.copilot', 'auth', 'credential.json');
    if (fs.existsSync(credPath)) {
      const data = JSON.parse(fs.readFileSync(credPath, 'utf8'));
      if (data.token && typeof data.token === 'string' && data.token.length > 0) {
        return data.token;
      }
    }
  } catch (_) {}
  // 2. ~/.config/github-copilot/apps.json (legacy VS Code extension)
  try {
    const appsPath = path.join(os.homedir(), '.config', 'github-copilot', 'apps.json');
    if (fs.existsSync(appsPath)) {
      const data = JSON.parse(fs.readFileSync(appsPath, 'utf8'));
      for (const key of Object.keys(data)) {
        if (key.startsWith('github.com') && data[key] && data[key].oauth_token) {
          return data[key].oauth_token;
        }
      }
    }
  } catch (_) {}
  return null;
}

/**
 * Exchange OAuth token for a short-lived Copilot session token.
 * Caches result and refreshes 60s before expiry.
 * @returns {Promise<{token: string, api_base: string}>}
 */
async function _ensureCopilotSession() {
  const now = Math.floor(Date.now() / 1000);
  if (_copilotSessionToken && _copilotSessionExpiresAt > now + COPILOT_TOKEN_REFRESH_MARGIN_SEC) {
    return { token: _copilotSessionToken, api_base: _copilotApiBase };
  }

  const oauthToken = _loadCopilotOAuthToken();
  if (!oauthToken) throw new Error('No Copilot OAuth token found');

  const result = await new Promise((resolve, reject) => {
    const parsed = new URL(COPILOT_TOKEN_ENDPOINT);
    const req = https.request({
      hostname: parsed.hostname,
      port: 443,
      path: parsed.pathname + parsed.search,
      method: 'GET',
      headers: {
        'User-Agent': COPILOT_USER_AGENT,
        'Accept': 'application/json',
        'Authorization': 'token ' + oauthToken,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode !== 200) {
          return reject(new Error('Copilot token exchange failed (HTTP ' + res.statusCode + '): ' + body));
        }
        try { resolve(JSON.parse(body)); } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(15000, () => { req.destroy(); reject(new Error('Copilot token exchange timeout')); });
    req.end();
  });

  if (!result.token) throw new Error('Copilot token exchange returned empty token');

  _copilotSessionToken = result.token;
  _copilotSessionExpiresAt = result.expires_at || 0;
  _copilotApiBase = (result.endpoints && result.endpoints.api) || COPILOT_DEFAULT_API_BASE;

  return { token: _copilotSessionToken, api_base: _copilotApiBase };
}

/**
 * Check if Copilot credentials exist on disk (sync, no network).
 * @returns {boolean}
 */
function _isCopilotAvailable() {
  return _loadCopilotOAuthToken() !== null;
}

// ── Provider 2: API (OpenAI-compatible) ──────────────────────
// Priority: 1) Copilot auto-discovery  2) Manual config fallback
async function embedAPI(texts) {
  if (!Array.isArray(texts)) texts = [texts];

  // ── Try Copilot first ──
  if (_isCopilotAvailable()) {
    try {
      const session = await _ensureCopilotSession();
      return await _callEmbeddingsEndpoint(
        session.api_base + '/embeddings',
        session.token,
        'text-embedding-3-small',
        texts,
        { 'Copilot-Integration-Id': 'codedash', 'Editor-Version': 'codedash/1.0' }
      );
    } catch (copilotErr) {
      // Copilot failed — fall through to manual config
      const cfg = loadConfig();
      if (!cfg.api_base_url || !cfg.api_key) {
        throw new Error('Copilot embeddings failed: ' + copilotErr.message);
      }
    }
  }

  // ── Fallback: manual config (api_base_url + api_key) ──
  const cfg = loadConfig();
  if (!cfg.api_base_url || !cfg.api_key) throw new Error('API embedding not configured (no Copilot credentials and no manual config)');

  return await _callEmbeddingsEndpoint(
    cfg.api_base_url,
    cfg.api_key,
    cfg.api_model || 'text-embedding-3-small',
    texts,
    {}
  );
}

/**
 * Call an OpenAI-compatible /embeddings endpoint.
 * @param {string} endpointUrl - Full URL (e.g. "https://api.../embeddings")
 * @param {string} token - Bearer token
 * @param {string} model - Model name
 * @param {string[]} texts - Input texts
 * @param {Object} extraHeaders - Additional headers
 * @returns {Promise<number[][]>}
 */
function _callEmbeddingsEndpoint(endpointUrl, token, model, texts, extraHeaders) {
  const url = new URL(endpointUrl);
  const body = JSON.stringify({
    model,
    input: texts,
    encoding_format: 'float',
  });

  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + token,
        'Accept': 'application/json',
        ...extraHeaders,
      },
      timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          if (parsed.data && Array.isArray(parsed.data)) {
            resolve(parsed.data.map(d => d.embedding));
          } else {
            reject(new Error('Unexpected API response: ' + (data.slice(0, 200))));
          }
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('API timeout')); });
    req.write(body);
    req.end();
  });
}

// ── Provider 3: TF-IDF fallback (always available) ───────────
function tokenize(text) {
  return (text || '').toLowerCase()
    .replace(/[^a-zа-яёüöäß0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1);
}

function embedTFIDF(texts) {
  if (!Array.isArray(texts)) texts = [texts];
  return texts.map(text => {
    const tokens = tokenize(text);
    const freq = {};
    for (const t of tokens) {
      const bucket = hashStr(t) % TFIDF_DIM;
      freq[bucket] = (freq[bucket] || 0) + 1;
    }
    // TF vector + L2 normalize
    const vec = new Float64Array(TFIDF_DIM);
    for (const [b, f] of Object.entries(freq)) {
      vec[parseInt(b)] = f; // simple TF, no IDF (single-doc context)
    }
    let norm = 0;
    for (let i = 0; i < TFIDF_DIM; i++) norm += vec[i] * vec[i];
    norm = Math.sqrt(norm) || 1;
    return Array.from(vec.map(v => v / norm));
  });
}

function hashStr(s) {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  return h;
}

// ── Provider chain ───────────────────────────────────────────
async function embed(texts) {
  if (!Array.isArray(texts)) texts = [texts];
  // Try local first
  try {
    if (_localAvailable !== false) {
      return await embedLocal(texts);
    }
  } catch {}
  // Try API (Copilot auto-discovery or manual config)
  try {
    const cfg = loadConfig();
    if (_isCopilotAvailable() || (cfg.api_base_url && cfg.api_key)) {
      return await embedAPI(texts);
    }
  } catch {}
  // TF-IDF fallback
  return embedTFIDF(texts);
}

function isAvailable() {
  try {
    require.resolve('@huggingface/transformers');
    return true;
  } catch {
    if (_isCopilotAvailable()) return true;
    const cfg = loadConfig();
    return !!(cfg.api_base_url && cfg.api_key);
  }
}

// ── Cosine similarity ────────────────────────────────────────
function cosineSimilarity(a, b) {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot; // Already L2-normalized
}

// ── Reciprocal Rank Fusion (Cormack et al. 2009) ─────────────
function reciprocalRankFusion(bm25Ranked, embeddingRanked, bm25Weight, embWeight) {
  const scores = new Map();
  // Graceful degradation
  const hasBM25 = bm25Ranked.length > 0;
  const hasEmb = embeddingRanked.length > 0;
  if (!hasBM25 && !hasEmb) return [];
  const effBM25 = hasBM25 && hasEmb ? bm25Weight : hasBM25 ? 1.0 : 0.0;
  const effEmb = hasBM25 && hasEmb ? embWeight : hasEmb ? 1.0 : 0.0;

  for (let rank = 0; rank < bm25Ranked.length; rank++) {
    const id = bm25Ranked[rank].id;
    scores.set(id, (scores.get(id) || 0) + effBM25 / (RRF_K + rank + 1));
  }
  for (let rank = 0; rank < embeddingRanked.length; rank++) {
    const id = embeddingRanked[rank].id;
    scores.set(id, (scores.get(id) || 0) + effEmb / (RRF_K + rank + 1));
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, rrf_score: score }))
    .sort((a, b) => b.rrf_score - a.rrf_score);
}

// ── Utility tracker (SQLite-backed) ──────────────────────────
function _sqliteIndex() { return require('./sqlite-index'); }

function ensureTables() {
  const sq = _sqliteIndex();
  sq._exec(`
    CREATE TABLE IF NOT EXISTS session_embeddings (
      session_id TEXT PRIMARY KEY,
      embedding TEXT NOT NULL,
      model TEXT NOT NULL,
      provider TEXT DEFAULT 'local',
      computed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_emb_model ON session_embeddings(model);

    CREATE TABLE IF NOT EXISTS search_utility (
      session_id TEXT NOT NULL,
      query_hash TEXT NOT NULL,
      outcome TEXT NOT NULL,
      ts INTEGER NOT NULL,
      PRIMARY KEY (session_id, query_hash)
    );
  `);
}

function recordUtility(sessionId, queryHash, outcome) {
  // outcome: 'click' | 'expand' | 'ignore'
  try {
    const sq = _sqliteIndex();
    const esc = (s) => "'" + String(s).replace(/'/g, "''") + "'";
    sq._exec(`INSERT OR REPLACE INTO search_utility (session_id, query_hash, outcome, ts) VALUES (${esc(sessionId)}, ${esc(queryHash)}, ${esc(outcome)}, ${Date.now()});`);
  } catch {}
}

function getUtilityRate(sessionId) {
  try {
    const sq = _sqliteIndex();
    const esc = (s) => "'" + String(s).replace(/'/g, "''") + "'";
    const rows = sq._execJson(`SELECT outcome, COUNT(*) AS n FROM search_utility WHERE session_id = ${esc(sessionId)} GROUP BY outcome`);
    let positive = 0, total = 0;
    for (const r of rows) {
      total += r.n;
      if (r.outcome === 'click' || r.outcome === 'expand') positive += r.n;
    }
    return total > 0 ? positive / total : 0.5; // default 0.5 for unknown
  } catch { return 0.5; }
}

// ── Embedding storage ────────────────────────────────────────
function storeEmbeddings(rows) {
  if (!rows || rows.length === 0) return;
  const sq = _sqliteIndex();
  ensureTables();
  const now = Date.now();
  const parts = ['BEGIN;'];
  for (const r of rows) {
    const sid = r.session_id.replace(/'/g, "''");
    const emb = JSON.stringify(r.embedding);
    const model = (r.model || getModelId()).replace(/'/g, "''");
    const provider = (r.provider || 'local').replace(/'/g, "''");
    parts.push(`INSERT OR REPLACE INTO session_embeddings (session_id, embedding, model, provider, computed_at) VALUES ('${sid}', '${emb}', '${model}', '${provider}', ${now});`);
  }
  parts.push('COMMIT;');
  sq._exec(parts.join('\n'), { timeout: 60000 });
}

function loadAllEmbeddings() {
  const sq = _sqliteIndex();
  ensureTables();
  const rows = sq._execJson(`SELECT session_id, embedding FROM session_embeddings`);
  return rows.map(r => ({
    session_id: r.session_id,
    embedding: JSON.parse(r.embedding),
  }));
}

function getEmbeddingCount() {
  const sq = _sqliteIndex();
  ensureTables();
  const rows = sq._execJson(`SELECT COUNT(*) AS n FROM session_embeddings`);
  return (rows[0] || {}).n || 0;
}

// ── 6-Stage Memento Search Pipeline ──────────────────────────

async function hybridSearch(query, limit) {
  limit = limit || 20;
  const sq = _sqliteIndex();

  // ── Stage 1: FTS5 sparse recall (top-20) ──
  const ftsResults = sq.search(query, STAGE_CANDIDATE_K);
  const ftsRanked = ftsResults.map(r => ({
    id: r.session_id,
    bm25_score: 1.0, // FTS5 doesn't expose raw BM25, use rank position
    ...r,
  }));

  // ── Stage 2: Dense embedding recall (top-20) ──
  let embRanked = [];
  try {
    const queryEmb = (await embed(query))[0];
    const all = loadAllEmbeddings();
    if (all.length > 0) {
      const scored = all.map(r => ({
        id: r.session_id,
        emb_score: cosineSimilarity(queryEmb, r.embedding),
      }));
      scored.sort((a, b) => b.emb_score - a.emb_score);
      embRanked = scored.slice(0, STAGE_CANDIDATE_K);
    }
  } catch {}

  // ── Stage 3: Reciprocal Rank Fusion (k=60) ──
  const fused = reciprocalRankFusion(ftsRanked, embRanked, BM25_WEIGHT, EMBEDDING_WEIGHT);

  // Build lookup maps
  const ftsMap = new Map(ftsResults.map(r => [r.session_id, r]));
  const embMap = new Map(embRanked.map(r => [r.id, r.emb_score]));

  // ── Stage 4: Utility reranking ──
  const reranked = fused.map(item => {
    const utilityRate = getUtilityRate(item.id);
    const multiplier = UTILITY_BASE + UTILITY_SCALE * utilityRate;
    return {
      ...item,
      utility_rate: utilityRate,
      fused_score: item.rrf_score * multiplier,
    };
  });
  reranked.sort((a, b) => b.fused_score - a.fused_score);

  // ── Stage 5: Threshold filter ──
  const MIN_SCORE = 0.0001;

  // ── Stage 6: Top-k with enrichment ──
  const results = [];
  for (const item of reranked) {
    if (item.fused_score < MIN_SCORE) continue;
    if (results.length >= limit) break;

    const fts = ftsMap.get(item.id);
    const embScore = embMap.get(item.id) || 0;

    results.push({
      session_id: item.id,
      fused_score: item.fused_score,
      rrf_score: item.rrf_score,
      bm25_rank: ftsRanked.findIndex(r => r.id === item.id),
      embedding_score: embScore,
      utility_rate: item.utility_rate,
      search_type: fts && embScore > 0 ? 'hybrid' : fts ? 'text' : 'semantic',
      matches: fts ? [{
        role: fts.role || 'unknown',
        snippet: (fts.snippet || '').replace(/<</g, '').replace(/>>/g, ''),
      }] : [],
    });
  }

  return results;
}

// Pure semantic search (no FTS5)
async function semanticSearch(query, limit) {
  limit = limit || 20;
  const queryEmb = (await embed(query))[0];
  const all = loadAllEmbeddings();
  if (all.length === 0) return [];
  const scored = all.map(r => ({
    session_id: r.session_id,
    score: cosineSimilarity(queryEmb, r.embedding),
  }));
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// Batch embed for backfill
async function embedBatch(texts, batchSize) {
  return embed(Array.isArray(texts) ? texts : [texts]);
}

module.exports = {
  // Config
  MODELS,
  loadConfig,
  getModelId,
  getModelDim,
  // Provider chain
  embed,
  embedLocal,
  embedAPI,
  embedTFIDF,
  isAvailable,
  // Search pipeline
  hybridSearch,
  semanticSearch,
  reciprocalRankFusion,
  cosineSimilarity,
  // Storage
  ensureTables,
  storeEmbeddings,
  loadAllEmbeddings,
  getEmbeddingCount,
  embedBatch,
  // Utility tracker
  recordUtility,
  getUtilityRate,
  // Constants
  EMBEDDING_DIM: 384, // default, actual may vary by model
  MODEL_ID: 'configurable', // use getModelId()
  RRF_K,
  BM25_WEIGHT,
  EMBEDDING_WEIGHT,
};
