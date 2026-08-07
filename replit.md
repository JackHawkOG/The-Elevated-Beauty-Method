# The Elevated Beauty Method

A free educational community portal where anyone can sign up, browse courses across 8 subject areas, track their learning progress, and connect with the community.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm --filter @workspace/edu-portal run dev` — run the frontend (port 21120)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run build` — typecheck + build all packages
- `pnpm --filter @workspace/api-spec run codegen` — regenerate API hooks and Zod schemas from the OpenAPI spec
- `pnpm --filter @workspace/db run push` — push DB schema changes (dev only)
- Required env: `DATABASE_URL` — Postgres connection string
- Required env: `CLERK_SECRET_KEY`, `CLERK_PUBLISHABLE_KEY`, `VITE_CLERK_PUBLISHABLE_KEY` — Clerk auth (auto-provisioned)

## Stack

- pnpm workspaces, Node.js 24, TypeScript 5.9
- Frontend: React + Vite, Tailwind CSS v4, shadcn/ui, Wouter routing
- Auth: Clerk (Replit-managed)
- API: Express 5
- DB: PostgreSQL + Drizzle ORM
- Validation: Zod (v3), `drizzle-zod`
- API codegen: Orval (from OpenAPI spec)
- Build: esbuild (CJS bundle)

## Where things live

- `lib/api-spec/openapi.yaml` — single source of truth for all API contracts
- `lib/db/src/schema/` — Drizzle table definitions (categories, courses, lessons, enrollments, announcements, users, activity)
- `artifacts/api-server/src/routes/` — Express route handlers per domain
- `artifacts/api-server/src/middlewares/` — requireAuth, jitProvisionUser, clerkProxyMiddleware
- `artifacts/edu-portal/src/pages/` — React pages (landing, dashboard, courses, course-detail, lesson, community, profile)
- `artifacts/edu-portal/src/App.tsx` — ClerkProvider wiring, wouter routing

## Architecture decisions

- **Contract-first API**: OpenAPI spec → codegen → typed hooks (Orval). All endpoints are spec-driven; never write raw fetch calls in the frontend.
- **Clerk auth via proxy**: The Express server proxies Clerk's frontend API through `/api/__clerk` so auth works under custom domains in production. Cookie-based on web (no Bearer tokens needed).
- **JIT user provisioning**: When a user first hits `/api/users/me`, a row is created in the `users` table from Clerk's session claims. No separate registration step.
- **Zod v3 constraint**: Orval 8.23 generates `zod.int()` (Zod v4 syntax). All integer fields in the spec use `type: number` to avoid the incompatibility.
- **All integer OpenAPI fields use `type: number`**: Due to Zod v3/Orval 8.23 incompatibility where `type: integer` generates `zod.int()` which doesn't exist in v3.

## Product

- **Landing page**: Public hero with sign-up CTA, subject categories, feature highlights
- **Dashboard**: Stats, featured courses, enrolled courses with progress, recent activity feed
- **Course Library**: Browse/search/filter 8+ courses across 8 subject categories
- **Course Detail**: Full description, lesson list, enroll button
- **Lesson Viewer**: Read lesson content, mark complete, navigate between lessons
- **Community Board**: Announcements, post new content, activity feed
- **Profile**: View and edit display name and bio, see enrolled courses

## User preferences

_Populate as needed._

## Gotchas

- **Do not use `type: integer` in openapi.yaml** — use `type: number` instead. Orval 8.23 generates `zod.int()` for integer types which doesn't exist in Zod v3.
- **Do not call `configureWorkflow`** for artifact services — they already have managed workflows.
- **Clerk auth is cookie-based on web** — do not add `getToken()` or `Authorization: Bearer` to browser fetch calls.
- **Run codegen after every spec change**: `pnpm --filter @workspace/api-spec run codegen`

## Pointers

- See the `pnpm-workspace` skill for workspace structure, TypeScript setup, and package details
- See the `clerk-auth` skill for auth troubleshooting and customization
