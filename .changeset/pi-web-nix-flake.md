---
"@jmfederico/pi-web": minor
---

Add a self-contained Nix flake (`flake.nix`) that builds pi-web as a pure package (`nix build .#default`) and ships a home-manager module (`services.pi-web`) that declaratively defines the two systemd user services — the session daemon and the web/API server. Also restores the missing `integrity` hashes on the six nested `@earendil-works/*` entries in `package-lock.json` (an npm lockfile omission) so the lockfile is compatible with nixpkgs' npm tooling. `package.json` is unchanged.
