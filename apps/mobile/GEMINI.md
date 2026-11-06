# Mobile Design Engineering & Polish Rules

When building or modifying UI components in `apps/mobile`:

## 1. Animation Performance (60fps/120fps WebView Rule)
- NEVER animate layout properties: `width`, `height`, `top`, `left`, `margin`, `padding`, or `border-width` (use `transform: scaleX()` / `scaleY()` for progress bars and indicators).
- Animate spatial motion and entrances/exits exclusively with GPU-accelerated properties: `transform` (translate, scale, rotate) and `opacity`. Lightweight paint transitions (`background-color`, `border-color`, `color`) are permitted for control state feedback.
- Use `will-change: transform, opacity` sparingly on actively animated containers, removing it when idle.
- Never use `transition: all` or bare `transition: var(--transition-fast)` without explicit property names. Always declare explicit transition properties.

## 2. Easing & Timing Curves
- Default Entrance: `cubic-bezier(0.16, 1, 0.3, 1)` (snappy ease-out, fast entrance with gradual deceleration).
- Default Exit: `cubic-bezier(0.7, 0, 0.84, 0)` or standard `ease-in` (swift exit, 150ms).
- Durations:
  - Micro-interactions (taps, icon toggles, badges): `100ms - 150ms`.
  - Floating panels, toasts, dialogs: `200ms - 250ms`.
  - Bottom sheets (`DevicesSheet`): `280ms - 320ms`.
- Respect `prefers-reduced-motion` for accessibility.

## 3. Tactile Mobile Feedback
- Every button, card, and row must have a responsive `:active` state.
- Button press feedback: `transform: scale(0.97)` on active with `transition: transform 100ms ease`.
- Ensure `-webkit-tap-highlight-color: transparent` and `user-select: none` on interactive controls.
- Minimum touch target for any interactive element is 44×44px.

## 4. Transform Origins
- Popovers, menus, and context sheets must open from their trigger point or screen anchor, never default to `transform-origin: center center`.
- Bottom sheets must anchor to `transform-origin: bottom center`.

## 5. Visual Polish (Obsidian + Lavender)
- Avoid harsh 1px solid borders; use subtle alpha borders (`rgba(255, 255, 255, 0.08)` or token `--border-subtle`).
- Layer surfaces using depth (`--surface`, `--surface-secondary`, `--surface-elevated`) rather than heavy blurred drop shadows that lag the GPU.

## 6. User Experience (UX) Engineering

### User-centred design
- Design every flow around the user's immediate goal (connecting to a peer, sending a file/text, or opening a received item) rather than exposing internal protocol states (raw sockets, chunk indices, or WebView quirks).
- Speak in plain, human-centred language: translate technical or platform errors into clear explanations of what happened and what the user can do next.
- Respect platform reality across Android/Capacitor vs Desktop Web:
  - Hide desktop-only controls (`webkitdirectory` folder inputs and `Ctrl + Enter` shortcut hints) on native Android (`Capacitor.isNativePlatform()`) and mobile coarse-pointer devices (`(pointer: coarse)`), while keeping them available on desktop browsers.
  - Tailor camera/permission guidance to the active runtime (Android App Settings on native Capacitor vs browser permission settings on web).
- Tailor actions to item direction and context: do not display redundant "Save to device" primary actions on files the user just sent from the same device unless explicitly requested via secondary menu.

### User journey and interaction design
- Maintain a frictionless, predictable path from **Discovery → Pairing → Selection → Transfer → Completion**:
  - Every entry point to "Add device" (whether from standby, multi-device list, or `DevicesSheet`) must give access to all pairing methods (automatic Wi-Fi discovery, QR scanner, and manual IP/port entry).
  - Never trap the user in a single-mode dead end (e.g., forcing QR camera only when all paired devices are offline).
- Keep all bottom sheets and modals consistent in dismissal behaviour: if a sheet renders a drag handle (`.sheet-drag-handle`), it must support touch swipe-to-dismiss in addition to backdrop tap and the Android hardware back button.
- Ensure filter and navigation controls reflect the active context accurately (e.g., `All` / `Received` / `Sent` badge counts must respect the currently selected device filter).

### System feedback and UI states
- Every asynchronous action must provide immediate, persistent, in-context feedback until resolved:
  - **Discovery & Pairing**: When waiting for desktop approval (`pairWithApproval`), display a persistent in-card or in-screen status ("Waiting for approval on <Device Name>…") with an explicit **Cancel** action—never rely solely on a transient toast that disappears while the request is still pending.
  - **Loading & Queued States**: Distinguish clearly between *Connecting*, *Waiting for peer approval*, *Queued*, *Paused*, and *Transferring* (with tabular progress percentage, transfer rate, and ETA).
  - **Empty States**: Provide contextual empty states that explain why a list is empty (distinguishing empty workspace vs active direction/device filters) and offer a direct recovery action (e.g., resetting filters or sending the first file).
  - **New Activity Visibility**: When new transfers arrive or start while the user is scrolled away or viewing a long stream, ensure the item is either scrolled into view or surfaced via a non-intrusive indicator.

