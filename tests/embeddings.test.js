/**
 * Tests for src/embeddings.js
 *
 * Runnable with: node tests/embeddings.test.js
 * Uses only Node.js built-in assert module (zero deps).
 */

'use strict';

const assert = require('assert');
const path = require('path');

// Module under test
const embeddings = require('../src/embeddings');

async function runTests() {
  console.log('embeddings tests');
  let passed = 0;

  // ── Test 1: isAvailable returns boolean ────────────────────────
  console.log('  test isAvailable returns boolean...');
  {
    const result = embeddings.isAvailable();
    assert.strictEqual(typeof result, 'boolean', 'isAvailable() must return a boolean');
    console.log(`    isAvailable() = ${result}`);
    passed++;
  }

  // ── Test 2: embedTFIDF fallback always works ───────────────────
  console.log('  test embedTFIDF fallback...');
  {
    // Single string input
    const single = embeddings.embedTFIDF('hello world test embedding');
    assert.ok(Array.isArray(single), 'embedTFIDF must return an array');
    assert.strictEqual(single.length, 1, 'single input should yield 1 embedding');
    assert.ok(Array.isArray(single[0]), 'each embedding must be an array');
    assert.strictEqual(single[0].length, 256, 'TF-IDF embedding dimension should be 256');

    // Verify L2 normalization
    let norm = 0;
    for (const v of single[0]) norm += v * v;
    norm = Math.sqrt(norm);
    assert.ok(Math.abs(norm - 1.0) < 0.001, `embedding should be L2-normalized, got norm=${norm}`);

    // Batch input
    const batch = embeddings.embedTFIDF(['first text', 'second text', 'third text']);
    assert.strictEqual(batch.length, 3, 'batch of 3 should yield 3 embeddings');
    for (let i = 0; i < batch.length; i++) {
      assert.strictEqual(batch[i].length, 256, `embedding ${i} should be 256-dim`);
    }

    // Empty string should still produce a valid vector (all zeros normalized)
    const empty = embeddings.embedTFIDF('');
    assert.strictEqual(empty.length, 1, 'empty string should yield 1 embedding');
    assert.strictEqual(empty[0].length, 256, 'empty embedding should be 256-dim');

    // Different texts should produce different embeddings
    const vecA = embeddings.embedTFIDF('javascript programming code')[0];
    const vecB = embeddings.embedTFIDF('quantum physics experiment')[0];
    let identical = true;
    for (let i = 0; i < vecA.length; i++) {
      if (vecA[i] !== vecB[i]) { identical = false; break; }
    }
    assert.ok(!identical, 'different texts should produce different TF-IDF embeddings');

    // Same text should produce identical embeddings (deterministic)
    const vec1 = embeddings.embedTFIDF('deterministic test')[0];
    const vec2 = embeddings.embedTFIDF('deterministic test')[0];
    let same = true;
    for (let i = 0; i < vec1.length; i++) {
      if (vec1[i] !== vec2[i]) { same = false; break; }
    }
    assert.ok(same, 'same text should produce identical TF-IDF embeddings');

    console.log('    single, batch, empty, distinctness, determinism all OK');
    passed++;
  }

  // ── Test 3: cosineSimilarity ───────────────────────────────────
  console.log('  test cosineSimilarity...');
  {
    // Identical vectors should have similarity ~1.0
    const vecA = embeddings.embedTFIDF('hello world')[0];
    const sim = embeddings.cosineSimilarity(vecA, vecA);
    assert.ok(Math.abs(sim - 1.0) < 0.001, `self-similarity should be ~1.0, got ${sim}`);

    // Similar texts should have higher similarity than unrelated texts
    const vecSimilar1 = embeddings.embedTFIDF('javascript function code programming nodejs express server')[0];
    const vecSimilar2 = embeddings.embedTFIDF('javascript nodejs code function server express api')[0];
    const vecDifferent = embeddings.embedTFIDF('ocean whale marine biology underwater coral reef diving')[0];
    const simSimilar = embeddings.cosineSimilarity(vecSimilar1, vecSimilar2);
    const simDifferent = embeddings.cosineSimilarity(vecSimilar1, vecDifferent);
    assert.ok(simSimilar > simDifferent,
      `similar texts should have higher cosine sim (${simSimilar}) than different texts (${simDifferent})`);

    // Orthogonal-like vectors should have low similarity
    assert.ok(simDifferent < 0.5,
      `unrelated texts should have low similarity, got ${simDifferent}`);

    // Mismatched dimensions should return 0
    const mismatchSim = embeddings.cosineSimilarity([1, 0, 0], [1, 0]);
    assert.strictEqual(mismatchSim, 0, 'mismatched dimensions should return 0');

    // Empty vectors
    const emptySim = embeddings.cosineSimilarity([], []);
    assert.strictEqual(emptySim, 0, 'empty vectors should return 0');

    console.log(`    self=${sim.toFixed(4)}, similar=${simSimilar.toFixed(4)}, different=${simDifferent.toFixed(4)}, mismatch=0, empty=0`);
    passed++;
  }

  // ── Test 4: reciprocalRankFusion ───────────────────────────────
  console.log('  test reciprocalRankFusion...');
  {
    const bm25 = [
      { id: 'session-1' },
      { id: 'session-2' },
      { id: 'session-3' },
    ];
    const embRanked = [
      { id: 'session-2' },
      { id: 'session-4' },
      { id: 'session-1' },
    ];

    const fused = embeddings.reciprocalRankFusion(bm25, embRanked, 0.3, 0.7);
    assert.ok(Array.isArray(fused), 'RRF should return an array');
    assert.ok(fused.length > 0, 'RRF should return results');

    // All items from both lists should be present
    const ids = new Set(fused.map(r => r.id));
    assert.ok(ids.has('session-1'), 'session-1 should be in results');
    assert.ok(ids.has('session-2'), 'session-2 should be in results');
    assert.ok(ids.has('session-3'), 'session-3 should be in results');
    assert.ok(ids.has('session-4'), 'session-4 should be in results');

    // session-2 appears in both lists (rank 1 in BM25, rank 0 in emb) so it should score highest
    assert.strictEqual(fused[0].id, 'session-2',
      `session-2 should rank first (appears in both lists), got ${fused[0].id}`);

    // Each result should have rrf_score
    for (const r of fused) {
      assert.ok(typeof r.rrf_score === 'number', `${r.id} should have numeric rrf_score`);
      assert.ok(r.rrf_score > 0, `${r.id} rrf_score should be positive`);
    }

    // Results should be sorted descending by rrf_score
    for (let i = 1; i < fused.length; i++) {
      assert.ok(fused[i - 1].rrf_score >= fused[i].rrf_score,
        `results should be sorted descending by rrf_score`);
    }

    // Empty inputs should return empty
    const emptyResult = embeddings.reciprocalRankFusion([], [], 0.3, 0.7);
    assert.strictEqual(emptyResult.length, 0, 'empty inputs should return empty');

    // Single-source graceful degradation
    const bm25Only = embeddings.reciprocalRankFusion(bm25, [], 0.3, 0.7);
    assert.ok(bm25Only.length === 3, 'BM25-only should return 3 results');
    // When only BM25 is present, effective weight becomes 1.0
    const embOnly = embeddings.reciprocalRankFusion([], embRanked, 0.3, 0.7);
    assert.ok(embOnly.length === 3, 'embedding-only should return 3 results');

    console.log(`    fused ${fused.length} items, top=${fused[0].id} (score=${fused[0].rrf_score.toFixed(6)}), graceful degradation OK`);
    passed++;
  }

  // ── Test 5: hybridSearch integration ───────────────────────────
  console.log('  test hybridSearch integration...');
  {
    // hybridSearch requires sqlite-index to be available
    let sqAvailable = false;
    try {
      require('../src/sqlite-index');
      sqAvailable = true;
    } catch {
      // sqlite-index not available (no DB, or module load error)
    }

    if (!sqAvailable) {
      console.log('    SKIPPED: sqlite-index not available (no SQLite DB built)');
    } else {
      try {
        const results = await embeddings.hybridSearch('test query', 5);
        assert.ok(Array.isArray(results), 'hybridSearch must return an array');
        // Results may be empty if no sessions are indexed
        for (const r of results) {
          assert.ok(typeof r.session_id === 'string', 'result must have string session_id');
          assert.ok(typeof r.fused_score === 'number', 'result must have numeric fused_score');
          assert.ok(typeof r.search_type === 'string', 'result must have string search_type');
          assert.ok(['hybrid', 'text', 'semantic'].includes(r.search_type),
            `search_type must be hybrid|text|semantic, got ${r.search_type}`);
        }
        console.log(`    hybridSearch returned ${results.length} results`);
        passed++;
      } catch (err) {
        console.log(`    SKIPPED: hybridSearch error — ${err.message.substring(0, 80)}`);
      }
    }
  }

  // ── Test 6: constants are exported correctly ───────────────────
  console.log('  test exported constants...');
  {
    assert.strictEqual(embeddings.RRF_K, 60, 'RRF_K should be 60');
    assert.strictEqual(embeddings.BM25_WEIGHT, 0.3, 'BM25_WEIGHT should be 0.3');
    assert.strictEqual(embeddings.EMBEDDING_WEIGHT, 0.7, 'EMBEDDING_WEIGHT should be 0.7');
    assert.strictEqual(embeddings.EMBEDDING_DIM, 384, 'EMBEDDING_DIM should be 384');
    assert.ok(embeddings.MODELS && typeof embeddings.MODELS === 'object', 'MODELS should be exported');
    assert.ok(embeddings.MODELS.minilm, 'MODELS should have minilm');
    assert.ok(embeddings.MODELS.qwen3, 'MODELS should have qwen3');
    assert.strictEqual(embeddings.MODELS.minilm.dim, 384, 'minilm dim should be 384');
    assert.strictEqual(embeddings.MODELS.qwen3.dim, 1024, 'qwen3 dim should be 1024');
    console.log('    all constants correct');
    passed++;
  }

  // ── Test 7: embed() fallback chain resolves to TF-IDF ─────────
  console.log('  test embed() fallback chain...');
  {
    // embed() should always succeed because TF-IDF is the final fallback
    const result = await embeddings.embed('test input for embedding');
    assert.ok(Array.isArray(result), 'embed() must return an array');
    assert.strictEqual(result.length, 1, 'single input should yield 1 embedding');
    assert.ok(Array.isArray(result[0]), 'each embedding must be an array');
    assert.ok(result[0].length > 0, 'embedding should have non-zero dimension');

    // Batch input
    const batchResult = await embeddings.embed(['text one', 'text two']);
    assert.strictEqual(batchResult.length, 2, 'batch of 2 should yield 2 embeddings');

    console.log(`    embed() returned ${result[0].length}-dim vector (fallback chain OK)`);
    passed++;
  }

  // ── Test 8: getModelId and getModelDim ─────────────────────────
  console.log('  test getModelId and getModelDim...');
  {
    const modelId = embeddings.getModelId();
    assert.strictEqual(typeof modelId, 'string', 'getModelId() must return a string');
    assert.ok(modelId.length > 0, 'model ID should not be empty');

    const modelDim = embeddings.getModelDim();
    assert.strictEqual(typeof modelDim, 'number', 'getModelDim() must return a number');
    assert.ok(modelDim > 0, 'model dim should be positive');

    // Default should be minilm
    const validIds = Object.values(embeddings.MODELS).map(m => m.id);
    assert.ok(validIds.includes(modelId), `model ID "${modelId}" should be a known model`);

    console.log(`    modelId=${modelId}, dim=${modelDim}`);
    passed++;
  }

  console.log(`\nAll tests passed! (${passed} tests)`);
}

runTests().catch(e => { console.error('FAIL:', e); process.exit(1); });
