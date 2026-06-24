/**
 * GMGN API Client — Direct HTTP wrapper for GMGN OpenAPI
 *
 * Replaces all `npx gmgn-cli` subprocess spawns with direct fetch calls.
 * Based on OpenApiClient.ts auth logic + meridian_ref/tools/gmgn.js pacing pattern.
 *
 * Auth mode: Exist (X-APIKEY + timestamp + client_id) — used for market/token endpoints.
 * No signed auth needed (no swap/order operations).
 *
 * Rate limit strategy:
 *   - Global pacing: minimum 2500ms between any two requests
 *   - Exponential backoff on 429 / "temporarily banned" (max 2 retries)
 *   - Respects Retry-After header; 60s for banned; min(30s, 3000*2^attempt) otherwise
 *   - CRITICAL: retrying during a RATE_LIMIT_BANNED window extends the ban by 5s per request (up to 5 min)
 *   - Force IPv4 — GMGN does not support IPv6
 */

const dns = require('dns');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');

// Force IPv4 — GMGN OpenAPI does not support IPv6
dns.setDefaultResultOrder('ipv4first');

require('./envcrypt.cjs').loadEnv();

const GMGN_BASE_URL = 'https://openapi.gmgn.ai';
const DEFAULT_PACING_MS = 2500;
const MAX_RETRIES = 2;
const MAX_BACKOFF_MS = 30000;

let lastRequestAt = 0;

// --- Internal helpers ---

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function paceRequest() {
    const elapsed = Date.now() - lastRequestAt;
    if (elapsed < DEFAULT_PACING_MS) {
        await sleep(DEFAULT_PACING_MS - elapsed);
    }
    lastRequestAt = Date.now();
}

function buildAuthQuery() {
    return {
        timestamp: Math.floor(Date.now() / 1000).toString(),
        client_id: crypto.randomUUID(),
    };
}

function buildUrl(pathname, params = {}) {
    const auth = buildAuthQuery();
    const allParams = { ...params, ...auth };
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(allParams)) {
        if (v == null || v === '') continue;
        if (Array.isArray(v)) {
            for (const item of v) {
                if (item != null && item !== '') qs.append(k, String(item));
            }
        } else {
            qs.set(k, String(v));
        }
    }
    return `${GMGN_BASE_URL}${pathname}?${qs.toString()}`;
}

function getApiKey() {
    const key = process.env.GMGN_API_KEY;
    if (!key) {
        throw new Error('[gmgn-client] GMGN_API_KEY is required. Set it in .env or environment.');
    }
    return key;
}

function num(value) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}

/**
 * Core fetch with retry + rate-limit handling.
 * Returns parsed JSON data on success, null on failure (never throws for API errors).
 */
async function gmgnFetch(pathname, { method = 'GET', params = {}, body = null } = {}) {
    const apiKey = getApiKey();
    const url = buildUrl(pathname, params);

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
        await paceRequest();

        let res;
        try {
            const fetchOpts = {
                method,
                headers: {
                    'X-APIKEY': apiKey,
                    'Content-Type': 'application/json',
                },
            };
            if (body) fetchOpts.body = JSON.stringify(body);

            res = await fetch(url, fetchOpts);
        } catch (err) {
            const code = err?.cause?.code || err?.code;
            if (code === 'EADDRNOTAVAIL' || code === 'ENETUNREACH') {
                console.error(`[gmgn-client] Network unreachable (${code}): GMGN requires IPv4.`);
                return null;
            }
            if (attempt < MAX_RETRIES) {
                await sleep(Math.min(5000, 2000 * Math.pow(2, attempt)));
                continue;
            }
            console.error(`[gmgn-client] Fetch failed for ${pathname}: ${err.message}`);
            return null;
        }

        let text = '';
        try {
            text = await res.text();
        } catch {
            if (attempt < MAX_RETRIES) {
                await sleep(2000);
                continue;
            }
            return null;
        }

        let payload = {};
        try {
            payload = text ? JSON.parse(text) : {};
        } catch {
            payload = { raw: text };
        }

        // Success
        if (res.ok && payload.code === 0) {
            // GMGN response is double-nested: { code:0, data: { code:0, data: {...}, message, reason } }
            // Unwrap to the inner data payload: payload.data.data || payload.data || payload
            const outer = payload.data;
            if (outer && typeof outer === 'object' && 'code' in outer && outer.data != null) {
                return outer.data;
            }
            return outer != null ? outer : payload;
        }

        // Rate limit handling
        const message = String(payload.message || payload.error || payload.raw || '');
        const rateLimited = res.status === 429 || /rate limit|temporarily banned/i.test(message);

        if (rateLimited && attempt < MAX_RETRIES) {
            const retryAfter = Number(res.headers.get('retry-after'));
            let backoffMs;
            if (Number.isFinite(retryAfter) && retryAfter > 0) {
                backoffMs = retryAfter * 1000;
            } else if (/temporarily banned/i.test(message)) {
                backoffMs = 60000;
            } else {
                backoffMs = Math.min(MAX_BACKOFF_MS, 3000 * Math.pow(2, attempt));
            }
            console.warn(`[gmgn-client] ${pathname} rate limited (attempt ${attempt + 1}/${MAX_RETRIES + 1}), backing off ${Math.round(backoffMs / 1000)}s`);
            await sleep(backoffMs);
            continue;
        }

        // Non-retryable error
        const errCode = payload.code !== undefined ? `code=${payload.code}` : `HTTP ${res.status}`;
        console.error(`[gmgn-client] ${pathname} failed: ${errCode} — ${message.slice(0, 200)}`);
        return null;
    }

    console.error(`[gmgn-client] ${pathname} exhausted all retries`);
    return null;
}

