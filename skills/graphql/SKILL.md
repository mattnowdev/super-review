---
description: GraphQL schema + resolver anti-patterns reference loaded by super-review:run when the diff touches GraphQL. Covers DoS surfaces (depth, complexity, alias abuse, introspection), authz gaps at field and subscription level, N+1 resolver patterns, pagination/ID/error/scalar hygiene, persisted-query enforcement, federation @key leaks. Patterns linters miss. Load when `graphql`/`@apollo/*`/`@graphql-tools/*`/`mercurius`/`type-graphql`/`nexus` in deps, or `*.graphql`/`*.gql` files in diff, or resolver files in diff.
---

# GraphQL review reference

Anti-patterns the parallel reviewers in [`super-review:run`](../run/SKILL.md) consult when the diff modifies a GraphQL schema or resolver. Linters like `graphql-eslint` catch syntax + naming — what follows is the residue they miss: DoS surface, authz gaps, N+1, and protocol-level hygiene.

## How to use

The orchestrator (`super-review:run`) auto-loads this content into the **Security** and **Correctness** reviewer prompts when it detects `graphql`, `@apollo/*`, `@graphql-tools/*`, `mercurius`, `type-graphql`, or `nexus` in `package.json`, or when `*.graphql`/`*.gql`/resolver files appear in the diff. Each anti-pattern below contributes one prompt-line to the reviewer's checklist.

---

## Anti-pattern: No query depth limit
**Detection signal:** Apollo/Yoga/Mercurius server setup without `depthLimit`, `graphql-depth-limit`, or equivalent `validationRules`; nested types that recursively reference each other (`User.posts.author.posts.author...`).
**Verbatim bad code:**
```ts
const server = new ApolloServer({ typeDefs, resolvers });
// no validationRules → arbitrary depth accepted
```
**Why it's wrong:** A single recursive query (`{ user { posts { author { posts { author { ... } } } } } }`) at depth 15 expands to thousands of resolver calls. The official GraphQL spec doesn't bound depth — the server must. This is the lowest-effort DoS against any GraphQL endpoint.
**Fix:** Add `validationRules: [depthLimit(7)]` (graphql-depth-limit) or `@graphql-tools` `MaxDepthRule`. Pick a depth based on your deepest legitimate query + 1.
**Review prompt one-liner:** Does the server config include an explicit max depth, and is it set to the smallest value that fits real queries?

## Anti-pattern: No query complexity / cost analysis
**Detection signal:** Server has depth limit but no `graphql-query-complexity`, `graphql-cost-analysis`, or per-field cost directive; list fields with `first: Int` accept arbitrary values.
**Verbatim bad code:**
```graphql
type Query { users(first: Int): [User!]! }
# resolver fetches `first` rows; no cap
```
**Why it's wrong:** Depth limit alone doesn't stop `{ users(first: 100000) { posts(first: 1000) { comments(first: 1000) { id } } } }` at depth 4 — that's 10^11 rows. Apollo's docs on demand control recommend complexity analysis as the canonical fix.
**Fix:** Assign per-field complexity (e.g., `@cost(complexity: 1, multipliers: ["first"])`), enforce a `maxComplexity` (e.g., 1000) at validation time, and cap `first` on every list resolver.
**Review prompt one-liner:** For every list field, is there a per-field cost weight and a server-level `maxComplexity` rejecting expensive queries before resolution?

## Anti-pattern: Introspection enabled in production
**Detection signal:** `introspection: true` in Apollo Server config, or absence of the option in a build that targets production (Apollo Server v4 defaults to `NODE_ENV !== 'production'` — but `NODE_ENV` is often unset in containers).
**Verbatim bad code:**
```ts
new ApolloServer({ typeDefs, resolvers, introspection: true });
```
**Why it's wrong:** `__schema` and `__type` let an attacker enumerate every type, field, argument, and deprecation reason. Combined with no auth on schema discovery, it hands an attacker a complete API map — including internal/admin fields you forgot to hide. Apollo recommends disabling in production per their security guidance.
**Fix:** `introspection: process.env.NODE_ENV !== 'production'` AND explicitly verify `NODE_ENV=production` is set in your prod container. For Apollo Studio/registry, push the schema at build time and disable runtime introspection.
**Review prompt one-liner:** Is introspection unconditionally disabled in production, and does the build verify `NODE_ENV=production` instead of relying on a default?

