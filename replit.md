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

## Branding & Marketing Source of Truth

- Use `attached_assets/Branding_&_Marketing__Mastery_Toolkit_Blueprint_for_TEBM_1789593207407.md` as the authoritative reference for TEBM branding, marketing, positioning, visual identity, voice, vocabulary, funnel language, and customer experience.
- Use `attached_assets/Founding_Member_Launch_-_Membership_Tiers_1789955682243.md` as the latest authority for membership tier names, inclusions, and launch pricing options. It supersedes older three-tier descriptions, but Tier 3 and Tier 4 prices remain undecided where the file lists multiple options.
- Use `attached_assets/Founding_Member_Launch_—_ACTION_STEPS_1789958505031.md` as the working Founding Member Launch checklist and progress tracker. It is a draft execution document and does not override confirmed membership pricing, continuity rules, brand terminology, or launch policy elsewhere in this section.
- Use `attached_assets/Headline,_Sub-Headline,_CTA,_&_Image_Concept_for_the_Founder_Me_1789959814592.md` as the approved layout and copy source for the Founding Member Launch landing-page hero.
- Before publishing content from the launch checklist, reconcile its draft `$28–$29` founding price to the approved `$24/month`, its `$47–$49` public range to the approved `$48/month`, and its MARI naming to the approved tier-access terminology.
- The current launch includes only Tier 1, The Beauty Method, and Tier 2, The Elevated Method. Tier 3 and Tier 4 are future roadmap concepts; do not publish, price, sell, or promote them until explicitly approved.
- Tier 1 and Tier 2 receive MARI AI Imaging Processor access. Future Tier 3 and Tier 4 receive MARI AI Video app access.
- The Tier 2 Founding Member rate is $24/month. Cancellation permanently ends that rate, and returning members pay the standard $48/month rate. Failed payments do not forfeit Founding Member pricing.
- Use `attached_assets/TEBM_Brand_Kit_Consistency__Brand_Identity,_Visual_Design_&_Aes_1789917998723.md` as the final authority for TEBM visual design requirements. Where it conflicts with the broader branding blueprint, this newer Brand Kit Consistency document governs visual design.
- Cross-reference branding and marketing requests against this blueprint before changing copy, visuals, offers, campaigns, or customer-facing flows.
- Preserve the approved Dark Luxury system: near-black and charcoal surfaces, warm cream text, `#dccebf` accents, Cormorant Garamond headings, Lato body/UI text, pill-shaped actions, restrained borders, and subtle glows.
- `#dccebf` is the sole primary accent. It replaces `#FFEBBF` and `#FFECC2` throughout future design work, including buttons, badges, links, icons, active states, focus treatments, and glows.
- Optional accents are Blush Pink `#F9D5E5` for the website, Dusty Rose `#C87A96` for the portal, and Mauve `#C9A8C0` for either.
- Follow the four voice pillars: Luxury of Truth, Beauty as Empowerment, Authority of Experience, and Timeless Elegance.
- Prefer identity-led, confidence-building language. Avoid the blueprint's forbidden shame-based, perfectionist, transactional, trend-driven, and overly casual terms.
- The current website and EduPortal master logo is `artifacts/edu-portal/public/brand/tebm-master-logo-1920x1080.png` (the upscaled cream-background PNG). The earlier transparent version remains saved separately for future use.
- Review `docs/tebm-branding-marketing-blueprint-review.md` before implementing pricing, deposits, retainers, or tier details because the blueprint contains unresolved internal conflicts in those areas.
- Service retainers are final: 25% for every Wedding/Bridal service and a flat $125 for every non-Wedding/Bridal service.
- Microblading pricing is final: $400 for the initial service and $200 for touch-ups.
- Masterclasses are exclusive to Nikki; do not describe them as crowdsourced.

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
