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
| `npm run db:migrate` | `npx prisma migrate dev` | Creates and applies new database migrations. |
| `npm run db:studio` | `npx prisma studio` | Opens Prisma Studio (web-based database GUI). |
| `npm run db:generate` | `npx prisma generate` | Regenerates the Prisma Client types from `prisma/schema.prisma`. |
| `npm run seed:admin` | `tsx scripts/seed-admin.ts` | Idempotently bootstraps the initial persistent Admin account. |

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
├── prisma/
│   ├── schema.prisma        # Prisma ORM schema & relations
│   └── migrations/          # Version-controlled SQL migrations
├── scripts/
│   ├── seed-admin.ts                 # Idempotent initial Admin bootstrap script
│   ├── verify-schema.ts              # Verification script for schema & relations
│   ├── verify-constraints.ts         # Verification script for cascade deletes & unique constraints
│   ├── verify-auth.ts                # End-to-end verification for auth, MFA, and RBAC
│   ├── verify-user-provisioning.ts   # End-to-end verification for POST /users & bootstrap
│   ├── verify-itineraries.ts         # End-to-end verification for Itineraries CRUD & workflow
│   ├── verify-uploads.ts             # End-to-end verification for Cloudinary upload & asset lifecycle
│   └── verify-destinations.ts        # End-to-end verification for Destinations list & create
└── src/
    ├── index.ts             # Application entry point: initializes env and starts HTTP server
    ├── app.ts               # Express app factory: configures middleware (helmet, cors, morgan) and routes
    ├── config/
    │   └── env.ts           # Strict runtime validation of environment variables using Zod
    ├── db/
    │   ├── pool.ts          # Postgres connection pool (pg.Pool) for raw queries
    │   └── prisma.ts        # PrismaClient singleton instance with hot-reload support
    ├── lib/
    │   ├── password.ts      # Password hashing & verification via bcryptjs (12 salt rounds)
    │   ├── tokens.ts        # JWT signing & verification for access, refresh, and MFA tokens
    │   ├── mfa.ts           # TOTP secret generation, verification, and QR code data URLs
    │   ├── slug.ts          # Kebab-case URL slug generator with collision resolution
    │   └── cloudinary.ts    # Cloudinary v2 SDK client, buffer upload, and asset deletion
    ├── middleware/
    │   ├── errorHandler.ts  # Centralized error handler returning standardized JSON shapes
    │   ├── notFound.ts      # 404 handler for unmatched routes
    │   ├── requireAuth.ts   # JWT access token authentication middleware
    │   └── requireRole.ts   # Role-based access control (RBAC) middleware factory
    └── routes/
        ├── auth/            # Authentication & MFA endpoints
        │   ├── auth.router.ts
        │   ├── auth.schemas.ts
        │   └── index.ts
        ├── users/           # User provisioning endpoints (Admin-only)
        │   ├── users.router.ts
        │   ├── users.schemas.ts
        │   └── index.ts
        ├── itineraries/     # Itineraries CRUD & workflow management
        │   ├── itineraries.router.ts
        │   ├── itineraries.schemas.ts
        │   └── index.ts
        ├── destinations/    # Destination management (list & create)
        │   ├── destinations.router.ts
        │   ├── destinations.schemas.ts
        │   └── index.ts
        ├── uploads/         # Multipart file upload proxy to Cloudinary
        │   ├── uploads.router.ts
        │   └── index.ts
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

## 6. Database Schema & Migrations (Prisma ORM)

The database schema is managed via **Prisma ORM** against the local PostgreSQL container.

### Core Entities & Architecture
- **`User`**: Internal users with role-based access control (`ADMIN`, `EDITOR`, `AUTHOR`, `VIEWER`), support for MFA secrets, and authored/edited itinerary relations.
- **`RefreshToken`**: Stores hashed refresh tokens (`tokenHash`) with expiration and revocation timestamps, cascading on user deletion.
- **`Destination`**: Minimal model (`id`, `name`, `slug`, timestamps) providing destination targets for safari packages. *(Full CRUD and rich destination content is a separate future feature).*
- **`Itinerary`**: Core safari package entity with editorial lifecycle status (`DRAFT`, `IN_REVIEW`, `PUBLISHED`, `ARCHIVED`), author/editor relations, inclusions, exclusions, and pricing.
  - **Application-level Rule**: When `priceOnRequest = true`, `startingPrice` is expected to be null; when `false`, `startingPrice` should be set. This is validated at the application/route level, not via DB constraint.
