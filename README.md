# Clinic Omnichannel AI Platform

See [docs/architecture](docs/architecture/00-system-overview.md) for the system design and
[docs/adr](docs/adr) for the decisions behind it.

## Local development

### PostgreSQL

A local Postgres instance runs via Docker Compose (`docker-compose.yml`). Copy `.env.example` to `.env` first if
you want non-default credentials — otherwise the defaults baked into `docker-compose.yml` are used.

```bash
# Start Postgres (detached)
docker compose up -d postgres

# Check status / health
docker compose ps

# Stop Postgres (keeps data)
docker compose stop postgres

# Reset local data — deletes the volume, next start is a fresh database
docker compose down -v
```

The API and Prisma are not wired up to this database yet — that lands in a later task.
