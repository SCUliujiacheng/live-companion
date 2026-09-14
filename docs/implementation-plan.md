# Live Companion Implementation Plan

**Goal:** Installable Bilibili companion extension with audio plus chat context, controlled auto reply, editable API settings.
**Architecture:** Side panel controls background routing, offscreen owns media and AI lifecycle, isolated content script handles page DOM. Secrets never reach the page.
**Tech Stack:** MV3, native ES modules, Web Audio, Node test runner.
**Spec:** design.md

- [x] Core settings, policy and OpenAI-compatible transport: write meaningful native tests, run failing, implement, rerun.
- [x] Browser audio capture and B站 page adapter: WAV encoding and bounded VAD segmentation; fixture verification of DOM safety and dedup.
- [x] Chinese side panel with editable dual API settings, session-only keys by default, listening and pending states, start/pause/stop controls.
- [x] Background + offscreen integration: room binding, sender validation, permission/capture errors, cancellation, stale response prevention, send acknowledgement.
- [x] Run all native tests, load extension in isolated Chromium, exercise settings and simulated conversation without posting publicly, inspect rendered UI.
- [x] Package extension and write Chinese install/usage guide, document API compatibility and live verification limits.

User has approved program and configuration fields; no key creation or model call is performed by the build. Configuration is entered by the user at runtime.

## Verification results (2026-09-14)
- 44 / 44 Node tests passed, zero skipped, including Chromium-backed DOM fixture tests.
- Actual MV3 loading, background / offscreen messaging, missing-room start rejection, API form and narrow 320px layout verified in isolated Chromium.
- Local HTTP test provider received independent chat and transcription-model-list requests. Session storage, opt-in local keys, key removal, settings reload, and endpoint-change key reset passed.
- JavaScript syntax, manifest entry points and inline-script CSP checks passed.
- Focused review found and fixed late-send cancellation, chat blocking the transcription queue, resuming a dead capture, stop-before-click, and start/state-query races.
- No real OpenAI API request or public B站 send was made. Live audio capture from the user's real room, live DOM/account compatibility and model quality remain runtime verification steps after the user enters a key.
