# Changelog

Notable changes to Pulse, newest first. Source releases are tagged `vX.Y.Z`.

## 0.1.29

- Copy custom legacy model settings to the picker on first start. Keep any saved picker selection.

## 0.1.28 (2026-11-19)

### Added

- A **Capture run model** settings section with the native provider and model picker. It stores the provider, model and reasoning level, with a "Use thread default" reset.

### Changed

- Pulse builds on Plugin SDK 0.6.132 and needs BB 0.49 or newer. The source repository continues to use `tsc` for typechecking.
- The Jev contract copy has no pinned default model. Jev chooses the model.
- Pulse drops stranded queued messages and pending retries in parallel. The reconcile pass checks running action threads in parallel.
- The Tasks settings section pauses its 30-second refresh while the page is hidden. It refreshes and resumes when the page is visible again.

### Fixed

- The quick menu and task dialog effects list all their dependencies. The task search effect no longer reads a ref in its cleanup.
- The snooze `until` input uses `z.iso.datetime()`.
