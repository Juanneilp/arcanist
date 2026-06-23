/**
 * Meteora Pool Discovery Client — Direct HTTP wrapper
 *
 * Provides access to the Meteora Pool Discovery API for checking DLMM pool existence
 * and discovering trending/pools. No API key required — free and unauthenticated.
 *
 * Used in screening pipeline to ensure GMGN trending tokens actually have active DLMM pools.
 * Based on meridian_ref/tools/screening.js pattern.
 *
 * Base URL: https://pool-discovery-api.datapi.meteora.ag
 *
 * IMPORTANT: The `filter_by` clause does NOT support filtering by token address directly
 * (verified empirically). To find pools for a specific token, use the `query` parameter,
 * which matches pools by token symbol/name/mint, then verify the mint client-side.
 */

const METEORA_POOL_DISCOVERY_BASE = 'https://pool-discovery-api.datapi.meteora.ag';
const METEORA_DLMM_API_BASE = 'https://dlmm.datapi.meteora.ag';

// --- Internal helpers ---

async function fetchJson(url, timeoutMs = 15000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const res = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);

        if (!res.ok) {
            const text = await res.text().catch(() => '');
            throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
        }

        return await res.json();
    } catch (err) {
        clearTimeout(timer);
        if (err.name === 'AbortError') {
            throw new Error(`Request to ${url} timed out after ${timeoutMs}ms`);
        }
        throw err;
    }
}

// --- Public API ---

/**
 * Discover DLMM pools from Meteora Pool Discovery API.
 *
 * @param {Object} opts
 * @param {number} [opts.pageSize=50] - number of pools to fetch
 * @param {string} [opts.filterBy] - server-side filter clause (e.g. "pool_type=dlmm&&tvl>=10000")
 * @param {string} [opts.query] - search query: matches pools by name, tokens, or address
 * @param {string} [opts.timeframe='5m'] - timeframe for metrics (5m, 30m, 1h, 2h, 4h, 12h, 24h)
 * @param {string} [opts.category='trending'] - pool category (trending, new, etc.)
 * @returns {Promise<{ pools: Array, total: number }|null>}
 */
async function discoverPools({ pageSize = 50, filterBy, query, timeframe = '5m', category = 'trending' } = {}) {
    const params = new URLSearchParams();
    if (pageSize) params.set('page_size', String(pageSize));
    if (filterBy) params.set('filter_by', filterBy);
    if (query) params.set('query', query);
    if (timeframe) params.set('timeframe', timeframe);
    if (category) params.set('category', category);

    const url = `${METEORA_POOL_DISCOVERY_BASE}/pools?${params.toString()}`;

    try {
        const result = await fetchJson(url);
        return {
            pools: Array.isArray(result.data) ? result.data : [],
            total: result.total || 0,
        };
    } catch (err) {
        console.error(`[meteora-client] discoverPools failed: ${err.message}`);
        return null;
    }
}

/**
 * Find DLMM pools for a specific token by its mint address.
 *
 * The Meteora Pool Discovery `filter_by` clause does NOT support filtering by
 * token address directly (verified empirically). Instead we use the `query`
 * parameter, which matches pools by token symbol/name/mint. We then verify the
 * mint is actually present as token_x or token_y in each returned pool.
 *
 * @param {string} baseMint - token mint address to check
 * @param {Object} [opts]
 * @param {number} [opts.minTvl=0] - minimum TVL filter (applied client-side)
 * @param {string} [opts.quoteSymbol] - quote token filter, e.g. "SOL", "USDC" (client-side)
 * @returns {Promise<Array>} array of matching pools (empty = no pool found)
 */
async function findPoolsForToken(baseMint, { minTvl = 0, quoteSymbol } = {}) {
    if (!baseMint) return [];

    const result = await discoverPools({
        pageSize: 20,
        query: baseMint,
        filterBy: 'pool_type=dlmm',
        timeframe: '5m',
    });

    if (!result) return [];

    // Verify the mint is actually token_x or token_y (the `query` param is a fuzzy match)
    // and apply client-side TVL + quote filters.
    return result.pools
        .filter(pool => {
            const tx = pool.token_x?.address;
            const ty = pool.token_y?.address;
            if (tx !== baseMint && ty !== baseMint) return false;

            const tvl = Number(pool.tvl || pool.active_tvl || 0);
            if (minTvl > 0 && tvl < minTvl) return false;

            if (quoteSymbol) {
                const qx = pool.token_x?.symbol;
                const qy = pool.token_y?.symbol;
                if (qx !== quoteSymbol && qy !== quoteSymbol) return false;
            }

            return true;
        })
        .map(pool => ({
            pool_address: pool.pool_address || pool.address,
            name: pool.name || '',
            base_token_address: pool.token_x?.address || baseMint,
            base_symbol: pool.token_x?.symbol || '',
            quote_token_address: pool.token_y?.address || '',
            quote_symbol: pool.token_y?.symbol || '',
            tvl: pool.tvl || pool.active_tvl || 0,
            volume: pool.volume || 0,
            fee_active_tvl_ratio: pool.fee_active_tvl_ratio || 0,
            bin_step: pool.dlmm_params?.bin_step || 0,
            pool_type: pool.pool_type || 'dlmm',
        }));
}

/**
 * Quick check: does this token have at least one active DLMM pool?
 *
 * @param {string} baseMint - token mint address
 * @param {Object} [opts]
 * @param {number} [opts.minTvl=100] - minimum TVL to consider pool "active"
 * @returns {Promise<boolean>}
 */
async function hasActiveDlmmPool(baseMint, { minTvl = 100 } = {}) {
    const pools = await findPoolsForToken(baseMint, { minTvl });
    return pools.length > 0;
}

/**
 * Batch check multiple tokens for active DLMM pools.
 * Uses Promise.allSettled so one failure doesn't block others.
 *
 * @param {string[]} baseMints - array of token mint addresses
 * @param {Object} [opts]
 * @param {number} [opts.minTvl=100]
 * @returns {Promise<Map<string, Array>>} map of mint → pool array (empty if no pool)
 */
async function batchCheckDlmmPools(baseMints, { minTvl = 100 } = {}) {
    const results = new Map();

    if (!baseMints || baseMints.length === 0) return results;

    const settled = await Promise.allSettled(
        baseMints.map(async (mint) => {
            const pools = await findPoolsForToken(mint, { minTvl });
            return { mint, pools };
        })
    );

    for (const r of settled) {
        if (r.status === 'fulfilled') {
            results.set(r.value.mint, r.value.pools);
        } else {
            results.set(r.value?.mint, []);
        }
    }

    return results;
}

/**
 * Fetch detailed DLMM pool data (for PVP detection, bin info, etc.)
 * Uses the DLMM Datapi endpoint.
 *
 * @param {string} poolAddress - pool address
 * @returns {Promise<Object|null>}
 */
async function getPoolDetail(poolAddress) {
    if (!poolAddress) return null;

    try {
        const url = `${METEORA_DLMM_API_BASE}/pools/${poolAddress}`;
        return await fetchJson(url, 10000);
    } catch (err) {
        console.error(`[meteora-client] getPoolDetail failed for ${poolAddress}: ${err.message}`);
        return null;
    }
}

module.exports = {
    discoverPools,
    findPoolsForToken,
    hasActiveDlmmPool,
    batchCheckDlmmPools,
    getPoolDetail,
};
