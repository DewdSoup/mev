// Save as: services/arb-mm/scripts/diagnose_raydium_token.ts
// Run with: cd services/arb-mm && npx tsx scripts/diagnose_raydium_token.ts

import { Token, Currency, TokenAmount } from "@raydium-io/raydium-sdk";
import { PublicKey } from "@solana/web3.js";

const SOL_MINT = new PublicKey("So11111111111111111111111111111111111111112");

console.log("=== Raydium SDK Token Diagnostic ===\n");

// 1. Check Token constructor
console.log("1. Token constructor analysis:");
console.log("   Token.length:", Token.length, "(number of expected parameters)");
console.log("   Token.name:", Token.name);
console.log("   typeof Token:", typeof Token);

// 2. Check if Token has toString to see constructor signature
const ctorString = Token.toString();
console.log("\n2. Constructor signature (first 500 chars):");
console.log("   ", ctorString.substring(0, 500));

// 3. Check prototype
console.log("\n3. Token.prototype methods:");
const proto = Token.prototype;
if (proto) {
  console.log("   Methods:", Object.getOwnPropertyNames(proto).join(", "));
}

// 4. Try to inspect parent class
console.log("\n4. Inheritance check:");
const parent = Object.getPrototypeOf(Token);
console.log("   Parent class name:", parent?.name || "none");
if (parent && parent.name === "Currency") {
  console.log("   Token extends Currency: true");
  console.log("   Currency.length:", parent.length);
}

// 5. Test constructor patterns systematically
console.log("\n5. Testing constructor patterns:\n");

const tests = [
  // Most likely patterns first based on error messages
  {
    name: "5 params: chainId, address(string), decimals, symbol, name",
    fn: () => new (Token as any)(101, SOL_MINT.toBase58(), 9, "SOL", "Solana")
  },
  {
    name: "5 params: chainId, address(PublicKey), decimals, symbol, name",
    fn: () => new (Token as any)(101, SOL_MINT, 9, "SOL", "Solana")
  },
  {
    name: "4 params: chainId, address(string), decimals, symbol",
    fn: () => new (Token as any)(101, SOL_MINT.toBase58(), 9, "SOL")
  },
  {
    name: "4 params: chainId, address(PublicKey), decimals, symbol",
    fn: () => new (Token as any)(101, SOL_MINT, 9, "SOL")
  },
  {
    name: "3 params: chainId, address(string), decimals",
    fn: () => new (Token as any)(101, SOL_MINT.toBase58(), 9)
  },
  {
    name: "3 params: chainId, address(PublicKey), decimals",
    fn: () => new (Token as any)(101, SOL_MINT, 9)
  },
  {
    name: "4 params: address(string), decimals, symbol, name",
    fn: () => new (Token as any)(SOL_MINT.toBase58(), 9, "SOL", "Solana")
  },
  {
    name: "3 params: address(string), decimals, symbol",
    fn: () => new (Token as any)(SOL_MINT.toBase58(), 9, "SOL")
  },
  {
    name: "2 params: address(string), decimals",
    fn: () => new (Token as any)(SOL_MINT.toBase58(), 9)
  },
  {
    name: "4 params: address(PublicKey), decimals, symbol, name",
    fn: () => new (Token as any)(SOL_MINT, 9, "SOL", "Solana")
  },
  {
    name: "3 params: address(PublicKey), decimals, symbol",
    fn: () => new (Token as any)(SOL_MINT, 9, "SOL")
  },
  {
    name: "2 params: address(PublicKey), decimals",
    fn: () => new (Token as any)(SOL_MINT, 9)
  }
];

let successfulToken: any = null;

for (const test of tests) {
  try {
    const token = test.fn();
    console.log(`✅ SUCCESS: ${test.name}`);
    console.log(`   Properties:`, Object.keys(token).join(", "));
    console.log(`   token.mint:`, token.mint?.toBase58?.() || token.mint || "undefined");
    console.log(`   token.address:`, token.address?.toBase58?.() || token.address || "undefined");
    console.log(`   token.decimals:`, token.decimals);
    console.log(`   token.symbol:`, token.symbol || "undefined");
    console.log(`   token.name:`, token.name || "undefined");
    console.log(`   token.chainId:`, token.chainId || "undefined");
    console.log(`   Has equals():`, typeof token.equals === 'function');
    console.log(`   Has isZero():`, typeof token.isZero === 'function');
    console.log("");
    successfulToken = token;
    break; // Found working constructor
  } catch (e: any) {
    const shortError = e.message.split('\n')[0].substring(0, 100);
    console.log(`❌ FAILED: ${test.name}`);
    console.log(`   Error: ${shortError}...`);
  }
}

// 6. If we found a working token, test TokenAmount
if (successfulToken) {
  console.log("\n6. Testing TokenAmount with successful Token:");
  try {
    const amount = new TokenAmount(successfulToken, "1000000000", true);
    console.log("   ✅ TokenAmount created successfully");
    console.log("   amount.toFixed():", amount.toFixed());
    console.log("   amount.raw:", amount.raw?.toString());
  } catch (e: any) {
    console.log("   ❌ TokenAmount failed:", e.message);
  }
} else {
  console.log("\n6. No successful Token constructor found!");
  console.log("   This SDK version may have a different Token implementation.");
  console.log("   Check if Token is exported differently or needs different imports.");
}

// 7. Check for alternative Token implementations
console.log("\n7. Checking for alternative exports:");
const sdk = require("@raydium-io/raydium-sdk");
const tokenRelated = Object.keys(sdk).filter(k =>
  k.toLowerCase().includes('token') ||
  k.toLowerCase().includes('currency')
);
console.log("   Token-related exports:", tokenRelated.join(", "));

// 8. Check SPL Token constants
if (sdk.NATIVE_MINT) {
  console.log("\n8. Built-in token constants:");
  console.log("   NATIVE_MINT:", sdk.NATIVE_MINT.toBase58());
}
if (sdk.WSOL) {
  console.log("   WSOL:", sdk.WSOL);
}
if (sdk.SOL) {
  console.log("   SOL:", sdk.SOL);
}