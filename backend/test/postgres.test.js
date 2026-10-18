const assert = require("node:assert/strict");
const Module = require("node:module");
const { test } = require("node:test");

test("frontend API helpers target the backend and safely parse error bodies", async () => {
  const { resolveApiUrl } = await import("../../frontend/src/api-config.js");
  const { parseApiResponseText } = await import("../../frontend/src/api-response.js");

  assert.equal(
    resolveApiUrl({
      configuredApiUrl: undefined,
      isProduction: true,
      frontendOrigin: "https://meet-up-realtime-communication.vercel.app",
    }),
    "https://meet-up-realtime-communication.onrender.com",
  );
  assert.equal(
    resolveApiUrl({
      configuredApiUrl: "https://meet-up-realtime-communication.vercel.app",
      isProduction: true,
      frontendOrigin: "https://meet-up-realtime-communication.vercel.app",
    }),
    "https://meet-up-realtime-communication.onrender.com",
  );
  assert.equal(
    resolveApiUrl({
      configuredApiUrl: "https://api.example.test/",
      isProduction: true,
      frontendOrigin: "https://meet-up-realtime-communication.vercel.app",
    }),
    "https://api.example.test",
  );
  assert.deepEqual(
    parseApiResponseText("<!DOCTYPE html><html></html>", 404),
    { error: "The server returned an unexpected response (HTTP 404)." },
  );
  assert.deepEqual(parseApiResponseText('{"error":"Not found"}', 404), {
    error: "Not found",
  });
});

const TEST_DATABASE_URL =
  "postgresql://unit-test.invalid/meetup_test?sslmode=disable";
process.env.DATABASE_URL = TEST_DATABASE_URL;
process.env.PORT = "0";
process.env.FRONTEND_URL = "http://localhost:5174";
process.env.NODE_ENV = "test";

const originalLoad = Module._load;
const users = new Map();
const sessions = new Map();
const rooms = new Map();
const statements = [];
let schemaAvailable = true;

class MockPool {
  constructor(options) {
    const connectionUrl = new URL(options.connectionString);
    assert.equal(connectionUrl.hostname, "unit-test.invalid");
    assert.equal(connectionUrl.searchParams.has("sslmode"), false);
    assert.deepEqual(options.ssl, { rejectUnauthorized: true });
  }

  on() {}

  async end() {}