- **`ItineraryDay`**: Individual day breakdown with `dayNumber`, titles, descriptions, and a unique constraint on `(itineraryId, dayNumber)`. Cascade-deletes with parent itinerary.
  - **Accommodation**: Represented as a simple text string for now; a dedicated accommodation entity is not in scope.
- **`ItineraryImage`**: Gallery images with sort ordering and cascade-deletion.
- **`ItineraryDestination`**: Many-to-many join table between itineraries and destinations with composite primary key.
- **`Enquiry`**: Inbound customer booking/inquiry pipeline from marketing CTAs, optionally referencing an `Itinerary` (with `onDelete: SetNull` to prevent customer data loss if an itinerary is archived/removed).

### Running Migrations
To apply schema changes locally:
```bash
npm run db:migrate
```

To view or manage data interactively:
```bash
npm run db:studio
```

To reset the database cleanly and re-run migrations from scratch:
```bash
npm run db:reset
npm run db:migrate
```

---

## 7. Authentication & Authorization Foundation

The Macho Halisi API uses a stateless JWT access token architecture paired with database-backed refresh tokens and mandatory TOTP Multi-Factor Authentication (compatible with Google Authenticator).

### Authentication Lifecycle

1. **First-Time User Login & Mandatory Enrollment**:
   - `POST /auth/login` with email and password returns `status: "mfa_enrollment_required"` along with a short-lived `challengeToken` (5m expiry).
   - `POST /auth/mfa/enroll` (Bearer: challengeToken) generates a base32 TOTP secret and returns a QR code data URL.
   - `POST /auth/mfa/enroll/confirm` (Bearer: challengeToken) takes the 6-digit TOTP code, enables MFA (`mfaEnabled = true`), and issues the initial access + refresh token pair.

2. **Subsequent Logins (Two-Step MFA)**:
   - `POST /auth/login` returns `status: "mfa_required"` with a `challengeToken`.
   - `POST /auth/mfa/verify` accepts the `challengeToken` and 6-digit TOTP `code`, returning `{ accessToken, refreshToken }`.

3. **Session Refresh & Revocation**:
   - `POST /auth/refresh` exchanges a valid, unrevoked refresh token for a fresh access token.
   - `POST /auth/logout` revokes the refresh token server-side (`revokedAt = NOW()`).

4. **Role-Based Access Control (RBAC)**:
   - `requireAuth`: Validates `Authorization: Bearer <accessToken>` and populates `req.user = { userId, role }`.
   - `requireRole(...allowedRoles)`: Enforces role permissions across `ADMIN`, `EDITOR`, `AUTHOR`, and `VIEWER`.
   - Test route: `GET /auth/me` (requires authentication) and `GET /auth/admin-test` (restricted to `ADMIN`).

### Required Environment Variables
```env
JWT_ACCESS_SECRET=your-access-secret-at-least-16-chars
JWT_REFRESH_SECRET=your-refresh-secret-at-least-16-chars
JWT_ACCESS_EXPIRES_IN=15m
JWT_REFRESH_EXPIRES_IN=7d
```

---

## 8. Admin Bootstrap & User Provisioning

Accounts for the internal dashboard are provisioned by an Admin—there is no public self-service registration endpoint.

### 1. Bootstrapping the Initial Administrator
In a fresh environment where zero users exist, run the idempotent bootstrap script:
```bash
npm run seed:admin
```
This reads `INITIAL_ADMIN_EMAIL` and `INITIAL_ADMIN_PASSWORD` from `.env` (defaulting to `admin@machohalisi.com` / `AdminPassword123!`), hashes the password using bcrypt with 12 salt rounds, and creates the initial `ADMIN` user with `mfaEnabled: false`. The Admin will complete TOTP enrollment on their first login.

