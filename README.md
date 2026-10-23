# SkinWise MVP v3

SkinWise is an Expo React Native app (iOS, Android, and web) with an Express/TypeScript API and Prisma/PostgreSQL database.

## Setup

Prerequisites: Node.js 20 or newer and Docker Compose (or a compatible PostgreSQL 16 server).

1. From this directory, start PostgreSQL with `docker compose up -d`.
2. In `api/`, copy `.env.example` to `.env`. Set `BEAUTY_API_KEY` from [The Beauty API dashboard](https://thebeautyapi.com/dashboard); never commit `.env`.
3. In `api/`, run `npm install`, `npx prisma generate`, `npx prisma db push`, and `npm run dev`.
4. In `app/`, copy `.env.example` to `.env`, run `npm install` and `npx expo install --fix`, then run `npm run web` or `npm start` for native development.
5. On a physical phone, set `EXPO_PUBLIC_API_URL` to the API server's LAN address and port. Set `CORS_ORIGIN` in the API environment to the exact app origins used in deployment. Use HTTPS outside local development.

When upgrading an existing database, back up the database before running `npx prisma db push`. Existing unowned profiles remain inaccessible; create a new account and profile, and remove old unowned records according to your retention requirements.

## API

Product endpoints are public and rate-limited. The app requires an account to use profile and routine endpoints.

- `POST /auth/register` and `POST /auth/login` accept `{ "email": "...", "password": "..." }` and return a bearer token. New passwords must be at least 12 characters.
- `GET /auth/me` validates a bearer token. `DELETE /auth/session` revokes the current session. `DELETE /auth/account` deletes the account, its sessions, profile, and routines.
- `GET /products?q=CeraVe%20Moisturizing%20Cream&page=1` proxies slim results from The Beauty API and returns `{products,pagination,no_match}`.
- `GET /products/barcode/:code` looks up EAN/UPC codes in [Open Beauty Facts](https://world.openbeautyfacts.org/), then caches the product locally for routines and analysis. The dataset is community-contributed and can be incomplete.
- `GET /products/:id` fetches product details and caches a local product for routines.
- `GET /products/:id/analysis?skinType=dry&concerns=acne` returns an educational ingredient compatibility assessment.
- `GET /ingredients/search?q=niacinamide&page=1` proxies ingredient search.
- Authenticated profile and routine routes: `POST /profiles`, `GET /profiles/me`, `GET/PUT /profiles/:id`, `GET/POST /profiles/:id/routines`, and `DELETE /routines/:id`. Send the bearer token in the `Authorization` header.

The API applies per-IP request limits, a stricter limit to sign-in/registration, bounded five-minute in-memory caches for provider responses, and a 12-second provider timeout. The Beauty API key remains on the server. Provider pages are limited to 1–51; HTTP 429 responses are retried twice with exponential backoff.

## Privacy and deployment

See [PRIVACY.md](./PRIVACY.md) for stored data, deletion, and third-party processing. Before public release, complete its operator contact details and review the notice against your jurisdiction and actual hosting/logging configuration. Do not deploy without HTTPS, a strong database password, a production API key, and a reviewed privacy notice.

Product search and barcode lookup send search terms/barcodes to their respective providers. Passwords are stored as salted scrypt hashes; session tokens are stored hashed in the database and retained for up to 30 days. Rate-limit state and provider response caches are in memory and are cleared when the API restarts.

The ingredient assessment is heuristic and is not clinically validated, a safety certification, or medical advice. Ingredient data may be missing, and product images may be unavailable. Live provider integration requires valid provider access and was not verified as part of local development.
