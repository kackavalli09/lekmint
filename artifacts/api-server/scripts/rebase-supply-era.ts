/**
 * One-time data correction: rebase supply-log rows recorded at/after the
 * current metrics baseline (set by a key rotation) so the era's figures
 * start at zero. Pre-rotation rows keep their historical values.
 *
 * Idempotent and safe against live supply writers (transaction + the same
 * advisory lock recordSupplyDelta takes) — see rebaseSupplyEraRetroactive.
 *
 * Run with: pnpm --filter @workspace/api-server run rebase-supply-era
 */
import { rebaseSupplyEraRetroactive } from "../src/lib/supply";

rebaseSupplyEraRetroactive()
  .then((msg) => {
    console.log(msg);
    process.exit(0);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
