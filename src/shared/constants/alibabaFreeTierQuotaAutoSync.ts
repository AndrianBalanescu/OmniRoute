/**
 * @file alibabaFreeTierQuotaAutoSync.ts — shared constants.
 *
 * Kept in src/shared/constants/ so both the server service
 * (src/lib/services/alibabaFreeTierQuotaAutoSync.ts) and UI surfaces read the
 * same cadence without importing Node-only modules.
 */

/** How often the background sync re-pulls the console free-tier quota API. */
export const ALIBABA_FREE_TIER_QUOTA_SYNC_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6h