  async query(sql, values = []) {
    statements.push({ sql, values });
    const normalizedSql = sql.replace(/\s+/g, " ").trim();

    if (normalizedSql.startsWith("CREATE TABLE") ||
        normalizedSql.startsWith("CREATE INDEX")) {
      return { rows: [], rowCount: 0 };
    }

    if (normalizedSql.includes("FROM information_schema.columns")) {
      const columns = {
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
      return {
        rows: schemaAvailable
          ? Object.entries(columns).flatMap(([table_name, names]) =>
            names.map((column_name) => ({ table_name, column_name })))
          : [],
        rowCount: schemaAvailable
          ? Object.values(columns).reduce((count, names) => count + names.length, 0)
          : 0,
      };
    }

    if (normalizedSql.startsWith("INSERT INTO users")) {
      if ([...users.values()].some((user) => user.email === values[1])) {
        const error = new Error("Duplicate email");
        error.code = "23505";
        error.constraint = "users_email_key";
        throw error;
      }
      users.set(values[0], {
        id: values[0],
        email: values[1],
        display_name: values[2],
        password_salt: values[3],
        password_hash: values[4],
        created_at: values[5],
      });
      return { rows: [], rowCount: 1 };
    }

    if (normalizedSql.startsWith("SELECT id, email, display_name, password_salt")) {
      return {
        rows: [...users.values()].filter((user) => user.email === values[0]),
        rowCount: 1,
      };
    }

    if (normalizedSql.startsWith("INSERT INTO sessions")) {
      sessions.set(values[0], {
        token_hash: values[0],
        user_id: values[1],
        expires_at: values[2],
        revoked_at: null,
        created_at: values[3],
      });
      return { rows: [], rowCount: 1 };
    }

    if (normalizedSql.startsWith("SELECT sessions.token_hash")) {
      const session = sessions.get(values[0]);
      const user = session && users.get(session.user_id);
      const active = session && user &&
        session.revoked_at === null &&
        session.expires_at > values[1];
      return {
        rows: active
          ? [{
            ...session,
            email: user.email,
            display_name: user.display_name,
          }]
          : [],
        rowCount: active ? 1 : 0,
      };
    }

    if (normalizedSql.startsWith("UPDATE sessions")) {
      const session = sessions.get(values[1]);
      if (!session || session.revoked_at !== null) {
        return { rows: [], rowCount: 0 };
      }
      session.revoked_at = values[0];
      return { rows: [], rowCount: 1 };
    }

    if (normalizedSql.startsWith("SELECT code, name, owner_user_id FROM meeting_rooms")) {
      if (normalizedSql.includes("WHERE code = $1")) {
        const room = rooms.get(values[0]);
        return { rows: room ? [room] : [], rowCount: room ? 1 : 0 };
      }
      return { rows: [...rooms.values()], rowCount: rooms.size };
    }

    if (normalizedSql.startsWith("INSERT INTO meeting_rooms")) {
      rooms.set(values[0], {
        code: values[0],
        name: values[1],
        owner_user_id: values[2],
        created_at: values[3],
      });
      return { rows: [], rowCount: 1 };
    }

    throw new Error(`Unexpected PostgreSQL query in test: ${normalizedSql}`);
  }
}

Module._load = function (request, parent, isMain) {
  if (request === "pg") return { Pool: MockPool };
  return originalLoad.call(this, request, parent, isMain);
};

const database = require("../database");
const { io, restoreRooms, server } = require("../server");

test("PostgreSQL schema, authentication, sessions, and room creation", async (t) => {
  await database.initializeDatabase();
  await restoreRooms();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  t.after(async () => {
    await new Promise((resolve) => io.close(resolve));
    await database.closeDatabase();
    Module._load = originalLoad;
  });

  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  const origin = "http://localhost:5174";
  const credentials = {
    email: "meetup-test@example.test",
    password: "a-test-password-long-enough",
    displayName: "Meet Up Tester",
  };
  let sessionCookie;

  await t.test("initializes the PostgreSQL schema and indexes", async () => {
    const schema = statements.find(({ sql }) => sql.includes("CREATE TABLE IF NOT EXISTS users"));
    assert.ok(schema);
    assert.match(schema.sql, /id UUID PRIMARY KEY/);
    assert.match(schema.sql, /email VARCHAR\(254\) NOT NULL UNIQUE/);
    assert.match(schema.sql, /password_salt BYTEA NOT NULL/);
    assert.match(schema.sql, /password_hash BYTEA NOT NULL/);
    assert.match(schema.sql, /user_id UUID NOT NULL REFERENCES users\(id\) ON DELETE CASCADE/);
    assert.match(schema.sql, /CREATE INDEX IF NOT EXISTS sessions_user_id_idx/);
    assert.match(schema.sql, /CREATE INDEX IF NOT EXISTS sessions_expires_at_idx/);
    assert.match(schema.sql, /CREATE TABLE IF NOT EXISTS meeting_rooms/);
    assert.match(schema.sql, /CREATE INDEX IF NOT EXISTS meeting_rooms_owner_user_id_idx/);
  });

  await t.test("health check validates the database schema without writes", async () => {
    const response = await fetch(`${baseUrl}/api/health`);
    assert.equal(response.status, 200);
    assert.equal((await response.json()).status, "ok");
    const healthQuery = statements.find(({ sql }) =>
      sql.includes("FROM information_schema.columns"));
    assert.ok(healthQuery);
    assert.match(healthQuery.sql, /current_schema\(\)/);
    assert.deepEqual(healthQuery.values, [["users", "sessions", "meeting_rooms"]]);

    schemaAvailable = false;
    const unavailable = await fetch(`${baseUrl}/api/health`);
    assert.equal(unavailable.status, 503);
    assert.equal((await unavailable.json()).status, "unavailable");
    schemaAvailable = true;
  });

  await t.test("registers an account and creates a cookie-backed session", async () => {
    const response = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(credentials),
    });
    assert.equal(response.status, 201);
    const result = await response.json();
    assert.equal(result.user.email, credentials.email);
    assert.equal(result.user.displayName, credentials.displayName);
    assert.equal(typeof result.expiresAt, "number");

    sessionCookie = response.headers.get("set-cookie").split(";")[0];
    const token = sessionCookie.slice(sessionCookie.indexOf("=") + 1);
    assert.ok(token);
    assert.ok([...sessions.keys()].every((hash) => hash !== token));
  });

