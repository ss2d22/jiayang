---
name: starter
description: Make a new app on Jiayang Cloud from nothing, starting from a template, and deploy it. Use when the user asks for a new app, site, page, tool or API and there's no code for it yet, for example "make me a page for the team" or "build a small tool to track orders".
---

# Start an app from a template

When there's no code yet, start from one of Jiayang Cloud's templates rather than a blank
directory. Each one deploys as it is, and each one with code already checks who is calling with
the SDK.

1. **Pick a template.** Call `list_templates`. Choose by what the user asked for:
   - `static-site`: pages with no code behind them, like a handbook or a launch page.
   - `worker`: a small JavaScript app or API that needs to know who is calling.
   - `internal-tool`: anything that keeps shared data, like a list, a log or a tracker. It has
     a database.
   - `express` or `fastapi`: when the user wants Node with Express, or Python. These run as
     containers, which need a paid plan. Say so before choosing one.

   If it isn't clear, pick the smallest that fits, and tell the user which and why.

2. **Write it.** Call `create_from_template` with the template and a new directory inside the
   project, named after the app, like `team-list`. It never replaces a file. If it says the files
   are there already, pick another directory rather than deleting anything.

3. **Make it theirs.** Read the template's `README.md`, then change the code to do what the user
   asked. Keep `requireUser()`, or `CurrentUser` in FastAPI. It's what tells the app who is
   calling. Never replace it with a header like `X-Jiayang-Email`. Keep credentials out of the
   code: they go in `set_secret`.

4. **Deploy it.** Follow the `deploy` skill, with `create_if_missing: true` and an app name in
   the workspace the user chose. Names are lowercase letters, digits and single dashes.

Finish with what you made, the URL, and how to share it.
