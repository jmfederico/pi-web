# PI WEB website design system

## Direction and scope

A calm reading surface for people setting up PI WEB, finding a command, or understanding where their agent work runs. Lead with the task and its next useful action. The homepage’s signature is device-independent access: agents, projects, and sessions stay on the host machine while people use whichever device suits them. Lead with access across devices, not browser disconnection, and never imply a single-session limit. Explain that process with semantic diagrams rather than simulated product screenshots. Complement the diagrams with real desktop and phone screenshots that show the workspace and conversation; example session data is acceptable and should be identified as such.

The visual world is the existing ink/navy canvas, pale reading text, muted supporting text, teal orientation/action accents, violet brand accents, and amber/red caution states. Preserve the palette across automatic, light, and dark themes; adjust contrast through shared tokens. Reject decorative gradients, animated introductions, card grids for ordinary prose, and oversized documentation heroes.

Scope: the public website under `docs/`. The application has separate primitives and theme ownership; website classes are not an app or plugin styling API.

## Tagline

Use **“Your agents. Any device.”** as the product tagline. On the homepage it closes the opening paragraph, once, with emphasis; do not repeat it below the device flow. Supporting copy distinguishes where agents run from the devices used to access them: no need to move the working environment or install PI WEB on every device. Keep the host-must-stay-on and private-access qualifications. Keep **“A web interface for your AI agents.”** as the category headline, with Pi Coding Agent named nearby.

Use both category phrases naturally: **“Web UI for Pi Coding Agent”** in the homepage title and social titles, **“web UI”** in supporting copy, and **“web interface”** in the visible headline. Do not repeat keywords throughout the page or assume search demand has been measured.

## Foundations and hierarchy

- **Type:** IBM Plex Sans for prose and controls; IBM Plex Mono for brand, code, and technical identifiers. Keep system fallbacks.
- **Hierarchy:** one `h1` per page; sequential section headings. Use weight, color, and space together. An `.overline` provides context but never substitutes for a heading.
- **Homepage:** expressive hero, roughly `clamp(3rem, 6.8vw, 5.5rem)` on wide screens, with its own narrow-screen scale. Keep that composition in `home.css`.
- **Documentation:** `h1` uses `clamp(2.2rem, 4vw, 2.9rem)`; `h2` uses `clamp(1.65rem, 2.5vw, 2rem)` (1.6rem on narrow screens); `h3` is 1.3rem (1.2rem narrow). Body is 1rem / 1.65, with a 68ch reading measure and 1120px outer content limit. Sections are substantially quieter than the homepage hero.
- **Spacing:** `--space-1` through `--space-9` are 4, 8, 12, 16, 24, 32, 48, 64, and 96px. Use 8–12px within related controls, 20–24px inside reference examples, and larger gaps between tasks. Do not stretch every section into a marketing panel.
- **Depth:** quiet surface shifts and restrained borders, not stacked shadows. Avoid a panel around every paragraph. `--radius` is 4px for controls; `--radius-panel` is 6px for panels. Larger diagram shapes belong to the illustration, not the common control system.
- **Targets:** ordinary buttons and fields are at least 48px high; compact navigation and utility controls at least 44px. Inline prose links are not standalone buttons. Do not vary targets by pointer type.

`docs/styles.css` and `docs/home.css` own these implemented values. Update this guide and the reference when the shared contract changes.

## Semantic theme tokens

Use the shared tokens, never a private palette or hardcoded per-page color:

| Role | Shared token family |
| --- | --- |
| Canvas and quiet inset background | `--bg`, `--bg-soft` |
| Contained surface and stronger surface | `--panel`, `--panel-strong` |
| Primary, supporting, and tertiary text | `--text`, `--muted`, `--muted-2` |
| Ordinary and emphasized boundary | `--line`, `--line-bright` |
| Interactive control boundary | `--control-border` |
| Brand identity and action/orientation accent | `--brand`, `--brand-2` |
| Caution and danger | `--brand-3`, `--danger` |
| Foreground on a filled accent control | `--on-accent` |
| Warning, danger, and success surfaces | `--warning-bg`, `--danger-bg`, `--success-bg` |
| Modal backdrop | `--backdrop` |

Shared sizing and typography use `--font-sans`, `--font-mono`, `--space-1` through `--space-9`, `--radius`, `--radius-panel`, `--control-height`, `--compact-control-height`, `--content-width`, and `--reading-width`.

Token roles stay stable when their values change between themes. The light action accent is `#00736b`, darker than the bright dark-mode teal so small accent text remains readable even on inset/code surfaces. `--control-border` keeps input and secondary-action boundaries distinguishable without brightening decorative separators. Check contrast against the actual surface. Status classes own their semantic colors; callers must not select arbitrary brand colors for success or error.

Automatic mode follows the OS until an explicit preference is chosen. Reuse the early theme initialization and `site.js` theme control; do not create a second preference store.

## Shared styles versus composition

`docs/styles.css` owns tokens, typography, native controls, site navigation/footer, documentation layout, reference patterns, and responsive behavior. `docs/home.css` owns only homepage composition and process/device illustrations. A page should not need `home.css` merely to obtain a button or navigation treatment.

