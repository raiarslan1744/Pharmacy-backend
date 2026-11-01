# Deploy to Render

1. In Supabase SQL Editor run `supabase/migrations/001_cloud_identity.sql` once. Enable the Data API.
2. On Render choose New Web Service and connect `raiarslan1744/Pharmacy-backend`.
3. Leave Root Directory blank. Runtime: Node. Build: `npm ci`. Start: `npm start`. Health check: `/health`. Alternatively create a Blueprint using `render.yaml`.
4. Set these Render environment variables:

| Variable | Value |
| --- | --- |
| `SUPABASE_URL` | Your project URL, e.g. `https://PROJECT.supabase.co` |
| `SUPABASE_SECRET_KEY` | A secret API key (`sb_secret_...`) from Supabase API Keys; this is **not your database password** |
| `SUPER_ADMIN_USERNAME` | Your chosen super admin username |
| `SUPER_ADMIN_PASSWORD` | Your chosen password, 12–1024 characters with no surrounding whitespace |
| `NODE_VERSION` | `22` |

5. Deploy. Startup creates or updates the matching super admin account using a salted password hash. The SQL migration must already exist or startup fails. Changing the password environment variable takes effect after restarting/redeploying. Changing the username creates a new account; disable the old account in `cloud_accounts` if retiring it.
6. In the Flutter project build with `flutter build windows --dart-define=BACKEND_URL=https://YOUR-SERVICE.onrender.com` (or `flutter build apk` with the same define). Sign in with your configured super admin credentials and leave Shop ID blank.

Use `.env.example` and `npm run provision` locally to create pharmacy admins/employees and pharmacy name/address records. Existing Flutter management screens currently update local SQLite only; cloud account/profile management from those screens is not implemented. Login does not issue tokens for future API calls. Inventory and sales remain local. Never put the Supabase secret or super admin password into Flutter build defines.

Run `npm test` to verify backend behavior.
