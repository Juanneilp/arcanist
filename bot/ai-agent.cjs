const fs = require('fs');
const path = require('path');
require('./envcrypt.cjs').loadEnv();

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
            if (!data.choices || data.choices.length === 0 || !data.choices[0].message) {
                throw new Error("Invalid response structure from AI API: " + JSON.stringify(data));
            }
            return data.choices[0].message.content || "";
        } catch (e) {
            console.warn(`[AI API] Attempt ${attempt}/${retries} failed: ${e.message}`);
            if (attempt === retries) throw e;
            // Wait 2 seconds before retrying
            await new Promise(res => setTimeout(res, 2000));
        }
    }
}

async function askAI(promptText) {
    // --- PATCH 3: Input Sanitization ---
    if (promptText.length > 500) {
        promptText = promptText.substring(0, 500);
    }
    promptText = promptText.replace(/```(system|user|assistant|instruction)/gi, '')
                           .replace(/\[\/?INST\]/gi, '')
                           .replace(/<[^>]*>/g, ''); // strip XML/HTML tags
                           
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
    if (candidates.length === 0) {
        return candidates; 
    }
    
    const configPath = path.join(__dirname, '..', 'user-config.json');
    let config = {};
    try {
        config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch (e) {
        console.warn("Could not read user-config.json for AI settings.");
    }
    
    let mindsetData = "";
    try {
        const mindsetPath = path.join(__dirname, '..', 'hermes-mindset.json');
        if (fs.existsSync(mindsetPath)) {
            mindsetData = fs.readFileSync(mindsetPath, 'utf-8');
        }
    } catch (e) {
        console.warn("Could not read hermes-mindset.json.");
    }

    const model = process.env.AI_MODEL || config.aiConfig?.model || "nousresearch/hermes-3-llama-3.1-405b";
    const baseUrl = process.env.AI_BASE_URL || config.aiConfig?.baseUrl || "https://openrouter.ai/api/v1";
    let systemPrompt = config.aiConfig?.systemPrompt || "You are Hermes Agent, an elite crypto trading analyst.";
    
    if (mindsetData) {
        systemPrompt += `\n\n=== HERMES AI CORE MINDSET & STRATEGY ===\n${mindsetData}\n=========================================\n`;
        systemPrompt += `Please strictly apply the coreStrategy and rankingScoringSystem defined above when evaluating candidates.`;
    }
    
    // Reduce payload size to prevent 504 timeouts
    const essentialCandidates = candidates.map(c => ({
        name: c.name,
        symbol: c.symbol,
        address: c.address,
        price: c.price,
        volume: c.volume,
        market_cap: c.market_cap,
        history_highest_market_cap: c.history_highest_market_cap,
        holder_count: c.holder_count,
        smart_degen_count: c.smart_degen_count,
        is_honeypot: c.is_honeypot,
        volume_trend: c.volumeTrend,
        volume_change_percent: c.volumeChangePercent,
        is_new_ath: c.is_new_ath,
        top_10_holder_percent: c.top_10_holder_percent || "Unknown",
        dev_holds_percent: c.dev_holds_percent || "Unknown",
        is_lp_burnt: c.is_lp_burnt !== undefined ? c.is_lp_burnt : "Unknown"
    }));

    let promptText = "";
    if (candidates.length <= maxLimit) {
        promptText = `
I have ${candidates.length} token candidate(s). Please analyze and SORT ALL of them from BEST to WORST based on the strategy. You MUST return EXACTLY ${candidates.length} tokens in the JSON array.

CRITICAL RANKING RULE:
You MUST prioritize tokens based on the 'rankingScoringSystem' from your Core Mindset. Focus on ATH Breakouts, Volume Momentum, and Safety Metrics (LP Burnt, Low Top 10 Holders).

Return ONLY a valid JSON array of objects, sorted from best to worst. Each object MUST have exactly two fields: "address" (the token address) and "ai_reason" (string explaining in Indonesian why it was ranked at this position based on the strategy, max 2 sentences). Do not include markdown formatting like \`\`\`json.

Candidates:
${JSON.stringify(essentialCandidates, null, 2)}
`;
    } else {
        promptText = `
I have ${candidates.length} token candidates, but I can only enter ${maxLimit} positions. 
Please analyze the candidates and select the best ${maxLimit}, sorted from best to worst. You MUST return EXACTLY ${maxLimit} tokens in the JSON array.

CRITICAL RANKING RULE:
You MUST prioritize tokens based on the 'rankingScoringSystem' from your Core Mindset. Focus on ATH Breakouts, Volume Momentum, and Safety Metrics (LP Burnt, Low Top 10 Holders).

Return ONLY a valid JSON array of objects, sorted from best to worst. Each object MUST have exactly two fields: "address" (the token address) and "ai_reason" (string explaining in Indonesian why it was chosen based on the strategy, max 2 sentences). Do not include markdown formatting like \`\`\`json.

Candidates:
${JSON.stringify(essentialCandidates, null, 2)}
`;
    }

    const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: promptText }
    ];
    
    let finalSelection = [];
    try {
        console.log(`Asking AI (${model} via ${baseUrl}) to screen ${candidates.length} candidates down to ${maxLimit}...`);
        let responseContent = await callOpenRouter(messages, model, baseUrl);
        
        if (!responseContent) {
            throw new Error("AI returned empty or null response");
        }
        
        responseContent = responseContent.replace(/```json/g, '').replace(/```/g, '').trim();
        let selected;
        try {
            selected = JSON.parse(responseContent);
        } catch (parseError) {
            console.error("AI JSON parse failed. Raw response:", responseContent.substring(0, 500));
            console.error("Parse error:", parseError.message);
            throw parseError;
        }
        
        if (Array.isArray(selected) && selected.length > 0) {
            for (const sel of selected) {
                const original = candidates.find(c => c.address === sel.address);
                if (original) {
                    original.ai_reason = sel.ai_reason;
                    finalSelection.push(original);
                }
            }
        } else {
            console.warn("AI returned malformed selection or no match. Falling back to default order.");
            finalSelection = candidates.slice(0, maxLimit);
            finalSelection.forEach(c => {
                if (!c.ai_reason) c.ai_reason = "⚠️ AI mengembalikan format yang salah, fallback ke urutan scraper.";
            });
        }
    } catch (e) {
        console.error("AI screening failed. Falling back to default order.", e.message);
        finalSelection = candidates.slice(0, maxLimit);
        finalSelection.forEach(c => {
            if (!c.ai_reason) c.ai_reason = "⚠️ AI API Error/Timeout, fallback ke urutan scraper.";
        });
    }
    
    return finalSelection.slice(0, maxLimit);
}

module.exports = {
    askAI,
    screenCandidates
};
