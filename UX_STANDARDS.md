# Web Application UX Standards

Build the interface according to these requirements unless the product specification explicitly overrides them.

This document is written for an AI coding agent (e.g. Claude Code). Two rules govern how to use it:

1. **Tiering.** Every requirement below is tagged `[MUST]`, `[SHOULD]`, or `[SCALE]`.
   - `[MUST]` — non-negotiable regardless of project size. Skipping these requires explicit user sign-off, stated as an assumption in your completion summary.
   - `[SHOULD]` — standard best practice; skip only with a stated reason.
   - `[SCALE]` — rigor should match project stakes. A throwaway internal prototype and a customer-facing production app get different treatment. Say which tier you applied and why.
2. **Verify, don't self-report.** Wherever a check can be run with a real tool, run it. Do not mark a requirement done because it "looks right" if a tool exists to confirm it. Section "Verification tooling" at the end maps requirements to concrete commands.

## Project discovery (do this first, before writing code)

- `[MUST]` Scan the repo for an existing design system before creating one: look for a `tokens`/`theme` file, a component library (`/components`, `/ui`), a Tailwind/CSS config, or a `STYLEGUIDE.md`. If found, extend it — do not introduce a parallel system.
- `[MUST]` Identify the framework/stack already in use (React, Vue, plain HTML, meta-framework) from `package.json` and existing files. Match it; do not introduce a second framework or state-management library without asking.
- `[SHOULD]` Note the primary users, their main task, supported devices, and success criteria for the screen being built. If genuinely ambiguous and the choice materially affects the product, ask rather than inventing behavior.
- `[SHOULD]` List the principal user flows and all associated states (loading, empty, error, success, offline, permission-denied) before writing components.

## Product and information architecture

- `[MUST]` Optimize each screen around one clear primary user goal.
- `[MUST]` Use familiar terminology from the user's domain; avoid internal technical language.
- `[SHOULD]` Keep navigation predictable and persistent where appropriate.
- `[MUST]` Make the primary action visually obvious, with secondary actions clearly subordinate.
- `[SHOULD]` Prefer recognition over recall: expose relevant choices, context, and recent information.
- `[MUST]` Do not add features, fields, navigation items, or decorative sections without a user need.
- `[MUST]` Preserve entered data and user progress whenever reasonably possible.

## Layout and visual hierarchy

- `[MUST]` Design mobile-first and support phones, tablets, laptops, and large displays.
- `[MUST]` Use a consistent spacing system, type scale, color palette, border treatment, and component language (reuse the discovered design system).
- `[SHOULD]` Keep readable content to approximately 45–75 characters per line for long-form text.
- `[SHOULD]` Use headings in a logical hierarchy; group related content through spacing and alignment.
- `[SCALE]` Avoid excessive cards, nested containers, gradients, shadows, animations, and decorative clutter — apply more strictly as the product moves toward production polish.
- `[MUST]` Never rely on color alone to communicate meaning.
- `[MUST]` Prevent horizontal page scrolling at supported viewport sizes.
- `[MUST]` Ensure zooming to 200% does not hide content or functionality.

## Interaction

- `[MUST]` Use standard controls and established interaction patterns before inventing custom ones.
- `[MUST]` Every interactive element must have clear default, hover, focus, active, disabled, loading, success, and error states where applicable.
- `[MUST]` Use buttons for actions and links for navigation.
- `[SHOULD]` Make the entire visible control target clickable.
- `[MUST]` Use at least 24×24 CSS-pixel pointer targets; prefer approximately 44×44 for important or frequently used controls.
- `[MUST]` Never place destructive actions as the default or most visually prominent choice.
- `[MUST]` Confirm irreversible actions or provide an effective undo mechanism.
- `[MUST]` Do not trigger unexpected navigation or major state changes merely from focus, selection, or typing.
- `[SHOULD]` Preserve scroll position and context when users return from a detail view where appropriate.

## Feedback and system status

- `[MUST]` Provide immediate feedback after every user action.
- `[MUST]` For operations taking noticeable time, show a meaningful loading or progress state.
- `[MUST]` Disable duplicate submissions while an operation is pending.
- `[SHOULD]` Use skeletons only when they resemble the final layout; otherwise use a simple progress indicator.
- `[MUST]` Clearly distinguish empty, loading, partial, error, offline, permission-denied, and success states.
- `[MUST]` Explain what happened and what the user can do next.
- `[MUST]` Do not show a success message until the operation has actually succeeded.

