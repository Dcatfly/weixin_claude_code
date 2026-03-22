import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { getSyncBufFilePath } from "../storage/sync-buf.js";


export const DEFAULT_BASE_URL = "https://ilinkai.weixin.qq.com";
export const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";

// ---------------------------------------------------------------------------
// Account ID normalization
// ---------------------------------------------------------------------------

export function normalizeAccountId(raw: string): string {
  return raw.replace(/[@.]/g, "-");
}

// ---------------------------------------------------------------------------
// Account index (persistent list of registered account IDs)
// ---------------------------------------------------------------------------

function resolveWeixinStateDir(): string {
  return path.join(os.homedir(), ".claude", "channels", "wechat");
}

function resolveAccountIndexPath(): string {
  return path.join(resolveWeixinStateDir(), "accounts.json");
}

/** Returns all accountIds registered via QR login. */
export function listIndexedWeixinAccountIds(): string[] {
  const filePath = resolveAccountIndexPath();
  try {
    if (!fs.existsSync(filePath)) return [];
    const raw = fs.readFileSync(filePath, "utf-8");
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((id): id is string => typeof id === "string" && id.trim() !== "");
  } catch {
    return [];
  }
}

/** Add accountId to the persistent index (no-op if already present). */
export function registerWeixinAccountId(accountId: string): void {
  const dir = resolveWeixinStateDir();
  fs.mkdirSync(dir, { recursive: true });

  const existing = listIndexedWeixinAccountIds();
  if (existing.includes(accountId)) return;

  const updated = [...existing, accountId];
  fs.writeFileSync(resolveAccountIndexPath(), JSON.stringify(updated, null, 2), "utf-8");
}


// ---------------------------------------------------------------------------
// Account store (per-account credential files)
// ---------------------------------------------------------------------------

/** Unified per-account data: token + baseUrl in one file. */
export type WeixinAccountData = {
  token?: string;
  savedAt?: string;
  baseUrl?: string;
  /** Last linked Weixin user id from QR login (optional). */
  userId?: string;
};

function resolveAccountsDir(): string {
  return path.join(resolveWeixinStateDir(), "accounts");
}

function resolveAccountPath(accountId: string): string {
  return path.join(resolveAccountsDir(), `${accountId}.json`);
}

function readAccountFile(filePath: string): WeixinAccountData | null {
  try {
    if (fs.existsSync(filePath)) {
      return JSON.parse(fs.readFileSync(filePath, "utf-8")) as WeixinAccountData;
    }
  } catch {
    // ignore
  }
  return null;
}

/** Load account data by ID. */
export function loadWeixinAccount(accountId: string): WeixinAccountData | null {
  const primary = readAccountFile(resolveAccountPath(accountId));
  if (primary) return primary;
  return null;
}

/**
 * Persist account data after QR login (merges into existing file).
 * - token: overwritten when provided.
 * - baseUrl: stored when non-empty; resolveWeixinAccount falls back to DEFAULT_BASE_URL.
 * - userId: set when `update.userId` is provided; omitted from file when cleared to empty.
 */
export function saveWeixinAccount(
  accountId: string,
  update: { token?: string; baseUrl?: string; userId?: string },
): void {
  const dir = resolveAccountsDir();
  fs.mkdirSync(dir, { recursive: true });

  const existing = loadWeixinAccount(accountId) ?? {};

  const token = update.token?.trim() || existing.token;
  const baseUrl = update.baseUrl?.trim() || existing.baseUrl;
  const userId =
    update.userId !== undefined
      ? update.userId.trim() || undefined
      : existing.userId?.trim() || undefined;

  const data: WeixinAccountData = {
    ...(token ? { token, savedAt: new Date().toISOString() } : {}),
    ...(baseUrl ? { baseUrl } : {}),
    ...(userId ? { userId } : {}),
  };

  const filePath = resolveAccountPath(accountId);
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    // best-effort
  }
}

/** Remove account: delete credential file, sync buf, and remove from index. */
export function removeWeixinAccount(accountId: string): void {
  // 删除凭证文件
  try { fs.unlinkSync(resolveAccountPath(accountId)); } catch { /* ignore */ }
  // 删除 sync buf 文件
  try { fs.unlinkSync(getSyncBufFilePath(accountId)); } catch { /* ignore */ }
  // 从索引中移除
  const existing = listIndexedWeixinAccountIds();
  const updated = existing.filter((id) => id !== accountId);
  const dir = resolveWeixinStateDir();
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(resolveAccountIndexPath(), JSON.stringify(updated, null, 2), "utf-8");
}

// ---------------------------------------------------------------------------
// Account resolution
// ---------------------------------------------------------------------------

export type ResolvedWeixinAccount = {
  accountId: string;
  baseUrl: string;
  cdnBaseUrl: string;
  token?: string;
  configured: boolean;
  userId?: string;
};

export function resolveWeixinAccount(accountId: string): ResolvedWeixinAccount {
  const data = loadWeixinAccount(accountId);
  return {
    accountId,
    baseUrl: data?.baseUrl?.trim() || DEFAULT_BASE_URL,
    cdnBaseUrl: CDN_BASE_URL,
    token: data?.token?.trim() || undefined,
    configured: Boolean(data?.token?.trim()),
    userId: data?.userId?.trim() || undefined,
  };
}