  await t.test("logs in with the stored password hash", async () => {
    const response = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: credentials.email,
        password: credentials.password,
      }),
    });
    assert.equal(response.status, 200);
    assert.equal((await response.json()).user.email, credentials.email);

    const invalidResponse = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: credentials.email,
        password: "a-wrong-password-value",
      }),
    });
    assert.equal(invalidResponse.status, 401);
  });

  await t.test("rejects duplicate email addresses", async () => {
    const response = await fetch(`${baseUrl}/api/auth/register`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify(credentials),
    });
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), {
      error: "An account with this email already exists.",
    });
  });

  await t.test("validates sessions and revokes them on logout", async () => {
    const authenticated = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(authenticated.status, 200);

    const logout = await fetch(`${baseUrl}/api/auth/logout`, {
      method: "POST",
      headers: { Origin: origin, Cookie: sessionCookie },
    });
    assert.equal(logout.status, 204);

    const revoked = await fetch(`${baseUrl}/api/auth/me`, {
      headers: { Cookie: sessionCookie },
    });
    assert.equal(revoked.status, 401);
  });

  await t.test("creates a persistent room for the authenticated owner", async () => {
    const login = await fetch(`${baseUrl}/api/auth/login`, {
      method: "POST",
      headers: { Origin: origin, "Content-Type": "application/json" },
      body: JSON.stringify({
        email: credentials.email,
        password: credentials.password,
      }),
    });
    assert.equal(login.status, 200);
    const cookie = login.headers.get("set-cookie").split(";")[0];

    const response = await fetch(`${baseUrl}/api/rooms`, {
      method: "POST",
      headers: {
        Origin: origin,
        Cookie: cookie,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ name: "Automated test room" }),
    });
    assert.equal(response.status, 201);
    const room = await response.json();
    assert.match(room.code, /^[0-9A-F]{32}$/);
    assert.equal(room.name, "Automated test room");
    assert.equal(rooms.get(room.code).owner_user_id, users.values().next().value.id);

    const lookup = await fetch(`${baseUrl}/api/rooms/${room.code.toLowerCase()}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(lookup.status, 200);
    assert.deepEqual(await lookup.json(), {
      id: room.code,
      name: "Automated test room",
      code: room.code,
      participants: [],
    });
    const lookupQuery = statements.findLast(({ sql }) =>
      sql.includes("WHERE code = $1"));
    assert.ok(lookupQuery);
    assert.deepEqual(lookupQuery.values, [room.code]);

    const invalidLookup = await fetch(`${baseUrl}/api/rooms/invalid`, {
      headers: { Cookie: cookie },
    });
    assert.equal(invalidLookup.status, 400);

    const missingLookup = await fetch(`${baseUrl}/api/rooms/${"A".repeat(32)}`, {
      headers: { Cookie: cookie },
    });
    assert.equal(missingLookup.status, 404);

    const unauthenticatedLookup = await fetch(`${baseUrl}/api/rooms/${room.code}`);
    assert.equal(unauthenticatedLookup.status, 401);
  });

  await t.test("returns JSON for unknown API routes", async () => {
    const response = await fetch(`${baseUrl}/api/not-a-route`);
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), {
      error: "API endpoint not found.",
    });
  });

  await t.test("uses parameterized SQL for user-provided values", () => {
    const parameterizedStatements = statements.filter(({ values }) => values.length);
    assert.ok(parameterizedStatements.length > 0);
    assert.ok(parameterizedStatements.every(({ sql }) => /\$\d+/.test(sql)));
  });
});
