# RingPe_Backend_API — the API and the worker

One code base, two processes (ADR-0002):

- `server.ts` serves the API (`/api/v1`, `/health/*`, `/metrics` on the internal port);
- `worker.ts` runs scheduled jobs, queues and the outbox relay.

Node 24 LTS · TypeScript 6 (strict) · Express 5 · Kysely + mysql2 · zod 4 · winston. Money is integer paise end to end (ADR-0004).

## Getting it running

```bash
npm install
cp .env.example .env          # set DATABASE_URL and DB_MIGRATOR_URL (see infra/mysql/local-setup.sql)
npm run keys:generate         # local signing and field-encryption keys in keys/ (never commit)
npm run migrate               # apply db/migrations (migrator user)
npm run seed                  # reference registers, payment channels, languages
npm run devStart              # API with watch → http://localhost:3000/health/ready
npm run devStart:worker       # worker with watch (second terminal)
```

Every setting is documented in [.env.example](.env.example).

## Layout

The folders follow the reference projects (`ClubPass_Backend_API`, `RingPe_Wallet_API`): one folder per layer, one file per module in each layer.

| Folder | Contents |
| --- | --- |
| `server.ts` · `worker.ts` · `app.ts` | Entrypoints, and the middleware chain (`app.ts`, used by the tests) |
| `config/` | Environment schema (`config.ts`, fail-fast), start-up (`bootstrap.ts`), the registers (`registers/`: statuses, messages, limits), the OpenAPI route registry and the committed `openapi.yaml` |
| `routes/` | `<module>.routes.ts` — paths, roles and request/response schemas |
| `controllers/` | `<module>.controller.ts` — HTTP in, HTTP out; `logger.ts` (request, response, database, app, audit, security and job streams) |
| `services/` | `<module>.service.ts` — the business rules |
| `repositories/` | `<module>.repository.ts` — SQL through Kysely, always scoped by `institution_id` |
| `models/` | Database connection (`database.ts`) and the table types (`ringpe_models/`) |
| `schemas/` | `<module>.schema.ts` — zod request/response DTOs (also generate the OpenAPI document) |
| `middlewares/` | Correlation id, request/response logs, security headers, CORS, body limits, rate limits, authentication, authorisation, error handler |
| `integrations/` | Bank, gateway, SMS, e-mail, WhatsApp, push, antivirus adapters (from Phase 2) |
| `schedulers/` | Job registry: every job states its schedule, window, catch-up and re-run rules |
| `functions/` | Small shared helpers used by several services |
| `utils/` | `CustomAPIError`, problem+json (`apiResponse.ts`), redaction, ids, money, formatting, validators, translation |
| `db/` | `migrations/NNNN_*.sql` (forward-only, checksummed), the migration runner and the reference seeds |
| `scripts/` | Database CLI, build, OpenAPI generation, smoke test, shared-file sync |
| `tests/` | Unit and HTTP tests (Vitest + supertest); `tests/integration` runs on a real MySQL |
| `infra/` | Docker Compose for local MySQL, Redis, MinIO and Mailpit; MySQL users and settings |

## Commands

| Task | Command |
| --- | --- |
| API / worker with watch | `npm run devStart` · `npm run devStart:worker` |
| Build (esbuild → `dist/server.js`, `dist/worker.js`, `dist/db.js`) | `npm run build` |
| Run the build | `npm start` · `npm run start:worker` |
| Tests (unit + HTTP) | `npm test` |
| Integration tests on real MySQL (needs `TEST_DB_MIGRATOR_URL` in `.env`) | `npm run test:integration` |
| Smoke-test the build (`-- true` expects "ready", i.e. MySQL reachable) | `npm run test:smoke` |
| Lint · type-check · format | `npm run lint` · `npm run typecheck` · `npm run format` |
| Migrations · status · reference seeds | `npm run migrate` · `npm run migrate:status` · `npm run seed` |
| Regenerate `config/openapi.yaml` (a test fails when it is stale) | `npm run openapi` |
| Shared files (see below) | `npm run shared:check` · `npm run shared:sync` |
| Local keys (first time; existing files are kept) | `npm run keys:generate` |
| Local services (needs Docker) | `docker compose -f infra/docker-compose.yml up -d` |
| Docker image | `docker build -t ringpe-backend-api .` |

## Files shared with the web and mobile apps

The three projects are independent, like the reference projects, but a few rules must be identical in all of them (RNG-GOV-005). Each such file has one master; the other projects keep byte-identical copies:

| Master | Copies |
| --- | --- |
| `utils/money.ts`, `utils/format.ts`, `utils/translate.ts` | `RingPe_Web_Application/src/components/Utils/`, `RingPe_Mobile_App/src/utils/` |
| `utils/messages.en.ts` (generated from `config/registers`) | same |
| `RingPe_Web_Application/src/theme/tokens.ts` (design tokens) | `RingPe_Mobile_App/src/theme/` |

Edit the master, then run `npm run shared:sync`. `npm run shared:check` (run in CI) fails when a copy has drifted.
