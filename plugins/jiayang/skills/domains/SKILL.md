---
name: domains
description: Put an app on Jiayang Cloud at a domain the user owns, like tools.example.com, and check its DNS. Use when the user wants an app on their own domain or a custom domain isn't working.
---

# Custom domains

An app on its own domain is still behind our sign-in, and shared exactly as at its own address.

1. Call `add_domain` with the app and the hostname, like `tools.example.com`. Only the app's owners
   and the workspace's owners and admins can.
2. Give the person the DNS records from the answer, exactly as they are, to add at their DNS
   provider. You can't add them.
3. Call `list_domains` until the domain is `active`. That usually takes a few minutes once the
   records are in. A `failed` domain says why, most often a record that's missing or different.

The plan limits how many custom domains a workspace has. `remove_domain` takes one off, and it
stops working within 60 seconds.
