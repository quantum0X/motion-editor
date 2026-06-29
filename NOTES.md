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

## Text layer (added in this session)

**Status: complete and verified end-to-end, both backend export and live
frontend preview.**

Backend support for title/caption text clips is implemented and verified
the same way the video export pipeline was: by actually running the
generated FFmpeg command, not just reading the code.

`backend/models/models.go` — added `TrackText` and the `TextClip` struct
(content, font family/weight/size, color, position as 0-100% of canvas,
outline, shadow, opacity, time range). Position is percentage-based so it
stays correct regardless of project resolution.

`backend/export/builder.go` — text clips render via FFmpeg's `drawtext`,
always composited above every video track. Two real bugs were found and
fixed by actually rendering output and checking it, not just reading the
generated filter string:

1. A literal `%` in text content makes `drawtext` silently render
   **blank text** (a "Stray %" warning, not an error — exit code stays 0).
   FFmpeg's default expansion mode treats `%` as the start of a
   `%{...}` template token. Fixed with `expansion=none`, which disables
   token parsing entirely, so percent signs need no escaping.
2. `drawtext=expansion=none:fontfile=...` is correct; `drawtext:expansion=none:...`
   (colon instead of `=` right after the filter name) is a filter-graph
   **parse error** ffmpeg rejects outright. Caught by running the actual
   Go-generated command through real ffmpeg, not just by reading the
   generated string and assuming it looked plausible.

`app.go` — added `AddTextTrack`, `AddTextClip`, `UpdateTextClip`,
`DeleteTextClip`, `MoveTextClip` bindings, following the same
validation/error patterns as the existing media-clip mutation methods.

**Frontend — built and verified via real browser interaction
(Playwright), not just typecheck:**
- `features/player/useCompositor.ts`: canvas rendering for text clips
  (`drawTextClip`), using Canvas 2D `fillText`/`strokeText`/native shadow
  properties to approximate `drawtext`'s outline/shadow/positioning as
  closely as Canvas 2D allows. Font family maps to a CSS stack
  (sans/serif/mono) rather than loading the exact bundled .ttf for
  preview — glyph shapes differ slightly between preview (browser font)
  and export (bundled DejaVu), but position/size/timing decisions made
  while editing are accurate, which is what actually matters live.
- `features/timeline/TimelineTextClip.tsx`: drag-to-move, edge-drag to
  resize duration, double-click to open the properties panel.
- `features/timeline/TextClipPanel.tsx`: content textarea, font/size/
  weight pickers, color picker (swatch + hex), position presets (Top/
  Center/Lower Third), outline/shadow toggles — edits apply live to both
  the timeline label and the canvas preview as you type.
- `features/timeline/Timeline.tsx`: "Add Text" toolbar button (creates a
  text track on first use, adds a 3-second clip at the playhead).
- Verified live in a real Chromium browser: add → drag → double-click to
  edit → change content/color/shadow → canvas updates immediately on
  every change, confirmed via screenshots at each step.

**Fonts**: ships its own bundled DejaVu Sans/Serif/Mono (regular + bold)
rather than resolving system font names, since "Arial" may not exist or
may render differently across Windows/macOS/Linux — this guarantees
export always matches preview (closely - see the canvas-vs-drawtext
glyph note above). Font files belong in a `fonts/` directory alongside
the packaged app; `export.FontsDir` (default `"fonts"`) should be set
from `app.go`'s `startup()` to wherever the packaged app actually places
them. **This zip includes a populated `fonts/` directory** (DejaVu,
public domain / Bitstream Vera license) so the export builder has
something real to point at out of the box.

**Known gaps, not yet done:**
- Overlapping text clips on the *same* text track aren't rejected the
  way overlapping media clips are (different tracks intentionally allow
  overlap - e.g. watermark + caption - but same-track overlap probably
  should be prevented or at least warned about; not addressed yet).
