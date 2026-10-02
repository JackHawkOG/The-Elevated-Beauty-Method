# The Elevated Beauty Method ™

A free educational community portal where anyone can sign up, browse courses across 8 subject areas, track their learning progress, and connect with the community.

## Brand usage

- In customer-facing copy, use the exact names `The Elevated Beauty Method ™` and `The Elevated Beauty Experience ™` (including the space before ™).
- `The Beauty Method` and `The Elevated Method` are distinct membership names; do not replace them with the brand name.
- Use the transparent master logo for the website. Its wordmark is part of the original artwork, preserving the Ablation lettering; do not substitute a CSS font for it.

## Run & Operate

- `pnpm --filter @workspace/api-server run dev` — run the API server (port 8080)
- `pnpm --filter @workspace/edu-portal run dev` — run the frontend (port 21120)
- `pnpm run typecheck` — full typecheck across all packages
- `pnpm run check:stripe-billing-links` — real Stripe test-mode portal URL contract check, also required by `check:pre-release`. Uses the exact membership destination validator; never opens or logs the session URL. Requires an existing active test portal configuration with payment updates and cancellation at period end enabled and subscription updates disabled. Creates/deletes only a disposable customer, with no app member or database writes; never changes portal settings. Missing test credentials/configuration, URL format drift, and cleanup failures exit nonzero.
- `pnpm run test:stripe-billing-links` — offline coverage for the contract check, destination protections, fixture isolation, and cleanup; included in `check`.
- `pnpm run build` — typecheck + build all packages
- `pnpm run check` — pre-merge development check: typecheck, progress and publication HTTP suites; uses disposable fixtures in the workspace development database. The registered `check` validation must pass before release; do not run these database-writing tests during a production build.
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
- The Tier 2 Founding Member rate is $24/month, with a standard rate of $48/month. The founding window is October 1, 2026 at 9:00 AM through October 7, 2026 at 11:59 PM Central Time, for the first 50 eligible paid members. The rate remains locked while the account is in good standing. Three consecutive monthly payment failures remove founding status; cancellation removes it when the paid period ends. Do not promise a discounted place before completed payment.
- Use `attached_assets/TEBM_Brand_Kit_Consistency__Brand_Identity,_Visual_Design_&_Aes_1789917998723.md` as the final authority for TEBM visual design requirements. Where it conflicts with the broader branding blueprint, this newer Brand Kit Consistency document governs visual design.
- Cross-reference branding and marketing requests against this blueprint before changing copy, visuals, offers, campaigns, or customer-facing flows.
- Preserve the approved Dark Luxury system: near-black and charcoal surfaces, warm cream text, `#dccebf` accents, Cormorant Garamond headings, Lato body/UI text, pill-shaped actions, restrained borders, and subtle glows.
- `#dccebf` is the sole primary accent. It replaces `#FFEBBF` and `#FFECC2` throughout future design work, including buttons, badges, links, icons, active states, focus treatments, and glows.
- Optional accents are Blush Pink `#F9D5E5` for the website, Dusty Rose `#C87A96` for the portal, and Mauve `#C9A8C0` for either.
- Follow the four voice pillars: Luxury of Truth, Beauty as Empowerment, Authority of Experience, and Timeless Elegance.
- Prefer identity-led, confidence-building language. Avoid the blueprint's forbidden shame-based, perfectionist, transactional, trend-driven, and overly casual terms.
- The current website and EduPortal master logo is `artifacts/edu-portal/public/brand/tebm-master-logo-1920x1080.png` (the upscaled cream-background PNG). The earlier transparent version remains saved separately for future use.
- `artifacts/edu-portal/public/brand/tebm-master-logo-vector.svg` is the true-vector, solid-black logo. Use it for suitable light-background or recolored treatments; keep the metallic PNG for existing dark-site branding unless a replacement treatment is approved. The older `tebm-master-logo-1920x1080.svg` embeds a PNG and is not true vector artwork.
- Review `docs/tebm-branding-marketing-blueprint-review.md` before implementing pricing, deposits, retainers, or tier details because the blueprint contains unresolved internal conflicts in those areas.
- Service retainers are final: 25% for every Wedding/Bridal service and a flat $125 for every non-Wedding/Bridal service.
- Microblading pricing is final: $400 for the initial service and $200 for touch-ups.
- Masterclasses are exclusive to Nikki; do not describe them as crowdsourced.

## Reference Library for Future TEBM Work

These nine original uploads are preserved in `attached_assets/`. Use them as starting materials for the named work areas, not as instructions to launch features or replace current project decisions.

