const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const AI_API_KEY = process.env.AI_API_KEY || process.env.OPENROUTER_API_KEY;

async function callOpenRouter(messages, model, baseUrl = "https://openrouter.ai/api/v1") {
    if (!AI_API_KEY || AI_API_KEY === 'your_ai_provider_api_key' || AI_API_KEY === 'your_openrouter_key') {
        throw new Error("AI_API_KEY is not set in .env.");
    }
    
    const cleanBaseUrl = baseUrl.endsWith('/') ? baseUrl.slice(0, -1) : baseUrl;
    const endpoint = `${cleanBaseUrl}/chat/completions`;

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
    
    const promptText = `
I have ${candidates.length} token candidates, but I can only enter ${maxLimit} positions. 
Please analyze the following candidates and select the best ${maxLimit}.
Return ONLY a valid JSON array containing the selected token objects, matching exactly the structure provided, but ADD a new string field called "ai_reason" to each selected token object explaining exactly why it was chosen (in Indonesian, max 2 sentences). Do not include markdown formatting like \`\`\`json.

Candidates:
${JSON.stringify(candidates, null, 2)}
`;

    const messages = [
        { role: "system", content: systemPrompt },
        { role: "user", content: promptText }
    ];
    
    try {
        console.log(`Asking AI (${model} via ${baseUrl}) to screen ${candidates.length} candidates down to ${maxLimit}...`);
        let responseContent = await callOpenRouter(messages, model, baseUrl);
        
        responseContent = responseContent.replace(/```json/g, '').replace(/```/g, '').trim();
        const selected = JSON.parse(responseContent);
        
        if (Array.isArray(selected) && selected.length <= maxLimit) {
            return selected;
        } else {
            console.warn("AI returned malformed JSON or exceeded limit. Falling back to simple slice.");
            return candidates.slice(0, maxLimit);
        }
    } catch (e) {
        console.error("AI screening failed. Falling back to simple slice.", e.message);
        return candidates.slice(0, maxLimit);
    }
}

module.exports = {
    askAI,
    screenCandidates
};
