# Mystiwan USSD Server

Standalone Node.js server for handling USSD gateway requests for Mystiwan E-Business.

## Features

- Express server with health check and USSD endpoints
- Menu flow using gateway-compatible `CON` and `END` responses
- Dedicated `ussd_agents` table for phone-to-agent mapping
- Secure hashed PIN verification in Postgres via `pgcrypto`
- Live bundle lookup from Supabase (`agent_offers` with fallback to `offers`)
- Live wallet check from Supabase (`agent_wallet`)
- Atomic SQL RPC for wallet debit + `agent_orders` insert (race-safe)
- Help and exit options

## Quick Start

1. Install dependencies:

   ```bash
  pnpm install
   ```

2. Copy environment file:

   ```bash
   cp .env.example .env
   ```

3. Start server:

   ```bash
  pnpm dev
   ```

4. Production start:

   ```bash
  pnpm start
   ```

Server runs on `http://localhost:3001` by default.

## Endpoints

- `GET /health`
  - Returns server health JSON.

- `POST /ussd`
  - Main USSD route.
  - Should return plain text responses prefixed with `CON` or `END`.

- `POST /ussd/callback`
  - Optional asynchronous callback endpoint.

## Expected Request Fields

Most gateways send `application/x-www-form-urlencoded` payloads with fields like:

- `sessionId`
- `serviceCode`
- `phoneNumber`
- `text`

This server also accepts alternate field names: `session_id`, `service_code`, `msisdn`, and `phone`.

## Required Environment Variables

Set these in `.env`:

- `SUPABASE_URL`
- `SUPABASE_SERVICE_ROLE_KEY`

Agent lookup is done from the caller MSISDN in `ussd_agents`, and PIN verification is performed against a bcrypt hash in SQL.

## Database Setup

Run this SQL in Supabase SQL Editor:

- `sql/ussd_agents_and_rpc.sql`

This migration creates:

- `public.ussd_agents`
- `public.upsert_ussd_agent(...)`
- `public.ussd_get_wallet_balance(...)`
- `public.ussd_create_agent_order(...)`

## Menu Structure

- `1` Buy Data Bundle
  - Select network
  - Select bundle
  - Continue
  - Enter wallet PIN
- `2` Check Wallet Balance
- `3` Help
- `4` Exit

## Gateway Integration

Set your USSD provider callback URL to:

- `https://your-domain.com/ussd`

If you deploy on Vercel, this works directly because `vercel.json` rewrites:

- `/ussd` -> `/api/ussd`
- `/ussd/callback` -> `/api/ussd-callback`
- `/health` -> `/api/health`

For local testing, expose your machine using a tunnel (for example, ngrok):

```bash
ngrok http 3001
```

Then configure the generated public URL with your gateway.

## Vercel Deployment

1. Import this folder as a Vercel project with root directory set to `ussd-server`.
2. Add environment variables in Vercel Project Settings:
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `USSD_SERVICE_NAME` (optional)
3. Deploy.
4. Use these production endpoints:
  - `https://<your-vercel-domain>/ussd`
  - `https://<your-vercel-domain>/health`
  - `https://<your-vercel-domain>/ussd/callback`

For CLI deployment from this folder:

```bash
pnpm dlx vercel
```

For production deployment:

```bash
pnpm dlx vercel --prod
```

## Notes

- This backend expects the caller phone to exist in `ussd_agents` and `agent_wallet`.
- PIN checks and wallet updates happen in SQL functions to keep credentials out of app code.
- Wallet debit and order creation are done in one transaction-safe RPC.

## Next Steps

1. Apply the SQL migration in Supabase from `sql/ussd_agents_and_rpc.sql`.
2. Create each USSD-enabled agent profile by calling `public.upsert_ussd_agent(...)` with `agent_id`, `msisdn`, and a 4-digit PIN.
3. Ensure each mapped `agent_id` has an existing row in `agent_wallet` with sufficient balance.
4. Set production values in `.env` for `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY`.
5. Start the service with `pnpm start` and configure the gateway callback URL to `/ussd`.
6. Test full flow using a registered MSISDN: check balance, buy bundle, and confirm row creation in `agent_orders`.