### Error prevention and recovery
- Guard destructive or high-cost actions against accidental taps with proportionality:
  - **In-flight or bulk destructive actions** ("Cancel All" batch uploads, cancelling or deleting an actively transferring/queued/paused item, clearing all history, or unpairing a device) must require explicit confirmation via `ConfirmationDialog`.
  - **Single completed/failed history item removal** should provide an immediate **Undo** action toast (deferring permanent cache/blob deletion until the undo window expires) or confirmation, avoiding modal fatigue while preventing accidental loss.
  - Physically separate destructive controls (`Cancel`, `Delete`) from high-frequency safe controls (`Pause`/`Resume`, `Save`, `Copy`, `Prioritize`) with sufficient spacing so adjacent touch targets never overlap.
- Make every error state actionable: pair failure messages (connection timeout, rejected pairing, interrupted transfer, camera failure) with a direct recovery button (`Retry`, `Scan QR instead`, `Enter IP manually`, or `Reset filters`).

### Cognitive load and information hierarchy
- Prioritise primary user intent per screen:
  - **Disconnected / Standby**: Focus on reconnecting to known peers or discovering nearby devices, keeping manual IP/port diagnostics progressively disclosed.
  - **Connected Workspace**: Keep the peer switcher header, transfer activity stream, and bottom action dock visually distinct using Obsidian + Lavender surface tokens (`--surface`, `--surface-secondary`, `--surface-elevated`).
- Avoid redundant badges, competing status labels, or duplicate CSS rules across component-scoped `<style>` blocks that cause inconsistent visual states.
- Group related actions cleanly: each transfer card should have one clear primary action (`Save` / `Open` for received files, `Copy` for text, `Accept` for pending approvals) and well-spaced secondary controls.

### Accessibility and usability
- Enforce the `44×44px` minimum touch target across all interactive controls, including inline progress buttons (`Pause`, `Resume`, `Cancel`, `Prioritize`), card icon buttons, and incoming transfer approval buttons (`Accept`, `Decline`, `Always Trust`).
- Ensure expanded hit areas (`::after` pseudo-elements) never overlap adjacent interactive elements—maintain at least `44px` center-to-center spacing or match hit expansion to the inter-button gap.
- Keep `aria-live` containers (`ToastContainer`, status banners) persistently mounted in the DOM so screen readers reliably announce dynamically injected status and alert messages (`role="status"`, `role="alert"`).
- Maintain full Android hardware back-button stack compliance (`backButtonManager`) without duplicate `Escape` listeners or unstable `useEffect` dependencies, trap and restore focus in modals, and enforce `@media (prefers-reduced-motion: reduce)` across all views.

### P2P-specific UX requirements
- **Multi-Peer Clarity**: Always make it unmistakable which peer is currently targeted for sending or filtering (including inside `SendTextModal` and `TransferActionPanel`), and use the multi-peer picker (`DevicesSheet` in `'pick'` mode) whenever an OS share-sheet intent arrives with multiple connected peers.
- **Network & Firewall Transparency**: Detect and explain local network obstacles (Wi-Fi client isolation on public/campus networks, subnet mismatches, stale mDNS sightings) in plain language with actionable guidance (e.g., switching to mobile hotspot or scanning a fresh QR code).
- **Resilient Chunk-Level Continuity**: Preserve chunk bitmaps and pending upload queues across transient disconnects, allowing users to pause, resume, prioritize, or retry transfers without losing completed progress.
- **Trust & Privacy Controls**: Surface clear sender identity, file metadata, and size before accepting untrusted incoming transfers, and protect sensitive clipboard contents from automatic background broadcast.

### UX validation
- Before considering any UI change complete, verify across mobile viewport sizes (`320px–430px` width):
  1. All interactive controls meet the `44×44px` non-overlapping touch target requirement.
  2. No destructive action (batch cancel, active transfer abort, item deletion) executes without confirmation or undo.
  3. All media and document viewers (`MediaViewer`, `AudioPlayer`, `PdfViewer`, `CodeViewer`) provide complete `Save` / `Open` / `Preview` parity across web and native Android (`Capacitor.isNativePlatform()`), while preserving O(1) memory streaming (`downloadDirectToDisk`) for large files.
  4. All animations and transitions strictly obey Sections 1–5 (no `transition: all`, GPU-accelerated motion, tactile `:active` states, and `prefers-reduced-motion` support).
  5. Automated unit/component tests (`npm --prefix ./apps/mobile test`) and production build (`npm --prefix ./apps/mobile run build`) pass with zero regressions.
