# Macho Halisi — Backend API

Backend service for **Macho Halisi**, a luxury safari tour operator based in Karatu, Tanzania. This service powers both the public Next.js marketing site and the internal role-based dashboard (`/dashboard`).

---

## 1. Prerequisites

- **Node.js**: `>= 20.0.0` (developed with v25)
- **npm**: `>= 10.0.0`
- **Docker**: `>= 24.0.0` with **Docker Compose v2+**

---

## 2. Quick Start

### 1. Configure Environment
Copy the example environment file:
```bash
cp .env.example .env
```
Default values work out of the box for local development:
- Express API: `http://localhost:4000`
- Postgres: `localhost:5433` (port 5433 avoids collisions with existing local Postgres instances)
- CORS origin: `http://localhost:3000` (Next.js frontend)

### 2. Install Dependencies
```bash
npm install
```

### 3. Start Postgres Database
Start the Postgres container in the background:
```bash
npm run db:up
```

### 4. Start Express Server
Run the development server in watch mode:
```bash
npm run dev
```

The API will be live at: `http://localhost:4000`

---

## 3. Verifying the Setup

Query the health endpoint to confirm that both the Express server and the Postgres connection pool are functioning properly:

```bash
curl http://localhost:4000/health
```

**Expected Response (`200 OK`):**
```json
{
  "status": "ok",
  "timestamp": "2026-09-09T10:30:00.000Z",
  "database": {
    "connected": true,
    "serverTime": "2026-09-09T10:30:00.000Z"
  }
}
```

If the database is unreachable, the endpoint returns HTTP `503 Service Unavailable` with:
```json
{
  "status": "error",
  "timestamp": "2026-09-09T10:30:00.000Z",
  "database": {
    "connected": false
  }
}
```

---

## 4. Database Lifecycle Scripts

Manage the local Docker Postgres container using npm scripts:

| Script | Command | Description |
|---|---|---|
| `npm run db:up` | `docker compose up -d` | Starts the Postgres container in detached mode. Data persists in the named volume `pgdata`. |
| `npm run db:down` | `docker compose down` | Stops and removes the container. Data in `pgdata` is preserved. |
| `npm run db:reset` | `docker compose down -v && docker compose up -d` | **Destructive**: Destroys the volume and restarts with a fresh, empty database. |

---

## 5. Project & Folder Structure

The codebase is organized **by resource** rather than technical layer. This keeps all route handlers, schemas, and resource-specific logic co-located as new features are introduced.

```
macho-halisi-backend/
├── docker-compose.yml       # Pinned Postgres 17.5-alpine container definition
├── .env.example             # Template for required environment variables
├── .env                     # Local environment config (git-ignored)
├── .gitignore               # Ignores node_modules, .env, dist, pgdata
├── package.json
├── tsconfig.json            # Node16 module resolution TypeScript configuration
├── README.md
└── src/
    ├── index.ts             # Application entry point: initializes env and starts HTTP server
    ├── app.ts               # Express app factory: configures middleware (helmet, cors, morgan) and routes
    ├── config/
    │   └── env.ts           # Strict runtime validation of environment variables using Zod
    ├── db/
    │   └── pool.ts          # Postgres connection pool (pg.Pool)
    ├── middleware/
    │   ├── errorHandler.ts  # Centralized error handler returning standardized JSON shapes
    │   └── notFound.ts      # 404 handler for unmatched routes
    └── routes/
        └── health/          # Self-contained health check resource
            ├── health.router.ts
            └── index.ts     # Barrel export
```

### Adding New Resources
To add a new feature (e.g., `itineraries`):
1. Create `src/routes/itineraries/`
2. Define router, handlers, and validation schemas within that directory
3. Export the router from `src/routes/itineraries/index.ts`
4. Mount it in `src/app.ts`: `app.use("/itineraries", itinerariesRouter)`

---

## 6. Recommended Next Steps

- **ORM & Migrations**: Introduce Drizzle ORM (`drizzle-orm` + `drizzle-kit`) or node-pg-migrate for schema versioning and type-safe database queries.
- **Authentication**: Set up JWT/session authentication with role-based access control (`Admin`, `Editor`, `Author`, `Viewer`) for the `/dashboard` routes.
- **Data Models**: Define tables for users, safari itineraries, accommodations, and customer enquiries.
- **Testing**: Add integration tests with Vitest and Supertest against the running Postgres instance.
