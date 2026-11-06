/**
 * SQLite local state (expo-sqlite).
 *
 * Stores paired shops, jobs, and payment references — NO private keys, no
 * document contents. This is the local-first source of truth so job history and
 * tracking work offline.
 */

/**
 * expo-sqlite is imported lazily so the app still boots on platforms/toolchains
 * where the native module can't resolve (e.g. the web dev bundle). On a real
 * device/simulator build it loads normally and persistence works. When it is
 * unavailable, reads return empty and writes no-op — the UI remains fully usable.
 */
import type * as SQLiteTypes from "expo-sqlite";
import type {
  JobStatus,
  PaymentStatus,
} from "@inklink/shared-schemas";

type SQLiteModule = typeof import("expo-sqlite");
type SQLiteDatabase = SQLiteTypes.SQLiteDatabase;

// Metro provides a CommonJS-style require at runtime; declare it for TS.
declare const require: (moduleId: string) => unknown;

let sqliteAvailable = true;

export interface PairedShopRow {
  shopId: string;
  gatewayId: string;
  name: string;
  /** Base64URL gateway public key, pinned from the verified QR. */
  publicKey: string;
  publicKeyFingerprint: string;
  gatewayMdns: string;
  gatewayIp: string | null;
  gatewayPort: number;
  /** Signed https origin of a cloud-hosted backend for this shop (from the QR), if any. */
  gatewayCloudOrigin?: string | null;
  pairedAt: string;
}

export interface JobRow {
  jobId: string;
  shopId: string;
  documentName: string | null;
  copies: number;
  pageRange: string;
  colourMode: string;
  paperSize: string;
  quoteAmountInr: string | null;
  status: JobStatus;
  paymentStatus: PaymentStatus;
  paymentId: string | null;
  transactionId: string | null;
  createdAt: string;
  updatedAt: string;
}

let dbPromise: Promise<SQLiteDatabase | null> | null = null;

async function getDb(): Promise<SQLiteDatabase | null> {
  if (!sqliteAvailable) return null;
  if (!dbPromise) {
    dbPromise = (async (): Promise<SQLiteDatabase | null> => {
      let SQLite: SQLiteModule;
      try {
        SQLite = require("expo-sqlite") as unknown as SQLiteModule;
      } catch (e) {
        console.warn("[inklink] expo-sqlite unavailable; running without local persistence.", e);
        sqliteAvailable = false;
        return null;
      }
      const db = await SQLite.openDatabaseAsync("inklink.db");
      await db.execAsync(`
        PRAGMA journal_mode = WAL;
        CREATE TABLE IF NOT EXISTS shops (
          shopId TEXT PRIMARY KEY,
          gatewayId TEXT NOT NULL,
          name TEXT NOT NULL,
          publicKey TEXT NOT NULL DEFAULT '',
          publicKeyFingerprint TEXT NOT NULL,
          gatewayMdns TEXT NOT NULL,
          gatewayIp TEXT,
          gatewayPort INTEGER NOT NULL,
          gatewayCloudOrigin TEXT,
          pairedAt TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS jobs (
          jobId TEXT PRIMARY KEY,
          shopId TEXT NOT NULL,
          documentName TEXT,
          copies INTEGER NOT NULL,
          pageRange TEXT NOT NULL,
          colourMode TEXT NOT NULL,
          paperSize TEXT NOT NULL,
          quoteAmountInr TEXT,
          status TEXT NOT NULL,
          paymentStatus TEXT NOT NULL,
          paymentId TEXT,
          transactionId TEXT,
          createdAt TEXT NOT NULL,
          updatedAt TEXT NOT NULL
        );
      `);
      // Migrate databases created before the pinned key / IPv4 hint existed.
      for (const ddl of [
        `ALTER TABLE shops ADD COLUMN publicKey TEXT NOT NULL DEFAULT ''`,
        `ALTER TABLE shops ADD COLUMN gatewayIp TEXT`,
        `ALTER TABLE shops ADD COLUMN gatewayCloudOrigin TEXT`,
      ]) {
        try {
          await db.execAsync(ddl);
        } catch {
          /* column already exists */
        }
      }
      return db;
    })();
  }
  return dbPromise;
}

export const db = {
  async upsertShop(row: PairedShopRow): Promise<void> {
    const d = await getDb();
    if (!d) return;
    await d.runAsync(
      `INSERT OR REPLACE INTO shops
       (shopId, gatewayId, name, publicKey, publicKeyFingerprint, gatewayMdns, gatewayIp, gatewayPort, gatewayCloudOrigin, pairedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.shopId,
      row.gatewayId,
      row.name,
      row.publicKey,
      row.publicKeyFingerprint,
      row.gatewayMdns,
      row.gatewayIp,
      row.gatewayPort,
      row.gatewayCloudOrigin ?? null,
      row.pairedAt,
    );
  },

  async listShops(): Promise<PairedShopRow[]> {
    const d = await getDb();
    if (!d) return [];
    return d.getAllAsync<PairedShopRow>(`SELECT * FROM shops ORDER BY pairedAt DESC`);
  },

  async insertJob(row: JobRow): Promise<void> {
    const d = await getDb();
    if (!d) return;
    await d.runAsync(
      `INSERT OR REPLACE INTO jobs
       (jobId, shopId, documentName, copies, pageRange, colourMode, paperSize,
        quoteAmountInr, status, paymentStatus, paymentId, transactionId, createdAt, updatedAt)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      row.jobId,
      row.shopId,
      row.documentName,
      row.copies,
      row.pageRange,
      row.colourMode,
      row.paperSize,
      row.quoteAmountInr,
      row.status,
      row.paymentStatus,
      row.paymentId,
      row.transactionId,
      row.createdAt,
      row.updatedAt,
    );
  },

  async updateJob(jobId: string, patch: Partial<JobRow>): Promise<void> {
    const d = await getDb();
    if (!d) return;
    const keys = Object.keys(patch);
    if (keys.length === 0) return;
    const setClause = keys.map((k) => `${k} = ?`).join(", ");
    const values = keys.map((k) => (patch as Record<string, unknown>)[k]);
    await d.runAsync(
      `UPDATE jobs SET ${setClause}, updatedAt = ? WHERE jobId = ?`,
      ...(values as (string | number | null)[]),
      new Date().toISOString(),
      jobId,
    );
  },

  async listJobs(): Promise<JobRow[]> {
    const d = await getDb();
    if (!d) return [];
    return d.getAllAsync<JobRow>(`SELECT * FROM jobs ORDER BY createdAt DESC`);
  },

  async getJob(jobId: string): Promise<JobRow | null> {
    const d = await getDb();
    if (!d) return null;
    return d.getFirstAsync<JobRow>(`SELECT * FROM jobs WHERE jobId = ?`, jobId);
  },
};
