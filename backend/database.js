require("dotenv").config();
const { Pool } = require("pg");

const REQUIRED_COLUMNS = {
  users: [
    "id",
    "email",
    "display_name",
    "password_salt",
    "password_hash",
    "created_at",
  ],
  sessions: ["token_hash", "user_id", "expires_at", "revoked_at", "created_at"],
  meeting_rooms: ["code", "name", "owner_user_id", "created_at"],
};
let pool;

function getPool() {
  if (pool) return pool;
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required to connect to PostgreSQL.");
  }

  let connectionUrl;
  try {
    connectionUrl = new URL(process.env.DATABASE_URL);
  } catch {
    throw new Error("DATABASE_URL must be a valid PostgreSQL connection URL.");
  }
  if (!["postgres:", "postgresql:"].includes(connectionUrl.protocol)) {
    throw new Error("DATABASE_URL must use the PostgreSQL protocol.");
  }

  const localHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);
  const useTls = !localHosts.has(connectionUrl.hostname.toLowerCase());

  // Keep TLS policy under application control instead of allowing URL options
  // to silently disable certificate-verified TLS on remote database hosts.
  for (const option of [
    "ssl",
    "sslmode",
    "sslcert",
    "sslkey",
    "sslrootcert",
    "uselibpqcompat",
  ]) {
    connectionUrl.searchParams.delete(option);
  }

  pool = new Pool({
    connectionString: connectionUrl.toString(),
    ssl: useTls ? { rejectUnauthorized: true } : false,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
  });

  pool.on("error", () => {
    console.error("An idle PostgreSQL connection encountered an error.");
  });
  return pool;
}

async function initializeDatabase() {
  await getPool().query(`
    CREATE TABLE IF NOT EXISTS users (
      id UUID PRIMARY KEY,
      email VARCHAR(254) NOT NULL UNIQUE,
      display_name VARCHAR(40) NOT NULL,
      password_salt BYTEA NOT NULL,
      password_hash BYTEA NOT NULL,
      created_at BIGINT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token_hash CHAR(64) PRIMARY KEY,
      user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at BIGINT NOT NULL,
      revoked_at BIGINT,
      created_at BIGINT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
    CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

    CREATE TABLE IF NOT EXISTS meeting_rooms (
      code VARCHAR(32) PRIMARY KEY,
      name VARCHAR(64) NOT NULL,
      owner_user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      created_at TIMESTAMPTZ NOT NULL
    );

    CREATE INDEX IF NOT EXISTS meeting_rooms_owner_user_id_idx
      ON meeting_rooms(owner_user_id);
  `);
}

async function healthCheck() {
  const result = await getPool().query(`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = ANY($1::text[])
  `, [Object.keys(REQUIRED_COLUMNS)]);
  const availableColumns = new Map();

  for (const row of result.rows) {
    if (!availableColumns.has(row.table_name)) {
      availableColumns.set(row.table_name, new Set());
    }
    availableColumns.get(row.table_name).add(row.column_name);
  }

  for (const [tableName, requiredColumns] of Object.entries(REQUIRED_COLUMNS)) {
    const columns = availableColumns.get(tableName);
    if (!columns || requiredColumns.some((column) => !columns.has(column))) {
      throw new Error("The PostgreSQL schema is missing required columns.");
    }
  }
}

async function withTransaction(operation) {
  const client = await getPool().connect();
  try {
    await client.query("BEGIN");
    const result = await operation((text, values) => client.query(text, values));
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function closeDatabase() {
  if (!pool) return;
  const activePool = pool;
  pool = undefined;
  await activePool.end();
}

module.exports = {
  closeDatabase,
  healthCheck,
  initializeDatabase,
  query: (text, values) => getPool().query(text, values),
  withTransaction,
};
