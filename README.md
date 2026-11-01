# Qodra Pharmacy Backend

Node.js backend for Supabase cloud login and pharmacy name/address loading. Deploy instructions and required environment variables: [DEPLOY.md](DEPLOY.md).

Run `npm test` for validation. No external npm dependencies. Passwords are stored as salted scrypt hashes; Supabase secrets stay on the backend.

Inventory and sales remain local to the Flutter POS. Cloud management through existing Flutter administration screens is not yet implemented.
