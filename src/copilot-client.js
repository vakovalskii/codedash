/**
 * @module copilot-client
 *
 * Auto-discovers GitHub Copilot OAuth tokens and exchanges them for session
 * tokens to call LLM APIs via the Copilot chat/completions endpoint.
 *
 * Ported from the Rust implementation at codex-rs/github-copilot/src/
 * (auth.rs, token_exchange.rs).
 *
 * Flow:
 *   1. Load OAuth token (gho_...) from ~/.copilot/auth/credential.json
 *      Fallback: ~/.config/github-copilot/apps.json
 *   2. Exchange for short-lived session token via GitHub internal endpoint
 *   3. Cache session token until expiry (refresh 60s before)
 *   4. Call chat/completions on the dynamic Copilot API base
 *
 * Zero dependencies — uses only Node.js stdlib (https, fs, path, os).
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');

// ── Constants ────────────────────────────────────────────────────

/** Copilot internal token exchange endpoint. */
const COPILOT_TOKEN_ENDPOINT = 'https://api.github.com/copilot_internal/v2/token';

/** Default Copilot API base (individual accounts). */
const DEFAULT_API_BASE = 'https://api.individual.githubcopilot.com';

/** Default model for chat completions. */
const DEFAULT_MODEL = 'gpt-4.1';

/** User-Agent header matching the official Copilot CLI. */
const USER_AGENT = `copilot/1.0.14 (client/github/cli ${process.platform} v24.11.1) term/${process.env.TERM_PROGRAM || 'xterm'}`;

/** Refresh session token 60 seconds before actual expiry. */
const TOKEN_REFRESH_MARGIN_SEC = 60;

// ── Credential file paths ────────────────────────────────────────

/**
 * Returns the path to ~/.copilot/auth/credential.json
 * @returns {string}
 */
function copilotCliCredentialPath() {
  return path.join(os.homedir(), '.copilot', 'auth', 'credential.json');
}

/**
 * Returns the path to ~/.config/github-copilot/apps.json (legacy VS Code / Copilot extension)
 * @returns {string}
 */
function copilotAppsJsonPath() {
  return path.join(os.homedir(), '.config', 'github-copilot', 'apps.json');
}

// ── Cached session state ─────────────────────────────────────────

/** @type {string|null} Cached OAuth token (gho_...) */
let _oauthToken = null;

/** @type {string|null} Cached session token (short-lived) */
let _sessionToken = null;

/** @type {number} Unix seconds when session token expires */
let _sessionExpiresAt = 0;

/** @type {string} Dynamic API base URL from token exchange */
let _apiBase = DEFAULT_API_BASE;

// ── HTTP helper ──────────────────────────────────────────────────

/**
 * Makes an HTTPS request using Node.js stdlib.
 * @param {string} url - Full URL
 * @param {Object} opts - Options
 * @param {string} [opts.method='GET'] - HTTP method
 * @param {Object} [opts.headers={}] - Request headers
 * @param {string|null} [opts.body=null] - Request body (for POST)
 * @returns {Promise<{statusCode: number, body: string, json: function}>}
 */
function httpsRequest(url, opts = {}) {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const reqOpts = {
      hostname: parsed.hostname,
      port: parsed.port || 443,
      path: parsed.pathname + parsed.search,
      method: opts.method || 'GET',
      headers: {
        'User-Agent': USER_AGENT,
        Accept: 'application/json',
        ...(opts.headers || {}),
      },
    };

    const req = https.request(reqOpts, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const body = Buffer.concat(chunks).toString('utf8');
        resolve({
          statusCode: res.statusCode,
          body,
          json() {
            return JSON.parse(body);
          },
        });
      });
    });

    req.on('error', reject);
    req.setTimeout(30000, () => {
      req.destroy(new Error('Request timed out'));
    });

    if (opts.body) {
      req.write(opts.body);
    }
    req.end();
  });
}

// ── OAuth token discovery ────────────────────────────────────────

/**
 * Attempts to load the OAuth token from known credential locations.
 *
 * Priority:
 *   1. ~/.copilot/auth/credential.json  (field: "token")
 *   2. ~/.config/github-copilot/apps.json  (field: oauth_token under github.com key)
 *
 * @returns {string|null} The gho_... OAuth token, or null if not found.
 */
