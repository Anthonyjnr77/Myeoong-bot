
# Solana Copytrading Bot

## 1. About

This copy-trading bot monitors source wallets via Helius Laserstream and automatically executes matching trades on pump.fun bonding curves and PumpSwap pools. Built with TypeScript, it uses parallel RPC calls, account caching, and optimized transaction building to minimize latency while maintaining safety through comprehensive validation and error handling.

**Project Structure:**
```
sol-copytrader/
├── src/
│   ├── bot/              # Event-driven bot orchestration + handlers
│   ├── config/           # Configuration and validation
│   ├── pumpfun-sdk/      # PumpFun protocol SDK
│   ├── pumpswap-sdk/     # PumpSwap protocol SDK
│   └── utils/            # Logging, metrics, testing utilities
├── test/                 # Demo, latency benchmarks, safety tests
└── examples/             # Sample outputs and logs
```

**Additional Resources:**
- See [`examples/`](examples/) for sample outputs from demo, latency tests, and live sessions
- See [`DESIGN.md`](DESIGN.md) for architecture details and optimization breakdown


## 2. Configuration

### Prerequisites

- Node.js 18+ and pnpm
- Helius API key with Laserstream access
- Funded Solana wallets on devnet or mainnet

### Environment Variables

**Required:**

| Variable | Description |
|----------|-------------|
| `HELIUS_API_KEY` | Your Helius API key |
| `HELIUS_RPC_ENDPOINT` | Helius RPC URL (include your API key in URL) |
| `LASERSTREAM_ENDPOINT` | Laserstream WebSocket endpoint |
| `BOT_WALLET_PRIVATE_KEY` | Base58-encoded private key for the bot wallet |

**Optional:**

| Variable | Default | Description |
|----------|---------|-------------|
| `MODE` | `live` | `simulate` or `live` - simulate mode skips execution |
| `SOURCE_WALLET_PRIVATE_KEY` | - | For testing - generates trades to copy |
| `WATCH_WALLETS` | - | Comma-separated wallet addresses to monitor. Can also pass via CLI `--wallets=...`. Defaults to SOURCE_WALLET_PRIVATE_KEY public key if set |
| `PUMPFUN_BUY_AMOUNT` | `0.005` | SOL amount for pump.fun buys |
| `PUMPSWAP_BUY_AMOUNT` | `0.002` | SOL amount for PumpSwap buys |
| `MIN_TRADE_AMOUNT` | `0.001` | Minimum SOL to copy (filters small trades) |
| `PUMPFUN_SLIPPAGE_BPS` | `500` | Slippage tolerance in basis points (5%) |
| `PUMPSWAP_SLIPPAGE_BPS` | `1000` | Slippage tolerance in basis points (10%) |

See `.env.example` for a complete configuration template.


## 3. Quick Start
```bash
# 1. Clone and install dependencies
git clone https://github.com/mteoong/sol-copytrader
cd sol-copytrader
pnpm install

# 2. Configure environment
cp .env.example .env
# Edit .env with your API keys and wallet private keys

# 3. Validate setup
pnpm validate
```

**Choose your path:**

**Option A: Run Demo** (recommended first time)
```bash
pnpm demo
```
- **Requires**: Both `BOT_WALLET_PRIVATE_KEY` and `SOURCE_WALLET_PRIVATE_KEY` in .env
- Creates test token, executes trades, measures performance
- Takes ~2-3 minutes, shows latency and block distance metrics
- Runs in **live mode** - actual transactions are executed

