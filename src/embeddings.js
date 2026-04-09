// Vector search via sentence embeddings (optional — requires @huggingface/transformers).
//
// Uses all-MiniLM-L6-v2 (384-dim, ~23 MB ONNX) for semantic similarity search
// across session first_messages and message content. Falls back gracefully if
// the npm package isn't installed.
//
// Architecture:
//   1. Pre-compute embeddings for each session's first_message during SQLite
//      backfill and store them as JSON arrays in the `session_embeddings` table.
//   2. On search: embed the query, load candidate embeddings from SQLite,
//      compute cosine similarity, return top-K.
//   3. Hybrid mode: FTS5 for recall (top 200) → vector re-rank for precision.

const { spawnSync } = require('child_process');
const path = require('path');
const os = require('os');

// ── Lazy-load transformers.js ──────────────────────────────
let _pipeline = null;
let _extractor = null;
let _loading = false;
let _loadPromise = null;
let _available = null; // null = unknown, true/false after first check

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const EMBEDDING_DIM = 384;

async function _ensureModel() {
  if (_extractor) return _extractor;
  if (_loadPromise) return _loadPromise;

  _loadPromise = (async () => {
    try {
      const { pipeline } = await import('@huggingface/transformers');
      _extractor = await pipeline('feature-extraction', MODEL_ID, {
        device: 'cpu',
        dtype: 'fp32',
      });
      _available = true;
      return _extractor;
    } catch (e) {
      _available = false;
      _loadPromise = null;
      throw new Error('Vector search unavailable: ' + e.message);
    }
  })();

  return _loadPromise;
}

function isAvailable() {
  if (_available !== null) return _available;
  try {
    require.resolve('@huggingface/transformers');
    _available = true; // module exists, model may still need download
    return true;
  } catch {
    _available = false;
    return false;
  }
}

// ── Embedding computation ───────────────────────────────────

async function embed(text) {
  const extractor = await _ensureModel();
  const result = await extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(result.data);
}

async function embedBatch(texts, batchSize) {
  batchSize = batchSize || 32;
  const extractor = await _ensureModel();
  const all = [];
  for (let i = 0; i < texts.length; i += batchSize) {
    const batch = texts.slice(i, i + batchSize);
    const results = await extractor(batch, { pooling: 'mean', normalize: true });
    // results.data is a flat Float32Array of shape [batch, dim]
    for (let j = 0; j < batch.length; j++) {
      const start = j * EMBEDDING_DIM;
      all.push(Array.from(results.data.slice(start, start + EMBEDDING_DIM)));
    }
  }
  return all;
}

// ── Cosine similarity ───────────────────────────────────────

function cosineSimilarity(a, b) {
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  // Vectors are already L2-normalized by the pipeline, so dot = cosine
  return dot;
}

// ── SQLite storage ──────────────────────────────────────────

function _sqliteIndex() {
  return require('./sqlite-index');
}

function ensureEmbeddingTable() {
  const sq = _sqliteIndex();
  sq._exec(`
    CREATE TABLE IF NOT EXISTS session_embeddings (
      session_id TEXT PRIMARY KEY,
      embedding  TEXT NOT NULL,
      model      TEXT NOT NULL,
      computed_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_emb_model ON session_embeddings(model);
  `);
}

function storeEmbeddings(rows) {
  // rows: [{session_id, embedding (array), model}]
  if (!rows || rows.length === 0) return;
  const sq = _sqliteIndex();
  ensureEmbeddingTable();

  const now = Date.now();
  const parts = ['BEGIN;'];
  for (const r of rows) {
    const sid = r.session_id.replace(/'/g, "''");
    const emb = JSON.stringify(r.embedding);
    const model = (r.model || MODEL_ID).replace(/'/g, "''");
    parts.push(`INSERT OR REPLACE INTO session_embeddings (session_id, embedding, model, computed_at) VALUES ('${sid}', '${emb}', '${model}', ${now});`);
  }
  parts.push('COMMIT;');
  sq._exec(parts.join('\n'), { timeout: 60000 });
}

function loadAllEmbeddings() {
  const sq = _sqliteIndex();
  ensureEmbeddingTable();
  const rows = sq._execJson(`SELECT session_id, embedding FROM session_embeddings WHERE model = '${MODEL_ID.replace(/'/g, "''")}'`);
  return rows.map(r => ({
    session_id: r.session_id,
    embedding: JSON.parse(r.embedding),
  }));
}

function getEmbeddingCount() {
  const sq = _sqliteIndex();
  ensureEmbeddingTable();
  const rows = sq._execJson(`SELECT COUNT(*) AS n FROM session_embeddings`);
  return (rows[0] || {}).n || 0;
}

// ── Semantic search ─────────────────────────────────────────

async function semanticSearch(query, limit) {
  limit = limit || 20;
  const queryEmb = await embed(query);
  const all = loadAllEmbeddings();

  if (all.length === 0) return [];

  // Compute similarities
  const scored = all.map(r => ({
    session_id: r.session_id,
    score: cosineSimilarity(queryEmb, r.embedding),
  }));

  // Sort by descending similarity, return top-K
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, limit);
}

// ── Hybrid search: FTS5 recall → vector re-rank ─────────────

async function hybridSearch(query, limit) {
  limit = limit || 20;
  const sq = _sqliteIndex();

  // Phase 1: FTS5 text search for recall (broad set)
  const ftsResults = sq.search(query, 200);

  if (!isAvailable() || ftsResults.length === 0) {
    // No vector model — return FTS5 results as-is
    return ftsResults.map(r => ({ ...r, search_type: 'text' }));
  }

  // Phase 2: embed query
  let queryEmb;
  try {
    queryEmb = await embed(query);
  } catch {
    return ftsResults.map(r => ({ ...r, search_type: 'text' }));
  }

  // Phase 3: load embeddings for FTS5-matched sessions
  const ftsSessionIds = [...new Set(ftsResults.map(r => r.session_id))];
  const all = loadAllEmbeddings();
  const embMap = new Map(all.map(r => [r.session_id, r.embedding]));

  // Phase 4: score and re-rank
  const scored = ftsSessionIds.map(sid => {
    const emb = embMap.get(sid);
    const similarity = emb ? cosineSimilarity(queryEmb, emb) : 0;
    const ftsSnippets = ftsResults.filter(r => r.session_id === sid);
    return {
      session_id: sid,
      similarity,
      fts_matches: ftsSnippets.length,
      // Combined score: FTS match count + semantic similarity
      combined_score: (ftsSnippets.length * 0.3) + (similarity * 0.7),
      matches: ftsSnippets.slice(0, 3).map(r => ({
        role: r.role,
        snippet: (r.snippet || '').replace(/<</g, '').replace(/>>/g, ''),
      })),
      search_type: emb ? 'hybrid' : 'text',
    };
  });

  scored.sort((a, b) => b.combined_score - a.combined_score);
  return scored.slice(0, limit);
}

module.exports = {
  isAvailable,
  embed,
  embedBatch,
  cosineSimilarity,
  ensureEmbeddingTable,
  storeEmbeddings,
  loadAllEmbeddings,
  getEmbeddingCount,
  semanticSearch,
  hybridSearch,
  EMBEDDING_DIM,
  MODEL_ID,
};