## Forms

- `[MUST]` Give every field a persistent visible label; placeholders are examples or hints, not labels.
- `[MUST]` Request only information necessary for the task.
- `[MUST]` Use appropriate input types, autocomplete attributes, and mobile keyboards.
- `[MUST]` Indicate required and optional fields consistently.
- `[SHOULD]` Validate at an appropriate time without interrupting normal entry.
- `[MUST]` Put errors next to the relevant field; provide an error summary for long forms.
- `[MUST]` Error messages must identify the problem and explain how to fix it.
- `[MUST]` Preserve all valid user input after validation or server errors.
- `[MUST]` Allow passwords to be revealed and pasted.
- `[SHOULD]` Do not block submission solely because formatting differs when input can be normalized safely.

## Accessibility

- `[MUST]` Meet WCAG 2.2 Level AA.
- `[MUST]` Use semantic HTML before ARIA; add ARIA only when native HTML cannot express the required behavior.
- `[MUST]` Ensure all functionality works with a keyboard alone.
- `[MUST]` Provide a logical tab order and a clearly visible focus indicator.
- `[MUST]` Move and restore focus intentionally for dialogs, menus, errors, and route changes.
- `[MUST]` Give controls accessible names that agree with their visible labels.
- `[MUST]` Provide text alternatives for meaningful images and empty alt text for decorative images.
- `[SHOULD]` Provide captions or transcripts for meaningful prerecorded media as required.
- `[MUST]` Meet contrast requirements: at least 4.5:1 for normal text, 3:1 for large text and essential interface graphics.
- `[MUST]` Respect `prefers-reduced-motion`; avoid flashing, autoplay, and unnecessary motion.
- `[MUST]` Use correctly implemented accessible patterns for dialogs, tabs, menus, comboboxes, and other composite widgets (follow WAI-ARIA Authoring Practices Guide patterns, don't invent your own).
- `[MUST]` Announce important asynchronous status changes to assistive technology without stealing focus (use `aria-live` regions appropriately).

## Content

- `[MUST]` Use concise, specific labels such as "Save changes" rather than "Submit."
- `[MUST]` Front-load important information and use plain language.
- `[MUST]` Write actionable error and empty-state messages.
- `[MUST]` Avoid ambiguous icon-only actions; provide visible labels or accessible names and tooltips where useful.
- `[SCALE]` Format dates, times, currencies, names, and addresses for the user's locale — required if the product has or will have non-US/multi-locale users; otherwise note as a known limitation.
- `[MUST]` Do not use manipulative language, hidden costs, preselected consent, or other dark patterns.

## Internationalization and content resilience

- `[SCALE]` If the product is or will be localized, externalize strings (no hardcoded UI text in components) rather than retrofitting later.
- `[MUST]` Layouts must not break with long translated strings, RTL languages (if in scope), or unusually long/short user-generated content.
- `[SHOULD]` Truncate or wrap long content predictably rather than letting it overflow or clip silently.

## Responsive behavior

- `[MUST]` Prioritize essential content and actions on small screens instead of merely shrinking the desktop layout.
- `[SHOULD]` Let content determine breakpoints.
- `[MUST]` Reflow tables thoughtfully; do not make critical data inaccessible on mobile.
- `[MUST]` Keep primary actions reachable without covering content.
- `[MUST]` Account for long translations, dynamic content, browser zoom, notches, and on-screen keyboards.
- `[MUST]` Do not make hover the only way to reveal essential information or actions.

## Performance and resilience

- `[SCALE]` Target real-user Core Web Vitals at the 75th percentile — enforce strictly for production; treat as directional for prototypes:
  - LCP ≤ 2.5 seconds
  - INP ≤ 200 milliseconds
  - CLS ≤ 0.1
- `[MUST]` Reserve layout space for images, embeds, and asynchronously loaded content.
- `[SHOULD]` Optimize and lazy-load noncritical media.
- `[SHOULD]` Avoid unnecessary dependencies, client-side JavaScript, and blocking requests.
- `[MUST]` Support slow connections, delayed responses, empty datasets, long content, and failed requests — build these states, don't assume the happy path.
- `[SHOULD]` Prevent accidental data loss on refresh, navigation, timeout, or interrupted connectivity when practical.

## Error handling and resilience patterns

- `[MUST]` Wrap route-level or major feature boundaries in error boundaries (React) or equivalent, so one component failure doesn't blank the whole page.
- `[MUST]` Network/API failures must show a retry path, not just a dead end.
- `[SHOULD]` Log errors in a way that aids debugging without exposing stack traces or internals to the end user.

## Privacy and security UX

- `[MUST]` Collect the minimum personal information necessary.
- `[MUST]` Explain why sensitive information or permissions are requested before requesting them.
- `[MUST]` Never expose secrets, personal data, or sensitive values in URLs, logs, notifications, or error messages.
- `[MUST]` Provide clear session-expiration behavior without silently discarding work.
- `[MUST]` Make consent choices understandable, equivalent, and reversible.
- `[MUST]` Do not imply that a sensitive operation succeeded before server confirmation.

## Testing strategy

- `[SCALE]` Unit tests for business logic (validation, calculations, state transitions) — expected even for small projects if logic is nontrivial.
- `[SCALE]` Integration/component tests for critical user flows (checkout, auth, data submission) — required for production; optional for prototypes, but note the gap.
- `[MUST]` At minimum, manually exercise each flow's happy path, error path, and empty state before declaring it done.

## Implementation process

Before implementation:

1. Complete "Project discovery" above.
2. List the principal user flows and all associated states.
3. State which tier (prototype / production) you're building to, since this determines how strictly `[SCALE]` items apply.
4. If requirements are genuinely ambiguous and the choice materially affects the product, ask rather than inventing behavior.

During implementation:

1. Build semantic structure and keyboard behavior first.
2. Implement responsive layout and all relevant states.
3. Keep business logic separate from presentation.
4. Avoid changing unrelated styles, components, or workflows.
5. Use realistic content and edge cases rather than only ideal placeholder data.

## Verification tooling

Run these rather than eyeballing compliance. If a tool isn't available in the environment, say so explicitly in the completion summary instead of silently skipping the check.

| Requirement area | Tool / method |
|---|---|
| Accessibility (WCAG, ARIA, contrast) | `axe-core` (via `@axe-core/cli` or `jest-axe`), or Lighthouse accessibility audit |
| Keyboard-only operation | Manual pass: Tab/Shift+Tab/Enter/Escape/Arrow keys through every flow |
| Color contrast | Computed via axe-core, or a contrast checker against actual rendered CSS values |
| Core Web Vitals (LCP/INP/CLS) | Lighthouse CI or `web-vitals` library in a real browser session |
| Linting for a11y regressions | `eslint-plugin-jsx-a11y` (React) or framework equivalent, wired into lint step |
| Responsive breakpoints | Render/screenshot at defined breakpoints (e.g. 360px, 768px, 1024px, 1440px) |
| `prefers-reduced-motion` | Toggle the OS/browser setting and confirm animations are suppressed |
| No console errors | Check browser console / test runner output during manual pass |
| Duplicate submission / race conditions | Manually double-click submit buttons during pending state |

## Before declaring the work complete, verify

- Primary flows work at mobile and desktop widths.
- Keyboard-only operation works from beginning to end.
- Focus remains visible and moves correctly.
- Forms, dialogs, menus, and destructive actions behave safely.
- Loading, empty, error, success, offline, and permission states are covered where applicable.
- Long text, missing content, large datasets, and slow or failed requests do not break the interface.
- Automated accessibility checks pass (via the tools above), followed by a manual keyboard and screen-reader spot check.
- No obvious layout shifts, duplicate submissions, inaccessible controls, or browser-console errors remain.

## Completion report format

When reporting completion, state:

1. **Tier applied** (prototype / production) and why.
2. User flows implemented.
3. Accessibility considerations and which automated checks were actually run (name the tool and result, not just "checked").
4. Responsive behavior and breakpoints tested.
5. States covered (loading/empty/error/success/offline/permission-denied).
6. Tests performed, including which were automated vs. manual.
7. Any `[MUST]` items skipped, with reason — this should be rare and flagged prominently, not buried.
8. Any `[SCALE]` items deliberately deferred given the project tier.
9. Remaining assumptions or limitations.
