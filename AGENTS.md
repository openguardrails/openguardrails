# Repository Guidelines

OpenGuardrails combines Python guardrail services with a Vite/React console; use these checkpoints when contributing.

## Project Structure & Module Organization
- `backend/` contains the FastAPI admin/detection/proxy services; shared config is `backend/config.py`, migrations live in `backend/migrations/`, and launch scripts are `backend/start_*.py`.
- `frontend/` houses the console (`src/` components, `public/` assets), while `landing/` and `openguardrails-www/` power marketing sites; `docs/` stores planning notes.
- End-to-end playgrounds and shell helpers are in `tests/`; runtime exports live in `data/`—keep them out of git.

## Build, Test, and Development Commands
- Backend bootstrap: `cd backend && python -m venv venv && source venv/bin/activate && pip install -r requirements.txt`; set `PYTHONPATH=$PWD/backend` when running scripts.
- Start services via `bash backend/start_all_services.sh` or launch each `python start_<service>_service.py` in its own terminal. Docker users can run `docker-compose up --build` for Postgres + services.
- Frontend flow: `cd frontend && npm install`, `npm run dev` for hot reload, `npm run build` for production assets, and `npm run lint` for ESLint.

## Coding Style & Naming Conventions
- Python code follows PEP 8, four-space indents, and type hints; format with `black` and lint with `flake8` (both declared in `backend/requirements.txt`). Modules/functions stay snake_case, models use UpperCamelCase.
- Keep backend logic domain-focused (`routers/`, `services/`, `utils/`); scanner changes usually touch `backend/services/scanner_detection_service.py` or `scanner_package_service.py`.
- Frontend components use strict TypeScript, hooks, and colocated styles. Name files `FeatureName.tsx` and rely on ESLint/Prettier via `npm run lint`.

## Testing Guidelines
- Primary coverage runs through `cd backend && pytest`; narrow scope with patterns like `pytest services/tests/test_scanner_detection.py -k s9`. Name new files `test_<feature>.py`.
- CLI smoke flows (registration, scanner uploads, etc.) are scripted in `tests/`—extend files such as `tests/quick_test.sh` and document any fixtures in `tests/README.md`.
- Reuse the placeholder credentials from `docker-compose.yml`; never paste real tenant data into tests.

## Commit & Pull Request Guidelines
- Commits follow the conventional prefixes in `CONTRIBUTING.md` (`feat:`, `fix:`, `docs:`, …) and stay in the imperative mood.
- PRs must describe motivation, note the validation commands, link issues, and add UI screenshots when React surfaces change; call out any config implications for reviewers.

## Security & Configuration Tips
- Update env files or Docker secrets instead of tracked config when handling keys, and scrub anything written to `data/` before pushing.
- Read `SECURITY.md` before editing auth, billing, or banning flows, and ensure new scanners preserve the tenant scoping visible in `backend/services/scanner_detection_service.py`.
