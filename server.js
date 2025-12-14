// ------------------------------
// Binance.US Spot Backend
// Open Positions + Break-even + P&L (RATE-LIMIT SAFE)
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
const BASE = "https://api.binance.us";
const FEE_RATE = parseFloat(process.env.BINANCE_FEE || 0.001);

// ------------------------------
// SIMPLE IN-MEMORY CACHE
// ------------------------------
const cache = {
    account: { data: null, ts: 0 },
    trades: {},   // symbol -> { data, ts }
    prices: {}    // symbol -> { price, ts }
};

const ACCOUNT_TTL = 5000;   // 5s
const TRADES_TTL  = 60000;  // 60s
const PRICE_TTL   = 5000;   // 5s

// ------------------------------
// SIGN QUERY
// ------------------------------
function signQuery(params) {
    const qs = new URLSearchParams(params).toString();
    const sig = crypto.createHmac("sha256", API_SECRET).update(qs).digest("hex");
    return qs + "&signature=" + sig;
}
const exchangeInfoCache = { data: null, ts: 0 };
const EXCHANGE_INFO_TTL = 60 * 60 * 1000; // 1 hour

async function getExchangeInfo() {
    if (exchangeInfoCache.data && Date.now() - exchangeInfoCache.ts < EXCHANGE_INFO_TTL) {
        return exchangeInfoCache.data;
    }

    const r = await axios.get(`${BASE}/api/v3/exchangeInfo`);
    exchangeInfoCache.data = r.data;
    exchangeInfoCache.ts = Date.now();
    return r.data;
}

function adjustToStepSize(qty, stepSize) {
    const precision = Math.round(Math.log10(1 / stepSize));
    return (Math.floor(qty / stepSize) * stepSize).toFixed(precision);
}

// ------------------------------
// CACHED HELPERS
// ------------------------------
async function getAccountCached() {
    if (cache.account.data && Date.now() - cache.account.ts < ACCOUNT_TTL) {
        return cache.account.data;
    }

    const qs = signQuery({ timestamp: Date.now() });
    const r = await axios.get(`${BASE}/api/v3/account?${qs}`, {
        headers: { "X-MBX-APIKEY": API_KEY }
    });

    cache.account = { data: r.data, ts: Date.now() };
    return r.data;
}

async function getTradesCached(symbol) {
    const c = cache.trades[symbol];
    if (c && Date.now() - c.ts < TRADES_TTL) return c.data;

    const q = `symbol=${symbol}&timestamp=${Date.now()}`;
    const sig = crypto.createHmac("sha256", API_SECRET).update(q).digest("hex");

    const r = await axios.get(`${BASE}/api/v3/myTrades?${q}&signature=${sig}`, {
        headers: { "X-MBX-APIKEY": API_KEY }
    });

    cache.trades[symbol] = { data: r.data, ts: Date.now() };
    return r.data;
}

async function getPriceCached(symbol) {
    const c = cache.prices[symbol];
    if (c && Date.now() - c.ts < PRICE_TTL) return c.price;

    const r = await axios.get(`${BASE}/api/v3/ticker/price?symbol=${symbol}`);
    const price = parseFloat(r.data.price);

    cache.prices[symbol] = { price, ts: Date.now() };
    return price;
}



app.use((req, res, next) => {
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    next();
});

