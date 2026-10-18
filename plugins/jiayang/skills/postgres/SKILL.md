---
name: postgres
description: Use a Postgres database the person already has (Neon, Supabase, RDS or any other the internet can reach) from an app on Jiayang Cloud, without its password in the app. Use when an app needs Postgres, or the person gives you a postgres:// URL.
---

# Postgres

An app on Jiayang Cloud never holds a database password. The workspace connects the database once,
Jiayang Cloud keeps the password sealed, and the app sends SQL to the platform over HTTP. Team
connects 3 databases per workspace and Business 10. Free has none, so say so and point the person
to Billing in the dashboard rather than working around it. When `list_postgres` says Postgres
connections aren't switched on yet, nothing connects on any plan, and no plan change helps. Tell
the person, and use the app's own SQLite database meanwhile if that fits.

1. **Keep the URL out of the app.** Never write a `postgres://` URL, a password or a host into the
   app's source, its `.env`, `set_env` or `set_secret`, and don't install a Postgres driver in the
   app to connect directly. Workers apps can't open the connection at all, and container apps have
   no route to the database but the platform's.

2. **Connect it.** `list_postgres` shows what the workspace has. If the database isn't there, ask
   a workspace owner to run `jiayang postgres add <workspace> main` and paste the URL at its
   prompt. There's no tool for it, so the password never passes through you: never ask for the
   URL, and if the person pastes it to you anyway, tell them to run the command instead and to
   change the password. A new password goes the same way, with `jiayang postgres rotate`. The
   database must take connections from the internet: private addresses are refused, and a
   firewall must allow Cloudflare's IP ranges (cloudflare.com/ips).

3. **Give it to the app.** `grant_postgres` with the app and the connection's name. It works
   within 10 seconds, with nothing to redeploy. If the answer says the app's list of hosts leaves
   the database out, ask the person whether to add it, then add it with `allow_outbound_host`.

4. **Query it from the app's code.** POST JSON to `http://postgres.jiayang.internal/<name>/query`
   with the header `x-jiayang-postgres: 1`. Workers and containers do it the same way.

   ```js
   async function sql(text, params = []) {
     const res = await fetch("http://postgres.jiayang.internal/main/query", {
       method: "POST",
       headers: { "content-type": "application/json", "x-jiayang-postgres": "1" },
       body: JSON.stringify({ sql: text, params }),
     });
     const body = await res.json();
     if (!res.ok) throw new Error(body.message);
     return body.rows;
   }
   ```

   - Always pass values as `params` with `$1`, `$2` placeholders. Never build SQL from strings.
   - One statement per request. For a transaction, send `{"statements": [...]}` to
     `/<name>/batch`: all of them commit or none do.
   - Each request is its own session, so `SET`, temporary tables and a `BEGIN` of your own don't
     carry over. Use a batch instead.
   - `bigint`, `numeric`, dates and times come back as strings. Parse them where it matters.
   - An answer holds at most 5,000 rows, 25,000 values and 1 MB of JSON, and a statement runs
     at most 30 seconds. Page with `LIMIT`.
   - Migrations are plain SQL sent the same way, for example from a route only the app's owners
     can call, or by the person with their own tools.

5. **When it fails**, read `error` in the answer: `no_connection` (not given to this app),
   `query_failed` (Postgres refused the SQL, and `code` is the SQLSTATE), `forbidden` (the mark is
   missing, or the list of hosts leaves the database out), `plan_limit` (the workspace has more
   connections than its plan allows, so the person removes one or changes the plan), `unavailable`
   (run `check_postgres`, which says what to fix). Never ask the person for the password to test
   it yourself.

Each statement counts as 2,000 database rows read toward the workspace's usage.
