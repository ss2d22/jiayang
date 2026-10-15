---
name: schedule
description: Run a path on an app on Jiayang Cloud on a schedule, like a nightly job or an hourly sync, and check or pause those jobs. Use when the user wants something to happen every day, hour or week, or asks why a job didn't run.
---

# Scheduled jobs

A schedule is a request the platform sends to a path on the app, at times given as five cron
fields in UTC. Up to 10 an app. Each run counts toward the plan like any request.

1. **Build the endpoint.** Pick a path for the job, like `/jobs/nightly`. The request is signed as
   the scheduler: its identity token has kind `service`, a `sub` starting with `scheduler:`, and
   role `viewer`. Verify it with the SDK's `requireUser()` and check that `sub` before doing the job,
   since nothing else proves the caller is the scheduler. Make running it twice harmless.

2. **Deploy**, then call `add_schedule` with the app, the cron fields and the path. POST is the
   default. For example, `0 6 * * 1-5` is 06:00 UTC on weekdays. Convert the person's local time to
   UTC and tell them which UTC time you used.

3. **Check it.** `run_schedule` runs it now, the way it always runs. Then `list_schedules` shows
   the last run: `ok`, `failed` with the app's status, `refused` before it reached the app, or
   `error`. For a failure, read `app_logs`.

`switch_schedule` with `on: false` pauses a job and keeps it. `on: true` starts it again from its
next time. `remove_schedule` deletes it.
