# Dependency holds

This file lists npm dependencies that are deliberately left on an older version. The automated dependency update skips a held dependency until a version newer than the one tried here is published, unless the entry says to keep it.

When a hold is resolved, remove its entry in the same change that upgrades the dependency.

| Dependency | Current | Tried | Status | Reason |
| --- | --- | --- | --- | --- |
| `typescript` | `^6.0.3` | `7.0.2` | Retry with a newer `typescript` or `typescript-eslint` | `typescript-eslint` 8.74.0 requires `typescript >=4.8.4 <6.1.0`, so npm cannot resolve the install. |
| `typebox` (devDependency) | `1.3.27` | — | Keep in step with Pi | Matches the exact `typebox` version that `@earendil-works/pi-coding-agent` depends on, which is the TypeBox Pi provides to extensions. Change it only together with Pi. The server-only `pi-web-typebox` alias is not covered by this entry. |
