const fetch = require('node-fetch'); // using native fetch, but we'll use global.fetch just in case
const _fetch = typeof fetch !== 'undefined' ? fetch : global.fetch;
const { spawn } = require('child_process');

function spawnAsync(command, args, options) {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, options);
        let stdout = '';
        let stderr = '';
        
        child.stdout.on('data', (data) => stdout += data.toString());
        child.stderr.on('data', (data) => stderr += data.toString());
        
        child.on('close', (code) => {
            if (code === 0) {
                resolve({ stdout, stderr });
            } else {
                const err = new Error(`Command failed with code ${code}`);
                err.stdout = stdout;
                err.stderr = stderr;
                reject(err);
            }
        });
        
        child.on('error', (err) => reject(err));
    });
}

async function fetchWithRetry(url, options = {}, maxRetries = 3) {
    let attempt = 0;
    
    if (url.includes('jup.ag')) {
        options.headers = options.headers || {};
        if (process.env.JUPITER_API_KEY) {
            options.headers['x-api-key'] = process.env.JUPITER_API_KEY;
        }
    }

    while (attempt < maxRetries) {
        try {
            const response = await _fetch(url, options);
            if (!response.ok) {
                // Rate limit (429) or Server error (5xx)
                if (response.status === 429 || response.status >= 500) {
                    throw new Error(`HTTP Error ${response.status}: ${response.statusText}`);
                }
                // Return response for other 4xx errors as retry won't help
                return response;
            }
            return response;
        } catch (error) {
            attempt++;
            if (attempt >= maxRetries) {
                throw new Error(`Failed to fetch ${url} after ${maxRetries} attempts: ${error.message}`);
            }
            const baseDelay = Math.pow(2, attempt - 1) * 1000;
            const jitter = Math.random() * 500;
            const delay = Math.min(baseDelay + jitter, 10000); 
            console.log(`[API Retry] Fetch failed. Attempt ${attempt}/${maxRetries}. Retrying in ${delay.toFixed(0)}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

async function rpcRetryWrapper(operation, maxRetries = 3) {
    let attempt = 0;
    while (attempt < maxRetries) {
        try {
            return await operation();
        } catch (error) {
            attempt++;
            if (attempt >= maxRetries) {
                throw new Error(`RPC operation failed after ${maxRetries} attempts: ${error.message}`);
            }
            
            console.log(`[RPC Retry] Operation failed: ${error.message}`);
            const delay = Math.pow(2, attempt - 1) * 1000; 
            console.log(`[RPC Retry] Attempt ${attempt}/${maxRetries}. Retrying in ${delay}ms...`);
            await new Promise(resolve => setTimeout(resolve, delay));
        }
    }
}

module.exports = {
    fetchWithRetry,
    rpcRetryWrapper,
    spawnAsync
};
