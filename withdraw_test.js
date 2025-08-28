// withdraw_rate_limit_test.js
import fetch from "node-fetch";

const TG_CASINO_AUTH = process.env.TG_CASINO_AUTH;
if (!TG_CASINO_AUTH) {
    console.error("❌ Please set TG_CASINO_AUTH env var first");
    process.exit(1);
}

// Set your SOL address here
const SOL_ADDRESS = "5wqHjxk5VhRTUc9Gavgtan3MN5k31ETjDvnU7x4MPRHr";
const BASE = "https://tg-cas-core.tgbackend.com";

// Delay between withdrawal attempts (ms) to avoid 429s
const DELAY_MS = 8000;

// Crafted test amounts
const TEST_AMOUNTS = [
    "0.0001",                  // below min
    "0.001",                   // below min
    "0.005",                   // probing low
    "0.01",                    // known OK
    "0.064996",                // just under balance
    "0.074996",                // over balance
    (309 / 308).toString(),      // fractional idea
    "0.010000000000000002",    // FP edge
    "1.003e0",                 // sci notation
    "0000.01"                  // padded
];

async function pause(ms) {
    return new Promise(res => setTimeout(res, ms));
}

async function safeFetch(url, opts = {}) {
    const res = await fetch(url, {
        ...opts,
        headers: {
            "content-type": "application/json",
            "tg-casino-auth": TG_CASINO_AUTH,
            ...(opts.headers || {})
        }
    });
    const text = await res.text();
    let json;
    try { json = JSON.parse(text); } catch { }
    return { status: res.status, ok: res.ok, text, json };
}

async function getSolBalance() {
    const me = await safeFetch(`${BASE}/users/me`);
    const bal = me.json?.balances?.find(b => b.currencyCode === "SOL");
    return { me, bal: bal ? parseFloat(bal.balance) : null };
}

(async () => {
    console.log("=== Auth Check ===");
    const { me, bal } = await getSolBalance();
    console.log(me.status, me.ok ? "OK" : "FAIL");
    if (!me.ok) {
        console.error("❌ Auth failed");
        process.exit(1);
    }
    const bhUserId = me.json.user.bhUserId;
    console.log(`BHUserID: ${bhUserId}`);
    console.log(`Current SOL: ${bal}`);

    console.log("\n=== Probing Withdrawals ===");
    for (const amt of TEST_AMOUNTS) {
        const before = (await getSolBalance()).bal;
        console.log(`\n-- Attempt: "${amt}" SOL --`);
        console.log(`Balance before: ${before}`);

        const body = { BHUserID: bhUserId, withdrawAddress: SOL_ADDRESS, amount: amt };
        const w = await safeFetch(`${BASE}/crypto/withdraw/sol`, {
            method: "POST",
            body: JSON.stringify(body)
        });

        console.log("Status:", w.status);
        console.log("OK?:", w.ok);
        console.log("Raw:", w.text);
        if (w.json) {
            console.log("JSON parsed:", JSON.stringify(w.json, null, 2));
        }

        const after = (await getSolBalance()).bal;
        console.log(`Balance after: ${after}`);

        console.log(`⏳ Waiting ${DELAY_MS / 1000}s to avoid rate limit...`);
        await pause(DELAY_MS);
    }
})();
