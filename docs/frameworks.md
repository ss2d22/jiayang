# Frameworks

The same framework deploys two different ways depending on which adapter is installed. With a
Cloudflare adapter it becomes a Worker. Without one it becomes a container, because deploying a server-rendering app as files would put up the
shell of an app whose pages never render.

`jiayang detect` tells you which one you're getting before you deploy.

| | With | Without |
|---|---|---|
| Next.js | `@opennextjs/cloudflare` → Worker | container |
| Astro | `@astrojs/cloudflare` → Worker | static, if it has no server output |
| SvelteKit | `@sveltejs/adapter-cloudflare` → Worker | `@sveltejs/adapter-node` → container |
| Nuxt | `nitro-cloudflare-dev` → Worker | container |
| React Router / Remix | `@react-router/cloudflare`, `@remix-run/cloudflare` → Worker | `@react-router/node` → container |
| Vite | `@cloudflare/vite-plugin` → Worker | static |
| Hono | Worker | Worker |
| Express, Fastify, Koa, NestJS, hapi | none | container |
| Docusaurus, VitePress, Eleventy, Create React App, Parcel | none | static |

## Astro

Astro's own CSRF protection, `security.checkOrigin`, is **on by default** and refuses any non-GET
request whose `Origin` header doesn't match the site. A browser always sends one; a machine never
does. So an Astro app with an endpoint anything other than a browser calls (a webhook, a script,
`jiayang curl`) rejects those calls with a 403 that looks like it came from the platform.

Turn it off and decide for yourself:

```js
// astro.config.mjs
export default defineConfig({
  output: "server",
  adapter: cloudflare(),
  security: { checkOrigin: false },
});
```

Nothing is lost by doing this here. Every request has already been through the platform's sign-in
before your app sees it, and the browser hosts have their own same-origin check. What your app
gets is a signed identity token, which a cross-site form post can't produce. A webhook is the one
caller that hasn't signed in: give its public path a verifier and the platform checks the
provider's signature first, then sends a token of kind `webhook` for `requireWebhook()` to check.
See [webhooks.md](webhooks.md).

With `output: "static"` and no adapter, Astro deploys as files and none of this applies.

## Next.js

`@opennextjs/cloudflare` runs the Next build itself, so `jiayang deploy` runs
`opennextjs-cloudflare build` rather than your `build` script. Running `npm run build` would leave
`.open-next/` unwritten and deploy nothing. You keep `"build": "next build"` as it is; the CLI
knows to use the adapter's command instead.

Without OpenNext, Next.js is a container and `next start` is the start command.

## SvelteKit, Nuxt, React Router

Each of these picks a target with its adapter, and the CLI follows whatever the adapter says.
Swapping `@sveltejs/adapter-node` for `@sveltejs/adapter-cloudflare` moves an app from a container
to a Worker, and the next deploy will say so, but it does not migrate anything. An app that has
already shipped stays on the driver it was created with; the CLI refuses the switch rather than
losing the app's data.

## Vite

A Vite project with no SSR framework deploys as the files it builds. With `@cloudflare/vite-plugin`
it becomes a Worker and the plugin's own output is what goes up.

`public/` is never what gets deployed. Every builder copies it into its own output directory, and
on a fresh checkout it is often the only directory that exists. Picking it would deploy a site's
sources instead of the site.

## Hono

Hono is a Worker. A bare TypeScript entry with no wrangler config gets one generated for it, so a
project can be a single `src/index.ts` and nothing else.

## Anything with a wrangler config

The config is read for the entry, the compatibility date and flags, and the assets directory.
Bindings are subject to the policy in [deploying.md](deploying.md#what-a-worker-may-ask-for): a D1
database named `DB` is handed out, `vars` are refused with the `jiayang env set` lines printed, and
everything else is refused by name.

Builds run with `CLOUDFLARE_*` and `CF_*` stripped from the environment, so a stray account token
in your shell can't reach wrangler and a build can't touch your own Cloudflare account.