// --- Public API ---

/**
 * Fetch trending tokens (replaces `npx gmgn-cli market trending`)
 *
 * @param {Object} opts
 * @param {string} opts.chain - e.g. "sol"
 * @param {string} opts.interval - e.g. "5m", "1h", "24h"
 * @param {number} [opts.limit] - max results (default 100)
 * @param {string[]} [opts.filters] - server-side filters, e.g. ["has_social", "burn", "renounced", "frozen"]
 * @param {string[]} [opts.platforms] - launchpad platforms, e.g. ["Pump.fun", "pump_agent"]
 * @param {string} [opts.orderBy] - sort field, e.g. "volume", "smart_degen_count"
 * @returns {Array|null} trending tokens array or null on failure
 */
async function getTrending({ chain = 'sol', interval = '24h', limit, filters, platforms, orderBy } = {}) {
    const params = { chain, interval };
    if (limit) params.limit = limit;
    if (orderBy) params.order_by = orderBy;

    // filters and platforms are arrays, each element becomes a separate query param
    if (filters && filters.length > 0) params.filter = filters;
    if (platforms && platforms.length > 0) params.platform = platforms;

    const result = await gmgnFetch('/v1/market/rank', { params });
    if (!result) return null;

    // Response shape: { rank: [...tokens] } or just the array
    const tokens = result.rank || result;
    return Array.isArray(tokens) ? tokens : null;
}

/**
 * Fetch kline/candlestick data (replaces `npx gmgn-cli market kline`)
 *
 * @param {Object} opts
 * @param {string} opts.chain - e.g. "sol"
 * @param {string} opts.address - token address
 * @param {string} opts.resolution - e.g. "1m", "5m", "15m", "1h"
 * @param {number} [opts.from] - Unix timestamp start
 * @param {number} [opts.to] - Unix timestamp end
 * @returns {Object|null} { list: [...klines] } or null on failure
 */
async function getKline({ chain = 'sol', address, resolution, from, to } = {}) {
    if (!address) return null;

    // Validate address format
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(address) && !/^0x[a-fA-F0-9]{40}$/.test(address)) {
        console.error(`[gmgn-client] Invalid address format: ${address}`);
        return null;
    }

    const params = { chain, address, resolution };
    if (from != null) params.from = from;
    if (to != null) params.to = to;

    return gmgnFetch('/v1/market/token_kline', { params });
}

/**
 * Fetch detailed token info (price, fees, holders, dev, etc.)
 *
 * @param {string} chain - e.g. "sol"
 * @param {string} address - token address
 * @returns {Object|null} token info or null
 */
async function getTokenInfo(chain = 'sol', address) {
    if (!address) return null;
    return gmgnFetch('/v1/token/info', { params: { chain, address } });
}

/**
 * Fetch token security/risk data (rug_ratio, insider%, dev%, bundler%, honeypot, etc.)
 *
 * @param {string} chain - e.g. "sol"
 * @param {string} address - token address
 * @returns {Object|null} security data or null
 */