## Anti-pattern: Alias abuse for rate-limit bypass
**Detection signal:** Rate limiter counts requests/queries (not fields), and the schema exposes any expensive field (`sendOtp`, `login`, `search`, `signedUrl`).
**Verbatim bad code:**
```graphql
mutation {
  a: sendOtp(phone: "+1...") { ok }
  b: sendOtp(phone: "+1...") { ok }
  c: sendOtp(phone: "+1...") { ok }
  # ... 500 aliases in one HTTP request
}
```
**Why it's wrong:** The HTTP-level rate limiter sees one POST; the resolver fires 500 times. GraphQL aliases (spec §6.3.1) allow the same field arbitrarily many times in one selection set. CVE history (GitLab, Shopify, multiple bug bounties) shows this bypassing OTP/login throttles.
**Fix:** Limit alias count per operation (custom validation rule), OR count resolver invocations per field (`graphql-shield`/`graphql-rate-limit` keyed by `info.path`), OR include complexity weight per field instance (not per query).
**Review prompt one-liner:** For every sensitive resolver, is rate limiting keyed by resolver-invocation count (not HTTP request count), and is there a per-operation alias cap?

## Anti-pattern: Missing field-level authorization
**Detection signal:** Auth checked only in `context` builder ("is user logged in?") or only on root `Query.me`/`Mutation.*`; nested types (`User.email`, `User.stripeCustomerId`, `Post.draftBody`) have no per-field guard.
**Verbatim bad code:**
```ts
const resolvers = {
  Query: { user: (_, { id }, ctx) => requireAuth(ctx) && db.user(id) },
  User: { email: (u) => u.email, stripeCustomerId: (u) => u.stripeCustomerId }
  //                       ^ any authed user reads any user's email + Stripe ID
};
```
**Why it's wrong:** Authz at the query root only proves "someone is logged in." Field-level data still leaks: any authed user can request `{ user(id: 42) { email stripeCustomerId } }`. Schema-level authz is the only safe pattern; resolver-level checks get forgotten on new fields.
**Fix:** Use `@auth(requires: SELF | ADMIN)` schema directive enforced by middleware (`graphql-shield`, `@graphql-tools/schema` `mapSchema`), OR field-resolver wrappers that check `ctx.user.id === parent.id`. Default-deny: every field opt-in, not opt-out.
**Review prompt one-liner:** Does every PII/sensitive field have an explicit auth directive or wrapper, and is the default for new fields deny-until-annotated?

## Anti-pattern: N+1 in nested resolvers (no DataLoader)
**Detection signal:** Resolver for a list-of-parent field directly calls DB per row: `Post.author: (post) => db.user.findUnique({ id: post.authorId })`; no `DataLoader` in `context`.
**Verbatim bad code:**
```ts
const resolvers = {
  Query: { posts: () => db.post.findMany() },
  Post: {
    author: (post) => db.user.findUnique({ where: { id: post.authorId } }),
    // 1 query for posts + N queries for authors
  }
};
```
**Why it's wrong:** For 100 posts, this fires 101 queries. DataLoader (the Facebook reference implementation, used by Apollo's own docs as the canonical fix) batches all `.load(id)` calls in the same tick into one `loadMany([ids])`.
**Fix:** Per-request DataLoader: `context: () => ({ userLoader: new DataLoader(ids => batchLoadUsers(ids)) })`, then `author: (post, _, ctx) => ctx.userLoader.load(post.authorId)`. Recreate loader per request (never global — caches stale across users).
**Review prompt one-liner:** For every resolver returning a related object/list, is the fetch routed through a per-request DataLoader (and is the loader instantiated in `context`, not module-scope)?