| Work area | Source | Intended use |
| --- | --- | --- |
| EduPortal Dashboard and membership | [Tier 1 — The Beauty Method](<attached_assets/Membership_Tier_1__“The_Beauty_Method”_1790476874614.md>) | Free-tier inclusions, onboarding, the Radiant Audit, and the five-part introductory series. |
| EduPortal Dashboard and membership | [Tier 2 — The Elevated Method](<attached_assets/Membership_Tier_2__“The_Elevated_Method”_1790476874615.md>) | Paid-tier inclusions, four-module curriculum, live group session, and member experience requirements. |
| EduPortal Dashboard and educational content | [Educational Content](<attached_assets/Educational_Content_1790476874616.md>) | Draft makeup, hair, body-style, and transformation lesson topics; review content before publication. |
| Launches and free-tier onboarding | [The Radiant Audit (PDF)](<attached_assets/The-Radiant-Audit_(2)_1790476874616.pdf>) | Two-page scorecard, check-in worksheet, five-stage framework, and free-membership call to action. |
| Launches and product research | [TEBM Products List (spreadsheet)](<attached_assets/TEBM_Products_List_1790476874613.xlsx>) | Product-reference list for future educational examples and product-matching research, not an approved storefront catalog. |
| Tech architecture and dashboard ideas | [TEBM Tech Stack — Beta Founding Member Launch](<attached_assets/TEBM_TECH_STACK_-_Beta_Founding_Member_Launch_1790476874611.md>) | Proposed portal features and multi-cloud architecture to evaluate against the actual stack, costs, security, and launch scope. |
| TEBM foundations and brand core identity | [The Elevated Beauty Experience™ — Our Signature IP](<attached_assets/The_Elevated_Beauty_Experience™_—_Our_Signature_IP_1790476874617.md>) | Brand pillars, voice, positioning, and Discover → Refine → Enhance → Embody → Radiate framework; product and architecture ideas are proposals. |
| Founding Member launch and free-tier content | [The Elevated Routine (original PDF)](<attached_assets/Elevated-Routine-Guide_1790514157477.pdf>) | Nine-page, ten-question branded guide; proposed permanent Tier 1 Curated Digital Guides resource and pre-launch email opt-in. Renamed from The Elevated Routine Guide at the owner's request; preserve the original attachment. Dominique is confirmed as its founder and live-workshop host. |
| Founding Member launch distribution | [The Elevated Routine launch notes (original upload)](<attached_assets/Founding_Member_Launch_—_The_Elevated_Routine_Guide_1790515199318.md>) | Proposed Facebook list builder, third-email link, and repurposed social posts; use the current publication name The Elevated Routine, and treat the source as a campaign plan, not proof that an opt-in/delivery flow is live. |

**Precedence and review:** The confirmed rules in “Branding & Marketing Source of Truth” above and `docs/tebm-branding-marketing-blueprint-review.md` govern where these uploads disagree. In particular, launch only Tier 1 and Tier 2; keep the confirmed $24 founding and $48 standard monthly rates, with the Founding Member price lock conditioned on an account in good standing and availability capped at 50. Apply the confirmed three-consecutive-monthly-failures and end-of-paid-period cancellation rules above, not the older membership document. MARI access described in tier materials is conditional on its release, not proof that it is already available. The signature-IP document contains a separate older $97/$597 offer diagram and implementation ideas; those are not approved launch offers. The tech-stack document proposes different hosting, database, deployment, integration, and cost assumptions; none are adopted by uploading it. Do not migrate infrastructure, change providers, or treat its estimates as verified without a separate decision.

**The Elevated Routine review:** See `docs/elevated-routine-guide-review.md` before using the PDF or launch notes in customer-facing materials. The publication's current name is **The Elevated Routine**, not The Elevated Routine Guide. The owner's requested PDF edits are implemented and approved in `docs/assets/the-elevated-routine-review.pdf`: original Q3/Q7 screenshot wording with only the requested MARI V1 substitutions and pink styling, a pink line beside “Priority access to MARI V1,” the new title throughout, and a light-background/black-text Audit button matching the Founding Member button. The screenshots describe MARI as “COMING SOON”; future matching and priority claims are retained at the owner's direction, not independently verified availability. Original attachments remain intact. Dominique's attribution and the live-site membership/Audit destinations are approved. The approved sender is `The Elevated Beauty Method ™ <hello@elevatedbeautymethod.com>`, with `hello@elevatedbeautymethod.com` for replies. The owner approved the corrected PDF and the new guide-only signup/privacy/delivery flow on 2026-10-02; no marketing or five-part sequence is authorized. The one approved PDF delivery test succeeded through the actual endpoint, and Resend reported `delivered`. Only afterward was the guide added to the free Curated Digital Guides library and portal navigation. Routes: public `/the-elevated-routine` and `/guide-privacy`, protected free `/guides`. The consent checkbox starts unchecked; the approved PDF is a private email attachment, not a public download. `ROUTINE_GUIDE_LIBRARY_PUBLISHED=true` is now set in shared configuration after approval/verification; unconfigured environments default to disabled. Google/Resend DNS verification and separate setup/guide delivery evidence are documented in `docs/elevated-routine-guide-sender-dns.md`. No production deployment was performed; the new flow is ready in development and must be published before its live-site route is shared.

**The Elevated Routine copy control:** The owner instructed: “Do not change the orginal text from these screenshots. Only change what I request.” Preserve screenshot wording and apply only explicitly requested edits. Do not rewrite claims or surrounding copy while changing names, colors, or buttons.

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
