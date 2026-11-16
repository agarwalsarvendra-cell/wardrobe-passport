// Postgres access. Production: DATABASE_URL (Supabase). Development and tests:
// an in-memory Postgres (PGlite), so the same SQL runs everywhere.
import type { Pool } from "pg";

type Row = Record<string, any>;
interface Db { query(sql: string, params?: any[]): Promise<Row[]> }

// Safe to run on every start: creates what's missing and adds new columns to old tables.
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
alter table users add column if not exists email text;
alter table users add column if not exists invited_by text;
alter table users add column if not exists onchain boolean not null default false;
alter table users add column if not exists city text;
alter table users add column if not exists seeded boolean not null default false;
create unique index if not exists users_email_idx on users (lower(email)) where email is not null;
create table if not exists photos (
  hash text primary key,
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
create table if not exists auth_requests (
  item_id bigint primary key,
  requested_by text not null,
  owner_address text not null,
  partner_address text not null,
  status text not null default 'pending',
  note text,
  created_at timestamptz not null default now(),
  decided_at timestamptz
);
create table if not exists sessions (
  token_hash text primary key,
  handle text not null,
  is_admin boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create table if not exists login_codes (
  key text primary key,
  code_hash text not null,
  expires_at timestamptz not null,
  attempts int not null default 0
);
create table if not exists invites (
  code text primary key,
  inviter text not null,
  created_at timestamptz not null default now(),
  used_by text,
  used_at timestamptz
);
create table if not exists credits (
  id bigserial primary key,
  handle text not null,
  kind text not null,
  amount_cents int not null,
  note text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at timestamptz
);
create table if not exists flags (
  item_id bigint not null,
  handle text not null,
  reason text,
  created_at timestamptz not null default now(),
  primary key (item_id, handle)
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
  if (!g.__wpDb) g.__wpDb = create().catch((e) => { g.__wpDb = undefined; throw e; });
  return g.__wpDb;
}
export async function q(sql: string, params: any[] = []): Promise<Row[]> {
  return (await db()).query(sql, params);
}
