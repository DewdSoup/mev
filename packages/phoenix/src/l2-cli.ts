// packages/phoenix/src/l2-cli.ts
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const BIN = process.env.PHOENIX_CLI_BIN ?? 'phoenix-cli'
const URL = process.env.PHOENIX_CLI_URL ?? 'main' // same as -u main
const KEYPAIR = process.env.PHOENIX_CLI_KEYPAIR || process.env.SOLANA_KEYPAIR // optional
const MARKET = process.env.PHOENIX_MARKET!
const POLL_MS = Number(process.env.PHOENIX_CLI_POLL_MS ?? 1000)

type TopOfBook = {
  best_bid: number
  best_ask: number
  bid_size: number
  ask_size: number
}

function parseTopOfBook(stdout: string): TopOfBook | null {
  // Expected 2 lines like:
  //         194.501  20.565
  //  20.580 194.357
  // ask_price ask_size
  // bid_size  bid_price
  const lines = stdout.trim().split('\n').filter(Boolean)
  if (lines.length < 2) return null

  // With noUncheckedIndexedAccess, assert we have two strings:
  const [line0, line1] = lines as [string, string]

  const askParts = line0.trim().split(/\s+/).filter(Boolean)
  const bidParts = line1.trim().split(/\s+/).filter(Boolean)
  if (askParts.length < 2 || bidParts.length < 2) return null

  // Assert the first two tokens as tuples to avoid undefined
  const [askPriceStr, askSizeStr] = askParts as [string, string]
  const [bidSizeStr, bidPriceStr] = bidParts as [string, string]

  const ask_price = Number(askPriceStr)
  const ask_size = Number(askSizeStr)
  const bid_size = Number(bidSizeStr)
  const bid_price = Number(bidPriceStr)

  if (![ask_price, ask_size, bid_price, bid_size].every(Number.isFinite)) return null

  return { best_bid: bid_price, best_ask: ask_price, bid_size, ask_size }
}

export async function pumpPhoenixL2Cli(log: (obj: any) => void): Promise<void> {
  if (!MARKET) throw new Error('PHOENIX_MARKET missing')
  while (true) {
    try {
      const args = ['-u', URL]
      if (KEYPAIR) args.push('-k', KEYPAIR)
      args.push('get-top-of-book', MARKET)

      const child = spawn(BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.on('data', (c) => (out += c.toString()))
      const errChunks: string[] = []
      child.stderr.on('data', (c) => errChunks.push(c.toString()))

      const code: number = await new Promise((res) => child.on('close', res))
      if (code === 0) {
        const parsed = parseTopOfBook(out)
        if (parsed) {
          const { best_bid, best_ask, bid_size, ask_size } = parsed
          log({
            type: 'phoenix_l2',
            ts: Date.now(),
            market: MARKET,
            best_bid,
            best_ask,
            bid_size,
            ask_size,
            source: 'phoenix_cli'
          })
        } else {
          log({ type: 'phoenix_l2_empty', ts: Date.now(), market: MARKET, source: 'cli_parse' })
        }
      } else {
        log({ type: 'phoenix_cli_error', ts: Date.now(), market: MARKET, code, stderr: errChunks.join('') })
      }
    } catch (e: any) {
      log({ type: 'phoenix_cli_exception', ts: Date.now(), market: MARKET, error: String(e?.message ?? e) })
    }
    await delay(POLL_MS)
  }
}
