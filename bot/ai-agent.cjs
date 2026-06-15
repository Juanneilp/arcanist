const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const AI_API_KEY = process.env.AI_API_KEY || process.env.OPENROUTER_API_KEY;

async function callOpenRouter(messages, model, baseUrl = "https://openrouter.ai/api/v1", retries = 3) {
    if (!AI_API_KEY || AI_API_KEY === 'your_ai_provider_api_key' || AI_API_KEY === 'your_openrouter_key') {
        throw new Error("AI_API_KEY is not set in .env.");
    }
    
    const cleanBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    const endpoint = `${cleanBaseUrl}/chat/completions`;

    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const response = await fetch(endpoint, {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${AI_API_KEY}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify({
                    model: model,
                    messages: messages
                })
            });
            
            if (!response.ok) {
                throw new Error(`AI API error: ${response.status} ${response.statusText}`);
            }
            
            const data = await response.json();
            return data.choices[0].message.content;
        } catch (e) {
            console.warn(`[AI API] Attempt ${attempt}/${retries} failed: ${e.message}`);
            if (attempt === retries) throw e;
            // Wait 2 seconds before retrying
            await new Promise(res => setTimeout(res, 2000));
        }
    }
}

async function askAI(promptText) {
    const configPath = path.join(__dirname, '..', 'user-config.json');
    let config = {};
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (e) {
        console.warn("Could not read user-config.json for AI settings. Using defaults.");
    }
    
    const model = process.env.AI_MODEL || config.aiConfig?.model || "nousresearch/hermes-3-llama-3.1-405b";
    const baseUrl = process.env.AI_BASE_URL || config.aiConfig?.baseUrl || "https://openrouter.ai/api/v1";
    const systemPrompt = config.aiConfig?.systemPrompt || "You are a helpful assistant.";
    
    const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: promptText }
    ];
    
    return await callOpenRouter(messages, model, baseUrl);
}

async function screenCandidates(candidates, maxLimit) {
    if (candidates.length <= maxLimit) {
        return candidates; 
    }
    
    // 1. Prioritize ATH Candidates
    const athCandidates = candidates.filter(c => c.is_new_ath);
    let normalCandidates = candidates.filter(c => !c.is_new_ath);
    
    let finalSelection = [];
    
    if (athCandidates.length > 0) {
        console.log(`[AI-Agent] Found ${athCandidates.length} ATH candidate(s). Prioritizing them...`);
        athCandidates.forEach(c => {
            if (!c.ai_reason) c.ai_reason = "🚀 Terdeteksi Breakout New ATH! (Prioritas Utama)";
        });
        
        // Sort ATH candidates by volume change percent just in case there are multiple
        athCandidates.sort((a, b) => (b.volumeChangePercent || 0) - (a.volumeChangePercent || 0));
        finalSelection.push(...athCandidates.slice(0, maxLimit));
    }
    
    const remainingSlotsAfterATH = maxLimit - finalSelection.length;
    
    // 2. Prioritize Best Volume Trend
    if (remainingSlotsAfterATH > 0 && normalCandidates.length > 0) {
        normalCandidates.sort((a, b) => (b.volumeChangePercent || 0) - (a.volumeChangePercent || 0));
        
        // Take the top volume trend candidate
        const bestVolCandidate = normalCandidates.shift(); // removes and returns the first element
        console.log(`[AI-Agent] Prioritizing Best Volume Trend candidate: ${bestVolCandidate.symbol} (${bestVolCandidate.volumeChangePercent?.toFixed(2)}%)`);
        
        if (!bestVolCandidate.ai_reason) {
            bestVolCandidate.ai_reason = `🌊 Volume Trend Terbaik (${bestVolCandidate.volumeChangePercent?.toFixed(1)}% Spike). (Prioritas Otomatis)`;
        }
        finalSelection.push(bestVolCandidate);
    }
    
    const remainingSlots = maxLimit - finalSelection.length;
    
    if (remainingSlots > 0 && normalCandidates.length > 0) {
        if (normalCandidates.length <= remainingSlots) {
            finalSelection.push(...normalCandidates);
        } else {
            const configPath = path.join(__dirname, '..', 'user-config.json');
            let config = {};
            try {
                config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
            } catch (e) {
                console.warn("Could not read user-config.json for AI settings.");
            }
            
            const model = process.env.AI_MODEL || config.aiConfig?.model || "nousresearch/hermes-3-llama-3.1-405b";
            const baseUrl = process.env.AI_BASE_URL || config.aiConfig?.baseUrl || "https://openrouter.ai/api/v1";
            const systemPrompt = config.aiConfig?.systemPrompt || "You are Hermes Agent, an elite crypto trading analyst.";
            
            // Reduce payload size to prevent 504 timeouts
            const essentialCandidates = normalCandidates.map(c => ({
                name: c.name,
                symbol: c.symbol,
                address: c.address,
                price: c.price,
                volume: c.volume,
                market_cap: c.market_cap,
                holder_count: c.holder_count,
                smart_degen_count: c.smart_degen_count,
                is_honeypot: c.is_honeypot,
                volume_trend: c.volumeTrend,
                volume_change_percent: c.volumeChangePercent
            }));

            const promptText = `
I have ${normalCandidates.length} token candidates, but I can only enter ${remainingSlots} positions. 
Please analyze the following candidates and select the best ${remainingSlots}.

CRITICAL RANKING RULE:
You MUST prioritize tokens based on 'volume_change_percent' (Volume Trend Analysis). For our wide-range Liquidity Pool strategy, sustained volume is the absolute most important metric.
1. Higher 'volume_change_percent' is always better (positive means accelerating, near zero means highly stable).
2. Tokens with lower/negative 'volume_change_percent' MUST be ranked lower or rejected, even if they have higher market cap, holder count, or smart degen count.

Return ONLY a valid JSON array of objects, sorted from best to worst. Each object MUST have exactly two fields: "address" (the token address) and "ai_reason" (string explaining in Indonesian why it was chosen, specifically mentioning its Volume Trend data, max 2 sentences). Do not include markdown formatting like \`\`\`json.

Candidates:
${JSON.stringify(essentialCandidates, null, 2)}
`;

            const messages = [
                { role: "system", content: systemPrompt },
                { role: "user", content: promptText }
            ];
            
            try {
                console.log(`Asking AI (${model} via ${baseUrl}) to screen ${normalCandidates.length} candidates down to ${remainingSlots}...`);
                let responseContent = await callOpenRouter(messages, model, baseUrl);
                
                responseContent = responseContent.replace(/```json/g, '').replace(/```/g, '').trim();
                const selected = JSON.parse(responseContent);
                
                if (Array.isArray(selected) && selected.length > 0) {
                    for (const sel of selected) {
                        const original = normalCandidates.find(c => c.address === sel.address);
                        if (original) {
                            original.ai_reason = sel.ai_reason;
                            finalSelection.push(original);
                        }
                    }
                } else {
                    console.warn("AI returned malformed selection or no match. Falling back to simple slice.");
                    finalSelection.push(...normalCandidates.slice(0, remainingSlots));
                }
            } catch (e) {
                console.error("AI screening failed. Falling back to simple slice.", e.message);
                finalSelection.push(...normalCandidates.slice(0, remainingSlots));
            }
        }
    }
    
    // Final safety slice to ensure we don't exceed maxLimit
    return finalSelection.slice(0, maxLimit);
}

module.exports = {
    askAI,
    screenCandidates
};
