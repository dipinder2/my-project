// ------------------------------
// Binance.US API keys
// ------------------------------
const express = require("express");
const axios = require("axios");
const crypto = require("crypto");
const cors = require("cors");
const dotenv = require("dotenv");
dotenv.config();
const app = express();
app.use(express.json());
app.use(cors());


const API_KEY = process.env.BINANCE_API_KEY;
const API_SECRET = process.env.BINANCE_API_SECRET;
const BASE = 'https://api.binance.us';
console.log("Using API Key:", API_KEY);
// ----------------------------------------
// SIGN REQUEST
// ----------------------------------------
function signQuery(params) {
    const qs = new URLSearchParams(params).toString();
    const sig = crypto
        .createHmac("sha256", API_SECRET)
        .update(qs)
        .digest("hex");
    return qs + "&signature=" + sig;
}

// ----------------------------------------
// HELPER: COUNT DECIMALS
// ----------------------------------------
function countDecimals(num) {
    const s = num.toString();
    if (s.includes("e") || s.includes("E")) {
        const [base, exp] = s.split(/e/i);
        const e = parseInt(exp, 10);
        const dec = (base.split('.')[1] || '').length;
        return Math.max(0, dec - e);
    }
    if (s.indexOf('.') >= 0) return s.split('.')[1].length;
    return 0;
}

// ----------------------------------------
// HELPER: ROUND PRICE
// ----------------------------------------
function roundPrice(price, tickSize) {
    const decimals = countDecimals(tickSize);
    return (Math.floor(price / tickSize) * tickSize).toFixed(decimals);
}

// ----------------------------------------
// HELPER: ADJUST QTY TO LOT_SIZE
// ----------------------------------------
function adjustQtyForLotSize(qty, stepSize, minQty) {
    let n = Math.floor(qty / stepSize) * stepSize;
    if (n < minQty) n = minQty;
    const decimals = countDecimals(stepSize);
    return n.toFixed(decimals);
}

// ----------------------------------------
// HELPER: GET QUOTE CURRENCY
// ----------------------------------------
function getQuoteCurrency(symbol) {
    if (symbol.endsWith("USDT")) return "USDT";
    if (symbol.endsWith("USDC")) return "USDC";
    if (symbol.endsWith("USD")) return "USD";
    return null;
}

// ----------------------------------------
// GET FILTERS (LOT_SIZE + PRICE_FILTER)
// ----------------------------------------
async function getFilters(symbol) {
    const r = await axios.get(`${BASE}/api/v3/exchangeInfo?symbol=${symbol}`);
    const fs = r.data.symbols[0].filters;

    const lot = fs.find(f => f.filterType === "LOT_SIZE");
    const priceFilter = fs.find(f => f.filterType === "PRICE_FILTER");

    return {
        minQty: parseFloat(lot.minQty),
        stepSize: parseFloat(lot.stepSize),
        tickSize: parseFloat(priceFilter.tickSize),
    };
}

// ----------------------------------------
// GET BALANCES
// ----------------------------------------
app.get("/balances", async (req, res) => {
    try {
        const ts = Date.now();
        const query = signQuery({ timestamp: ts });

        const r = await axios.get(`${BASE}/api/v3/account?${query}`, {
            headers: { "X-MBX-APIKEY": API_KEY }
        });

        const balances = r.data.balances
            .map(b => ({
                asset: b.asset,
                free: b.free,
                locked: b.locked,
                total: (parseFloat(b.free) + parseFloat(b.locked)).toFixed(12)
            }))
            .filter(b => parseFloat(b.total) > 0);

        res.json(balances);
    } catch (err) {
        res.status(500).json({ error: err.response?.data || err.message });
    }
});

// ----------------------------------------
// PLACE ORDER
// ----------------------------------------
app.post("/order", async (req, res) => {
    try {
        const { symbol, side, quantity, price, usdAmount } = req.body;

        if (!symbol || !side || (!quantity && !usdAmount) || !price) {
            return res.status(400).json({ error: "Missing required fields" });
        }

        const filters = await getFilters(symbol);
        const quote = getQuoteCurrency(symbol);

        let qty;

        if (quantity) {
            // Use frontend-calculated quantity directly
            qty = Number(quantity);
        } else if (usdAmount) {
            // Calculate quantity from USD amount
            qty = usdAmount / price;
        } else {
            return res.status(400).json({ error: "Quantity or USD amount required" });
        }

        // SELL: if quantity not provided, use all base asset
        if (side === "SELL" && !quantity) {
            const base = symbol.replace(quote, "");
            const bals = await axios.get("http://localhost:5000/balances");
            const bal = bals.data.find(b => b.asset === base);
            if (!bal) return res.status(400).json({ error: `No balance found for ${base}` });
            qty = parseFloat(bal.total);
        }

        // Adjust quantity to LOT_SIZE
        const finalQty = adjustQtyForLotSize(qty, filters.stepSize, filters.minQty);

        // Round price to tickSize
        const finalPrice = roundPrice(price, filters.tickSize);

        const params = {
            symbol,
            side,
            type: "LIMIT",
            timeInForce: "GTC",
            quantity: finalQty,
            price: finalPrice,
            timestamp: Date.now()
        };

        const qs = signQuery(params);

        const r = await axios.post(`${BASE}/api/v3/order`, qs, {
            headers: { "X-MBX-APIKEY": API_KEY }
        });

        res.json(r.data);

    } catch (err) {
        console.log("ORDER ERROR:", err.response?.data || err.message);
        res.status(500).json({ error: err.response?.data || err.message });
    }
});

// ----------------------------------------
app.listen(5000, () => console.log("Binance.US local API running on http://localhost:5000"));