### 2. Admin User Creation: `POST /users`
Once authenticated as an `ADMIN`, you can provision other dashboard users (`ADMIN`, `EDITOR`, `AUTHOR`, `VIEWER`).

- **Method**: `POST`
- **Path**: `/users`
- **Headers**: `Authorization: Bearer <adminAccessToken>`
- **Request Body**:
  ```json
  {
    "email": "editor@machohalisi.com",
    "password": "SecurePassword123!",
    "role": "EDITOR"
  }
  ```
- **Validation Rules**:
  - `email`: Valid email format, must be unique across all users (returns `409 Conflict` if duplicate).
  - `password`: Minimum 8 characters; hashed immediately via bcrypt.
  - `role`: One of `ADMIN`, `EDITOR`, `AUTHOR`, `VIEWER`.
- **Response (`201 Created`)**:
  ```json
  {
    "status": "ok",
    "user": {
      "id": "e6140f23-ca32-4504-989d-09eef348d89b",
      "email": "editor@machohalisi.com",
      "role": "EDITOR",
      "createdAt": "2026-09-09T15:34:00.000Z"
    }
  }
  ```
  *(Note: Password hashes and secrets are never returned in responses).*

---

## 9. Itineraries CRUD & Editorial Workflow

The Itineraries API manages safari packages and editorial draft-to-publish workflows with strict database and API-level role enforcement.

### 1. Role & Permission Matrix

| Endpoint | Method | Allowed Roles | Description |
|---|---|---|---|
| `/itineraries` | `GET` | `ADMIN`, `EDITOR`, `AUTHOR`, `VIEWER` | List lightweight summaries (paginated, filterable by `?status=`) |
| `/itineraries/:id` | `GET` | `ADMIN`, `EDITOR`, `AUTHOR`, `VIEWER` | Full detail with ordered days (`dayNumber ASC`), images, & destinations |
| `/itineraries` | `POST` | `ADMIN`, `EDITOR`, `AUTHOR` | Create itinerary in `DRAFT` (auto-generates unique slug) |
| `/itineraries/:id` | `PUT` | `ADMIN`, `EDITOR`, `AUTHOR` | Update fields; atomically replaces days and destination links; sets `editorId` |
| `/itineraries/:id/publish` | `PATCH` | **`ADMIN` ONLY** | Validates readiness, moves to `PUBLISHED`, sets `publishedAt = NOW()` |
| `/itineraries/:id/archive` | `PATCH` | **`ADMIN` ONLY** | Moves itinerary to `ARCHIVED` |
| `/itineraries/:id` | `DELETE` | **`ADMIN` ONLY** | Destructive deletion (cascades to days, images, destination links) |
| `/itineraries/:id/images` | `POST` | `ADMIN`, `EDITOR`, `AUTHOR` | Attach gallery image URL with sortOrder and altText |
| `/itineraries/:id/images/:imageId` | `DELETE` | `ADMIN`, `EDITOR`, `AUTHOR` | Remove gallery image record |

### 2. Workflow Rules & Guarantees
- **No Ownership Restriction**: Any `ADMIN`, `EDITOR`, or `AUTHOR` can create and edit *any* itinerary across the organization.
- **Publishing Gate**: Only `ADMIN` can publish or archive itineraries. `EDITOR` and `AUTHOR` are restricted with `403 Forbidden`.
- **Ready to Publish Validation**: `PATCH /itineraries/:id/publish` requires at least 1 day defined, non-empty title, and starting price provided if `priceOnRequest` is false.
- **Atomic Day Replacement**: `PUT /itineraries/:id` accepts a `days` array; existing days for that itinerary are deleted and replaced in a single Prisma transaction (`prisma.$transaction`).
- **Unique Slugs**: If a title collides (e.g. "Serengeti Explorer"), a numeric suffix is auto-appended (e.g. `serengeti-explorer-1`).

---

## 10. Image Uploads & Cloudinary Asset Lifecycle

