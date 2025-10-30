# 🚨 Deployment Checklist - MUST VERIFY BEFORE EVERY COMMIT

## Critical Rule: One-Command Deployment

**Every commit MUST ensure that:**
```bash
docker compose up -d
```
**Works successfully for first-time users!**

---

## Pre-Commit Verification Steps

### 1. Clean State Test (MANDATORY)

```bash
# Stop and remove all containers and volumes
docker compose down -v

# Verify volumes are removed
docker volume ls | grep openguardrails
# Should return EMPTY

# Clean Docker cache (optional but recommended)
docker system prune -f

# Start from clean slate
docker compose up -d

# Monitor startup
docker logs -f openguardrails-admin
```

**Expected behavior:**
- PostgreSQL starts and becomes healthy
- Admin service starts and runs migrations
- Detection and proxy services start
- Frontend becomes accessible
- **NO ERRORS in logs**

---

### 2. Service Health Check

```bash
# All services should be running
docker ps --filter "name=openguardrails" --format "table {{.Names}}\t{{.Status}}"

# Expected: All services show "Up" or "healthy" status
```

**Services must be running:**
- ✅ openguardrails-postgres (healthy)
- ✅ openguardrails-admin (healthy)
- ✅ openguardrails-detection (healthy)
- ✅ openguardrails-proxy (healthy)
- ✅ openguardrails-frontend (Up)

---

### 3. Migration Verification

```bash
# Check migration logs
docker logs openguardrails-admin | grep -i migration

# Expected output includes:
# - "Running database migrations (admin service)..."
# - "Successfully executed X migration(s)" OR "Database schema is up to date"
```

```bash
# Verify migration table exists and has records
docker exec openguardrails-postgres psql -U openguardrails -d openguardrails \
  -c "SELECT version, description, executed_at, success FROM schema_migrations ORDER BY version;"

# Should show all executed migrations with success=true
```

---

### 4. Service Accessibility Test

```bash
# Frontend (should return HTML)
curl -I http://localhost:3000/platform/

# Admin service health
curl http://localhost:5000/health

# Detection service health
curl http://localhost:5001/health

# Proxy service health
curl http://localhost:5002/health
```

**All should return HTTP 200 OK**

---

### 5. Database Schema Verification

```bash
# List all tables
docker exec openguardrails-postgres psql -U openguardrails -d openguardrails \
  -c "\dt"

# Should include at minimum:
# - tenants
# - detection_results
# - blacklist
# - whitelist
# - response_templates
# - risk_type_config
# - ban_policies
# - schema_migrations
```

---

### 6. Port Availability Check (Before Starting)

```bash
# Check if required ports are available
lsof -i :3000  # Frontend
lsof -i :5000  # Admin
lsof -i :5001  # Detection
lsof -i :5002  # Proxy
lsof -i :54321 # PostgreSQL

# All should return EMPTY (no output) before starting
```

---

## Common Failure Scenarios & Fixes

### ❌ PostgreSQL won't start
**Check:**
- Port 54321 not already in use
- Data directory permissions: `/mnt/data/openguardrails-data/db`
- Volume mount path exists

**Fix:**
```bash
docker logs openguardrails-postgres
# Check for permission errors or port conflicts
```

---

### ❌ Migrations fail
**Check:**
- SQL syntax in migration files
- Migration version numbers are sequential
- No duplicate migration versions

**Fix:**
```bash
# View migration error
docker logs openguardrails-admin | grep -A 20 "Migration.*failed"

# Check migration file syntax
cat backend/migrations/versions/XXX_migration_name.sql
```

---

### ❌ Services stuck in "starting" state
**Check:**
- PostgreSQL healthcheck is passing
- Migration completed successfully
- No errors in service logs

**Fix:**
```bash
# Check specific service logs
docker logs openguardrails-admin
docker logs openguardrails-detection
docker logs openguardrails-proxy
```

---

### ❌ Frontend can't connect to backend
**Check:**
- Backend services are running
- CORS configuration in docker-compose.yml
- Nginx configuration in frontend

**Fix:**
```bash
# Check frontend logs
docker logs openguardrails-frontend

# Test backend connectivity from frontend container
docker exec openguardrails-frontend curl http://admin-service:5000/health
```

---

## Changes That Require Extra Verification

### Database Schema Changes
- ✅ New migration file created in `backend/migrations/versions/`
- ✅ Migration uses idempotent SQL (IF EXISTS, IF NOT EXISTS)
- ✅ Tested from clean state (`docker compose down -v && docker compose up -d`)
- ✅ Migration logs show successful execution
- ✅ Schema changes visible in database

### Docker Configuration Changes
- ✅ Test build from scratch: `docker compose build --no-cache`
- ✅ Test startup with new configuration
- ✅ Verify environment variables are set correctly
- ✅ Check service dependencies (`depends_on`)

### Dependency Changes
- ✅ Test `pip install` or `npm install` succeeds in container
- ✅ Verify no version conflicts
- ✅ Check image size hasn't grown excessively
- ✅ Update requirements.txt or package.json

### Service Port Changes
- ✅ Update docker-compose.yml port mappings
- ✅ Update documentation (README.md, CLAUDE.md)
- ✅ Update frontend service URLs if needed
- ✅ Update healthcheck URLs

---

## Post-Commit Verification

After committing changes:

1. **Ask another developer to test** (if possible):
   ```bash
   git clone <your-repo>
   cd openguardrails
   docker compose up -d
   ```

2. **Test on a clean VM or CI environment**

3. **Update documentation** if deployment steps changed

---

## Emergency Rollback Procedure

If deployment is broken:

1. **Identify the breaking commit**:
   ```bash
   git log --oneline -10
   ```

2. **Revert the commit**:
   ```bash
   git revert <commit-hash>
   git push
   ```

3. **Or reset to last working commit**:
   ```bash
   git reset --hard <last-working-commit>
   git push --force  # ⚠️ USE WITH CAUTION
   ```

4. **Test the rollback**:
   ```bash
   docker compose down -v
   docker compose up -d
   ```

---

## Documentation to Update

When making deployment changes, update:

- ✅ [README.md](../README.md) - Quick Start section
- ✅ [CLAUDE.md](../CLAUDE.md) - Deployment section
- ✅ [CHANGELOG.md](../CHANGELOG.md) - Log the change
- ✅ [backend/migrations/README.md](../backend/migrations/README.md) - If migration-related
- ✅ [docs/DEPLOYMENT.md](../docs/DEPLOYMENT.md) - Deployment guide

---

## Final Checklist Before Push

- [ ] Clean state test passed (`docker compose down -v && docker compose up -d`)
- [ ] All services healthy (`docker ps`)
- [ ] Migrations executed successfully
- [ ] Frontend accessible at http://localhost:3000/platform/
- [ ] All backend APIs return 200 OK
- [ ] Database schema correct
- [ ] No errors in any service logs
- [ ] Documentation updated
- [ ] CHANGELOG.md updated

**If ANY item is unchecked, DO NOT PUSH!**

---

## Remember

> **The first impression is critical. If a developer can't deploy with `docker compose up -d`, we lose them forever.**

Make it work. Make it simple. Make it reliable.
