# Meet Up — Real-Time Communication App

Meet Up is a browser-based meeting and collaboration app. It combines authenticated meeting rooms with live audio/video, chat, shared files, and a collaborative whiteboard.

## Features

- Account registration, sign-in, session restoration, and logout.
- Authenticated room creation and code-based room joining.
- Real-time participant presence and room-scoped chat.
- WebRTC audio/video calling and screen sharing, coordinated through Socket.IO.
- Room-scoped file uploads and downloads.
- A shared whiteboard with live drawing and clear events.
- Light and dark themes and responsive layouts.

Chat, participant presence, shared-file listings, and whiteboard state are kept in backend memory. Uploaded file contents are written to the backend's private local filesystem; see [Storage and hosting limitations](#storage-and-hosting-limitations).

## Technology and architecture

| Area | Technology |
| --- | --- |
| Frontend | React, Vite, JavaScript |
| HTTP API | Node.js, Express |
| Real-time events | Socket.IO |
| Audio/video | WebRTC |
| Persistent application data | PostgreSQL, using the `pg` driver; Neon is used for the hosted database |
| Frontend hosting | Vercel |
| Backend hosting | Render |

The browser sends HTTP requests to the Express API and connects to Socket.IO using the same session cookie. The backend validates sessions and room membership before relaying room events and WebRTC signaling. PostgreSQL stores accounts, sessions, and meeting-room metadata. The frontend and backend are separate applications with separate dependency manifests.

## Run locally

Use Node.js and npm versions supported by the installed Vite and backend dependencies. A PostgreSQL database is required; use a local PostgreSQL instance or a development database. Do not use production data for local testing.

1. Configure the backend environment in `backend/.env` (variable names are listed below). The backend loads this file with dotenv. Keep credentials in the backend only.
2. Open a terminal at the project root and start the backend:

   ```powershell
   cd backend
   npm install
   npm start
   ```

   The backend listens on port `5000` by default and initializes the PostgreSQL schema at startup.

3. Open a second terminal at the project root and start the frontend:

   ```powershell
   cd frontend
   npm install
   npm run dev -- --host localhost --port 5174
   ```

4. Open the Vite URL shown in the terminal. By default, the frontend calls the backend at `http://localhost:5000`, and the backend allows the frontend origin `http://localhost:5174`.

If you change either local port or origin, set `PORT` and/or `FRONTEND_URL` for the backend, and configure `VITE_API_URL` for the frontend if its API target differs from the default. Browser requests must use the exact frontend origin configured in `FRONTEND_URL`.

## Environment-variable names

Set values in the relevant service environment or ignored local `.env` file. This list intentionally contains **names only**; never commit connection strings, passwords, tokens, or other secret values.

### Backend

| Name | Required | Purpose |
| --- | --- | --- |
| `DATABASE_URL` | Yes | PostgreSQL connection URL. Keep it only in the backend environment. |
| `FRONTEND_URL` | No | Exact allowed frontend origin. Defaults to `http://localhost:5174`. |
| `PORT` | No | Backend HTTP port. Defaults to `5000`; hosting providers may supply it. |
| `NODE_ENV` | No | Set to `production` for production cookie behavior. |
| `COOKIE_SECURE` | No | Can enable secure-cookie behavior with `true`; production mode enables it automatically. |

### Frontend

| Name | Required | Purpose |
| --- | --- | --- |
| `VITE_API_URL` | No | Public backend base URL. Defaults to the deployed Render API in production and `http://localhost:5000` in development. It is not a secret. |

Do not put `DATABASE_URL` or any private credential in a `VITE_*` variable: frontend variables are included in browser-delivered code.

## Tests and checks

Run the backend tests from the backend directory:

```powershell
cd backend
npm test
```

The current backend tests use a mocked PostgreSQL pool and a local test server; they do not verify connectivity to a live Neon database.

Run frontend linting and a production build from the frontend directory:

```powershell
cd frontend
npm run lint
npm run build
```

The generated frontend build is written to `frontend/dist/`.

## Deployment

The frontend is deployed on Vercel and the backend on Render:

- Frontend: https://meet-up-realtime-communication.vercel.app/
- Backend: https://meet-up-realtime-communication.onrender.com/

Configure the hosting services without placing secrets in source control:

- On Render, provide `DATABASE_URL`, set `FRONTEND_URL` to the deployed Vercel origin, and use `NODE_ENV=production`.
- On Vercel, set `VITE_API_URL` to the Render backend base URL and rebuild/redeploy after changing it.
- Confirm the frontend and backend use HTTPS and that the production cookie settings and allowed origin match the deployed domains.
- Check the Render service's storage and instance configuration against the behavior described below. A successful `/api/health` response checks the backend and required PostgreSQL schema; it does not verify uploaded-file persistence.

Hosting plans, quotas, sleep behavior, storage options, and pricing can change. Check the current Vercel, Render, and Neon dashboards for the limits that apply to the project's specific services; this README does not assume a particular free-tier quota.

## Storage and hosting limitations

- PostgreSQL persists users, sessions, and room metadata.
- Live participants, chat messages, file listings, and whiteboard history are held in backend memory and are lost when the backend process restarts.
- Uploaded file contents are stored under `backend/private-files` on the backend filesystem. Unless a persistent disk is configured and mounted there, files can be lost when the hosting instance restarts or is replaced. File listings are in memory, so files left on disk after a restart may no longer be retrievable through the app.
- On a free or otherwise ephemeral backend instance, do not assume local uploaded files persist. If durable sharing is required, configure storage intended for persistence and update the app to use it.
- Multiple backend instances do not share their in-memory participants, chat, whiteboard, or file-list state. Do not assume horizontal scaling preserves real-time state.
- Vercel, Render, and Neon have plan-specific usage and availability limits. Consult their current service dashboards and documentation rather than relying on fixed quota numbers.

For backend-specific API, authentication, and database details, see [backend/README.md](./backend/README.md).
