// Transitions: builds an `xfade`-based crossfade between two adjacent
// clips on the same track.
//
// Timing model, verified against real ffmpeg before being encoded here
// (see project notes): given clip A (earlier) and clip B (immediately
// following it on the same track) with a Transition of DurationSec on
// A, the rendered output is:
//
//	[ A alone, for (A's own duration - DurationSec) ]
//	[ crossfade of A's tail + B's head, for DurationSec ]
//	[ B alone, for (B's own duration - DurationSec) ]
//
// xfade's own `offset` parameter is where (on its own two trimmed input
// streams, NOT the overall project timeline) the crossfade begins - it
// is NOT the same thing as the clip's TimelineStartSec. This package
// computes offset purely from the two clips' own (already-trimmed)
// durations, which is why xfade-based transitions are built as a
// distinct stage from the base-track concat chain in builder.go rather
// than folded into the per-clip filter construction there: xfade
// consumes TWO clip streams and produces ONE output stream covering
// both, which doesn't fit the one-clip-in-one-segment-out shape the
// rest of the base-track concat chain assumes.
package export

import (
	"fmt"

	"videoeditor/backend/models"
)

// xfadePresetFor maps our TransitionType + Direction onto one of
// xfade's ~58 built-in transition presets. Direction is only meaningful
// for wipe/slide; fade/dissolve/zoom ignore it.
func xfadePresetFor(t models.TransitionType, direction string) string {
	switch t {
	case models.TransitionFade:
		return "fade"
	case models.TransitionDissolve:
		return "dissolve"
	case models.TransitionZoom:
		return "zoomin"
	case models.TransitionWipe:
		switch direction {
		case "up":
			return "wipeup"
		case "down":
			return "wipedown"
		case "left":
			return "wipeleft"
		default:
			return "wiperight"
		}
	case models.TransitionSlide:
		switch direction {
		case "up":
			return "slideup"
		case "down":
			return "slidedown"
		case "left":
			return "slideleft"
		default:
			return "slideright"
		}
	case models.TransitionPush:
		// xfade has no dedicated "push" preset; slide is the closest
		// built-in equivalent (the outgoing clip is shoved off-frame by
		// the incoming one rather than fading) - revisit with a custom
		// `expr`-based transition if a true push look becomes a hard
		// requirement later.
		switch direction {
		case "up":
			return "slideup"
		case "down":
			return "slidedown"
		case "left":
			return "slideleft"
		default:
			return "slideright"
		}
	default:
		return "fade"
	}
}

// buildXfadeSegment returns the filter-graph fragment that crossfades
// clipALabel into clipBLabel using the given Transition, plus the
// output label the caller should chain forward from. clipADuration and
// clipBDuration are each clip's OWN rendered duration (SourceOutSec -
// SourceInSec / Speed) - the offset calculation below depends on
// knowing exactly how long clip A's trimmed stream is before any
// crossfade is applied to it.
func buildXfadeSegment(clipALabel, clipBLabel string, clipADuration float64, transition models.Transition, outLabel string) (string, error) {
	if transition.DurationSec <= 0 {
		return "", fmt.Errorf("transition duration must be positive")
	}
	if transition.DurationSec >= clipADuration {
		return "", fmt.Errorf("transition duration (%.3fs) must be shorter than the preceding clip's duration (%.3fs)", transition.DurationSec, clipADuration)
	}

	preset := xfadePresetFor(transition.Type, transition.Direction)
	offset := clipADuration - transition.DurationSec

	return fmt.Sprintf(
		"[%s][%s]xfade=transition=%s:duration=%.6f:offset=%.6f[%s]",
		clipALabel, clipBLabel, preset, transition.DurationSec, offset, outLabel,
	), nil
}
