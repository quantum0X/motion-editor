// keyframes_apply.go: wires compiled keyframe expressions (see
// keyframes.go) into a clip's actual filter chain.
//
// IMPORTANT CONSTRAINT, discovered and verified against real ffmpeg
// (see project notes) - NOT all clip properties can be animated the way
// the original spec's keyframe list (position/rotation/scale/opacity)
// might suggest, given the filters available in a standard ffmpeg
// build:
//
//   - Rotation: `rotate`'s angle parameter accepts a `t`-based
//     expression directly. Works as expected.
//   - Scale ("zoom"): a video's actual encoded frame dimensions cannot
//     change over the course of one output file - `scale` with a
//     time-varying w/h either errors or silently freezes at the first
//     evaluated size. The correct technique (verified) is to scale UP
//     by the animated factor and then `crop` back down to the fixed
//     output size - i.e. "zoom" is implemented as scale+crop, not a
//     bare animated scale.
//   - Position: implemented the same way, via crop's x/y offset
//     expressions (which DO support per-frame evaluation), keeping
//     output dimensions fixed while panning which region is visible.
//   - Opacity: verified NOT animatable via colorchannelmixer's `aa`
//     parameter - it rejects time-varying expressions outright (this
//     ffmpeg build has no eval mode for that filter at all). The
//     pragmatic fallback, covering the overwhelming majority of real
//     opacity-keyframe usage, is ffmpeg's dedicated `fade` filter for
//     the simple "fade in" / "fade out" case (exactly two keyframes
//     going 0->1 or 1->0). A genuinely continuous multi-point opacity
//     curve is NOT supported in this phase; ApplyOpacityKeyframes
//     returns a clear error for that case rather than silently
//     producing a static, non-animating result.
package export

import (
	"fmt"

	"videoeditor/backend/models"
)

// ApplyRotationKeyframes returns the `rotate` filter clause for a
// clip's rotation keyframes, in DEGREES on the Keyframe.Value (rotate's
// own angle parameter wants radians, so this converts).
func ApplyRotationKeyframes(keyframes []models.Keyframe) (string, error) {
	expr, err := buildKeyframeExpression(keyframes)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf("rotate=angle='(%s)*PI/180':fillcolor=black@0", expr), nil
}

// ApplyScaleKeyframes returns a scale+crop filter pair that implements
// a "zoom" animation while keeping the output frame at canvasW x
// canvasH throughout - see package doc comment for why a bare animated
// `scale` cannot be used here. Keyframe.Value is a multiplier (1.0 =
// 100%, 1.5 = 150% zoomed in); values below 1.0 would crop a region
// LARGER than the canvas and are rejected, since "zooming out" beyond
// the source frame has no defined content to show at the edges in this
// phase (no pan/letterbox fallback implemented).
func ApplyScaleKeyframes(keyframes []models.Keyframe, canvasW, canvasH int) (string, error) {
	for _, kf := range keyframes {
		if kf.Value < 1.0 {
			return "", fmt.Errorf("scale keyframe value %.3f is below 1.0 - zooming out beyond the source frame isn't supported in this phase", kf.Value)
		}
	}
	expr, err := buildKeyframeExpression(keyframes)
	if err != nil {
		return "", err
	}
	return fmt.Sprintf(
		"scale=eval=frame:w='iw*(%s)':h='ih*(%s)',crop=%d:%d",
		expr, expr, canvasW, canvasH,
	), nil
}

// ApplyPositionKeyframes returns a crop filter clause that pans the
// visible region according to x/y keyframes (in pixels, relative to the
// clip's own unscaled frame) while keeping output dimensions fixed -
// see package doc comment. xKeyframes/yKeyframes may each be nil/empty
// independently (e.g. animate X but hold Y constant); at least one must
// be non-empty or there's nothing to animate.
func ApplyPositionKeyframes(xKeyframes, yKeyframes []models.Keyframe, canvasW, canvasH int) (string, error) {
	if len(xKeyframes) == 0 && len(yKeyframes) == 0 {
		return "", fmt.Errorf("no position keyframes provided")
	}

	xExpr := fmt.Sprintf("(iw-%d)/2", canvasW) // default: centered, if X isn't animated
	if len(xKeyframes) > 0 {
		expr, err := buildKeyframeExpression(xKeyframes)
		if err != nil {
			return "", fmt.Errorf("position X: %w", err)
		}
		xExpr = expr
	}

	yExpr := fmt.Sprintf("(ih-%d)/2", canvasH)
	if len(yKeyframes) > 0 {
		expr, err := buildKeyframeExpression(yKeyframes)
		if err != nil {
			return "", fmt.Errorf("position Y: %w", err)
		}
		yExpr = expr
	}

	return fmt.Sprintf("crop=%d:%d:%s:%s:eval=frame", canvasW, canvasH, xExpr, yExpr), nil
}

// ApplyOpacityKeyframes returns ffmpeg's `fade` filter for the common
// two-keyframe fade-in or fade-out case, or an error for anything more
// complex - see package doc comment for why a general opacity curve
// isn't supported by this ffmpeg build's available filters.
func ApplyOpacityKeyframes(keyframes []models.Keyframe) (string, error) {
	if len(keyframes) != 2 {
		return "", fmt.Errorf("opacity keyframes are only supported as a simple two-point fade in this phase (got %d keyframes) - ffmpeg's colorchannelmixer filter does not support animated alpha in this build", len(keyframes))
	}

	sorted := make([]models.Keyframe, 2)
	copy(sorted, keyframes)
	if sorted[0].TimeSec > sorted[1].TimeSec {
		sorted[0], sorted[1] = sorted[1], sorted[0]
	}

	start, end := sorted[0], sorted[1]
	duration := end.TimeSec - start.TimeSec
	if duration <= 0 {
		return "", fmt.Errorf("opacity keyframes must be at two different times")
	}

	var fadeType string
	switch {
	case start.Value < end.Value:
		fadeType = "in"
	case start.Value > end.Value:
		fadeType = "out"
	default:
		return "", fmt.Errorf("opacity keyframes have the same value at both points - nothing to animate")
	}

	return fmt.Sprintf("fade=t=%s:st=%.6f:d=%.6f:alpha=1", fadeType, start.TimeSec, duration), nil
}
