# Known Issues

## 1. Meteora Wide Range Deployment (>69 Bins)
**Status:** Open
**Description:** 
Meteora SDK allows creating liquidity positions. However, when deploying a "Wide Range" position (e.g. `minRange: -90`, `maxRange: +1`) which translates to more than 69 bins difference, Solana's network architecture hits physical limits. 

**Technical Details:**
- **Solana Reallocation Limit:** A single `InitializePosition` inner instruction in Solana can only reallocate a maximum of `10240 bytes` of account data. This roughly corresponds to ~69 bins. Any wider range will throw `Failed to reallocate account data`.
- **Transaction Packet Size Limit:** A single Transaction Packet in Solana is hard-capped at `1232 bytes` (MTU limit). Compressing the generated multiple instructions into 1 `VersionedTransaction` (V0) will result in `encoding overruns Uint8Array`.
- **Meteora Chunking Limit:** Using the SDK's `addLiquidityByStrategyChunkable` will inherently split the wide-range deployment into multiple sequential transactions (Chunking).

**Current Workaround:**
- Deployments made via the Telegram `/open` command are **hard-capped to 69 bins** to ensure it can be processed within 1 transaction and 1 gas fee. 
- If a user wishes to open an extreme wide-range position, they must currently do so **manually via the Meteora Website**. The bot will still correctly detect the manually opened position and enforce its Technical Exit (Take Profit / Stop Loss) auto-close logic without any issues.
