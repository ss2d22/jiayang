---
name: preview
description: Put a change up at a preview address of its own on Jiayang Cloud, leave the live version alone, and put the preview live once it's approved. Use when the user wants to try a change before it goes live, or show it to someone first.
---

# Previews

A preview is a new version at its own address, next to the live one. Only people the app is
shared with can open it, for 7 days or until the app's next preview. Worker apps and static sites
that already have a version live can have one.

1. Call `deploy_app` with `preview: true`. The answer has the preview's address and its version
   number. Give the person the address.
2. Check the preview answers with `call_app`, giving `preview` the version number. Without
   `preview` it reaches the live version. If `call_app` has no `preview` parameter, the CLI is
   older than 0.1.13 and would read the live version: ask the person to update it, and don't use
   `call_app` to check the preview. Then ask the person to open the preview's address and try it.
3. When the person says it's good, call `promote_preview` with that version. It goes live as it
   is. If they want to go back afterwards, `rollback` to the version that was live before.
4. If they don't want it after all, call `end_preview` with the app and that `version`. Its
   address stops answering at once, and the live version stays as it is.

Don't promote a preview the person hasn't looked at.