function loadOAuthToken() {
  // Collect ALL candidate tokens, return as array (caller tries each)
  return loadAllOAuthTokens()[0] || null;
}

/**
 * Loads all available OAuth tokens from known credential locations.
 * Returns tokens most-likely-to-work first: apps.json (actively refreshed
 * by VS Code/Copilot extension) before credential.json (can go stale).
 * @returns {string[]}
 */
function loadAllOAuthTokens() {
  const tokens = [];

  // 1. apps.json (preferred — refreshed by VS Code Copilot extension)
  try {
    const appsPath = copilotAppsJsonPath();
    if (fs.existsSync(appsPath)) {
      const data = JSON.parse(fs.readFileSync(appsPath, 'utf8'));
      for (const key of Object.keys(data)) {
        if (key.startsWith('github.com') && data[key] && data[key].oauth_token) {
          tokens.push(data[key].oauth_token);
        }
      }
    }
  } catch (_) {}

  // 2. Copilot CLI credential file (can be stale)
  try {
    const credPath = copilotCliCredentialPath();
    if (fs.existsSync(credPath)) {
      const data = JSON.parse(fs.readFileSync(credPath, 'utf8'));
      if (data.token && typeof data.token === 'string' && data.token.length > 0) {
        if (!tokens.includes(data.token)) tokens.push(data.token);
      }
    }
  } catch (_) {}

  return tokens;
}

// ── Token exchange ───────────────────────────────────────────────

/**
 * Exchange a persistent OAuth token (gho_...) for a short-lived Copilot API
 * session token via the internal GitHub endpoint.
 *
 * The response includes:
 *   - token: session token for Bearer auth
 *   - expires_at: unix seconds
 *   - endpoints.api: dynamic API base URL
 *
 * @param {string} oauthToken - The gho_... OAuth token
 * @returns {Promise<{token: string, expires_at: number, endpoints?: {api?: string}}>}
 * @throws {Error} If the exchange fails
 */
async function exchangeToken(oauthToken) {
  const res = await httpsRequest(COPILOT_TOKEN_ENDPOINT, {
    method: 'GET',
    headers: {
      Authorization: `token ${oauthToken}`,
    },
  });

  if (res.statusCode !== 200) {
    throw new Error(
      `Copilot token exchange failed (HTTP ${res.statusCode}): ${res.body}`
    );
  }

  const data = res.json();
  if (!data.token) {
    throw new Error('Copilot token exchange returned empty token');
  }

  return data;
}

/**
 * Ensures we have a valid session token, exchanging/refreshing as needed.
 * Caches the token and refreshes 60 seconds before expiry.
 *
 * @returns {Promise<string>} The session token
 * @throws {Error} If no OAuth token is available or exchange fails
 */
async function ensureSessionToken() {
  const now = Math.floor(Date.now() / 1000);

  // Return cached token if still valid
  if (_sessionToken && _sessionExpiresAt > now + TOKEN_REFRESH_MARGIN_SEC) {
    return _sessionToken;
  }

  // Try all available OAuth tokens until one exchanges successfully.
  // apps.json tokens (refreshed by VS Code) are tried first; credential.json
  // (Copilot CLI, can go stale) is tried last.
  const allTokens = loadAllOAuthTokens();
  if (allTokens.length === 0) {
    throw new Error(
      'No GitHub Copilot OAuth token found. ' +
      'Expected at ~/.copilot/auth/credential.json or ~/.config/github-copilot/apps.json'
    );
  }

  let lastErr = null;
  for (const token of allTokens) {
    try {
      const result = await exchangeToken(token);
      _oauthToken = token;
      _sessionToken = result.token;
      _sessionExpiresAt = result.expires_at || 0;
      if (result.endpoints && result.endpoints.api) {
        _apiBase = result.endpoints.api;
      } else {
        _apiBase = DEFAULT_API_BASE;
      }
      return _sessionToken;
    } catch (e) {
      lastErr = e;
      // Try next token
    }
  }
  throw lastErr || new Error('All OAuth tokens failed exchange');
}

// ── Public API ───────────────────────────────────────────────────

/**
 * Synchronous check whether a Copilot credential file exists on disk.
 * Does NOT validate the token — just checks file presence.
 *
 * @returns {boolean} True if a credential file exists
 */
