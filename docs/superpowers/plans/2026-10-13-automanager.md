# Automanager Implementation Plan

> **For agentic workers:** Use superpowers:executing-plans or superpowers:subagent-driven-development. Steps use checkboxes. The user explicitly requires continuous execution without approval questions; design and plan approval gates are overridden by that instruction.

**Goal:** Build a working Electron/TypeScript tracker with background steps/screenshots/audio capture, independent WAV chunks, local speech engines, Korean UI, scheduling, recovery and export.

**Architecture:** Electron main supervises capture and OS workers. A single SQLite/file worker owns durable state. Inference workers use persistent queues and local engines. React communicates through a validated preload API.

**Tech Stack:** Electron, electron-vite, TypeScript, React, Node SQLite, Vitest, Playwright, whisper.cpp, MeloTTS, sherpa-onnx.

**Spec:** `docs/superpowers/specs/2026-10-13-automanager-design.md`

## Global Constraints

- Use the existing isolated `/workspace/automanager` checkout; do not create a worktree.
- Supported Windows target is Windows 10/11 x64; Linux checks do not establish Windows readiness.
- Capture is explicitly started and has visible tray controls. No ordinary typed text, clipboard contents or password values are logged.
- Audio is continuous 16 kHz mono PCM, independently playable WAV chunks; default 30 seconds; pause and stop flush partial chunks.
- File/database writes have one owner. Generations prevent late inference results from reviving deleted data.
- TLS/checksum verification stays enabled. Models and engines show actual installation/error state.
- Capture and inference are separate; bounded queues, storage reserve, fail-visible overload.
- UI is Korean, has actual empty states, accessible controls and no fabricated recording history.

## Review Focus

1. Pause/stop during an outstanding audio write must preserve every acknowledged sample.
2. Engine results after delete/cancel must not restore a session or duplicate transcript.
3. A click that changes focus must not borrow the next foreground window's identity.
4. Offline synthesis requires all tokenizer/G2P assets, not just model weights.
5. Failed downloads, exhausted disk and inaccessible capture must remain explicit errors.

### Task 1: Contracts and application toolchain

**Files:** package/config files, `src/shared/types.ts`, `src/shared/validation.ts`.
**Interfaces:** all workers and UI consume `DesktopAPI`, `AppSnapshot`, `SessionDetail`, `Settings`, `StoreAPI` from the shared types file.
- [x] Define complete typed contracts and write payload-validation rejection tests.
- [x] Install pinned dependencies and verify test/typecheck commands execute.
- [x] Build main/preload/renderer inputs and packaging configuration.

### Task 2: Durable sessions, PCM, recovery and export

**Files:** `src/storage/*`, `src/workers/store-worker.ts`, `tests/storage.test.ts`.
**Interfaces:** `TrackerStore` implements `StoreAPI`; worker delegates serialized calls.
- [x] RED: temp DB tests for session transitions, 30s WAV partitioning, pause partial flush, text-only steps, screenshot retention, recovery, cancel/delete generation and export.
- [x] GREEN: SQLite migrations, transactional state, fsync/rename files, chunk journal recovery, settings, schedules, MHTML/HTML/ZIP export.
- [x] Verify real WAV headers/sample counts, persistence across reopening and archive content.

### Task 3: OS steps capture

**Files:** `src/platform/*`, `native/windows-context/*`, platform tests.
**Interfaces:** `createActionRecorder(options)` emits `RecordedAction` and exposes start/stop/capabilities.
- [x] RED: input normalization excludes typed characters; drag/shortcut handling and stale context identity tests.
- [x] GREEN: global hook in owned process, Windows native foreground/UI Automation adapter, timeout handling, capability reporting.
- [x] Provide target-OS build command and honest Windows verification checklist.

### Task 4: Speech engines and model provisioning

**Files:** `src/engines/*`, `resources/engines/*`, `scripts/setup-engines.*`, engine tests.
**Interfaces:** `EngineManager` consumes `StoreAPI`, emits changes, supports models/install/import/transcribe/synthesize/cancel/retry/dispose.
- [x] RED: pinned model integrity, failed install status, queued job cancellation/deletion and real process failure tests.
- [x] GREEN: whisper worker, Korean Melo resident worker, sherpa/Kokoro worker, verified model installation, bounded durable jobs.
- [x] Run actual STT/TTS samples where current machine can install assets; report blocked models explicitly.

### Task 5: Capture and Electron lifecycle

**Files:** `src/main/*`, `src/preload/*`, `src/capture/*`.
- [x] RED: session transitions, scheduling, screenshot coordinate mapping and pause/stop drain tests.
- [x] GREEN: dedicated AudioWorklet capture renderer, display streams, screenshot requests, tray, global shortcuts, power/suspend gaps, permission handling and safe asset protocol.
- [x] Wire store and engines through narrow validated IPC; verify hidden-window recording lifecycle.

### Task 6: Korean desktop UI

**Files:** `src/renderer/*`, `index.html`, UI tests.
**Interfaces:** UI uses only `window.automanager: DesktopAPI`.
- [x] RED: empty library/start session, session navigation, comments, filters, settings and synthesis controls.
- [x] GREEN: polished responsive overview, library/detail timeline, transcription queue, voice studio, schedules and settings; assets/playback/export.
- [x] Verify every button acts on real APIs and errors are visible.

### Task 7: Integration, packaging and documentation

**Files:** README, environment scripts/startup instructions, smoke tests, packaging resources.
- [x] Run test suite/typecheck/production build and real Electron smoke in this machine.
- [x] Capture UI screenshots and correct visual/interaction defects.
- [x] Run fresh-context code review, fix consequential findings and rerun affected checks.
- [x] Prepare installable artifacts, document Windows build/capture tests and model licensing. Commit final app.

## Progress

Plan interfaces are centralized in `src/shared/types.ts`. Independent implementation agents own separate directories; coordinator owns configuration and integration. This uses parallel work under the developer's delegation instruction while preserving one file owner.

Implemented all seven tasks. Current-instance validation, review fixes, portable engine checks and Linux package preparation are recorded in `docs/VALIDATION.md`. Windows build/execution remains unrun; the target-native MSVC workflow and manual checks are provided rather than reporting those as passed. No external push or publication was performed.