async function getTokenSecurity(chain = 'sol', address) {
    if (!address) return null;
    return gmgnFetch('/v1/token/security', { params: { chain, address } });
}

/**
 * Fetch top holders with optional tag filtering
 *
 * @param {Object} opts
 * @param {string} opts.chain - e.g. "sol"
 * @param {string} opts.address - token address
 * @param {string} [opts.tag] - filter: "smart_degen", "renowned", "sniper", "bundler", "rat_trader", "dev", "fresh_wallet"
 * @returns {Object|null} holders data or null
 */
async function getTokenTopHolders({ chain = 'sol', address, tag } = {}) {
    if (!address) return null;
    const params = { chain, address };
    if (tag) params.tag = tag;
    return gmgnFetch('/v1/market/token_top_holders', { params });
}

/**
 * Fetch top traders with optional tag filtering
 *
 * @param {Object} opts
 * @param {string} opts.chain
 * @param {string} opts.address
 * @param {string} [opts.tag]
 * @returns {Object|null}
 */
async function getTokenTopTraders({ chain = 'sol', address, tag } = {}) {
    if (!address) return null;
    const params = { chain, address };
    if (tag) params.tag = tag;
    return gmgnFetch('/v1/market/token_top_traders', { params });
}

// --- Convenience helpers ---

/**
 * Check if GMGN API key is available
 */
function hasApiKey() {
    return !!(process.env.GMGN_API_KEY);
}

/**
 * Get token fees in SOL (for minTokenFeesSol gate)
 * @param {string} mint - token mint address
 * @returns {{ total_fee: number|null, trade_fee: number|null }|null}
 */
async function getTokenFeesSol(mint) {
    if (!mint || !hasApiKey()) return null;
    try {
        const info = await getTokenInfo('sol', mint);
        if (!info || typeof info !== 'object') return null;
        const data = info.data || info;
        if (!data || typeof data !== 'object') return null;
        return {
            total_fee: num(data.total_fee),
            trade_fee: num(data.trade_fee),
        };
    } catch (err) {
        console.error(`[gmgn-client] Token fees lookup failed for ${String(mint).slice(0, 8)}: ${err.message}`);
        return null;
    }
}

/**
 * Fetch token metrics for trade history logging
 * @param {string} mint - token mint address
 * @returns {Promise<Object>}
 */
async function fetchMetricsForEntry(mint) {
    if (!mint || !hasApiKey()) return {};
    let metrics = {};
    try {
        const infoRaw = await getTokenInfo('sol', mint);
        if (infoRaw && typeof infoRaw === 'object') {
            const info = infoRaw.data || infoRaw;
            metrics.marketCap = num(info.market_cap);
            metrics.volume24h = num(info.volume_24h) || num(info.volume);
            metrics.holders = num(info.holder_count);
            if (info.creation_timestamp) {
                metrics.tokenAgeHours = (Date.now() - info.creation_timestamp * 1000) / 3600000;
            }
            metrics.smartDegenCount = num(info.smart_degen_count) || num(info.smart_degens_count) || 0;
            metrics.totalFees = num(info.total_fee);
        }
        
        const secRaw = await getTokenSecurity('sol', mint);
        if (secRaw && typeof secRaw === 'object') {
            const sec = secRaw.data || secRaw;
            if (sec.top10_holder_rate !== undefined) metrics.top10Percentage = num(sec.top10_holder_rate) * 100;
            if (sec.creator_percentage !== undefined) metrics.devHoldsPercentage = num(sec.creator_percentage) * 100;
            if (sec.insider_percentage !== undefined) metrics.insiderPercentage = num(sec.insider_percentage) * 100;
            metrics.liquidityBurnt = !!(sec.is_lp_burned || (sec.lp_burned_perc && num(sec.lp_burned_perc) > 0.9));
            if (sec.rug_ratio !== undefined) metrics.rugPercentage = num(sec.rug_ratio) * 100;
            if (sec.buy_tax !== undefined) metrics.bundlingPercentage = num(sec.buy_tax) * 100;
        }
    } catch (err) {
        console.error(`[gmgn-client] fetchMetricsForEntry failed for ${String(mint).slice(0, 8)}: ${err.message}`);
    }
    return metrics;
}

module.exports = {
    getTrending,
    getKline,
    getTokenInfo,
    getTokenSecurity,
    getTokenTopHolders,
    getTokenTopTraders,
    getTokenFeesSol,
    fetchMetricsForEntry,
    hasApiKey,
};
