# Meet Up backend

Meet Up provides real-time meeting rooms, video calling, screen sharing, and room file sharing.

## Run locally

From the project root, open two terminals:

```powershell
cd backend
npm install
npm start
```

```powershell
cd frontend
npm run dev -- --host localhost --port 5174
```

The backend defaults to `http://localhost:5000` and accepts browser requests only from `http://localhost:5174`. Set `FRONTEND_URL` to the frontend's exact origin if it changes. `PORT` changes the backend port.

The backend uses PostgreSQL in both local development and production. Set `DATABASE_URL` in the backend process environment; locally, dotenv loads it from the ignored `backend/.env` file, and on Render, add it as a private service environment variable. Use a local PostgreSQL database or a hosted database such as Neon for local development. Remote database connections require TLS with certificate verification; loopback PostgreSQL connections use local non-TLS defaults. The server checks the connection and initializes its schema before accepting traffic. `GET /api/health` verifies that the users, sessions, and meeting-room tables have their required columns, and reports an unavailable status if the connection or schema check fails.

To safely verify a deployed Render service without changing data, request `https://meet-up-realtime-communication.onrender.com/api/health` in a browser or run `curl.exe -i https://meet-up-realtime-communication.onrender.com/api/health`. A healthy response is HTTP 200 with `"status":"ok"`; a database or schema problem returns HTTP 503 with `"status":"unavailable"`. This endpoint only reads PostgreSQL metadata.

For the deployed app, set Render's `FRONTEND_URL` to `https://meet-up-realtime-communication.vercel.app` and set Vercel's `VITE_API_URL` to `https://meet-up-realtime-communication.onrender.com`, then redeploy the frontend. `VITE_API_URL` is a public endpoint address, not a secret. The root `.gitignore` excludes `.env` files; never put `DATABASE_URL` in frontend variables, source code, or committed files. HTTPS production mode enables secure cross-site session cookies automatically. Set `NODE_ENV=production` on Render.

`DATABASE_URL` is the only required database variable. `PORT` defaults to `5000`; `FRONTEND_URL` defaults to `http://localhost:5174`. `DATABASE_PATH` is no longer used by the server.

To copy existing local SQLite accounts, sessions, and meeting-room metadata into an empty PostgreSQL database, set `DATABASE_URL` and run `node migrate-sqlite-to-postgres.js` from `backend` (or pass a SQLite file path as the first argument). The script opens SQLite read-only, uses a single PostgreSQL transaction, and never removes or modifies the SQLite file. It aborts on conflicting destination rows, so do not run it against a populated destination. Meeting file metadata, live participants, chat, and whiteboard state are not persisted in SQLite and cannot be copied by this script. Missing data from a hosted ephemeral SQLite database cannot be recovered unless a separate copy exists.

## Accounts and sessions

- `POST /api/auth/register` creates an account, and `POST /api/auth/login` verifies it.
- Passwords are hashed on the server. The browser receives an `HttpOnly`, `SameSite=None; Secure` session cookie in production and `SameSite=Lax` in local development; PostgreSQL stores only a hash of the opaque session token.
- `GET /api/auth/me` restores the signed-in account. `POST /api/auth/logout` revokes the session and disconnects its sockets.
- Sessions expire after seven days. Registration and login are rate-limited. State-changing browser requests must come from the configured frontend origin.
- Socket.IO uses the same cookie. The server derives participant identity from the verified account, not the display name supplied by a client.

## Rooms and shared files

Room creation and lookup require an active account session. New rooms use a 32-character hexadecimal invite code generated from 128 bits of cryptographic randomness. The dashboard room list includes rooms created by the signed-in account; invite-code holders can join a room. Failed room lookups and Socket.IO join attempts are limited to 30 per IP address in a 15-minute window. The limiter is in memory and applies per backend process. WebRTC signaling is forwarded only between authenticated sockets currently in the same room.

## Meeting chat

Connected participants use the authenticated Socket.IO connection to send `chat:send` with a room code and message text. The server verifies the active session and current room membership, trims and validates the message (up to 2,000 characters), and derives the sender name from the verified participant record. Accepted messages are delivered only in that room as `chat:message`.

Chat is live-only and is not stored in PostgreSQL. A participant who joins later will not receive earlier messages; messages already shown in the current page remain visible only while that page stays mounted.

## Collaborative whiteboard

The meeting uses the existing authenticated Socket.IO connection for room-scoped whiteboard events:

- `whiteboard:stroke` accepts normalized drawing coordinates, a supported pen color, brush size, eraser state, and a unique stroke ID.
- `whiteboard:state` sends the current room board to a participant after joining or reconnecting.
- `whiteboard:clear` clears retained strokes and broadcasts the clear to everyone currently in that room.

Every stroke and clear request rechecks the sender's active session and current room membership. The server validates each stroke, limits it to 96 points and 12 KB, accepts brush sizes from 1 to 24 and a fixed color palette, and caps retained room history at 1,500 strokes, 50,000 points, and 2 MB. The server supplies participant identity; clients cannot choose the sender identity or broadcast to an arbitrary room.

Board history is held in memory per room, not in PostgreSQL. This lets joined participants and reconnecting participants share the current board while the backend is running, but a backend restart clears the board.

The meeting file endpoints are:

- `GET /api/rooms/:code/files` — list files shared in a meeting.
- `POST /api/rooms/:code/files` — upload one multipart field named `file`.
- `GET /api/rooms/:code/files/:fileId/download` — download a listed file.

File requests require an active account session, a room-scoped bearer capability issued to a joined socket, and a fresh check that this socket still belongs to the requested room. Uploads are limited to 25 MB and accepted for PDF, text/CSV, common image/audio/video formats, and ZIP files. Files are stored under the private `backend/private-files` directory using generated storage names; they are not exposed through a static route.

Room codes, names, and owners are stored in PostgreSQL and restored when the backend starts. Live socket membership, file listings, chat, and whiteboard state remain in memory and are lost on restart. Uploaded private file data may remain on disk without metadata and cannot be retrieved through the API. A PostgreSQL room record does not restore uploaded file listings.

## Checks

```powershell
cd frontend
npm run lint
npm run build
```

```powershell
cd backend
node --check server.js
node --check auth.js
node --check database.js
node --check migrate-sqlite-to-postgres.js
```