To support the dashboard itinerary gallery management UI, the API acts as a secure proxy to Cloudinary. The client never talks directly to Cloudinary, and Cloudinary secrets remain server-side.

### 1. Upload Endpoint: `POST /uploads/image`
- **Method**: `POST`
- **Path**: `/uploads/image`
- **Headers**: `Authorization: Bearer <accessToken>` (`ADMIN`, `EDITOR`, or `AUTHOR`)
- **Body**: `multipart/form-data` with field name `image`
- **Validation**:
  - `mimetype`: Only `image/jpeg`, `image/png`, `image/webp`, and `image/avif` are accepted. Other types return `400 Bad Request`.
  - `fileSize`: Max 10MB (`10 * 1024 * 1024` bytes).
- **Target Folder**: `macho-halisi/itineraries`
- **Response (`201 Created`)**:
  ```json
  {
    "status": "ok",
    "url": "https://res.cloudinary.com/.../macho-halisi/itineraries/sample.png",
    "publicId": "macho-halisi/itineraries/sample"
  }
  ```

### 2. Gallery Asset Lifecycle: Upload → Attach → Delete
1. **Upload**: Client uploads image via `POST /uploads/image` and receives `{ url, publicId }`.
2. **Attach**: Client calls `POST /itineraries/:id/images` passing `{ url, cloudinaryPublicId: publicId, sortOrder, altText }`.
3. **Delete**: When `DELETE /itineraries/:id/images/:imageId` is invoked, the API checks for `cloudinaryPublicId`:
   - If present, calls Cloudinary's `uploader.destroy(publicId)` to delete the remote asset before removing the database row.
   - If null (e.g. manually linked image), Cloudinary deletion is skipped and only the database row is deleted.

### 3. Required Environment Variables
```env
CLOUDINARY_CLOUD_NAME=your-cloud-name
CLOUDINARY_API_KEY=your-api-key
CLOUDINARY_API_SECRET=your-api-secret
```

---

## 11. Destination Management

Minimal destination endpoints to support dropdown selection and package associations in the itinerary builder.

### 1. Endpoints

| Endpoint | Method | Allowed Roles | Description |
|---|---|---|---|
| `/destinations` | `GET` | `ADMIN`, `EDITOR`, `AUTHOR`, `VIEWER` | List all destinations (`id`, `name`, `slug`) ordered alphabetically |
| `/destinations` | `POST` | `ADMIN`, `EDITOR`, `AUTHOR` | Create a new destination with auto-generated unique slug |

### 2. Contracts & Validation
- **`GET /destinations`**:
  - Response:
    ```json
    {
      "status": "ok",
      "data": [
        {
          "id": "uuid",
          "name": "Ngorongoro Crater",
          "slug": "ngorongoro-crater"
        }
      ]
    }
    ```
- **`POST /destinations`**:
  - Headers: `Authorization: Bearer <accessToken>`
  - Request body:
    ```json
    {
      "name": "Tarangire National Park"
    }
    ```
  - **Duplicate Prevention**: Rejects duplicate names (case-insensitive) with `409 Conflict`.
  - **Slug Generation**: Automatically derives a clean URL slug from `name` (e.g. `tarangire-national-park`).
  - Response (`201 Created`):
    ```json
    {
      "status": "ok",
      "destination": {
        "id": "uuid",
        "name": "Tarangire National Park",
        "slug": "tarangire-national-park",
        "createdAt": "2026-09-09T20:30:00.000Z"
      }
    }
    ```

---

## 12. Recommended Next Steps

- **Dashboard Frontend (Step 7)**: Build the Next.js itinerary builder consuming `/destinations`, `/uploads/image`, and `/itineraries`.
- **Public Itineraries Read Endpoint**: Build public, unauthenticated routes (e.g. `GET /public/itineraries` and `GET /public/itineraries/:slug`) returning only `PUBLISHED` itineraries with caching.
- **Enquiry Pipeline**: API endpoints for customer safari enquiries and lead management.
- **Security Hardening**: Encrypt `mfaSecret` at rest via AES-256-GCM and add rate limiting to `/auth/login` and `/auth/mfa/*`.