## Anti-pattern: Unbounded list fields (no pagination)
**Detection signal:** Schema field `comments: [Comment!]!` without `first`/`after` or `limit`/`offset` args; resolver does `db.comment.findMany({ where: { postId } })` with no cap.
**Verbatim bad code:**
```graphql
type Post { comments: [Comment!]! }
```
**Why it's wrong:** A post with 1M comments returns 1M rows in one response. Even with depth+complexity limits, an unbounded list at depth 1 is uncapped bandwidth + memory. Relay's Cursor Connections Spec exists precisely for this.
**Fix:** Cursor pagination: `comments(first: Int!, after: String): CommentConnection!` with `pageInfo { hasNextPage endCursor }`. Hard-cap `first` server-side (e.g., `Math.min(first, 100)`). Never offer offset pagination on tables that mutate.
**Review prompt one-liner:** Does every list field require pagination args, and does the resolver enforce a server-side max page size regardless of what the client requests?

## Anti-pattern: Exposing raw internal IDs
**Detection signal:** Schema fields `id: Int!` or `id: ID!` where the resolver returns the DB autoincrement primary key (`1`, `2`, `3`) rather than an opaque/global ID.
**Verbatim bad code:**
```graphql
type User { id: Int! }  # returns 1, 2, 3...
```
**Why it's wrong:** Autoincrement IDs leak business metrics (user count, growth rate, ordering) and enable IDOR enumeration (`{ user(id: 1) { ... } user(id: 2) { ... } }`). Relay's Object Identification spec requires global, opaque, type-prefixed IDs (`base64("User:42")`).
**Fix:** Either UUIDs as primary keys, or Relay-style global IDs (`toGlobalId('User', dbId)`), or HashIDs. Combine with per-field authz so even known IDs don't leak data.
**Review prompt one-liner:** Are externally-visible IDs opaque (UUID or base64-encoded type+id) such that they don't expose row counts, ordering, or allow enumeration?

## Anti-pattern: Mutation returns the whole graph
**Detection signal:** `Mutation.updatePost` returns `User!` (the whole user with all posts) instead of `UpdatePostPayload { post: Post! }`; resolver re-fetches relations the client didn't ask for.
**Verbatim bad code:**
```graphql
type Mutation {
  updatePost(id: ID!, body: String!): User!  # client now traverses user.posts.comments.author...
}
```
**Why it's wrong:** Mutations should return the minimal affected data; returning a root object lets clients trigger expensive sub-fetches in the mutation response, and re-runs N+1 on hot paths. Apollo + Relay convention: every mutation returns a dedicated `<Mutation>Payload` type.
**Fix:** `type UpdatePostPayload { post: Post!, errors: [UserError!]! }`; client opts into the fields it wants. Apply the same complexity rules to mutation responses.
**Review prompt one-liner:** Does every mutation return a dedicated `<Mutation>Payload` type with only the directly-affected entity, not a root object that re-opens the whole graph?

## Anti-pattern: Persisted queries not enforced in production
**Detection signal:** Production server accepts arbitrary `query` strings from clients; Apollo Server config lacks `persistedQueries: { ttl: ... }` with an allowlist, or APQ is enabled but not required.
**Verbatim bad code:**
```ts
// any client can POST { query: "{ users { ... } }" }
new ApolloServer({ typeDefs, resolvers });
```
**Why it's wrong:** Even with depth+complexity limits, allowing ad-hoc queries from browser clients means a compromised CDN/extension/MITM can issue any allowed-by-validation query. Persisted queries (Apollo's "Persisted Queries" / "safelisting") restrict prod to a build-time-registered allowlist; arbitrary queries are rejected. This also enables GET caching and smaller payloads.
**Fix:** Build step extracts all client queries → manifest; server rejects any operation whose hash isn't in the manifest (Apollo `@apollo/server-plugin-operation-registry`, or `graphql-yoga` persisted-operations plugin). Allow introspection bypass only behind an admin token in staging.
**Review prompt one-liner:** Does production reject any operation whose document hash isn't in the build-time persisted-query manifest?

