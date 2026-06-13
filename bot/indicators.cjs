function calculateRSI(closes, period) {
    if (closes.length < period + 1) return [];
    
    let gains = 0;
    let losses = 0;
    
    for (let i = 1; i <= period; i++) {
        const diff = closes[i] - closes[i - 1];
        if (diff >= 0) gains += diff;
        else losses -= diff;
    }
    
    let avgGain = gains / period;
    let avgLoss = losses / period;
    
    const rsi = new Array(closes.length).fill(null);
    if (avgLoss === 0) rsi[period] = 100;
    else rsi[period] = 100 - (100 / (1 + avgGain / avgLoss));
    
    for (let i = period + 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i - 1];
        const gain = diff >= 0 ? diff : 0;
        const loss = diff < 0 ? -diff : 0;
        
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        
        if (avgLoss === 0) {
            rsi[i] = 100;
        } else {
            rsi[i] = 100 - (100 / (1 + avgGain / avgLoss));
        }
    }
    
    return rsi;
}

function calculateEMA(data, period) {
    const k = 2 / (period + 1);
    const ema = new Array(data.length).fill(null);
    
    if (data.length < period) return ema;
    
    let sum = 0;
    for (let i = 0; i < period; i++) sum += data[i];
    ema[period - 1] = sum / period;
    
    for (let i = period; i < data.length; i++) {
        ema[i] = (data[i] - ema[i - 1]) * k + ema[i - 1];
    }
    return ema;
}

function calculateMACD(closes, fastPeriod, slowPeriod, signalPeriod) {
    const fastEMA = calculateEMA(closes, fastPeriod);
    const slowEMA = calculateEMA(closes, slowPeriod);
    
    const macdLine = new Array(closes.length).fill(null);
    for (let i = slowPeriod - 1; i < closes.length; i++) {
        macdLine[i] = fastEMA[i] - slowEMA[i];
    }
    
    const validMacd = macdLine.filter(val => val !== null);
    const signalLineRaw = calculateEMA(validMacd, signalPeriod);
    
    const signalLine = new Array(closes.length).fill(null);
    for (let i = 0; i < signalLineRaw.length; i++) {
        signalLine[closes.length - signalLineRaw.length + i] = signalLineRaw[i];
    }
    
    const histogram = new Array(closes.length).fill(null);
    for (let i = 0; i < closes.length; i++) {
        if (macdLine[i] !== null && signalLine[i] !== null) {
            histogram[i] = macdLine[i] - signalLine[i];
        }
    }
    
    return { macdLine, signalLine, histogram };
}

function calculateSMA(data, period) {
    const sma = new Array(data.length).fill(null);
    for (let i = period - 1; i < data.length; i++) {
        let sum = 0;
        for (let j = 0; j < period; j++) sum += data[i - j];
        sma[i] = sum / period;
    }
    return sma;
}

function calculateStandardDeviation(data, sma, period) {
    const stdDev = new Array(data.length).fill(null);
    for (let i = period - 1; i < data.length; i++) {
        let sum = 0;
        for (let j = 0; j < period; j++) {
            sum += Math.pow(data[i - j] - sma[i], 2);
        }
        stdDev[i] = Math.sqrt(sum / period);
    }
    return stdDev;
}

function calculateBollingerBands(closes, period, multiplier) {
    const sma = calculateSMA(closes, period);
    const stdDev = calculateStandardDeviation(closes, sma, period);
    
    const upperBand = new Array(closes.length).fill(null);
    const lowerBand = new Array(closes.length).fill(null);
    
    for (let i = period - 1; i < closes.length; i++) {
        upperBand[i] = sma[i] + (stdDev[i] * multiplier);
        lowerBand[i] = sma[i] - (stdDev[i] * multiplier);
    }
    
    return { middle: sma, upper: upperBand, lower: lowerBand };
}

module.exports = {
    calculateRSI,
    calculateMACD,
    calculateBollingerBands
};
