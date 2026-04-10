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

// ── Provider 2: API (OpenAI-compatible) ──────────────────────
async function embedAPI(texts) {
  const cfg = loadConfig();
  if (!cfg.api_base_url || !cfg.api_key) throw new Error('API embedding not configured');
  if (!Array.isArray(texts)) texts = [texts];

  const url = new URL(cfg.api_base_url);
  const body = JSON.stringify({
    model: cfg.api_model || 'text-embedding-3-small',
    input: texts,
    encoding_format: 'float',
  });

  return new Promise((resolve, reject) => {
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + cfg.api_key,
        'Accept': 'application/json',
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
            reject(new Error('Unexpected API response'));
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
  // Try API
  try {
    const cfg = loadConfig();
    if (cfg.api_base_url && cfg.api_key) {
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
