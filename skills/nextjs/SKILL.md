---
description: Next.js 15 + 16 App Router anti-patterns reference loaded by super-review:run. Covers Server Actions security, RSC boundary leaks, cache invalidation, middleware, async request APIs, parallel routes, `use cache` directive. Load when next is detected in package.json or app/ directory is in the diff.
---

# Next.js review reference

Next.js 15+16 anti-patterns for parallel reviewers in [`super-review:run`](../run/SKILL.md). The orchestrator auto-loads this when `next` is in `package.json` or `app/` is in the diff.

---

## Anti-pattern: Server Action with no auth/authz check in the body
**Detection signal:** File-top `'use server'` exporting mutations that read `formData` and write to DB without `await getSession()` / role check at the top.
**Verbatim bad code:**
```tsx
'use server';
export async function deletePost(formData: FormData) {
  const id = formData.get('id') as string;
  await db.post.delete({ where: { id } }); // anyone with the action ID can call this
}
```
**Why it's wrong:** Per the Next 15 security notes, every Server Action is a publicly callable HTTP endpoint, even if no client references it. Unguessable IDs ≠ authorization. Untrusted `formData` keys can also be spoofed (no schema validation).
**Fix:** First lines of every action body: `const session = await auth(); if (!session) throw …; if (!canDelete(session, id)) throw …;`. Validate `formData` with Zod. Re-derive IDs from session where possible (don't trust `formData.get('userId')`).
**Review prompt one-liner:** Does every `'use server'` function start with an auth check and a schema-validated parse of its inputs, including IDs that could be spoofed?

## Anti-pattern: Forgot `revalidatePath`/`revalidateTag` (or `updateTag` in Next 16) after mutation
**Detection signal:** Server Action mutates DB then `redirect()`s, but no `revalidateTag`/`updateTag` for the affected data tag.
**Verbatim bad code:**
```tsx
'use server';
export async function createPost(formData: FormData) {
  await db.post.create({ data: { title: formData.get('title') as string } });
  redirect('/posts'); // /posts is cached → user sees their post missing
}
```
**Why it's wrong:** `redirect()` does not invalidate the cache; the destination route renders from stale tagged/`use cache` output. Per Next 16 docs the modern API is `updateTag('posts')` paired with `cacheTag('posts')` in the cached read.
**Fix:** Call `revalidateTag('posts')` (Next 15) or `updateTag('posts')` (Next 16 Cache Components) before `redirect`. Note: calling `revalidateTag`/`revalidatePath` during render now throws (Next 15 breaking change).
**Review prompt one-liner:** For every mutating Server Action, is there a matching cache invalidation by tag/path for every cached read whose result this mutation invalidates?

## Anti-pattern: `'use cache'` (Next 16) wrapping a function that reads `cookies()`/`headers()`
**Detection signal:** Function with `'use cache'` directive that also `await cookies()` or `await headers()` inside.
**Verbatim bad code:**
```tsx
async function Dashboard() {
  'use cache';
  cacheLife('hours');
  const session = (await cookies()).get('session')?.value;
  const data = await getDataFor(session);
  return <Widget data={data} />;
}
```
**Why it's wrong:** Runtime APIs inside `use cache` either error at build or, worse, cache the first request's session value and serve it to everyone — a classic cross-user cache poisoning. Per nextjs.org/docs/app/getting-started/caching, runtime APIs must be read outside the cached function and passed as args so they become part of the cache key.
**Fix:** Read `cookies()`/`headers()` in an outer Suspense'd component, then pass the extracted value as a prop to the `use cache` child; the arg auto-keys the cache.
**Review prompt one-liner:** Does any `'use cache'` function read `cookies`, `headers`, `Date.now()`, randomness, or anything else not in its argument list / closed-over scope?

## Anti-pattern: Server secrets leaked through a Server-to-Client component prop
**Detection signal:** A Server Component fetches an object containing secret fields (`apiKey`, `stripeSecret`, `hashedPassword`, full user row) and spreads it to a `'use client'` child as `<C user={user} />`.
**Verbatim bad code:**
```tsx
// server component
const user = await db.user.findUnique({ where: { id }}); // includes hashedPassword, stripeCustomerId
return <ProfileClient user={user} />;
```
**Why it's wrong:** Everything serialized across the RSC boundary lands in the client RSC payload (viewable in DevTools). Compiler can't statically prove which fields are sensitive.
**Fix:** Use `import 'server-only'` in data-access modules; use the React `taintObjectReference` / `taintUniqueValue` APIs (stable in React 19) on secret-bearing objects; or narrow the projection: `select: { id: true, name: true }`.
**Review prompt one-liner:** For every prop crossing a Server→Client boundary, is it a minimal projection or is the full DB row being shipped to the browser?

## Anti-pattern: `'use client'` cascade pushing the world to the browser
**Detection signal:** A leaf interactive component (button, icon) has `'use client'`, and its parent (a layout) also has `'use client'` because it imports the leaf at the top level.
**Verbatim bad code:**
```tsx
// app/dashboard/layout.tsx
'use client';
import { Sidebar } from './sidebar'; // forces entire dashboard into client bundle
```
**Why it's wrong:** Anything imported by a `'use client'` module becomes a client module. The "interactive island" pattern dies and bundle balloons.
**Fix:** Keep `'use client'` at the leaf. Pass server-rendered children as `children` props through the client component (composition), so server subtrees stay on the server.
**Review prompt one-liner:** Is the `'use client'` boundary at the smallest interactive leaf, with server content composed in via children rather than imported?

## Anti-pattern: Heavy middleware on every request
**Detection signal:** `middleware.ts` with no `matcher` config (runs on every request including `_next/static`), or doing JWT verification with a key fetch / DB lookup per request.
**Verbatim bad code:**
```tsx
export async function middleware(req) {
  const user = await db.user.findUnique({ where: { token: req.cookies.get('t')?.value } });
  // every request to /favicon.ico does a DB roundtrip
}
```
**Why it's wrong:** Edge middleware runs before static asset serving when matcher is unset; DB drivers usually aren't Edge-compatible; latency tax on every navigation/prefetch.
**Fix:** Add `export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] }`; verify JWTs with `jose` (Edge-safe) without DB calls; defer auth state hydration to the page.
**Review prompt one-liner:** Does middleware have a tight `matcher`, run only Edge-compatible code, and avoid network/DB calls in the request hot path?

## Anti-pattern: Reading `searchParams`/`params` synchronously after the Next 15 async-APIs break
**Detection signal:** `page.tsx` typed with `{ params: { id: string } }` instead of `Promise<{ id: string }>`, or `searchParams.q` without `await`.
**Verbatim bad code:**
```tsx
export default function Page({ params }: { params: { id: string } }) {
  return <Item id={params.id} />; // warns in 15, will break in next major
}
```
**Why it's wrong:** Per the Next 15 release notes, `params`, `searchParams`, `cookies`, `headers`, `draftMode` are now async. Sync access prints a warning and is slated for removal.
**Fix:** `export default async function Page({ params }: { params: Promise<{ id: string }> }) { const { id } = await params; }`. Run `npx @next/codemod@canary next-async-request-api .`.
**Review prompt one-liner:** Is every `params`/`searchParams`/`cookies`/`headers`/`draftMode` access awaited and typed as a Promise?

## Anti-pattern: `unstable_cache` keyed without including all variant inputs
**Detection signal:** `unstable_cache(fn, ['user'])` where `fn` takes an `id` argument but the key array doesn't include it; or the cached function closes over a request-scoped variable.
**Verbatim bad code:**
```tsx
export const getUser = unstable_cache(
  async (id: string) => db.user.findUnique({ where: { id } }),
  ['user'], // missing id! all callers share one cache entry
  { tags: ['user'] }
);
```
**Why it's wrong:** Next builds the cache key from `keyParts + JSON.stringify(args)`; misunderstanding this is the #1 cross-tenant data leak in Next caching. If the function closes over `cookies()`/`headers()` results from the outer scope, those are NOT part of the key at all.
**Fix:** Include every variant in the key parts (or rely on arg serialization), never close over request-scoped values inside `unstable_cache`. Prefer Next 16 `'use cache'` which auto-keys on args + closure.
**Review prompt one-liner:** For every `unstable_cache`, do the key parts plus arguments uniquely identify the result across users, tenants, and locales?

## Anti-pattern: `next/dynamic` with `ssr: false` inside a Server Component
**Detection signal:** `dynamic(() => import('./chart'), { ssr: false })` in a file without `'use client'`.
**Verbatim bad code:**
```tsx
// app/dashboard/page.tsx  (Server Component)
import dynamic from 'next/dynamic';
const Chart = dynamic(() => import('./chart'), { ssr: false });
```
**Why it's wrong:** Next 15 disallows `ssr: false` inside Server Components (breaking change in 15.0). It also defeats streaming for the surrounding region with no benefit.
**Fix:** Move the `dynamic()` call into a `'use client'` boundary file that the server component imports.
**Review prompt one-liner:** Is every `next/dynamic({ ssr: false })` declared inside a `'use client'` module?

## Anti-pattern: Parallel routes missing `default.tsx` slots
**Detection signal:** `@modal/` parallel slot defined alongside `@team/`, but only one has a `default.tsx`. After a hard navigation the missing slot 404s the whole route.
**Verbatim bad code:**
```
app/
  layout.tsx
  @modal/
    (.)photo/[id]/page.tsx   ← only intercepting route, no default.tsx
  @feed/
    page.tsx
    default.tsx
```
**Why it's wrong:** On direct navigation or refresh, Next can't render the parallel slot without a `default` and falls back to a 404 for the whole layout. The intercepting route only matches soft navigations.
**Fix:** Every parallel `@slot/` needs a `default.tsx` that returns `null` (or a sensible fallback) for the un-soft-navigated case.
**Review prompt one-liner:** Does every `@slot/` directory have a `default.tsx` next to its `page.tsx`?

## Anti-pattern: `<Image priority>` on everything / `<Script strategy>` wrong choice
**Detection signal:** Multiple `<Image priority>` on a page (priority should be unique to the LCP image); `<Script strategy="beforeInteractive">` for analytics; `<Script>` for analytics not using `afterInteractive` or `lazyOnload`.
**Verbatim bad code:**
```tsx
{products.map(p => <Image key={p.id} src={p.img} priority />)}
<Script src="https://analytics.example.com/a.js" strategy="beforeInteractive" />
```
**Why it's wrong:** `priority` on N images defeats prioritization (everything fights for early bandwidth, LCP regresses). `beforeInteractive` blocks hydration; analytics belongs in `afterInteractive`/`lazyOnload`.
**Fix:** Exactly one `priority` per route — the actual LCP image. Use `strategy="afterInteractive"` for analytics; reserve `beforeInteractive` for polyfills or consent SDKs that genuinely must run pre-hydration.
**Review prompt one-liner:** Is exactly one `<Image priority>` per route, and does every `<Script strategy>` match its real loading need?

## What good looks like

### Server Action with auth + Zod first lines
```tsx
'use server';
const InputSchema = z.object({ id: z.string().uuid(), title: z.string().min(1).max(200) }).strict();
export async function updatePost(formData: FormData) {
  const session = await auth();
  if (!session) throw new HttpError(401);
  const input = InputSchema.parse(Object.fromEntries(formData));
  if (!(await canEdit(session, input.id))) throw new HttpError(403);
  await db.post.update({ where: { id: input.id }, data: { title: input.title } });
  revalidateTag(`post:${input.id}`);
}
```
**Why it works:** Auth + authz + schema validation are first lines, not buried; strict schema rejects extra fields; tag invalidation paired with cached read.
**Affirm:** Every `'use server'` function opens with auth → input parse → authz → mutation → revalidate.

### `cacheTag` paired with `updateTag` (Next 16) or `revalidateTag` (Next 15)
```tsx
// read:
async function getPost(id: string) {
  'use cache';
  cacheTag(`post:${id}`);
  return db.post.findUnique({ where: { id } });
}
// write:
await db.post.update(...);
updateTag(`post:${id}`);  // or revalidateTag in Next 15
```
**Why it works:** Mutation invalidates by the same tag the cached read declared; no stale data after write.
**Affirm:** Every cached read declares a `cacheTag`; every mutation calls `updateTag`/`revalidateTag` for every tag it invalidates.

### Tight middleware matcher
```ts
export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|api/health).*)'],
};
```
**Why it works:** Static assets + health checks skip the middleware; no per-request DB hit on `/favicon.ico`.
**Affirm:** Middleware has an explicit `matcher` that excludes static and health-check paths.

### `server-only` import for data access modules
```ts
// db/users.ts
import 'server-only';
export async function getUser(id) { return db.user.findUnique({ where: { id } }); }
```
**Why it works:** Build fails if any client component imports this file by mistake; secrets and DB driver never leak to the client bundle.
**Affirm:** Every server-only module declares `import 'server-only'` at the top.

### Minimal projection across the RSC boundary
```tsx
// server component:
const user = await db.user.findUnique({
  where: { id },
  select: { id: true, name: true, avatarUrl: true }, // explicit projection
});
return <ProfileClient user={user} />;
```
**Why it works:** Sensitive fields (`hashedPassword`, `stripeCustomerId`) never serialize to the client RSC payload.
**Affirm:** Every Server→Client prop is a hand-picked `select` projection, not the full DB row.

## Sources
- [Next.js 15 release notes](https://nextjs.org/blog/next-15)
- [Next.js Cache Components docs (`use cache`, `cacheLife`, `cacheTag`, `updateTag`)](https://nextjs.org/docs/app/getting-started/caching)
- [Next.js caching without cache components](https://nextjs.org/docs/app/guides/caching-without-cache-components)
- [React — `server-only` package](https://www.npmjs.com/package/server-only)
