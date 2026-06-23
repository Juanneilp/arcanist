# Analisa Mendalam: Arcanist vs Meridian

> Referensi: [meridian_ref](file:///root/arcanist/meridian_ref) | Core: [arcanist/bot](file:///root/arcanist/bot)

---

## Ringkasan Eksekutif

Arcanist saat ini adalah trading bot DLMM yang fungsional dengan screening, entry/exit otomatis, dan notifikasi Telegram. Namun dibandingkan Meridian, Arcanist masih jauh tertinggal di **arsitektur AI agent**, **manajemen state**, **learning system**, dan **risk management**. Meridian menerapkan pola ReAct agent loop dengan tool-calling, sedangkan Arcanist masih menggunakan pola "AI as selector" tradisional.

### Perbandingan Statistik

| Aspek | Arcanist | Meridian |
|-------|----------|----------|
| Module System | CommonJS (`.cjs`) | ES Modules (`.js`) |
| AI Integration | Simple prompt → JSON response | ReAct Agent Loop + Tool Calling |
| State Management | Flat array JSON | Structured object with per-position metadata |
| Learning System | ❌ Tidak ada | ✅ Auto-learn + evolve + Darwin weights |
| Pool Memory | ❌ Tidak ada | ✅ Full deploy history + cooldowns |
| Trailing TP | ❌ Tidak ada | ✅ Peak tracking + confirmation |
| HiveMind | ❌ Tidak ada | ✅ Shared lessons + presets |
| Telegram Control | Passive (notifikasi saja) | Full interactive (slash commands + settings menu + live messages) |
| Config Management | Manual file edit | Runtime update via tool + Telegram |
| Graceful Shutdown | ❌ Tidak ada | ✅ Signal handlers + position snapshot |
| Deterministic Rules | Partial (basic TP/SL) | ✅ 5 rules (SL, TP, pump OOR, OOR timeout, low yield) |
| Total Files | 15 bot files | 33+ files (tools, utils, scripts) |

---

## 🔴 CRITICAL — Harus Segera Diubah

Perubahan ini fundamental dan mempengaruhi keandalan, keamanan, dan efektivitas bot.

---

### 1. AI Agent Architecture: Simple Prompt → ReAct Agent Loop

> [!CAUTION]
> Ini adalah perbedaan paling fundamental. Arcanist menggunakan AI hanya sebagai "selector" sedangkan Meridian menggunakan pola agent loop penuh.

**Arcanist saat ini** ([ai-agent.cjs](file:///root/arcanist/bot/ai-agent.cjs)):
```
User → Prompt with candidates → AI returns JSON array → Bot picks from array
```
- AI tidak bisa memanggil tool
- AI tidak bisa membaca data on-chain
- AI hanya bisa memilih dari data yang sudah diberikan

**Meridian** ([agent.js](file:///root/arcanist/meridian_ref/agent.js)):
```
User → Goal → Agent Loop (system prompt + tools) → Tool calls → Results → Next step → Final answer
```
- AI bisa memanggil tools: `deploy_position`, `close_position`, `get_active_bin`, dll
- Role-based tool filtering (MANAGER, SCREENER, GENERAL)
- Intent detection untuk optimasi tool selection
- Once-per-session guards (prevent double deploy)
- Provider fallback dan retry logic
- JSON repair untuk malformed tool call args

**Yang Perlu Dibangun:**
- [ ] `agentLoop()` function dengan iterative tool calling
- [ ] Tool definitions ([definitions.js](file:///root/arcanist/meridian_ref/tools/definitions.js)) - 41K file
- [ ] Tool executor ([executor.js](file:///root/arcanist/meridian_ref/tools/executor.js)) - 35K file
- [ ] System prompt builder ([prompt.js](file:///root/arcanist/meridian_ref/prompt.js))
- [ ] Role-based tool filtering (MANAGER, SCREENER, GENERAL)
- [ ] Intent detection patterns

---

### 2. State Management: Flat Array → Structured Position Registry

> [!CAUTION]
> State Arcanist mudah corrupt dan tidak tracking metadata kritis.

**Arcanist** ([state.cjs](file:///root/arcanist/bot/state.cjs#L1-L145)):
- `active_positions.json` = flat array
- Hanya tracks: `positionPubKey`, `poolAddress`, `tokenMint`, `investedSol`
- No peak PnL tracking
- No trailing TP state
- No instruction support
- No close reason recording
- Depends on `proper-lockfile` (external dependency)

**Meridian** ([state.js](file:///root/arcanist/meridian_ref/state.js#L1-L523)):
- `state.json` = object keyed by position address
- Tracks per position:
  - `peak_pnl_pct` — untuk trailing TP
  - `trailing_active` — state machine untuk trailing exit
  - `pending_peak_pnl_pct` / `pending_trailing_*` — confirmation state
  - `instruction` — user-set hold conditions
  - `out_of_range_since` — timestamp tracking
  - `total_fees_claimed_usd` — claimed fees accumulator
  - `signal_snapshot` — entry signals snapshot untuk learning
  - `confirmed_trailing_exit_reason` — confirmed exits
  - `recentEvents` — event log untuk prompt injection
- Functions:
  - `trackPosition()`, `recordClose()`, `recordClaim()`
  - `updatePnlAndCheckExits()` — unified exit condition checker
  - `queuePeakConfirmation()` / `resolvePendingPeak()` — PnL recheck
  - `syncOpenPositions()` — reconcile with on-chain data
  - `getStateSummary()` — for system prompt

**Action Items:**
- [ ] Migrate dari flat array ke object-keyed state
- [ ] Add peak PnL tracking fields
- [ ] Add trailing TP state machine
- [ ] Add instruction support
- [ ] Add event log
- [ ] Add PnL confirmation flow
- [ ] Implement `updatePnlAndCheckExits()` unified checker

---

### 3. Exit Strategy: Basic TP/SL → Multi-Rule Deterministic + Trailing TP

> [!WARNING]
> Arcanist sering kehilangan profit karena tidak ada trailing TP dan hanya punya 2 exit rules sederhana.

**Arcanist** ([monitor.cjs](file:///root/arcanist/bot/monitor.cjs#L28-L169)):
- Take Profit: price-based (% dari entry)
- Stop Loss: price-based (% dari entry)
- Max hold hours
- OOR distance / OOR timeout
- RSI + BB + MACD technical exit (tapi berdasarkan kline, bukan PnL position)
- **NO trailing TP** → Posisi yang profit 50% bisa turun kembali ke 0%

**Meridian** ([index.js](file:///root/arcanist/meridian_ref/index.js#L875-L918) + [state.js](file:///root/arcanist/meridian_ref/state.js#L381-L471)):
5 deterministic rules:
1. **Stop Loss** — `pnl_pct <= stopLossPct` (default -50%)
2. **Take Profit** — `pnl_pct >= takeProfitPct` (default 5%)
3. **Pump OOR** — active bin > upper bin + outOfRangeBinsToClose (10 bins)
4. **OOR Timeout** — active bin > upper bin AND OOR >= 30 minutes
5. **Low Yield** — `fee_per_tvl_24h < minFeePerTvl24h` (7%) after 60 min

**Trailing TP system:**
- Trigger at `trailingTriggerPct` (3%)
- Track `peak_pnl_pct` continuously
- Close when drops `trailingDropPct` (1.5%) from peak
- **Double confirmation:** 15s recheck sebelum close (prevent flash crash exits)
- PnL poller setiap 3 detik (independent dari management cycle)

**Action Items:**
- [ ] Implement trailing TP with peak tracking
- [ ] Add PnL-based exit rules (bukan hanya price-based)
- [ ] Add pump OOR detection (bukan hanya generic OOR)
- [ ] Add low yield exit rule
- [ ] Add PnL confirmation system (15s recheck)
- [ ] Add aggressive PnL poller (3s interval)

---

### 4. Screening Architecture: Scraper → Integrated Screening Pipeline

> [!CAUTION]
> Arcanist scraper terlalu tergantung pada external CLI tools dan tidak memiliki integrated recon.

**Arcanist** ([scraper.cjs](file:///root/arcanist/bot/scraper.cjs)):
- Spawns `npx gmgn-cli` as subprocess (!!!)
- Single-pass: fetch trending → filter → Supertrend check → save to file
- No smart wallet checking
- No token narrative analysis
- No pool memory checking
- No cooldown checking
- No PVP detection
- No deployer blacklisting
- No launchpad filtering
- No bot holder % filtering

**Meridian** ([index.js](file:///root/arcanist/meridian_ref/index.js#L385-L704) + [tools/screening.js](file:///root/arcanist/meridian_ref/tools/screening.js)):
- Integrated screening with `getTopCandidates()`
- Multi-layered pipeline:
  1. Fetch candidates from screening API
  2. For each: smart wallet check + narrative + token info (parallel)
  3. Hard filters: launchpad + bot holders %
  4. Single-candidate skip logic (safety check)
  5. Pre-fetch active bins (parallel)
  6. Build rich candidate blocks for LLM
  7. Stage signals for Darwinian weighting
  8. LLM decides deployment
- Pool memory integration (cooldowns, past performance)
- PVP detection and blocking
- Deployer blacklist checking

**Action Items:**
- [ ] Replace subprocess spawning dengan direct API calls
- [ ] Add smart wallet checking integration
- [ ] Add token narrative analysis
- [ ] Add pool memory / cooldown checking
- [ ] Add PVP detection
- [ ] Add deployer blacklist
- [ ] Add launchpad filtering
- [ ] Add bot holder percentage filtering

---

### 5. Configuration System: Static File → Dynamic Runtime Config

**Arcanist** ([config.cjs](file:///root/arcanist/bot/config.cjs)):
- 54 lines, basic read/write
- No defaults merging
- No validation
- Config changes require restart
- No screening threshold auto-evolution

**Meridian** ([config.js](file:///root/arcanist/meridian_ref/config.js)):
- 307 lines, comprehensive config object
- Every field has sensible defaults with `??` operator
- `computeDeployAmount()` — dynamic position sizing based on wallet
- `reloadScreeningThresholds()` — hot reload without restart
- `update_config` tool — AI can change config at runtime
- Telegram `/setcfg` and `/settings` menu for live changes

**Action Items:**
- [ ] Restructure config as centralized config object with defaults
- [ ] Add `computeDeployAmount()` for dynamic sizing
- [ ] Add hot reload support
- [ ] Add `update_config` tool for AI runtime changes

---

## 🟡 MEDIUM — Penting untuk Kompetitif

Fitur-fitur yang meningkatkan efektivitas dan pengalaman operator secara signifikan.

---

### 6. Learning System — Tidak ada di Arcanist

**Meridian** ([lessons.js](file:///root/arcanist/meridian_ref/lessons.js)):
- `recordPerformance()` — auto-record saat position close
- `derivLesson()` — auto-generate lessons dari outcomes
- `evolveThresholds()` — auto-adjust screening thresholds setiap 5 closes
- Manual lessons: `addLesson()`, `pinLesson()`, `unpinLesson()`
- Role-aware injection: pinned → role-matched → recent
- Performance summary for prompt injection
- Suspicion guards (prevent bad data from skewing learning)

**Action Items:**
- [ ] Build `lessons.json` persistence layer
- [ ] Implement `recordPerformance()` on position close
- [ ] Implement `derivLesson()` auto-lesson generation
- [ ] Implement `evolveThresholds()` adaptive screening
- [ ] Add lesson injection into system prompt
- [ ] Add manual lesson management via Telegram

---

### 7. Pool Memory — Tidak ada di Arcanist

**Meridian** ([pool-memory.js](file:///root/arcanist/meridian_ref/pool-memory.js)):
- Per-pool deploy history tracking
- Win rate and adjusted win rate calculation
- Pool-level and token-level cooldowns
- OOR cooldown (3x OOR closes → 12h cooldown)
- Repeat deploy cooldown (3x fee-generating → 12h cooldown)
- Position snapshot recording (trending data)
- `recallForPool()` — contextual recall for LLM decisions

**Action Items:**
- [ ] Build pool-memory.json persistence
- [ ] Implement cooldown system (pool + token level)
- [ ] Implement deploy history tracking
- [ ] Implement snapshot recording for trend analysis

---

### 8. Darwinian Signal Weighting — Tidak ada di Arcanist

**Meridian** ([signal-weights.js](file:///root/arcanist/meridian_ref/signal-weights.js)):
- Tracks which screening signals predict profitable positions
- Numeric, boolean, and categorical signal lift computation
- Quartile-based boost/decay system
- Weight persistence in `signal-weights.json`
- Summary injection into LLM prompt
- Auto-recalculate every 5 position closes

**Action Items:**
- [ ] Implement signal weight tracking
- [ ] Add lift computation per signal type
- [ ] Add weight injection into screening prompt

---

### 9. Telegram Upgrade: Notification-Only → Full Interactive Control

**Arcanist** ([telegram.cjs](file:///root/arcanist/bot/telegram.cjs) + [telegram-handlers.cjs](file:///root/arcanist/bot/telegram-handlers.cjs)):
- Sudah memiliki beberapa slash commands
- Sudah ada beberapa handlers

**Meridian** ([telegram.js](file:///root/arcanist/meridian_ref/telegram.js) + [index.js](file:///root/arcanist/meridian_ref/index.js#L1365-L1649)):
Full interactive system:
- `/help`, `/status`, `/wallet`, `/positions`, `/pool N`, `/close N`, `/closeall`
- `/set N <note>` — set instruction on position
- `/config`, `/settings` — button menu with inline keyboard
- `/setcfg <key> <value>` — live config update
- `/screen`, `/candidates`, `/deploy N` — manual screening + deploy
- `/briefing`, `/hive`, `/hive pull`
- `/pause`, `/resume`, `/stop`
- **Live messages** — real-time tool execution updates
- **Settings menu** with inline keyboard buttons (toggle, step, navigation)
- **Message queue** — max 5 messages queued while agent busy
- **Callback query handling** for inline buttons
- **Authorization system** — `TELEGRAM_ALLOWED_USER_IDS`

**Action Items:**
- [ ] Add missing commands: `/pool`, `/set`, `/settings`, `/setcfg`, `/deploy`, `/candidates`
- [ ] Add inline keyboard settings menu
- [ ] Add live message system (real-time tool updates)
- [ ] Add authorization check (`TELEGRAM_ALLOWED_USER_IDS`)
- [ ] Add message queue for busy agent

---

### 10. Management Cycle Architecture

**Arcanist:**
- `monitoringLoop()` runs on interval — checks exit conditions one by one
- No structured management/screening cycle separation
- No live Telegram updates during cycle

**Meridian** ([index.js](file:///root/arcanist/meridian_ref/index.js#L205-L383)):
- `runManagementCycle()` — structured pipeline:
  1. Fetch positions (force refresh)
  2. Record snapshots + load pool memory
  3. JS trailing TP check (PnL peak confirmation)
  4. Deterministic rule checks (no LLM needed)
  5. Build JS report
  6. Call LLM **only if action needed**
  7. Post-management: trigger screening if slots available
- `runScreeningCycle()` — structured pipeline:
  1. Pre-checks: max positions + SOL balance
  2. Load strategy
  3. Fetch + recon candidates
  4. Hard filters
  5. Single-candidate safety check
  6. Pre-fetch active bins
  7. LLM decision
  8. Decision logging

**Key insight: Meridian only calls LLM when deterministic rules can't handle it.**

**Action Items:**
- [ ] Restructure into management cycle + screening cycle
- [ ] Add deterministic rule layer before LLM
- [ ] Add post-management screening trigger
- [ ] Add decision logging (`appendDecision()`)

---

### 11. HiveMind — Shared Learning Network

**Meridian** ([hivemind.js](file:///root/arcanist/meridian_ref/hivemind.js)):
- Agent registration with unique ID
- Shared lessons push/pull
- Shared presets pull
- Background heartbeat sync (15 min)
- Shared lessons injected into LLM prompt
- Performance event sharing

**Action Items:**
- [ ] Implement HiveMind client
- [ ] Add agent registration
- [ ] Add lesson sharing (push + pull)
- [ ] Add background sync

---

### 12. Morning Briefing — Tidak ada di Arcanist

**Meridian** ([briefing.js](file:///root/arcanist/meridian_ref/briefing.js)):
- Auto daily briefing at 8:00 AM UTC+7
- Performance summary
- Missed briefing detection on restart

**Action Items:**
- [ ] Implement daily briefing generation
- [ ] Add cron job for briefing
- [ ] Add missed briefing detection

---

## 🟢 LOW — Nice to Have / Polish

---

### 13. Module System: CommonJS → ES Modules

Meridian menggunakan ES Modules (`"type": "module"` di package.json). Arcanist masih `.cjs`.

**Impact:** ESM enables dynamic imports, top-level await, better tree shaking.

**Action Items:**
- [ ] Migrate to ESM (rename `.cjs` → `.js`, add `"type": "module"`)
- [ ] Update `require()` → `import`

---

### 14. Graceful Shutdown

**Meridian** ([index.js](file:///root/arcanist/meridian_ref/index.js#L807-L851)):
- `SIGINT` / `SIGTERM` handlers
- Stops polling and cron jobs
- Snapshots open positions before exit
- 5s timeout for position snapshot
- Prevents duplicate shutdown

**Action Items:**
- [ ] Add signal handlers
- [ ] Add position snapshot on shutdown

---

### 15. Interactive REPL

**Meridian** ([index.js](file:///root/arcanist/meridian_ref/index.js#L1691-L1978)):
- Full TTY REPL with countdown prompts
- Number pick (deploy by index)
- `auto` command (agent picks and deploys)
- `/learn` command (study top LPers)
- `/evolve` command (manual threshold evolution)
- Session history (last 20 messages)

**Action Items:**
- [ ] Add TTY REPL interface
- [ ] Add session history for multi-turn conversations

---

### 16. Strategy Library — Tidak ada di Arcanist

**Meridian** ([strategy-library.js](file:///root/arcanist/meridian_ref/strategy-library.js)):
- Named strategies with entry/exit conditions
- `getActiveStrategy()` for context injection
- CRUD via Telegram (`add_strategy`, `remove_strategy`, `set_active_strategy`)

**Action Items:**
- [ ] Implement strategy library

---

### 17. Smart Wallets Tracking — Tidak ada di Arcanist

**Meridian** ([smart-wallets.js](file:///root/arcanist/meridian_ref/smart-wallets.js)):
- Track known profitable wallets
- Check if smart wallets are in a pool before deploying
- Add/remove via Telegram commands

**Action Items:**
- [ ] Implement smart wallet tracking
- [ ] Add pool checking against smart wallets

---

### 18. Decision Logging — Tidak ada di Arcanist

**Meridian** ([decision-log.js](file:///root/arcanist/meridian_ref/decision-log.js)):
- Log every deploy/skip decision
- Queryable for "why did you deploy/skip X?"
- Injected into prompt for self-awareness

**Action Items:**
- [ ] Implement decision log
- [ ] Add Telegram query command

---

### 19. Logger Module

**Arcanist:** Uses `console.log/error` directly everywhere.

**Meridian** ([logger.js](file:///root/arcanist/meridian_ref/logger.js)):
- Structured logger with categories
- Timestamp formatting
- File output support

**Action Items:**
- [ ] Implement structured logger
- [ ] Replace console.log with logger calls

---

### 20. Dev Blocklist

**Meridian** ([dev-blocklist.js](file:///root/arcanist/meridian_ref/dev-blocklist.js)):
- Block token deployer addresses
- Prevent deploying into tokens from known ruggers
- Persistent + manageable via Telegram

**Arcanist:** Only has `blacklist.json` for token addresses, no deployer blocking.

---

### 21. Env Encryption

**Meridian** ([envcrypt.js](file:///root/arcanist/meridian_ref/envcrypt.js)):
- Encrypt `.env` at rest
- Decrypt on startup with passphrase
- Protects wallet private key

**Action Items:**
- [ ] Implement env encryption

---

## ✅ KEEP — Fitur Arcanist yang Sudah Bagus

Fitur-fitur ini sudah ada di Arcanist dan layak dipertahankan (bahkan beberapa lebih baik dari Meridian):

| Fitur | File | Catatan |
|-------|------|---------|
| **Supertrend Indicator** | [scraper.cjs](file:///root/arcanist/bot/scraper.cjs#L43-L93) | Meridian punya `chart-indicators.js` tapi Arcanist punya implementasi Supertrend yang solid |
| **Volume Trend Detection** | [scraper.cjs](file:///root/arcanist/bot/scraper.cjs#L95-L117) | Feature unik Arcanist — deteksi accelerating/decelerating volume |
| **ATH Breakout Detection** | [scraper.cjs](file:///root/arcanist/bot/scraper.cjs#L339-L346) + [ai-agent.cjs](file:///root/arcanist/bot/ai-agent.cjs#L78-L93) | Prioritas otomatis untuk token yang breakout ATH — tidak ada di Meridian |
| **Manual Position Sync** | [sync-positions.cjs](file:///root/arcanist/bot/sync-positions.cjs) | Auto-detect dan track posisi manual — berguna |
| **Comprehensive Token Filters** | [scraper.cjs](file:///root/arcanist/bot/scraper.cjs#L211-L257) | Top 10 %, dev holds %, insider %, phishing %, bundling %, rug % — lebih granular dari Meridian |
| **RSI/BB/MACD Exit** | [monitor.cjs](file:///root/arcanist/bot/monitor.cjs#L133-L162) | Technical exit conditions — Meridian tidak punya exit berbasis TA |
| **Hermes Mindset** | [hermes-mindset.json](file:///root/arcanist/hermes-mindset.json) | Custom AI personality/strategy — bisa dipertahankan sebagai system prompt component |
| **Health Check HTTP** | [main.cjs](file:///root/arcanist/bot/main.cjs#L420-L436) | Simple health endpoint di port 3001 |
| **Bin Array Cost Check** | [engine.cjs](file:///root/arcanist/bot/engine.cjs#L148-L153) | Skip deploy jika non-refundable binArray cost terlalu tinggi |
| **Telegram Handlers** | [telegram-handlers.cjs](file:///root/arcanist/bot/telegram-handlers.cjs) | Sudah punya base handlers yang bisa di-extend |

---

## 🚫 REMOVE / REPLACE — Yang Harus Dihilangkan

| Item | Alasan |
|------|--------|
| `npx gmgn-cli` subprocess spawning | Terlalu lambat, unreliable, tergantung external package. Ganti dengan direct API calls |
| Flat array state (`active_positions.json`) | Migrate ke object-keyed state |
| `proper-lockfile` dependency | Tidak perlu — filesystem atomic writes cukup |
| Kline-based TP/SL (`entryPriceUsd`) | Ganti dengan PnL-based (actual position value) |
| `hermes-mindset.json` sebagai file terpisah | Integrate into system prompt builder |

---

## 📋 Recommended Implementation Order

### Phase 1 — Foundation (Critical)
1. Config system restructure
2. State management migration
3. Logger module
4. Graceful shutdown

### Phase 2 — Core Agent (Critical)
5. Agent loop (ReAct pattern)
6. Tool definitions + executor
7. System prompt builder
8. Management cycle restructure
9. Screening pipeline restructure

### Phase 3 — Exit & Risk (Critical)
10. Trailing TP implementation
11. Deterministic exit rules (5 rules)
12. PnL poller (3s interval)
13. PnL confirmation system

### Phase 4 — Learning & Memory (Medium)
14. Lessons system
15. Pool memory
16. Signal weights (Darwin)
17. Decision logging

### Phase 5 — Control & UX (Medium)
18. Telegram interactive upgrade
19. Settings menu (inline keyboard)
20. Live messages
21. Morning briefing

### Phase 6 — Network & Polish (Low)
22. HiveMind integration
23. Smart wallets
24. Strategy library
25. Dev blocklist
26. ES Module migration
27. Env encryption

---

## Estimasi Effort

| Phase | Complexity | Est. Time |
|-------|-----------|-----------|
| Phase 1 | Medium | 2-3 hari |
| Phase 2 | **Very High** | 5-7 hari |
| Phase 3 | High | 3-4 hari |
| Phase 4 | High | 3-4 hari |
| Phase 5 | Medium | 2-3 hari |
| Phase 6 | Low-Medium | 2-3 hari |
| **Total** | | **17-24 hari** |

> [!IMPORTANT]
> Phase 2 (Core Agent) adalah fase paling kompleks karena melibatkan pembuatan tool definitions (~41K lines di Meridian), executor (~35K lines), dan system prompt builder (~11K lines). Ini adalah inti dari arsitektur Meridian.

---

## Catatan Arsitektur Kunci

### Meridian Pattern: "Deterministic First, LLM Second"
```
Position Data
    ↓
Deterministic Rules (JS)   →  CLOSE/CLAIM/STAY
    ↓ (only if INSTRUCTION or ambiguous)
LLM Agent Loop             →  Decision + Execution
```

Ini sangat efisien karena:
- 80% situasi tidak perlu LLM call
- Mengurangi biaya API
- Mengurangi latency
- Mengurangi risiko hallucination

### Meridian Pattern: "Position-Centric State"
```json
{
  "positions": {
    "POSITION_ADDRESS": {
      "peak_pnl_pct": 5.2,
      "trailing_active": true,
      "pending_peak_pnl_pct": null,
      "instruction": "hold until 10% profit",
      "signal_snapshot": { ... }
    }
  },
  "recentEvents": [...]
}
```

Ini memungkinkan:
- Per-position trailing TP
- Per-position instructions
- Learning dari setiap position
- Event timeline untuk debugging

### Meridian Pattern: "Configuration as Living Document"
Config bisa berubah dari:
1. `user-config.json` file edit
2. `update_config` tool (AI runtime)
3. `/setcfg key value` (Telegram)
4. `/settings` button menu (Telegram)
5. `evolveThresholds()` auto-evolution
6. HiveMind preset sync

Arcanist hanya support #1.
