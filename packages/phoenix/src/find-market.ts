// packages/phoenix/src/find-market.ts
// Prints PHOENIX_MARKET=... for a given pair (default SOL/USDC) from the official list.

const LIST_URL =
  process.env.PHOENIX_MARKET_LIST_URL ??
  "https://raw.githubusercontent.com/Ellipsis-Labs/phoenix-sdk/master/mainnet_markets.json";

async function main() {
  const pair = (process.env.PHOENIX_PAIR ?? "SOL/USDC").toUpperCase();

  const res = await fetch(LIST_URL);
  if (!res.ok) throw new Error(`HTTP ${res.status} from ${LIST_URL}`);
  const data: unknown = await res.json();

  if (!Array.isArray(data)) throw new Error("Unexpected list shape");
  const m = data.find(
    (x: any) => String(x?.name ?? "").toUpperCase() === pair && x?.address
  ) as { name: string; address: string } | undefined;

  if (!m) {
    console.error(`Pair not found in list: ${pair}`);
    process.exit(1);
  }
  console.log(`PHOENIX_MARKET=${m.address}`);
}

main().catch((e) => {
  console.error(String(e?.message ?? e));
  process.exit(1);
});