| Pattern | Markup contract |
| --- | --- |
| Site shell | `.site-header`, `.nav`, `.site-footer` with named native navigation, relative page links, and a skip link |
| Documentation | `.page-hero`, `.doc-layout`, `.toc`, `.doc-content`; `.section.compact` supplies content-to-footer spacing; retain stable section IDs |
| Action | `button.button` for behavior; `a.button` for navigation; add `.primary` for the main action |
| Supporting destination | `a.text-link` with a real destination |
| Field | `.field` containing a visible `label`, native input, and `.field-help` or `.field-error` |
| Form composition | `.form-stack`, `.form-actions`, `.form-panel`; these styles do not implement submission |
| Pattern reference | `.pattern-grid`, `.pattern-preview`; use sparingly, not as general prose cards |
| Feedback | `.status-notice`, optionally `.status-notice--error` or `.status-notice--success` |
| Documentation caution | `.callout.warning` or `.callout.danger`, with explicit severity and consequence in text |
| Code | `.code-card`, `.copy-row`, native `.copy-button[data-copy]`, selectable `pre > code` with a unique target ID |
| Disclosure | Native `details.config-details > summary`, followed by optional content |

The shared header switches to two rows at 800px, before its links can collide with actions. Documentation navigation wraps at 640px. Section contents stay in an unboxed sticky rail above 1100px; below that, the existing native dialog replaces the rail only when JavaScript is available. Without JavaScript, the original contents links remain visible.

Reuse `site.js` for clipboard feedback, theme cycling, version-anchor preservation, and compact contents navigation. Page-specific composition owns order, grouping, and meaning; shared styles own control size, surface, focus, hover, active, and disabled appearance. Extract a repeated treatment centrally rather than copying declarations into each page.

Ordinary site links and assets are relative so stable and nested dev deployments share the same source. The stable/dev footer links are intentionally canonical absolute cross-deployment URLs. Preserve `data-version-option="stable"` / `"dev"` and source `aria-current="true"` on Stable; the dev build flips the active option. The reference remains `noindex` and is not added to the sitemap.

## Accessibility and states

- Use native semantics first: buttons, links, labeled inputs, and details. Keep DOM order aligned with reading and keyboard order.
- Focus is a real `:focus-visible` state, not a permanently painted demonstration. Keep the ring visible outside control bounds and clear of sticky elements.
- Use native `disabled` for unavailable buttons/inputs. An unavailable destination must not have a working `href`; `aria-disabled` alone does not prevent navigation.
- Associate help/error text through `aria-describedby`; use `aria-invalid="true"` for invalid fields. Keep labels visible rather than relying on placeholders.
- Pair status color with words. Static reference notices need no live region; real nonurgent updates can use `role="status"`, urgent errors `role="alert"`. Busy operations need a text label and appropriate `aria-busy`, not animation alone.
- Preserve readable contrast in both themes, including muted text, field boundaries, and focus. Honor reduced motion. Never hide core content behind animation or JavaScript.
- Code and tables may scroll inside their containers; the whole page must not overflow. Native contents links and disclosures remain usable without JavaScript. Copy failures retain selectable code and clear fallback guidance.

## Sign-in specimen: external ownership

`docs/design-system.html#sign-in-pattern` demonstrates transferable layout and idle/error/busy states. It is **not a sign-in page**. This repository has no standalone website account-login flow. Separate Safe Tunnels services own their authentication experience; PI WEB’s in-app provider authorization dialog serves a different purpose.

Keep the visible label **“Design example — not a sign-in page”**. Use fixed example values in read-only or disabled native inputs, disabled `type="button"` actions, and no form submission, authentication handler, or credential collection. Do not add fake recovery links. Small error/busy snippets are enough; do not repeat a full form for every state.

An external service adopting the pattern owns validation, accessible error focus, password-manager integration, recovery routes, security controls, and real request behavior. This reference grants no authority to change that service.

## Adoption and review

1. Start from the shell and a task-appropriate layout, not a blank stylesheet.
2. Preserve technical commands, security warnings, anchors, clipboard targets, and deployment routing while changing presentation.
3. Use `docs/design-system.html` to inspect shared controls in both themes. Verify actual keyboard focus, disabled states, copy success/failure, and native disclosure behavior.
4. Review desktop and narrow widths, zoom, long code, and no-JavaScript content in a browser. Check the nested dev build and version switching as well as source pages.
5. Use real screenshots to demonstrate the interface, and small semantic diagrams to explain processes. Homepage screenshots use PI WEB Light or PI WEB Dark to match the page's effective theme, including OS changes in Auto mode; full-size links must open the matching image. Keep the preview static, without autoplay or separate screenshot theme controls. Use named demo models, never an unresolved model label. Browser screenshots may also be used for visual verification without shipping them on the site.

Follow `docs/testing.md` and `docs/development-checks.md` for verification. Record results separately from this durable contract; a design guideline is not evidence that a browser check passed.
