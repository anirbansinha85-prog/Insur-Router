---
name: api-client-react dist rebuild
description: After running codegen (pnpm --filter @workspace/api-spec run codegen), the api-client-react dist/ must be rebuilt or Expo typecheck fails with "has no exported member" for new hooks.
---

## Rule
After codegen updates `lib/api-client-react/src/generated/api.ts`, run:
```
pnpm --filter @workspace/api-client-react exec tsc -p tsconfig.json
```
This regenerates `dist/generated/api.d.ts` so TypeScript project references in Expo (rc-capture) can see the new exports.

**Why:** The Expo tsconfig declares a project reference to `../../lib/api-client-react`. TypeScript resolves the package via its `dist/` declarations, not the `src/` files directly. Stale `dist/` causes "Module '...' has no exported member" for any hooks added in the latest codegen run.

**How to apply:** Any time you add or update OpenAPI endpoints and run codegen, rebuild api-client-react before typechecking any Expo artifact that imports from `@workspace/api-client-react`.