## Anti-pattern: Federation `@key` without per-subgraph authz consideration
**Detection signal:** `@key(fields: "id")` on a type in subgraph A that resolves via `Query._entities` without rechecking authz; type contains sensitive fields.
**Verbatim bad code:**
```graphql
# subgraph: billing
type User @key(fields: "id") {
  id: ID!
  stripeCustomerId: String!
  totalSpent: Int!
}
# resolved via __resolveReference using only the id from gateway
```
**Why it's wrong:** The gateway federates by passing `{ __typename: "User", id }` to the entity resolver. If subgraph A trusts the gateway and skips authz on `__resolveReference`, any client that can name a `User.id` through subgraph B can pivot to billing fields. The Apollo Federation spec explicitly warns: each subgraph re-validates authz on entity references.
**Fix:** Apply the same field-level `@auth` directive in every subgraph that exposes the type; treat `__resolveReference` as a public entrypoint, not an internal RPC.
**Review prompt one-liner:** For every `@key` type, does the owning subgraph's `__resolveReference` enforce the same authz as a direct `Query.user(id:)`?

## Anti-pattern: Errors leak stack traces / DB queries
**Detection signal:** Default Apollo formatter in prod; `formatError` returns `error` as-is; resolver throws raw `PrismaClientKnownRequestError` or `pg` error that surfaces in `errors[].extensions.exception.stacktrace` or `.query`.
**Verbatim bad code:**
```ts
new ApolloServer({ /* no formatError */ });
// response: errors[0].extensions.exception.stacktrace: ["at PrismaClient...", "DATABASE_URL=postgres://..."]
```
**Why it's wrong:** Stack traces reveal file paths, ORM version, DB layout; raw query text can leak schema and even connection strings if errors include config. The GraphQL spec leaves `extensions` to the server — by default Apollo includes stacktraces unless `NODE_ENV=production` (and again, that env var often isn't set).
**Fix:** Explicit `formatError(formatted, error) { if (prod) return { message: 'Internal error', code: formatted.extensions?.code }; return formatted; }`. Log the full error server-side with a correlation ID; return only the ID to the client.
**Review prompt one-liner:** In production, do error responses contain only `message` + `code` (and a correlation ID), with no stacktrace, query text, or framework-specific exception details?

## Anti-pattern: Subscription channels without per-user authz / rate limit
**Detection signal:** `Subscription.messageAdded(roomId: ID!)` resolver that calls `pubsub.asyncIterator('MESSAGE_ADDED')` and filters in `subscribe`, but doesn't verify `ctx.user` can read `roomId`; no connection-level rate limit on WS.
**Verbatim bad code:**
```ts
Subscription: {
  messageAdded: {
    subscribe: (_, { roomId }) => pubsub.asyncIterator(`MSG_${roomId}`)
    // no auth check; any client can subscribe to any room
  }
}
```
**Why it's wrong:** Subscriptions are long-lived WS channels; one auth check at connection init isn't enough — each `subscribe` call is a separate authz decision (the user may not have access to this specific room). Also, without per-connection limits, a client can open thousands of subscriptions and exhaust server memory.
**Fix:** Check authz inside `subscribe` (throw or return empty iterator if denied); use `withFilter` to drop events the user can't see. Cap subscriptions per connection and connections per user (e.g., `graphql-ws` `onSubscribe` hook).
**Review prompt one-liner:** Does each subscription's `subscribe` function re-check authz for the specific arguments, and is there a server-side cap on subscriptions-per-connection and connections-per-user?

## Anti-pattern: Date/DateTime scalars without timezone normalization
**Detection signal:** Custom `Date` scalar that does `new Date(value).toISOString()` (assumes UTC) but accepts naive strings like `"2026-05-16 14:00"`; or a mix of `Date`/`DateTime`/`Timestamp` scalars across the schema.
**Verbatim bad code:**
```ts
const DateScalar = new GraphQLScalarType({
  name: 'Date',
  parseValue: (v: string) => new Date(v),  // "2026-05-16 14:00" → browser-local TZ
  serialize: (v: Date) => v.toISOString()
});
```
**Why it's wrong:** `new Date("2026-05-16 14:00")` parses in the server's local timezone; same string on different servers produces different UTC instants. Clients receive `Z`-suffixed strings and assume UTC, silently shifting events by hours.
**Fix:** Use `graphql-scalars`'s `DateTime` (ISO-8601 with required offset) and reject inputs missing TZ in `parseValue`. Pick one scalar (`DateTime`) across the whole schema; document that all values are UTC instants with explicit offset.
**Review prompt one-liner:** Does the schema use exactly one date/time scalar that requires an explicit timezone on input and serializes to ISO-8601 with `Z`?

