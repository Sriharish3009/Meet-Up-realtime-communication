const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const database = require("./database");

async function migrate() {
  const sqlitePath = process.argv[2] || path.join(__dirname, "relay.sqlite");
  if (!fs.existsSync(sqlitePath)) {
    throw new Error("The selected SQLite database does not exist.");
  }

  const sqlite = new Database(sqlitePath, {
    readonly: true,
    fileMustExist: true,
  });

  let users;
  let sessions;
  let rooms;
  try {
    users = sqlite.prepare(`
      SELECT id, email, display_name, password_salt, password_hash, created_at
      FROM users
    `).all();
    sessions = sqlite.prepare(`
      SELECT token_hash, user_id, expires_at, revoked_at, created_at
      FROM sessions
    `).all();
    rooms = sqlite.prepare(`
      SELECT code, name, owner_user_id, created_at
      FROM meeting_rooms
    `).all();
  } finally {
    sqlite.close();
  }

  await database.initializeDatabase();
  await database.withTransaction(async (query) => {
    for (const user of users) {
      await query(`
        INSERT INTO users
          (id, email, display_name, password_salt, password_hash, created_at)
        VALUES ($1, $2, $3, $4, $5, $6)
      `, [
        user.id,
        user.email,
        user.display_name,
        user.password_salt,
        user.password_hash,
        user.created_at,
      ]);
    }

    for (const session of sessions) {
      await query(`
        INSERT INTO sessions
          (token_hash, user_id, expires_at, revoked_at, created_at)
        VALUES ($1, $2, $3, $4, $5)
      `, [
        session.token_hash,
        session.user_id,
        session.expires_at,
        session.revoked_at,
        session.created_at,
      ]);
    }

    for (const room of rooms) {
      const createdAt = new Date(room.created_at);
      if (Number.isNaN(createdAt.getTime())) {
        throw new Error("A saved room has an invalid creation timestamp.");
      }

      await query(`
        INSERT INTO meeting_rooms (code, name, owner_user_id, created_at)
        VALUES ($1, $2, $3, $4)
      `, [room.code, room.name, room.owner_user_id, createdAt]);
    }
  });

  console.log(
    `Migration complete: ${users.length} users, ${sessions.length} sessions, ${rooms.length} rooms copied.`,
  );
}

migrate()
  .catch(async () => {
    console.error(
      "SQLite migration failed. Check the source schema, PostgreSQL connection, and whether the destination already contains conflicting records.",
    );
    process.exitCode = 1;
  })
  .finally(async () => {
    await database.closeDatabase().catch(() => {
      console.error("Could not close the PostgreSQL connection pool.");
      process.exitCode = 1;
    });
  });
