# Arcanist DLMM — Bug Analysis & Solutions

> **Date**: 2026-06-18
> **Status**: ✅ ALL FIXED
> **Files Changed**: state.cjs, sync-positions.cjs, telegram-handlers.cjs, main.cjs, engine.cjs, meteora.cjs

---

## Issue #1: Duplicate Positions — Posisi FRAG Terbagi Menjadi 2 Entry ✅ FIXED

### Symptom
```
📈 Active: 4/2 Limit   ← Seharusnya 2 posisi unik, tapi menampilkan 4
```

### Root Cause
Race condition antara `syncManualPositions` dan `engine.cjs` auto-entry — same positionPubKey saved twice.

### Fix
**state.cjs** `addPosition()` — added de-duplication guard that checks for existing `positionPubKey` before adding. If duplicate found and existing is manual while new is auto, upgrades entry instead.

---

## Issue #2: `/close_all` Error — Menghitung Posisi Duplikat ✅ FIXED

### Symptom
```
⏳ Closing 1/3: FRAG...     ← Harusnya 1/2
⏳ Closing 3/3: FRAG...     ← GAGAL: already closed
```

### Root Cause
`confirmCloseAllAction` reads raw state with duplicates, loops all entries including the duplicate one that's already closed.

### Fix
**telegram-handlers.cjs** `confirmCloseAllAction()` — de-duplicates by `positionPubKey` before loop, tracks closed pubkeys with Set.

---

## Issue #3: Manual Position Menunjukkan `🤖 Auto` di Close Mode ✅ FIXED

### Symptom
```
3. 👤 FRAG/SOL 🔒
   ⚙️ 🤖 Auto    ← Seharusnya 👤 Manual
```

### Root Cause
`syncManualPositions` didn't set `closeMode` property.

### Fix
**sync-positions.cjs** — added `closeMode: "manual"` default for synced positions.

---

## Issue #4: maxActivePositions Limit Bypass ✅ FIXED

### Symptom
Config `maxActivePositions: 2` but 4 positions displayed & scraper still runs.

### Root Cause
Multiple places count raw state length instead of unique positions.

### Fix
- **engine.cjs** — counts unique positions by `positionPubKey` for slot calculation
- **main.cjs** — scraper cron and startup both de-duplicate before limit check

---

## Issue #5: Display Count Salah di Semua Views ✅ FIXED

### Root Cause
No de-duplication before rendering in any display function.

### Fix
De-duplication added to ALL position-reading code paths:
- **telegram-handlers.cjs**: `sendPositionsCommand`, `closeCommand`, `closeAllCommand` (dialog), `confirmCloseAllAction`, `toggleCloseCommand`
- **main.cjs**: `sendDashboardReport`, scraper cron limit check, startup limit check

---

## Issue #6 (CRITICAL): Non-Refundable Cost Guard Broken ✅ FIXED

### Symptom
The `quoteCreatePosition` guard used wrong field names and couldn't handle both SDK return formats (BN lamports vs plain SOL number).

### Root Cause
1. Used `quote.binArraysCount` (wrong field name — correct is `binArrayCount`)
2. Used `quote.binArrayCost || 0` — `||` on BN(0) returns BN(0) which is truthy → not actually detecting zero
3. If SDK returns plain number like `0.075` SOL, `new BN(0.075)` truncates to `new BN(0)` → guard bypassed!
4. **engine.cjs** didn't check `result.status === "skipped"` → tried to save position data even when deploy was skipped, causing crash
5. **telegram-handlers.cjs** `/open` command had same issue

### Fix
- **meteora.cjs** — `toSolValue()` helper normalizes BN/number/string to SOL float. Guard checks `binArrayCount > 0 || binArrayCostSol > 0`. Logs all cost fields from SDK.
- **engine.cjs** — checks `result.status === "skipped"` before saving position, sends Telegram notification
- **telegram-handlers.cjs** `/open` — checks `result.status === "skipped"` before saving position

---

## Summary Table

| # | Issue | File(s) | Severity | Status |
|---|-------|---------|----------|--------|
| 1 | Duplicate positions | state.cjs | 🔴 Critical | ✅ Fixed |
| 2 | close_all error | telegram-handlers.cjs | 🔴 Critical | ✅ Fixed |
| 3 | Wrong close mode display | sync-positions.cjs | 🟡 Medium | ✅ Fixed |
| 4 | maxActivePositions bypass | engine.cjs, main.cjs | 🟡 Medium | ✅ Fixed |
| 5 | Display count wrong | telegram-handlers.cjs, main.cjs | 🟡 Medium | ✅ Fixed |
| 6 | Non-refundable guard broken | meteora.cjs, engine.cjs, telegram-handlers.cjs | 🔴 Critical | ✅ Fixed |