**Option B: Run Live Bot**
```bash
pnpm bot -- --wallets=WALLET_ADDRESS_TO_WATCH
```
- **Requires**: `BOT_WALLET_PRIVATE_KEY` in .env
- Monitors specified wallet(s) and copies their trades in real-time
- See [Live Bot](#live-bot) section below for more details

**Setup tips:**
- Ensure wallets are funded (>0.5 SOL each for demo, >0.1 SOL for bot)
- Validation script checks RPC connectivity, balances, and configuration
- Start with demo to verify everything works before running live bot

## 4. Scripts

### Demo (`pnpm demo`)

Runs end-to-end performance test with real transactions:
```bash
pnpm demo
```

**What it does:**
- Creates a pump.fun test token
- Finds a PumpSwap pool
- Executes 5 buy/sell cycles per protocol (20 total operations)
- Measures latency breakdown (detection, parsing, building, execution)
- Calculates block distance from source trades

**Output:** Latency metrics (p50/p95/avg) and success rate. Takes ~2-3 minutes.

---

### Latency Benchmark (`pnpm latency`)

High-volume performance testing:
```bash
pnpm latency                           # Default: 20 operations per protocol
pnpm latency -- --operations=50        # Custom operation count
pnpm latency -- --sdk-operations=30    # Custom SDK comparison count
```

**What it measures:**
- Processing time per phase (detection, parsing, building, execution)
- Block distance statistics
- Comparison with native SDK performance

**Output:** Detailed performance breakdown with p50/p95/avg across 40 operations. Takes ~5 minutes.

---

### Safety Tests (`pnpm test-safety`)

Validates error handling and edge cases:
```bash
pnpm test-safety
```

**What it validates:**
- Duplicate detection and memory management
- Null account handling
- RPC retry logic
- Circuit breaker functionality
- Graceful shutdown mechanisms
- Configuration validation

**Output:** Test results showing 25+ edge case validations. Takes ~30 seconds.

## 5. Live Bot


### Running the Bot
Start the bot:
```bash
# If WATCH_WALLETS or SOURCE_WALLET_PRIVATE_KEY is set in .env
pnpm bot

# Or specify wallets via CLI (overrides .env)
pnpm bot -- --wallets=WALLET_ADDRESS

# Specify mode (defaults to .env MODE or 'live')
pnpm bot -- --mode=simulate
pnpm bot -- --mode=live

# Both options
pnpm bot -- --wallets=WALLET1,WALLET2 --mode=simulate
```

**Configuration priority:**
1. CLI arguments (`--wallets`, `--mode`) override .env
2. Falls back to `WATCH_WALLETS` in .env
3. Falls back to `SOURCE_WALLET_PRIVATE_KEY` public key if set

**Stop the bot:** Press `Ctrl+C` for graceful shutdown (waits for in-flight trades)

**Logs:** Saved to `./logs/bot-{timestamp}.log` and `./logs/session-{timestamp}.json`

---

### Manual Trading (Generate Test Trades)

**Recommended setup:** Split your terminal - run bot in one pane, generate trades in another.

**Requirements:** `SOURCE_WALLET_PRIVATE_KEY` must be set in `.env`


**Example commands:**
```bash
# Default: buy then sell (pump.fun)
pnpm trades

# Simple pump.fun buy (creates token automatically)
pnpm trades buy

# Simple pump.fun sell
pnpm trades -- sell --token=TOKEN_ADDRESS

# Buy with custom amount
pnpm trades -- buy --amount=0.01

# PumpSwap buy (finds pool automatically)
pnpm trades -- buy --pumpswap

# PumpSwap with specific pool
pnpm trades -- buy --pool=POOL_ADDRESS

# Test both protocols (buy+sell on both pump.fun and PumpSwap)
pnpm trades pump
```

**How it works:**
1. Terminal 1: Bot listens and copies trades from SOURCE_WALLET
2. Terminal 2: `trades` script executes trades using SOURCE_WALLET
3. Bot detects and copies the trades in real-time

**Example workflow:**
```bash
# Terminal 1
pnpm bot -- --mode=simulate

# Terminal 2 (wait for bot to start)
pnpm trades -- buysell
# Watch Terminal 1 for detection → execution output
```


## 6. Safety & Troubleshooting

### Safety Notes

- **Devnet only** - This project is configured for Solana devnet. Do not use mainnet keys or attempt mainnet trading
- **Start with simulate mode** - Test your setup without executing real trades first
- **Use small amounts** - Start with minimum buy amounts (0.001-0.005 SOL) when going live
- **Monitor actively** - Watch the bot's output and check wallet balances regularly
- **Check logs for debugging** - All sessions save logs to `./logs/` with transaction signatures for verification

### Common Issues

**"RPC connection failed"**
- Verify `HELIUS_RPC_ENDPOINT` includes your API key in the URL
- Check your Helius API key is valid and has RPC access

**"Laserstream connection timeout"**
- Ensure `HELIUS_API_KEY` has Laserstream access enabled
- Check `LASERSTREAM_ENDPOINT` is correct

**"Insufficient bot wallet balance"**
- Fund your bot wallet with at least 0.1 SOL (devnet SOL from faucet)
- Run `pnpm validate` to check current balance

**"Build failed: Bonding curve not found"**
- Token may have graduated to Raydium (no longer on bonding curve)
- Try a different token or create one (default behavior)

**"No wallets configured"**
- Set `WATCH_WALLETS` in .env OR pass `--wallets=ADDRESS` via CLI
- Or set `SOURCE_WALLET_PRIVATE_KEY` which auto-derives the public key

**Rate limiting (429 errors)**
- Built-in exponential backoff handles this automatically
- Consider upgrading your Helius plan for higher rate limits

**Debugging tips:**
- Check `./logs/bot-{timestamp}.log` for detailed execution logs
- Transaction signatures are logged for each trade - verify on Solana Explorer (devnet)
- Session metrics saved to `./logs/session-{timestamp}.json` include error details

