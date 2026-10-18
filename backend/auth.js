const crypto = require("crypto");
const { promisify } = require("util");
const database = require("./database");

const scrypt = promisify(crypto.scrypt);
const SESSION_COOKIE_NAME = "relay_session";
const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PASSWORD_SALT_BYTES = 16;
const PASSWORD_HASH_BYTES = 64;
const PASSWORD_SCRYPT_OPTIONS = { N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };
const COOKIE_SECURE =
  process.env.NODE_ENV === "production" || process.env.COOKIE_SECURE === "true";

function publicUser(user) {
  return {
    id: user.id,
    email: user.email,
    displayName: user.display_name,
  };
}

function normalizeEmail(email) {
  return typeof email === "string" ? email.trim().toLowerCase() : "";
}

function validateCredentials({ email, password, displayName }, registering = false) {
  const normalizedEmail = normalizeEmail(email);
  if (
    normalizedEmail.length > 254 ||
    !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)
  ) {
    return { error: "Enter a valid email address." };
  }

  if (
    typeof password !== "string" ||
    Buffer.byteLength(password, "utf8") < 12 ||
    Buffer.byteLength(password, "utf8") > 128
  ) {
    return { error: "Password must be between 12 and 128 bytes." };
  }

  if (registering) {
    const name = typeof displayName === "string" ? displayName.trim() : "";
    if (!name || name.length > 40 || /[\u0000-\u001f\u007f]/.test(name)) {
      return { error: "Display name must contain 1-40 readable characters." };
    }
    return { email: normalizedEmail, password, displayName: name };
  }

  return { email: normalizedEmail, password };
}

async function hashPassword(password, salt = crypto.randomBytes(PASSWORD_SALT_BYTES)) {
  const passwordHash = await scrypt(password, salt, PASSWORD_HASH_BYTES, PASSWORD_SCRYPT_OPTIONS);
  return { salt, passwordHash };
}

async function registerUser(input) {
  const validated = validateCredentials(input, true);
  if (validated.error) {
    const error = new Error(validated.error);
    error.status = 400;
    throw error;
  }

  const { salt, passwordHash } = await hashPassword(validated.password);
  const user = {
    id: crypto.randomUUID(),
    email: validated.email,
    displayName: validated.displayName,
    salt,
    passwordHash,
    createdAt: Date.now(),
  };

  try {
    database.prepare(`
      INSERT INTO users (id, email, display_name, password_salt, password_hash, created_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(user.id, user.email, user.displayName, user.salt, user.passwordHash, user.createdAt);
  } catch (error) {
    if (error.code === "SQLITE_CONSTRAINT_UNIQUE") {
      const duplicate = new Error("An account with this email already exists.");
      duplicate.status = 409;
      throw duplicate;
    }
    throw error;
  }

  return publicUser({
    id: user.id,
    email: user.email,
    display_name: user.displayName,
  });
}

async function verifyCredentials(input) {
  const validated = validateCredentials(input);
  if (validated.error) {
    const error = new Error(validated.error);
    error.status = 400;
    throw error;
  }

  const user = database.prepare(`
    SELECT id, email, display_name, password_salt, password_hash
    FROM users
    WHERE email = ?
  `).get(validated.email);

  if (!user) {
    const fakeSalt = Buffer.alloc(PASSWORD_SALT_BYTES);
    await hashPassword(validated.password, fakeSalt);
    return null;
  }

  const candidate = await scrypt(
    validated.password,
    user.password_salt,
    PASSWORD_HASH_BYTES,
    PASSWORD_SCRYPT_OPTIONS,
  );
  if (
    candidate.length !== user.password_hash.length ||
    !crypto.timingSafeEqual(candidate, user.password_hash)
  ) {
    return null;
  }

  return publicUser(user);
}

function hashSessionToken(token) {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function createSession(userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = hashSessionToken(token);
  const createdAt = Date.now();
  const expiresAt = createdAt + SESSION_TTL_MS;

  database.prepare(`
    INSERT INTO sessions (token_hash, user_id, expires_at, revoked_at, created_at)
    VALUES (?, ?, ?, NULL, ?)
  `).run(tokenHash, userId, expiresAt, createdAt);

  return { token, tokenHash, expiresAt };
}

function findActiveSession(token) {
  if (!token || typeof token !== "string" || token.length > 256) return null;
  return findActiveSessionByHash(hashSessionToken(token));
}

function findActiveSessionByHash(tokenHash) {
  if (!tokenHash || typeof tokenHash !== "string") return null;
  const session = database.prepare(`
    SELECT sessions.token_hash, sessions.user_id, sessions.expires_at,
           users.email, users.display_name
    FROM sessions
    JOIN users ON users.id = sessions.user_id
    WHERE sessions.token_hash = ?
      AND sessions.revoked_at IS NULL
      AND sessions.expires_at > ?
  `).get(tokenHash, Date.now());

  if (!session) return null;
  return {
    tokenHash: session.token_hash,
    expiresAt: session.expires_at,
    user: publicUser({
      id: session.user_id,
      email: session.email,
      display_name: session.display_name,
    }),
  };
}

function revokeSession(token) {
  if (!token || typeof token !== "string" || token.length > 256) return false;
  const result = database.prepare(`
    UPDATE sessions
    SET revoked_at = ?
    WHERE token_hash = ? AND revoked_at IS NULL
  `).run(Date.now(), hashSessionToken(token));
  return result.changes > 0;
}

function parseCookieHeader(header = "") {
  const cookies = new Map();
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0) continue;
    const name = part.slice(0, separator).trim();
    const value = part.slice(separator + 1).trim();
    if (name) cookies.set(name, value);
  }
  return cookies;
}

function readSessionToken(requestOrSocket) {
  const header = requestOrSocket.headers
    ? requestOrSocket.headers.cookie
    : requestOrSocket.handshake?.headers?.cookie;
  return parseCookieHeader(header).get(SESSION_COOKIE_NAME) || "";
}

function sessionCookie(token, maxAgeSeconds) {
  const attributes = [
    `${SESSION_COOKIE_NAME}=${token}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Max-Age=${maxAgeSeconds}`,
  ];
  if (COOKIE_SECURE) attributes.push("Secure");
  return attributes.join("; ");
}

function clearSessionCookie() {
  const attributes = [
    `${SESSION_COOKIE_NAME}=`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Max-Age=0",
  ];
  if (COOKIE_SECURE) attributes.push("Secure");
  return attributes.join("; ");
}

function requireAuth(request, response, next) {
  const token = readSessionToken(request);
  const session = findActiveSession(token);
  if (!session) {
    return response.status(401).json({ error: "Sign in to continue." });
  }

  request.auth = { ...session, token };
  next();
}

function createOriginValidator(frontendOrigin) {
  return (request, response, next) => {
    const origin = request.get("origin");
    if (origin !== frontendOrigin) {
      return response.status(403).json({ error: "Request origin is not allowed." });
    }
    next();
  };
}

module.exports = {
  COOKIE_SECURE,
  SESSION_COOKIE_NAME,
  SESSION_TTL_MS,
  clearSessionCookie,
  createOriginValidator,
  createSession,
  findActiveSession,
  findActiveSessionByHash,
  readSessionToken,
  registerUser,
  requireAuth,
  revokeSession,
  sessionCookie,
  verifyCredentials,
};
