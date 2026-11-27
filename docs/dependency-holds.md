# Dependency holds

This file lists npm dependencies that are deliberately left on an older version. The automated dependency update skips a held dependency until a version newer than the one tried here is published, unless the entry says to keep it.

When a hold is resolved, remove its entry in the same change that upgrades the dependency.

| Dependency | Current | Tried | Status | Reason |
| --- | --- | --- | --- | --- |
| `typescript` | `npm:@typescript/typescript6@^6.0.2` | — | Keep until TypeScript 7 provides a stable programmatic API | Build scripts and tests use the TypeScript 6 API, which TypeScript 7.0 does not provide. TypeScript 7 is installed separately as `@typescript/native` and runs type checking and builds through `scripts/tsc.mjs`. |
| `typebox` (devDependency) | `1.3.27` | — | Keep in step with Pi | Matches the exact `typebox` version that `@earendil-works/pi-coding-agent` depends on, which is the TypeBox Pi provides to extensions. Change it only together with Pi. The server-only `pi-web-typebox` alias is not covered by this entry. |
