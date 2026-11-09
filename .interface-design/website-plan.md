# Website design migration

## Goal

Extend the approved flow-led homepage style across PI WEB's public website without changing the application's runtime or authentication behavior. Work on `website/homepage-refresh` in `/home/core/projects/pi-web-homepage`; do not push or deploy publicly. Keep the private NetBird preview at `http://100.120.152.255:8520/` available.

## Design contract

- Keep the approved palette and automatic/light/dark theme behavior.
- Use clear typography, restrained surfaces, generous but purposeful space, and one obvious primary action.
- Explain outcomes and processes. Prefer semantic HTML and small diagrams over screenshots. Do not add a screenshot unless it materially explains an otherwise unclear task.
- Documentation has a denser reading layout, not oversized marketing sections.
- Preserve technical guidance, commands, security warnings, anchor IDs, deep links, plugin discovery behavior, clipboard actions, and development-site routing.
- Prefer existing native controls and shared CSS; no new UI framework or JavaScript-only navigation.

## Scope and ownership

1. `docs/styles.css`: common tokens, typography, controls, site shell, documentation layout, reference components, plugin directory and error page.
2. `docs/home.css`: only the homepage layout and illustrative device/process diagrams.
3. Existing public HTML pages: common navigation/footer, calm page headings, accessible landmarks and document navigation.
4. `docs/design-system.html`: a noindex working reference for reusable patterns, including sign-in form states. Not a functioning login route; never collect or send credentials.
5. `.interface-design/system.md`: durable design decisions and adoption instructions.
6. Website tests and dev-site assembly: protect real behavior and link/asset contracts, not incidental wording or layout class names.

There is no standalone PI WEB website login page in this repository. The in-app AuthDialog configures model/MCP providers and is not a website account login. Separate Safe Tunnels services own their own sign-in experience. Do not modify deployed services or unrelated repositories. Provide the transferable login pattern here and report that boundary explicitly.

## Work sequence

- [x] Inventory public pages and locate authentication ownership.
- [x] Extract shared foundations from the approved homepage; remove obsolete marketing effects and screenshot-carousel CSS.
- [x] Migrate all public documentation pages and community directory to the common shell and reading layout.
- [x] Replace the animated/blaming 404 page with a direct, helpful error page.
- [x] Add the design reference and durable design guide, including honest sign-in form specimens.
- [x] Verify links, theme persistence, contents navigation, copy controls, plugin discovery states, keyboard access, responsive geometry and no-JS content.
- [x] Assemble the nested dev site and verify its assets/navigation and version switcher.
- [x] Review the complete site in both themes, fix issues, record results and commit locally without pushing.

## Completion criteria

All existing website pages use the approved visual language. Homepage remains recognizably the approved version. No placeholder controls are presented as real account login. Reference page explains usage and accessible states. Long code and tables scroll within their containers; page layout does not overflow at narrow widths. Native details and navigation work without JavaScript. Browser inspection covers desktop/mobile, light/dark, focus and compact TOC behavior. Relevant tests and docs build pass, or any remaining limitation is explicitly reported.

## Verification log

### Completed implementation

- The shared stylesheet owns palette, typography, spacing, navigation, controls, forms, notices, code blocks, tables, documentation layout and responsive states. `home.css` now contains only the approved homepage composition and illustrations.
- All ten HTML pages (including the noindex reference) share these foundations. Seven technical page bodies retain their commands, warnings, forms, IDs, contents and copy targets. No screenshots were added.
- The durable design contract is `.interface-design/system.md`; `AGENTS.md` points future website work to it. Preview the reference at `/design-system`.
- The light teal and dark control boundaries were adjusted slightly for readable text and visible input boundaries, without replacing the palette.
- Intermediate-width navigation collisions were caught during browser review and fixed by moving the shared two-row header breakpoint to 800px.

### Passed checks

- `npm exec -- vitest run --config vitest.config.ts scripts/docs-site.test.mjs scripts/plugin-search.test.mjs src/docker/piWebDockerDocs.test.ts`: 45 tests passed. Covers source-page links/assets/IDs/copy targets, theme/TOC behavior, clipboard success/failure and preserved commands, plugin registry behavior and Docker installation documentation.
- `node scripts/build-docs-dev.mjs`: nine nested pages assembled. Browser checks verified all nine pages' relative assets, noindex markers, active Dev switcher, stable/development anchor retention and navigation under `/dev/`.
- Chromium: ten pages at 320, 390, 768 and 1440px in both light and dark modes (80 geometry combinations); no document overflow or unexpected page errors. Inspected desktop/mobile screenshots as local verification artifacts, not website assets.
- Header hit-target checks at 320, 390, 640, 641, 700, 768, 800, 801, 900, 901, 1100 and 1440px: no overlapping controls after the breakpoint fix.
- Native compact contents menu: open, choose section, focus destination, Escape, restore focus. Keyboard skip link and horizontal scrolling of long code/tables passed.
- No-JavaScript checks: homepage content, original contents links, fragment navigation and native disclosures remain usable.
- Plugin directory: real npm search rendered nine packages. Controlled browser responses verified results, filtering, sorting, empty search, failed registry request and retry. The deliberate HTTP 503 and the deliberately visited missing route's HTTP 404 were expected failure-path probes, not successful HTTP requests.
- Clipboard success was verified in a local secure-context browser by the reference-page work; browser denial/fallback was also verified on the private HTTP preview. The latter cannot normally use the browser clipboard API; selectable commands and fallback feedback remain available.
- Representative WCAG contrast checks passed for body/muted text, accent text, filled primary controls and input borders in both themes. The final light accent also exceeds 4.5:1 on inset/code surfaces.
- `git diff --check` passed after fixing a trailing blank line.

### Verification boundaries

- WebKit/iPhone-profile startup was attempted but blocked by missing container libraries (`libicudata.so.74`, `libicui18n.so.74`, `libicuuc.so.74`, `libxml2.so.2`). Safari rendering is unverified; Chromium device-size checks are not a substitute for that engine.
- This is a website-only change. Full application typecheck/build, runtime smoke and application component browser suites were not run because no application/runtime or package-delivery code changed.
- The sign-in specimen is intentionally inert. Real Safe Tunnels login adoption remains work in its owning repository/service, not a completed authentication UI migration.
- The existing dev-build contract keeps its root 404 page's absolute links/assets pointing at the stable site. No deployment routing contract or public service was changed.

### Preview operation

The `pi-web-homepage-preview` Docker container serves the worktree's `docs/` read-only, bound only to `100.120.152.255:8520`. Its independent helper is `/home/core/.local/share/pi-web-previews/homepage/server.py`. It supports extensionless URLs, the generated `/dev/` preview, no-cache/noindex headers and the designed error page with a real HTTP 404. Only this preview container was restarted; PI WEB's session daemon and web services were not restarted. Stop the preview with `docker stop pi-web-homepage-preview` when it is no longer needed. Nothing was pushed or publicly deployed.