// ------------------------------
// BALANCES
// ------------------------------
app.get("/balances", async (req, res) => {
    try {
        const acct = await getAccountCached();

        const balances = acct.balances
            .map(b => ({
                asset: b.asset,
                free: b.free,
                locked: b.locked,
                total: (parseFloat(b.free) + parseFloat(b.locked)).toFixed(8)
            }))
            .filter(b => parseFloat(b.total) > 0);

        res.json(balances);
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.post("/order", async (req, res) => {
    try {
        const {
            symbol,
            side,
            quantity,
            type = "MARKET",
            price,
            timeInForce
        } = req.body;

        if (!symbol || !side || !quantity) {
            return res.status(400).json({ error: "Missing required parameters" });
        }

        const info = await getExchangeInfo();
        const sym = info.symbols.find(s => s.symbol === symbol);
        if (!sym) return res.status(400).json({ error: "Unknown symbol" });

        const lot = sym.filters.find(f => f.filterType === "LOT_SIZE");
        const stepSize = parseFloat(lot.stepSize);
        const minQty = parseFloat(lot.minQty);

        let qty = parseFloat(quantity);
        qty = parseFloat(adjustToStepSize(qty, stepSize));

        if (qty < minQty) {
            return res.status(400).json({
                error: `Quantity ${qty} < minQty ${minQty}`
            });
        }

        const params = {
            symbol,
            side,
            type,
            quantity: qty,
            timestamp: Date.now()
        };

        if (type === "LIMIT") {
            if (!price) {
                return res.status(400).json({ error: "LIMIT requires price" });
            }
            params.price = price;
            params.timeInForce = timeInForce || "GTC";
        }

        const qs = signQuery(params);

        const r = await axios.post(
            `${BASE}/api/v3/order?${qs}`,
            null,
            { headers: { "X-MBX-APIKEY": API_KEY } }
        );

        res.json(r.data);

    } catch (e) {
        console.error("Order error:", e.response?.data || e.message);
        res.status(500).json(e.response?.data || { error: e.message });
    }
});



// ------------------------------
// POSITIONS (OPEN ONLY, >$10, FIFO, FEES)
// ------------------------------
app.get("/positions", async (req, res) => {
    try {
        const acct = await getAccountCached();
        console.log("Calculating positions for account:", acct.accountType);
        const assets = acct.balances
            .map(b => ({
                asset: b.asset,
                qty: parseFloat(b.free) + parseFloat(b.locked)
            }))
            .filter(b =>
                b.qty > 0 &&
                !["USD", "USDT", "USDC"].includes(b.asset)
            );

        const positions = [];

        for (const a of assets) {
            const symbolCandidates = [
                `${a.asset}USDT`,
                `${a.asset}USDC`,
                `${a.asset}USD`
            ];

            let symbol = null;
            let trades = null;
            let price = null;

            // Resolve correct symbol safely
            for (const s of symbolCandidates) {
                try {
                    const t = await getTradesCached(s);
                    if (!t.length) continue;

                    symbol = s;
                    trades = t;
                    price = await getPriceCached(s);
                    break;
                } catch {}
            }

            if (!symbol || !trades || price === null) continue;

            // FIFO open-position calculation
            let openQty = 0;
            let openCost = 0;

            for (const t of trades) {
                const qty = parseFloat(t.qty);
                const p = parseFloat(t.price);
                const fee = qty * p * FEE_RATE;

                if (t.isBuyer) {
                    openQty += qty;
                    openCost += qty * p + fee;
                } else if (openQty > 0) {
                    const avg = openCost / openQty;
                    openQty -= qty;
                    openCost -= qty * avg;
                    if (openQty < 0) openQty = 0;
                    if (openCost < 0) openCost = 0;
                }
            }

            if (openQty <= 0) continue;

            const value = openQty * price;
            if (value < 10) continue; // 🔥 filter <$10

            const breakEven = openCost / openQty;
            const pnl = (price - breakEven) * openQty;

            positions.push({
                symbol,
                positionAmt: openQty.toFixed(8),
                breakEven: breakEven.toFixed(8),
                entryPrice: breakEven.toFixed(8),
                currentPrice: price.toFixed(8),
                marketValue: value.toFixed(2),
                unrealizedPL: pnl.toFixed(2)
            });
        }

        res.json(positions);

    } catch (e) {
        console.error("Positions error:", e.message);
        res.status(500).json({ error: e.message });
    }
});

// ------------------------------
// BREAK-EVEN (CONSISTENT WITH POSITIONS)
// ------------------------------
app.get("/breakeven/:symbol", async (req, res) => {
    try {
        const symbol = req.params.symbol.toUpperCase();
        const trades = await getTradesCached(symbol);

        let qty = 0;
        let cost = 0;

        for (const t of trades) {
            const q = parseFloat(t.qty);
            const p = parseFloat(t.price);
            const fee = q * p * FEE_RATE;

            if (t.isBuyer) {
                qty += q;
                cost += q * p + fee;
            } else if (qty > 0) {
                const avg = cost / qty;
                qty -= q;
                cost -= q * avg;
            }
        }

        const be = qty > 0 ? cost / qty : 0;

        res.json({
            breakEven: be.toFixed(8),
            averagePrice: be.toFixed(8),
            totalQuantity: qty.toFixed(8)
        });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// ------------------------------
app.listen(5000, '0.0.0.0', () => {
  console.log("Server running on 0.0.0.0:5000");
});
