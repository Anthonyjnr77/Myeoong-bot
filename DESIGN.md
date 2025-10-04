# DESIGN.md

## 1. System Architecture

This is a copytrading bot that detects trades from given source wallets via Laserstream and automatically executes matching trades on pump.fun and PumpSwap. 

**Architecture Overview:**
```
                                    ┌─ PumpFun Builder ─┐
Source Trade → Detector → Parser ──┤                    ├─→ Executor → Blockchain
(Laserstream)     ↓          ↓      └─ PumpSwap Builder ┘      ↓
              Identify   Validate        Build TX           Submit+Sign
              Protocol   & Filter      (parallel RPC)      
              & Dedupe
```
**Component Responsibilities:**

- **Detector** (`detector.ts`): Subscribes to Laserstream with protocol-specific filters, identifies transaction protocol, deduplicates, and emits detected transactions
- **Parser** (`parser.ts`): Decodes instruction data, extracts trade parameters, validates against watchlist and minimum amounts
- **Tx Builders** (`pumpfun-tx.ts`, `pumpswap-tx.ts`): Protocol-specific transaction construction with account fetching and slippage calculations
- **Executor** (`executor.ts`): Signs and submits transactions with priority fees, polls for confirmation in background
- **Bot** (`CopytradingBot.ts`): Orchestrates the pipeline and emits events to pluggable handlers

**Event-Driven Design:**

The bot emits typed events (`detected`, `buildSuccess`, `executionSuccess`, etc.) to registered handlers. This pattern enables:
- **Modularity**: Logging, metrics, and circuit breaking are separate handlers that can be added/removed independently, enabling code reuse across contexts—the live bot and testing scripts all use the same trade engine with different handler sets.
- **Testability**: Each handler can be unit tested; components can be tested with mock handlers
- **Extensibility**: The handler interface decouples concerns—new capabilities can be added as handlers without touching core logic, while improvements to the trade engine automatically benefit all contexts without handler changes.

This separation of concerns keeps each component focused on a single responsibility, making the codebase maintainable and allowing protocol support to be added without touching the detection or execution layers.



## 2. Latency Analysis & Optimization

**Measured Performance:**
Across 100 test operations (50 pump.fun, 50 PumpSwap), the system achieves:
- **Processing Time**: p50 608ms, p95 783ms, avg 617ms (detection → submission)
- **Block Distance**: p50 3 blocks, p95 3 blocks, avg 2.5 blocks

**Phase Breakdown:**

| Phase         | p50   | p95   | avg   | Notes                          |
|---------------|-------|-------|-------|--------------------------------|
| Detection     | 1ms   | 3ms   | 1ms   | Laserstream → bot processing   |
| Parsing       | 0ms   | 1ms   | 0ms   | Instruction decoding           |
| Building      | 314ms | 468ms | 326ms | Account fetching + TX creation |
| Execution     | 294ms | 361ms | 290ms | Signing + RPC submission       |


The build phase requires at least one RPC call (account data), and execution requires at least one (transaction submission). At 617ms average total latency, further gains would require alternative approaches like dedicated RPC infrastructure or advanced submission paths like Jito bundles for priority inclusion.

**SDK Comparison:**
Native pump.fun and PumpSwap SDK implementations average 4913ms, though this is inflated by outliers—the median (p50) is 1658ms, but some transactions take up to 14918ms (p95). The optimized pipeline averages **617ms** (p50: 608ms, p95: 783ms), making it **7.96x faster** with more consistent performance through parallelization, caching, and removing abstraction overhead.


**Optimization Journey:**
Each optimization was tested independently with measurements averaged over 20 transactions to validate effectiveness. Starting from a baseline SDK implementation:


