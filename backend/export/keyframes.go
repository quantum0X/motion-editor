// Keyframes: compiles a sorted list of models.Keyframe (for one
// property, on one clip) into a single FFmpeg time-expression string
// that interpolates between them.
//
// The expression shape is a right-associative chain of
// `if(lt(t,T), VALUE_AT_T, ...rest)` clauses, built from the END
// backwards so each segment's "else" branch is simply the
// already-built expression for everything after it. Before the first
// keyframe and after the last, the expression holds flat at that
// keyframe's value rather than extrapolating - this matches how every
// mainstream NLE's keyframe system behaves (a keyframe is a pin, not an
// invitation to project the curve infinitely).
//
// CRITICAL GOTCHA (see effects.go's package doc comment for the full
// explanation): whichever ffmpeg filter consumes this expression MUST
// either support per-frame expression evaluation by default (like
// `rotate`'s angle, or `overlay`'s x/y - verified against real ffmpeg
// output) or be given `eval=frame` explicitly (like `eq`, `vignette`,
// `scale` - same verification). This package only builds the
// expression string; it is the CALLER's responsibility to know which
// case its target filter falls into.
package export

import (
	"fmt"
	"sort"

	"videoeditor/backend/models"
)

// easedProgress returns the ffmpeg sub-expression for normalized
// progress (0..1) through a segment, after applying the segment's
// interpolation curve. progressExpr is assumed to already be a valid
// ffmpeg expression evaluating to a 0..1 ratio for the CURRENT t within
// this segment.
func easedProgress(progressExpr string, interp models.InterpolationType) string {
	switch interp {
	case models.InterpolationEaseIn:
		return fmt.Sprintf("pow(%s,2)", progressExpr)
	case models.InterpolationEaseOut:
		return fmt.Sprintf("(1-pow(1-(%s),2))", progressExpr)
	case models.InterpolationBezier:
		// Phase 1 approximates bezier as a smoothstep (ease-in-out)
		// curve rather than accepting arbitrary control points - see
		// models.Keyframe's doc comment. smoothstep(x) = 3x^2 - 2x^3.
		return fmt.Sprintf("((%s)*(%s)*(3-2*(%s)))", progressExpr, progressExpr, progressExpr)
	default: // linear
		return progressExpr
	}
}

// buildKeyframeExpression compiles one property's keyframes (already
// filtered to a single KeyframeProperty by the caller) into an ffmpeg
// time expression. keyframes need not be pre-sorted - this function
// sorts a copy by TimeSec itself, since keyframe order in project.json
// reflects insertion/edit history, not necessarily chronological order.
//
// Returns an error if keyframes is empty (the caller should simply not
// invoke this and use the clip's static property value instead - an
// empty keyframe list is "no animation," not "animate to zero").
func buildKeyframeExpression(keyframes []models.Keyframe) (string, error) {
	if len(keyframes) == 0 {
		return "", fmt.Errorf("cannot build an expression from zero keyframes")
	}

	sorted := make([]models.Keyframe, len(keyframes))
	copy(sorted, keyframes)
	sort.Slice(sorted, func(i, j int) bool { return sorted[i].TimeSec < sorted[j].TimeSec })

	if len(sorted) == 1 {
		return fmt.Sprintf("%.6f", sorted[0].Value), nil
	}

	// Build from the end backwards: expr starts as "hold the last
	// keyframe's value forever," then each earlier segment wraps it in
	// one more if(lt(t,...)) clause.
	expr := fmt.Sprintf("%.6f", sorted[len(sorted)-1].Value)

	for i := len(sorted) - 2; i >= 0; i-- {
		kfStart := sorted[i]
		kfEnd := sorted[i+1]
		duration := kfEnd.TimeSec - kfStart.TimeSec
		if duration <= 0 {
			return "", fmt.Errorf("keyframes must be at strictly increasing times (got %.3fs then %.3fs)", kfStart.TimeSec, kfEnd.TimeSec)
		}

		progress := fmt.Sprintf("((t-%.6f)/%.6f)", kfStart.TimeSec, duration)
		eased := easedProgress(progress, kfStart.Interpolation)
		valueAtT := fmt.Sprintf("(%.6f+(%.6f-%.6f)*%s)", kfStart.Value, kfEnd.Value, kfStart.Value, eased)

		expr = fmt.Sprintf("if(lt(t,%.6f),%s,%s)", kfEnd.TimeSec, valueAtT, expr)
	}

	// Before the first keyframe: hold its value flat.
	first := sorted[0]
	expr = fmt.Sprintf("if(lt(t,%.6f),%.6f,%s)", first.TimeSec, first.Value, expr)

	return expr, nil
}

// groupKeyframesByProperty splits a clip's flat Keyframe list into one
// slice per KeyframeProperty, so the caller can build (at most) one
// expression per animated property rather than re-filtering the list
// for each property it checks.
func groupKeyframesByProperty(keyframes []models.Keyframe) map[models.KeyframeProperty][]models.Keyframe {
	grouped := make(map[models.KeyframeProperty][]models.Keyframe)
	for _, kf := range keyframes {
		grouped[kf.Property] = append(grouped[kf.Property], kf)
	}
	return grouped
}
