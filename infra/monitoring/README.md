# Monitoring (Phase 9.5)

Files for the monitoring host — Prometheus, its blackbox exporter and Grafana are **not installed on this workstation** (ask before adding infrastructure); load them where production runs once hosting is decided.

| File | What it is |
| --- | --- |
| `prometheus.yml` | Scrapes the API (`/metrics`) and the worker (`/metrics` on `WORKER_HEALTH_PORT`), and probes `/health/ready` through the blackbox exporter. Both `/metrics` answer only from `INTERNAL_ALLOWLIST` — add the Prometheus host. |
| `alerts.yml` | 13 alert rules: target down, readiness down, error rate, slow reads / payments / database, rate-limit surge, event-loop lag, payment refusals by check, job failed, outbox lag, dead outbox events, message failures. Each names its runbook. |
| `grafana-dashboard.json` | "CampusOne — service health": API, money, jobs and messages, runtime and database. Import it and choose the Prometheus data source. |

Metrics come from `utils/metrics.ts` (requests, database, payment refusals, job runs, messages, rate limits; Node.js defaults with the `campusone_` prefix) and `utils/metrics-db.ts` (outbox lag, dead events, failed job runs in the last day — read on each scrape). The thresholds are starting values: tune them from the dashboard after the first weeks.