function isAvailable() {
  try {
    if (fs.existsSync(copilotCliCredentialPath())) return true;
  } catch (_) { /* ignore */ }

  try {
    if (fs.existsSync(copilotAppsJsonPath())) return true;
  } catch (_) { /* ignore */ }

  return false;
}

/**
 * Call the Copilot chat/completions endpoint.
 *
 * @param {Array<{role: string, content: string}>} messages - Chat messages
 * @param {Object} [opts={}] - Options
 * @param {string} [opts.model='gpt-4.1'] - Model ID
 * @param {number} [opts.max_tokens=4000] - Max tokens in response
 * @param {string} [opts.reasoning_effort] - Reasoning effort level (e.g. 'xhigh' for gpt-5-mini)
 * @returns {Promise<{content: string, model: string, usage: Object}>}
 * @throws {Error} If authentication fails or the API returns an error
 */
async function chatCompletion(messages, opts = {}) {
  const token = await ensureSessionToken();
  const model = opts.model || DEFAULT_MODEL;
  const maxTokens = opts.max_tokens || 4000;

  const body = {
    model,
    messages,
    max_tokens: maxTokens,
  };

  // Add reasoning_effort for models that support it (e.g. gpt-5-mini)
  if (opts.reasoning_effort) {
    body.reasoning_effort = opts.reasoning_effort;
  }

  const url = `${_apiBase}/chat/completions`;
  const res = await httpsRequest(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      'Editor-Version': 'vscode/1.96.0',
      'Copilot-Integration-Id': 'vscode-chat',
      'Editor-Plugin-Version': 'copilot-chat/0.24.2',
    },
    body: JSON.stringify(body),
  });

  if (res.statusCode === 401 || res.statusCode === 403) {
    // Session token may have expired despite our margin check — force refresh
    _sessionToken = null;
    _sessionExpiresAt = 0;
    throw new Error(
      `Copilot API auth error (HTTP ${res.statusCode}): ${res.body}. ` +
      'Token has been cleared; retry will attempt re-authentication.'
    );
  }

  if (res.statusCode !== 200) {
    throw new Error(
      `Copilot API error (HTTP ${res.statusCode}): ${res.body}`
    );
  }

  const data = res.json();

  // Extract the assistant message content
  const choice = data.choices && data.choices[0];
  const content = choice && choice.message ? choice.message.content : '';

  return {
    content: content || '',
    model: data.model || model,
    usage: data.usage || {},
  };
}

/**
 * Summarize a coding session conversation using the Copilot LLM.
 *
 * @param {Array<{role: string, content: string}>} messages - Session messages
 * @returns {Promise<string>} A concise summary of the session
 * @throws {Error} If the API call fails
 */
async function summarizeSession(messages) {
  // Truncate very long conversations to stay within context limits.
  // Keep the first 2 and last 8 messages for large sessions.
  let truncated = messages;
  if (messages.length > 20) {
    truncated = [
      ...messages.slice(0, 2),
      { role: 'system', content: `[... ${messages.length - 10} messages omitted for brevity ...]` },
      ...messages.slice(-8),
    ];
  }

  const systemPrompt = {
    role: 'system',
    content:
      'You are a helpful assistant that summarizes coding sessions. ' +
      'Given the conversation below, produce a concise 2-4 sentence summary ' +
      'describing what was accomplished, key decisions made, and any outstanding issues. ' +
      'Be specific about file names, features, and technologies mentioned.',
  };

  const result = await chatCompletion(
    [systemPrompt, ...truncated],
    { model: DEFAULT_MODEL, max_tokens: 500 }
  );

  return result.content.trim();
}

/**
 * Returns the current authentication and connection status.
 *
 * @returns {{authenticated: boolean, model: string, api_base: string, token_expires_at: number}}
 */
function getStatus() {
  const hasToken = !!_oauthToken || isAvailable();
  const hasSession = !!_sessionToken && _sessionExpiresAt > Math.floor(Date.now() / 1000);

  return {
    authenticated: hasSession,
    model: DEFAULT_MODEL,
    api_base: _apiBase,
    token_expires_at: _sessionExpiresAt,
  };
}

// ── Exports ──────────────────────────────────────────────────────

module.exports = {
  isAvailable,
  chatCompletion,
  summarizeSession,
  getStatus,
};
