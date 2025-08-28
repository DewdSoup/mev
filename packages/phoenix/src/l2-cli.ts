// packages/phoenix/src/l2-cli.ts
import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'

const BIN = process.env.PHOENIX_CLI_BIN ?? 'phoenix-cli'
const URL = process.env.PHOENIX_CLI_URL ?? 'main' // same as -u main
const KEYPAIR = process.env.PHOENIX_CLI_KEYPAIR || process.env.SOLANA_KEYPAIR // optional
const MARKET = process.env.PHOENIX_MARKET!
const POLL_MS = Number(process.env.PHOENIX_CLI_POLL_MS ?? 1000)

function parseTopOfBook(stdout: string) {
  // Expected 2 lines like:
  //         194.501  20.565
  //  20.580 194.357
  // ask_price ask_size
  // bid_size  bid_price
  const lines = stdout.trim().split('\n').filter(Boolean)
  if (lines.length < 2) return null
  const askLine = lines[0].trim().split(/\s+/).map(Number)
  const bidLine = lines[1].trim().split(/\s+/).map(Number)
  if (askLine.length < 2 || bidLine.length < 2) return null

  const ask_price = askLine[0]
  const ask_size = askLine[1]
  const bid_size = bidLine[0]
  const bid_price = bidLine[1]

  if (![ask_price, ask_size, bid_price, bid_size].every(Number.isFinite)) return null
  return { best_bid: bid_price, best_ask: ask_price, bid_size, ask_size }
}

export async function pumpPhoenixL2Cli(log: (obj: any) => void) {
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
