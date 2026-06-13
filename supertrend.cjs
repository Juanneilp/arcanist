// supertrend.cjs
// Helper module to compute Average True Range (ATR) and Supertrend indicator.

function calculateATR(data, period) {
    let atr = [];
    let tr = [];
    
    for (let i = 0; i < data.length; i++) {
        if (i === 0) {
            tr.push(data[i].high - data[i].low);
        } else {
            const highLow = data[i].high - data[i].low;
            const highClose = Math.abs(data[i].high - data[i - 1].close);
            const lowClose = Math.abs(data[i].low - data[i - 1].close);
            tr.push(Math.max(highLow, highClose, lowClose));
        }
    }
    
    // First ATR is the simple average of the TR over the period
    let sum = 0;
    for (let i = 0; i < period; i++) {
        sum += tr[i];
    }
    
    for (let i = 0; i < period - 1; i++) {
        atr.push(null);
    }
    atr.push(sum / period);
    
    // Using RMA (Wilder's Smoothing) for subsequent ATR values
    for (let i = period; i < data.length; i++) {
        atr.push((atr[i - 1] * (period - 1) + tr[i]) / period);
    }
    
    return atr;
}

function calculateSupertrend(data, period, multiplier) {
    if (!data || data.length < period) {
        return null;
    }
    
    const atr = calculateATR(data, period);
    
    let upperband = new Array(data.length).fill(null);
    let lowerband = new Array(data.length).fill(null);
    let supertrend = new Array(data.length).fill(null);
    let trend = new Array(data.length).fill(1); // 1 for Bullish, -1 for Bearish
    
    for (let i = period; i < data.length; i++) {
        const hl2 = (data[i].high + data[i].low) / 2;
        const basicUb = hl2 + (multiplier * atr[i]);
        const basicLb = hl2 - (multiplier * atr[i]);
        
        // Final Upper Band
        if (i === period) {
            upperband[i] = basicUb;
            lowerband[i] = basicLb;
            supertrend[i] = upperband[i]; // Default to downtrend initially if no context
        } else {
            if (basicUb < upperband[i - 1] || data[i - 1].close > upperband[i - 1]) {
                upperband[i] = basicUb;
            } else {
                upperband[i] = upperband[i - 1];
            }
            
            // Final Lower Band
            if (basicLb > lowerband[i - 1] || data[i - 1].close < lowerband[i - 1]) {
                lowerband[i] = basicLb;
            } else {
                lowerband[i] = lowerband[i - 1];
            }
        }
        
        // Trend Direction
        if (i === period) {
            trend[i] = data[i].close > upperband[i] ? 1 : -1;
        } else {
            if (supertrend[i - 1] === upperband[i - 1] && data[i].close > upperband[i]) {
                trend[i] = 1;
            } else if (supertrend[i - 1] === lowerband[i - 1] && data[i].close < lowerband[i]) {
                trend[i] = -1;
            } else {
                trend[i] = trend[i - 1];
            }
        }
        
        // Supertrend line
        if (trend[i] === 1) {
            supertrend[i] = lowerband[i];
        } else {
            supertrend[i] = upperband[i];
        }
    }
    
    return {
        trend,
        supertrend,
        upperband,
        lowerband
    };
}

module.exports = {
    calculateSupertrend
};