| Optimization | Avg Latency | Improvement | Description |
|--------------|-------------|-------------|-------------|
| **Baseline**  | 2942ms | - | SDK methods with 'processed' commitment |
| Remove SDK abstraction overhead | 2707ms | -235ms | Direct transaction building, using SDK only for calculations |
| Cache global account & fee config | 1833ms | -874ms | Fetch at startup, refresh every 10min. Eliminates 2 RPC calls per trade |
| Extract creator from bonding curve | 1372ms | -461ms | Parse from account data instead of separate RPC call (-1 call) |
| Idempotent ATA creation | 977ms | -395ms | Use `createAssociatedTokenAccountIdempotentInstruction` to avoid checks |
| Parallel RPC calls | **617ms** | -360ms | Fetch blockhash + bonding curve + accounts concurrently with `Promise.all()` |


*Additional refinements include RPC retry logic, exponential backoff on rate limits, skipPreflight=true, and other minor improvements.

**Total Improvement:** 2942ms → 617ms (4.8x faster, -2325ms)


## 3. Safety & Robustness

The system implements multiple protection layers validated through 25+ automated tests:

**Stream Reliability (Laserstream SDK):**
- Auto-reconnection with configurable retry limits
- Slot tracking with automatic replay from last processed slot (no data loss on reconnect)

**Configuration & Input Validation:**
- Startup validation checks: RPC connectivity, wallet balances, API keys, private key formats
- `validate.ts` script performs pre-flight checks before running bot
- Environment variable validation with descriptive error messages
- Numeric range validation (slippage 0-10000 bps, positive amounts, etc.)
- CLI argument validation with helpful error messages

**Data Integrity:**
- Signature-based deduplication with memory-capped set (max 1,000 entries)
- Null account detection with descriptive errors ("Pool account not found - pool may be closed")
- Balance checks before sells
- Malformed instruction data and out-of-bounds account index handling

**RPC Resilience:**
- Exponential backoff on 429 rate limits (500ms → 1000ms → 2000ms)
- Non-429 errors fail immediately without retry

**Error Handling:**
- Descriptive error messages include context (mint address, wallet, specific failure reason)
- Try-catch blocks at every async boundary
- Errors propagated through event system for centralized handling
- All builder/executor failures include timing data for debugging

**Circuit Breaker:**
- Shuts down after 5 consecutive failures to prevent runaway errors
- Counter resets on successful trade

**Graceful Shutdown:**
- SIGINT/SIGTERM handlers for clean termination
- Waits 5s for in-flight trades before force exit
- Cleanup sequence: stop detector → wait trades → cleanup builders → save metrics/logs
- Uncaught exceptions saved to crash reports with full metrics

**Code Quality:**
- Event-driven architecture enables unit testing of individual handlers
- All safety mechanisms verified in `test-safety.ts` covering edge cases, concurrency, and lifecycle management
- Separation of concerns allows components to be tested in isolation


## 4. Future Improvements

1. **Mainnet Testing**: Comprehensive testing on mainnet with real positions and market conditions
2. **Jito Bundle Integration**: Submit transactions via Jito bundles for priority inclusion and MEV protection
3. **RPC Racing**: Query multiple RPC endpoints concurrently, use fastest response
4. **Dynamic Position Sizing**: 
   - Scale buy/sell amount based on source trade size (e.g., 10% of source)
   - Respect available balance limits
   - Adjust for pool liquidity and slippage impact
5. **Rust Rewrite**: Port to Rust for lower latency and better performance
6. **Position Tracking**: Maintain persistent database of all buys/sells with PnL calculations
7. **Stop-loss/Take-profit**: Automated exit strategies based on price targets
8. **Additional DEX Support**: Raydium, Orca, Jupiter aggregator

**Extensibility Points:**

- **Handler interface**: New capabilities (notifications, webhooks, Telegram bot) can be added as event handlers without modifying core logic
- **Builder pattern**: Additional protocols can be integrated by implementing the builder interface
- **Protocol detection**: Easy to add new program IDs and discriminators to `detector.ts`
- **Configuration system**: All parameters are environment-driven, enabling different strategies per deployment
