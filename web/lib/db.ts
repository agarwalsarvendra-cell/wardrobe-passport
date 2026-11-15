// Postgres access. Production: DATABASE_URL (Supabase). Development and tests:
// an in-memory Postgres (PGlite), so the same SQL runs everywhere.
import type { Pool } from "pg";

type Row = Record<string, any>;
interface Db { query(sql: string, params?: any[]): Promise<Row[]> }

const SCHEMA = `
create table if not exists users (
  handle text primary key,
  display_name text not null,
  role text not null,
  wallet_provider text not null,
  wallet_id text not null,
  address text not null,
  created_at timestamptz not null default now()
);
create table if not exists photos (
  hash text primary key,              -- sha256 of the bytes, also written into the passport on Arc
  mime text not null,
  bytes bytea not null,
  uploaded_by text,
  created_at timestamptz not null default now()
);
create table if not exists activity (
  id bigserial primary key,
  tx_hash text not null,
  action text not null,
  item_id bigint,
  actor text not null,
  detail jsonb not null default '{}'::jsonb,
  fee_wei text,
  created_at timestamptz not null default now()
);
create index if not exists activity_item_idx on activity (item_id);
create table if not exists settings (
  key text primary key,
  value text not null
);
`;

const g = globalThis as unknown as { __wpDb?: Promise<Db> };

async function create(): Promise<Db> {
  let db: Db;
  if (process.env.DATABASE_URL) {
    const { Pool } = await import("pg");
    const pool: Pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 3, ssl: { rejectUnauthorized: false } });
    db = { query: async (sql, params) => (await pool.query(sql, params)).rows };
  } else {
    const { PGlite } = await import("@electric-sql/pglite");
    const lite = new PGlite();
    db = { query: async (sql, params) => (await lite.query(sql, params)).rows as Row[] };
  }
  for (const stmt of SCHEMA.split(";").map((s) => s.trim()).filter(Boolean)) await db.query(stmt);
  return db;
}

export function db(): Promise<Db> {
  if (!g.__wpDb) g.__wpDb = create();
  return g.__wpDb;
}
export async function q(sql: string, params: any[] = []): Promise<Row[]> {
  return (await db()).query(sql, params);
}
