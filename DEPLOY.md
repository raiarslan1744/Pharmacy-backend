# Review-only update for raiarslan1744/Pharmacy-backend

This is a source bundle, not a deployed release. Uploading/pushing it may auto-deploy and requires explicit approval.

Repository: https://github.com/raiarslan1744/Pharmacy-backend
Known source branch: main (verify the Render deployment branch and deployed commit in Settings).
Root Directory: blank, because package.json and server.mjs are at repository root.
Build: npm ci. Start: npm start (node server.mjs). Runtime: Node >=22. Health: /health.
Keep the existing Render service and hostname. Do not create a new service.

After approved Supabase schema review/backups, migrations 003 and 004 are required. Do not rerun historical 001/002 blindly.
Retain the existing Supabase and Super Admin environment values; the v4 server additionally requires an independent SESSION_SECRET.
No environment or database changes are authorized by generating this bundle.

After separately approved deployment: /version must report API version 4 and the approved commit; /ready must return 200; anonymous shop APIs must return 401.
See the project final report for validation, compatibility and rollback.
