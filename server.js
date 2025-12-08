// ----------------------------------------
// IN-MEMORY POSITION TRACKING
// ----------------------------------------
const positions = {};  
// positions[symbol] = { totalQty, totalCost, avgPrice, breakEven }

// ----------------------------------------
// PLACE ORDER + TRACK AVERAGE PRICE
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
            qty = Number(quantity);
        } else if (usdAmount) {
            qty = usdAmount / price;
        } else {
            return res.status(400).json({ error: "Quantity or USD amount required" });
        }

        // SELL: if quantity not provided use all base asset
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

        // -----------------------------
        // POSITION TRACKING CALCULATIONS
        // -----------------------------
        if (!positions[symbol]) {
            positions[symbol] = {
                totalQty: 0,
                totalCost: 0,
                avgPrice: 0,
                breakEven: 0
            };
        }

        const pos = positions[symbol];

        if (side === "BUY") {
            const cost = qty * price;
            pos.totalQty += qty;
            pos.totalCost += cost;
            pos.avgPrice = pos.totalCost / pos.totalQty;
            pos.breakEven = pos.avgPrice; 
        }

        if (side === "SELL") {
            const proceeds = qty * price;
            // Adjust cost basis proportionally
            const costPortion = pos.avgPrice * qty;
            pos.totalQty -= qty;
            pos.totalCost -= costPortion;

            if (pos.totalQty <= 0) {
                pos.totalQty = 0;
                pos.totalCost = 0;
                pos.avgPrice = 0;
                pos.breakEven = 0;
            } else {
                pos.avgPrice = pos.totalCost / pos.totalQty;
                pos.breakEven = pos.avgPrice;
            }
        }

        return res.json({
            orderResponse: r.data,
            position: {
                symbol,
                totalQty: pos.totalQty,
                totalCost: pos.totalCost,
                avgPrice: pos.avgPrice,
                breakEven: pos.breakEven
            }
        });

    } catch (err) {
        console.log("ORDER ERROR:", err.response?.data || err.message);
        res.status(500).json({ error: err.response?.data || err.message });
    }
});
