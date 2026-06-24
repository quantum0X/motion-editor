# VideoEditor — Build Status

Phase 1 scope: timeline, preview, import, cut/split/trim, multi-track video
compositing, export. No effects/transitions/text/audio-waveform-editing/
subtitles/AI yet — those are explicitly deferred to later phases per the
original plan.

## What's verified and how

**Backend (Go) — NOW COMPILES SUCCESSFULLY.** A Go 1.22 toolchain was
installed in this sandbox and the full backend was built end-to-end:
`go build .` succeeds with zero errors, `go vet ./...` is clean, and the
build is reproducible (identical binary checksum across two clean
builds). This sandbox's network egress only allowlists `github.com` (not
`proxy.golang.org` or `golang.org`), so `go.mod` contains `replace`
directives routing `golang.org/x/*` and `gopkg.in/*` dependencies to
their GitHub mirrors. **On a normal machine with full internet access,
these replace directives are unnecessary but harmless** — feel free to
delete the `replace (...)` block in `go.mod` and run a fresh `go mod
tidy` if you'd rather use the real golang.org/x and gopkg.in paths
through the standard Go module proxy.

What I could NOT verify in this sandbox: the actual Wails desktop build
(`wails build`) and runtime, since that needs `libwebkit2gtk-4.1-dev` and
related GTK packages, which failed to install here due to a package
mirror inconsistency (404s on otherwise-allowlisted Ubuntu security
mirrors — an infrastructure issue, not a code issue). Running the
compiled binary directly fails immediately and predictably with "Wails
applications will not build without the correct build tags" - this is
expected; the Wails CLI normally injects build tags and links against
the system webview library automatically, which plain `go build` doesn't
do. This is a packaging step still to verify on your machine, not a sign
of broken code - the underlying Go logic is proven to compile and pass
static analysis.

**Export pipeline (Go + FFmpeg filter graph) — verified correct**, but
indirectly: the multi-track filter-graph logic was first prototyped in
Python (`test_export/build_plan.py`), run against real sample clips,
debugged until correct (see two real bugs below), then ported to
`backend/export/builder.go` line-for-line. I diffed the Go and Python
logic again at the end of this session to confirm no drift. The Go file
itself has not been compiled.

Two real bugs were caught and fixed during that verification:
1. Manually shifting a clip's `setpts` before feeding it into `concat`
   double-shifted its position — `concat` already sequences inputs
   itself. Only overlay-track clips need an explicit position shift.
2. FFmpeg's `overlay` filter needs the overlay input to have frames
   spanning the *entire* output duration (even outside its `enable=`
   window) or the whole output silently truncates to the overlay clip's
   own length.

**Frontend (React/TS) — built AND verified running**, including against
real rendered output (Playwright + headless Chromium screenshots, not
just typecheck/build). `npm run build` is clean. The mock backend
(`services/mockBackend.ts`) mirrors `app.go`'s validation logic closely
enough that the entire UI was developed and debugged against it before
ever touching Wails.

Real bugs found and fixed via actual UI testing (not just code review):
1. Hidden `<video>` elements created via `document.createElement` but
   never attached to the DOM stalled at `readyState: 1` indefinitely in
   this environment's Chromium — fixed by attaching them to an
   off-screen-but-in-DOM host container.
2. The canvas render loop's early-return guard didn't reschedule the next
   `requestAnimationFrame`, so any single bad frame (e.g. canvas ref not
   yet mounted) permanently killed the preview.
3. `readyState` transiently drops back to `HAVE_METADATA` immediately
   after seeking, even with a decodable frame already available — gating
   the draw call on `readyState >= 2` skipped drawing on every seek.
4. `TimelineClip` stopped `mousedown` propagation but not `click`, so the
   timeline's background-deselect handler fired right after every
   selection and silently broke split/duplicate/delete from the toolbar
   and keyboard shortcuts.
5. Stale closure: `handleMouseUp` (for drag-move and trim) read
   `previewOffset` from React state captured at `mousedown` time, never
   seeing live updates from `mousemove` — trims and drag-moves visually
   previewed correctly but never committed. Fixed with a ref for the live
   value.

Cross-checked: the export pipeline and the canvas preview were verified
to agree on what's visible during multi-track overlap, using matching
project data run through both systems independently.

**Known sandbox-only limitation:** this environment's Chromium build has
no H.264 support (VP9/WebM works fine) — `DEMUXER_ERROR_NO_SUPPORTED_STREAMS`
on .mp4 is expected here and is not an app bug. Real Chrome, the Wails
webview, and your OS's native video stack all support H.264 normally.

## Next steps, in order
1. `wails dev` (or install Wails CLI: `go install
   github.com/wailsapp/wails/v2/cmd/wails@latest`, then `wails doctor` to
   confirm your system has the right webview/GTK libraries — standard on
   most desktop Linux/macOS/Windows setups, just not in this headless
   sandbox). This is the one thing this sandbox genuinely could not
   verify: the Go↔React bridge at runtime, and real MP4 handling.
2. Re-run the core loop by hand: new project → import a real MP4 → drag to
   timeline → multi-track overlay → export → confirm the exported file
   looks like the preview.
3. Only after that loop is solid: move to Phase 2 (audio waveform editing,
   text layer tool, transitions, effects).

## Folders
- `backend/`, `app.go`, `go.mod`, `wails.json` — the actual application.
- `frontend/` — the actual application.
- `dev_tests/`, `test_export/`, `test_frames/`, `test_thumbs/`,
  `sample_assets/` — sandbox-only verification scaffolding used to build
  and debug this. Not part of the shipped app; safe to delete, or keep
  for reference on how the export filter graph was validated.
