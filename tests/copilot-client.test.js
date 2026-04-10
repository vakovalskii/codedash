/**
 * Tests for src/copilot-client.js
 *
 * Runnable with: node tests/copilot-client.test.js
 * Uses only Node.js built-in assert module (zero deps).
 */

'use strict';

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

// Module under test
const copilot = require('../src/copilot-client');

async function runTests() {
  console.log('copilot-client tests');
  let passed = 0;

  // ── Test 1: isAvailable returns boolean ────────────────────────
  console.log('  test isAvailable returns boolean...');
  {
    const result = copilot.isAvailable();
    assert.strictEqual(typeof result, 'boolean', 'isAvailable() must return a boolean');
    console.log(`    isAvailable() = ${result}`);
    passed++;
  }

  // ── Test 2: getStatus returns expected shape ───────────────────
  console.log('  test getStatus returns expected shape...');
  {
    const status = copilot.getStatus();
    assert.ok(status !== null && typeof status === 'object', 'getStatus() must return an object');
    assert.strictEqual(typeof status.authenticated, 'boolean', 'status.authenticated must be boolean');
    assert.strictEqual(typeof status.model, 'string', 'status.model must be string');
    assert.strictEqual(typeof status.api_base, 'string', 'status.api_base must be string');
    assert.ok('token_expires_at' in status, 'status must have token_expires_at');
    assert.strictEqual(typeof status.token_expires_at, 'number', 'status.token_expires_at must be number');
    // Default model should be gpt-4.1
    assert.strictEqual(status.model, 'gpt-4.1', 'default model should be gpt-4.1');
    console.log(`    status = ${JSON.stringify(status)}`);
    passed++;
  }

  // ── Test 3: token loading from credential file ─────────────────
  console.log('  test token loading from credential file...');
  {
    const credPath = path.join(os.homedir(), '.copilot', 'auth', 'credential.json');
    const appsPath = path.join(os.homedir(), '.config', 'github-copilot', 'apps.json');
    const hasCredFile = fs.existsSync(credPath);
    const hasAppsFile = fs.existsSync(appsPath);

    if (hasCredFile) {
      // Verify the file is valid JSON with a token field
      const data = JSON.parse(fs.readFileSync(credPath, 'utf8'));
      assert.ok(data.token && typeof data.token === 'string', 'credential.json should have a string token');
      assert.ok(data.token.length > 0, 'token should not be empty');
      console.log(`    credential.json found, token starts with: ${data.token.substring(0, 8)}...`);
    } else if (hasAppsFile) {
      const data = JSON.parse(fs.readFileSync(appsPath, 'utf8'));
      const ghKey = Object.keys(data).find(k => k.startsWith('github.com'));
      assert.ok(ghKey, 'apps.json should have a github.com key');
      assert.ok(data[ghKey].oauth_token, 'apps.json github.com entry should have oauth_token');
      console.log(`    apps.json found, key: ${ghKey}`);
    } else {
      console.log('    (no credential files found, skipping content verification)');
    }

    // isAvailable should match file presence
    const available = copilot.isAvailable();
    assert.strictEqual(available, hasCredFile || hasAppsFile,
      `isAvailable() should be ${hasCredFile || hasAppsFile} given credential file presence`);
    passed++;
  }

  // ── Test 4: summarizeSession integration (skip if no token) ────
  console.log('  test summarizeSession integration...');
  {
    if (!copilot.isAvailable()) {
      console.log('    SKIPPED: no Copilot credentials available');
    } else {
      try {
        const testMessages = [
          { role: 'user', content: 'Create a hello world function in JavaScript' },
          { role: 'assistant', content: 'function helloWorld() { console.log("Hello, World!"); }' },
          { role: 'user', content: 'Add a parameter for the name' },
          { role: 'assistant', content: 'function helloWorld(name) { console.log(`Hello, ${name}!`); }' },
        ];
        const summary = await copilot.summarizeSession(testMessages);
        assert.strictEqual(typeof summary, 'string', 'summary must be a string');
        assert.ok(summary.length > 0, 'summary should not be empty');
        console.log(`    summary (${summary.length} chars): ${summary.substring(0, 120)}...`);
        passed++;
      } catch (err) {
        // Auth might fail even if file exists (expired token, network issues)
        if (err.message.includes('auth error') || err.message.includes('timed out') || err.message.includes('token exchange')) {
          console.log(`    SKIPPED: ${err.message.substring(0, 80)}`);
        } else {
          throw err;
        }
      }
    }
  }

  // ── Test 5: chatCompletion with gpt-4.1 ───────────────────────
  console.log('  test chatCompletion with gpt-4.1...');
  {
    if (!copilot.isAvailable()) {
      console.log('    SKIPPED: no Copilot credentials available');
    } else {
      try {
        const result = await copilot.chatCompletion(
          [{ role: 'user', content: 'Reply with exactly: PONG' }],
          { model: 'gpt-4.1', max_tokens: 50 }
        );
        assert.ok(result !== null && typeof result === 'object', 'result must be an object');
        assert.strictEqual(typeof result.content, 'string', 'result.content must be a string');
        assert.strictEqual(typeof result.model, 'string', 'result.model must be a string');
        assert.ok(result.usage !== null && typeof result.usage === 'object', 'result.usage must be an object');
        assert.ok(result.content.length > 0, 'response content should not be empty');
        console.log(`    model=${result.model}, content="${result.content.substring(0, 60)}"`);
        passed++;
      } catch (err) {
        if (err.message.includes('auth error') || err.message.includes('timed out') || err.message.includes('token exchange')) {
          console.log(`    SKIPPED: ${err.message.substring(0, 80)}`);
        } else {
          throw err;
        }
      }
    }
  }

  // ── Test 6: chatCompletion with gpt-5-mini + reasoning_effort ──
  console.log('  test chatCompletion with gpt-5-mini and reasoning_effort xhigh...');
  {
    if (!copilot.isAvailable()) {
      console.log('    SKIPPED: no Copilot credentials available');
    } else {
      try {
        const result = await copilot.chatCompletion(
          [{ role: 'user', content: 'What is 2 + 2? Reply with just the number.' }],
          { model: 'gpt-5-mini', max_tokens: 50, reasoning_effort: 'xhigh' }
        );
        assert.ok(result !== null && typeof result === 'object', 'result must be an object');
        assert.strictEqual(typeof result.content, 'string', 'result.content must be a string');
        assert.strictEqual(typeof result.model, 'string', 'result.model must be a string');
        assert.ok(result.usage !== null && typeof result.usage === 'object', 'result.usage must be an object');
        assert.ok(result.content.length > 0, 'response content should not be empty');
        console.log(`    model=${result.model}, content="${result.content.substring(0, 60)}"`);
        passed++;
      } catch (err) {
        if (err.message.includes('auth error') || err.message.includes('timed out') || err.message.includes('token exchange') || err.message.includes('API error')) {
          console.log(`    SKIPPED: ${err.message.substring(0, 100)}`);
        } else {
          throw err;
        }
      }
    }
  }

  // ── Test 7: error handling when no credentials exist ───────────
  console.log('  test error handling with missing credentials...');
  {
    // We test the module's exported functions handle absence gracefully.
    // isAvailable() should not throw regardless.
    let threw = false;
    try {
      copilot.isAvailable();
    } catch (err) {
      threw = true;
    }
    assert.strictEqual(threw, false, 'isAvailable() must never throw');

    // getStatus() should not throw regardless.
    threw = false;
    try {
      copilot.getStatus();
    } catch (err) {
      threw = true;
    }
    assert.strictEqual(threw, false, 'getStatus() must never throw');

    // chatCompletion should throw/reject when credentials are absent
    // (we can only fully test this if credentials are NOT present)
    if (!copilot.isAvailable()) {
      try {
        await copilot.chatCompletion([{ role: 'user', content: 'test' }]);
        assert.fail('chatCompletion should throw when no credentials exist');
      } catch (err) {
        assert.ok(err.message.includes('No GitHub Copilot OAuth token found'),
          `Expected credential error, got: ${err.message}`);
        console.log(`    chatCompletion correctly threw: ${err.message.substring(0, 80)}`);
      }
    } else {
      console.log('    (credentials present; verified isAvailable/getStatus never throw)');
    }
    passed++;
  }

  console.log(`\nAll tests passed! (${passed} tests)`);
}

runTests().catch(e => { console.error('FAIL:', e); process.exit(1); });
