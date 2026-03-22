export declare const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export declare const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
export declare function normalizeAccountId(raw: string): string;
/** Returns all accountIds registered via QR login. */
export declare function listIndexedWeixinAccountIds(): string[];
/** Add accountId to the persistent index (no-op if already present). */
export declare function registerWeixinAccountId(accountId: string): void;
/** Unified per-account data: token + baseUrl in one file. */
export type WeixinAccountData = {
    token?: string;
    savedAt?: string;
    baseUrl?: string;
    /** Last linked Weixin user id from QR login (optional). */
    userId?: string;
};
/** Load account data by ID. */
export declare function loadWeixinAccount(accountId: string): WeixinAccountData | null;
/**
 * Persist account data after QR login (merges into existing file).
 * - token: overwritten when provided.
 * - baseUrl: stored when non-empty; resolveWeixinAccount falls back to DEFAULT_BASE_URL.
 * - userId: set when `update.userId` is provided; omitted from file when cleared to empty.
 */
export declare function saveWeixinAccount(accountId: string, update: {
    token?: string;
    baseUrl?: string;
    userId?: string;
}): void;
/** Remove account: delete credential file, sync buf, and remove from index. */
export declare function removeWeixinAccount(accountId: string): void;
export type ResolvedWeixinAccount = {
    accountId: string;
    baseUrl: string;
    cdnBaseUrl: string;
    token?: string;
    configured: boolean;
    userId?: string;
};
export declare function resolveWeixinAccount(accountId: string): ResolvedWeixinAccount;