---

## What good looks like

### DataLoader instantiated per request
```ts
const server = new ApolloServer({ typeDefs, resolvers });
await startStandaloneServer(server, {
  context: async ({ req }) => ({
    user: await authFromReq(req),
    loaders: {
      user: new DataLoader<string, User>(ids => batchLoadUsers(ids)),
      postsByAuthor: new DataLoader<string, Post[]>(ids => batchLoadPostsByAuthor(ids)),
    },
  }),
});
```
**Why it works:** Loader cache lives for one request — no cross-user data bleed; one DB roundtrip per entity type per request.
**Affirm:** DataLoader instances are created in `context`, not module-scope.

### Persisted-queries-only in production
```ts
new ApolloServer({
  typeDefs, resolvers,
  persistedQueries: { ttl: null },  // permanent allowlist from build manifest
  plugins: [
    process.env.NODE_ENV === 'production'
      ? require('@apollo/server-plugin-operation-registry').default({ forbidUnregisteredOperations: true })
      : null,
  ].filter(Boolean),
});
```
**Why it works:** Prod rejects any query whose hash isn't in the manifest; complexity/depth checks become a backstop, not the only line.
**Affirm:** Production rejects unregistered operations; staging requires admin token to bypass.

### Field-level auth via schema directive
```graphql
directive @auth(requires: Role = USER) on FIELD_DEFINITION
type User {
  id: ID!
  name: String!
  email: String! @auth(requires: SELF)
  stripeCustomerId: String! @auth(requires: ADMIN)
}
```
```ts
// mapSchema wraps each @auth field's resolver to assert ctx.user matches
```
**Why it works:** Default-deny: new fields without `@auth` fail CI lint; PII fields require explicit role.
**Affirm:** Every PII/sensitive field carries an explicit `@auth` directive enforced by middleware.

### Cursor pagination on every list
```graphql
type Query {
  posts(first: Int! = 20, after: String): PostConnection!
}
type PostConnection {
  edges: [PostEdge!]!
  pageInfo: PageInfo!
}
type PageInfo { hasNextPage: Boolean!, endCursor: String }
```
```ts
posts: (_, { first, after }) => paginate({ first: Math.min(first, 100), after })
```
**Why it works:** Server caps page size regardless of client; cursors stable under inserts.
**Affirm:** Every list field uses cursor pagination with a server-enforced max page size.

### Explicit complexity + depth limits
```ts
const MAX_COMPLEXITY = 1000;
const MAX_DEPTH = 7;
new ApolloServer({
  validationRules: [
    depthLimit(MAX_DEPTH),
    createComplexityLimitRule(MAX_COMPLEXITY, {
      scalarCost: 1, objectCost: 2, listFactor: 10,
    }),
  ],
});
```
**Why it works:** Constants are named, reviewable, and tunable; both limits enforced at validation (before resolution).
**Affirm:** Server config exposes `MAX_COMPLEXITY` and `MAX_DEPTH` as named constants reviewed in PRs.

## Sources
- [GraphQL Spec — Aliases (§6.3.1)](https://spec.graphql.org/October2021/#sec-Field-Alias)
- [Apollo Server — Security (introspection, persisted queries)](https://www.apollographql.com/docs/apollo-server/security/)
- [Apollo Server — Limiting query depth & complexity](https://www.apollographql.com/docs/technotes/TN0030-confidence-rules/)
- [DataLoader — Facebook reference impl](https://github.com/graphql/dataloader)
- [Relay — Cursor Connections Spec](https://relay.dev/graphql/connections.htm)
- [Relay — Object Identification (global IDs)](https://relay.dev/graphql/objectidentification.htm)
- [Apollo Federation — Entities & `__resolveReference`](https://www.apollographql.com/docs/federation/entities/)
- [graphql-scalars — DateTime](https://the-guild.dev/graphql/scalars/docs/scalars/date-time)