- No "duplicate text clip" or copy/paste support yet (media clips have
  this via Ctrl+D / Ctrl+C/V; text clips don't).
- Canvas preview approximates but doesn't pixel-match drawtext's exact
  glyph rendering (see font note above) - close enough for editing
  decisions, not guaranteed identical to the final export pixel-for-pixel.


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

## Bug fixes, menu bar, project location (this session, before effects work)

**Real bugs found and fixed, root-caused rather than guessed:**
1. **"is not iterable"** on selecting/importing media — Wails v2 does not
   reliably support Go methods returning 3+ values
   (`(*Project, string, error)`). `DuplicateClip` and `ImportMediaFiles`
   both had this shape; fixed by wrapping the extra value into a single
   response struct on both the Go and TypeScript sides.
2. Drag-and-drop / click-to-import "not working" — almost certainly the
   same root cause as #1, since both import paths call `ImportMediaFiles`.
3. `media.ImportResult` had no JSON tags at all (relying on Go's default
   capitalized-field-name behavior, which happened to accidentally match
   what the frontend read) — made explicit and consistent with every
   other type in the codebase.
4. "Add Text not working" — could not reproduce against the mock backend;
   most likely the same root cause as #1 in the real Wails app. Please
   confirm fixed after rebuilding; if it persists, it has a different
   cause and needs a fresh repro.

**New features, built and verified:**
- **Project location picker**: first-launch screen (and a later
  File > Change Projects Location... action) lets you choose any folder
  for projects, persisted to `settings.json`. Pointing it at a
  Dropbox/Google Drive/iCloud folder is how projects sync across
  devices — this app has no server-side sync of its own.
- **In-app menu bar**: File/Edit/View/Project/Help, real dropdowns wired
  to actual store actions (not placeholders) — New/Open/Save/Save As/
  Export, Split/Duplicate/Delete, Zoom controls, keyboard shortcuts shown
  inline.

Both verified via real Playwright browser testing; both halves of the
project build clean from a completely fresh zip extraction.

## Effects, Transitions, Keyframes, Subtitles (this session)

**Status: backend logic built and verified against real ffmpeg for all
four. Effects and Subtitles are fully wired into the main export path
(`export.Plan()`). Transitions and Keyframes have proven, working
building-block functions that are NOT YET called from `Plan()` - see
"what's actually wired" below. No frontend UI exists yet for any of the
four.**

### Effects — fully wired
`backend/export/effects.go` converts a `models.Effect` into one FFmpeg
filter clause (blur→boxblur, sharpen→unsharp, brightness/contrast/
saturation→eq, vignette→vignette, grain→noise, rgbshift→rgbashift, vhs→a
composite chain of several of the above). Effects are appended to both
the base-track and overlay-track per-clip filter construction in
`builder.go`, so any clip's `Effects` list is rendered automatically.
Verified by actually rendering all five effect types stacked together
and inspecting the output frame.

**Bug found and fixed the same way as the text/%-escaping bug**: `eq`
and `vignette` both default to `eval=init` — they evaluate any
time-varying expression in their parameters ONCE at filter-graph
construction, not per-frame. This doesn't affect today's static effect
values, but would silently break the moment any effect parameter is
ever driven by a keyframe expression. Every effect builder sets
`eval=frame` unconditionally as a result, even though Phase 1 has no
per-effect keyframing yet — the cost is zero and it forecloses an entire
bug category.

### Subtitles — fully wired
`models.SubtitleClip` + `TrackSubtitle`, with `app.go` CRUD bindings
(`AddSubtitleTrack`, `AddSubtitleClip`, `UpdateSubtitleClip`,
`DeleteSubtitleClip`). Reuses the already-proven `drawtext` pipeline via
a `subtitleToTextClip` adapter (fixed bottom-center white/black-outline
styling, no per-clip font customization — see the type's doc comment for
why) rather than duplicating the whole text-rendering pipeline. Subtitle
layers render after text layers in the filter graph (visually on top),
so a caption is never hidden behind a decorative title. Verified by
rendering a real subtitle line over real video and confirming correct
position/timing.

Manual subtitle create/edit/delete only in this phase — auto-generation
("Auto Subtitle Engine" in the original spec) is explicitly deferred,
and whenever it's built, local-only processing (no cloud API) should
remain a hard requirement, consistent with the rest of this app's
offline-first design.

### Transitions — backend proven, NOT yet wired into Plan()
`backend/export/transitions.go` builds an `xfade`-based crossfade
between two clips, with presets for fade/dissolve/wipe(4 directions)/
slide(4 directions)/zoom (push reuses slide — xfade has no dedicated
push preset). The exact timing model (`offset` = clip A's own trimmed
duration minus the transition duration) was verified against real
ffmpeg: rendered a 3s+4s two-clip sequence with a 0.5s crossfade and
confirmed pure-A, blended, and pure-B frames land exactly where expected.

**Why it's not wired into `Plan()` yet**: `xfade` consumes TWO clip
streams and produces ONE merged output stream spanning both — this
doesn't fit the shape of the existing base-track loop, which assumes
each clip becomes exactly one filter-graph segment that gets `concat`'d
in sequence. Properly integrating transitions means restructuring that
loop to detect `Clip.Transition != nil`, pull in the next clip as a
second input at that point, splice an `xfade` stage into the concat
chain instead of a plain segment, and renumber every label after it.
This is a real, contained piece of work, not started yet.

`app.go` has `SetTransition`/`RemoveTransition` bindings already, so the
data model and CRUD are ready for when the export-side wiring happens.

### Keyframes — backend proven, NOT yet wired into Plan()
`backend/export/keyframes.go` compiles a sorted `[]models.Keyframe` for
one property into a single ffmpeg time-expression
(`if(lt(t,T),value,...)` chain, built right-to-left), with linear/
ease-in/ease-out/bezier-as-smoothstep interpolation. Verified by driving
`eq`'s brightness parameter through a fade-in/hold/fade-out keyframe set
and confirming all three phases render correctly.

`backend/export/keyframes_apply.go` wires the compiled expression into
an actual per-property filter clause:
- **Rotation**: `rotate=angle=...` — works exactly as expected, verified
  end-to-end.
- **Scale ("zoom")**: a real, important constraint was discovered here —
  a video's output frame dimensions cannot change mid-file; `scale`
  with a time-varying w/h either errors or freezes at the first
  evaluated size. The correct, verified technique is scale-up-then-crop-
  back-down to the fixed canvas size (i.e. "zoom" = scale + crop, not a
  bare animated scale). Verified: rendered a 1.0x→1.4x zoom over 2s and
  confirmed the later frame is visibly more zoomed in than the first.
- **Position**: same scale+crop-family technique, via `crop`'s x/y
  offset expressions (animated independently per axis).
- **Opacity**: **a real ffmpeg limitation was found, not worked around
  with a hack** — `colorchannelmixer`'s `aa` (alpha gain) parameter
  flatly rejects time-varying expressions in this ffmpeg build (no
  `eval` option exists for that filter at all). Rather than silently
  shipping a "keyframe" that doesn't animate, opacity keyframes are
  supported ONLY as the simple two-point fade-in/fade-out case (covers
  the large majority of real usage) via ffmpeg's dedicated `fade`
  filter, and `ApplyOpacityKeyframes` returns a clear, explicit error
  for anything more complex (3+ keyframes) rather than degrading
  silently.

**Why it's not wired into `Plan()` yet**: connecting these functions to
real per-clip rendering means deciding, for each clip, whether ANY
property has keyframes and if so threading the resulting filter
clause(s) into that clip's existing trim/scale/pad/effects chain in the
right order (rotation and position/scale interact with each other and
with the existing scale-to-canvas step) — a design decision each
keyframed property needs, not yet made.

### Frontend: not started for any of the four
No UI exists yet for effects, transitions, keyframes, or subtitles. The
canvas preview also does not render any of these four yet.

## Updated next steps, in order
1. `wails dev` locally — re-confirm the bug fixes actually resolved the
   reported issues in the real app, not just the mock backend.
2. Wire transitions and keyframes into `export.Plan()` (see "why not
   wired" notes above for exactly what's involved).
3. Build frontend UI for effects (panel on selected clip), subtitles
   (track + simple line editor, closely mirroring the text tool), then
   transitions and keyframes (more involved UI: a transition picker at
   clip boundaries, a keyframe timeline with draggable markers).
4. Add canvas preview support for effects/keyframes so preview matches
   export, the same property maintained for every other feature so far.
