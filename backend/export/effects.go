// Effects: converts a models.Effect into one FFmpeg filter clause.
//
// Every filter choice and parameter here was verified by actually
// rendering output and checking it, the same way the rest of this
// export pipeline was built - in particular:
//
//   - brightness/contrast/saturation use the `eq` filter.
//   - blur uses `boxblur`; sharpen uses `unsharp` (also doubles as a
//     blur if given a negative amount, but Phase 1 keeps blur/sharpen as
//     two distinct user-facing effects for clarity).
//   - vignette uses `vignette`.
//   - grain uses `noise`.
//   - vhs and rgbshift are composite effects (no single ffmpeg filter
//     named either of these) - vhs chains noise + slight chroma
//     shift + a soft vignette to approximate the look; rgbshift uses
//     `rgbashift` directly.
//
// CRITICAL GOTCHA, verified the hard way (see project notes): eq and
// vignette both default to `eval=init` - they evaluate any time-varying
// expression in their parameters ONCE, at filter-graph construction
// time, not per frame. Without `eval=frame`, an effect whose strength
// is meant to change over time (e.g. animated via a keyframe-driven
// expression - see keyframes.go) will silently render as a single static
// value for the clip's entire duration instead of animating. Every
// builder function below that could ever receive a time-varying
// expression sets eval=frame unconditionally, even for effects that are
// constant in Phase 1 (no per-effect keyframing yet) - the cost of
// always specifying it is zero, and it removes an entire class of "my
// animated effect doesn't animate" bug for whenever per-effect
// keyframing is added later.
package export

import (
	"fmt"
	"strings"

	"videoeditor/backend/models"
)

// buildEffectFilter returns the FFmpeg filter clause for one effect
// (e.g. "eq=eval=frame:contrast=1.500000"), or an error if the effect
// type is unrecognized. The caller chains these with "," between other
// per-clip filter stages (trim, scale, pad, etc.) - see builder.go.
func buildEffectFilter(e models.Effect) (string, error) {
	if !e.Enabled {
		return "", nil // caller skips empty strings
	}

	switch e.Type {
	case models.EffectBrightness:
		return fmt.Sprintf("eq=eval=frame:brightness=%.6f", paramOr(e.Params, "amount", 0.0)), nil

	case models.EffectContrast:
		return fmt.Sprintf("eq=eval=frame:contrast=%.6f", paramOr(e.Params, "amount", 1.0)), nil

	case models.EffectSaturation:
		return fmt.Sprintf("eq=eval=frame:saturation=%.6f", paramOr(e.Params, "amount", 1.0)), nil

	case models.EffectBlur:
		// boxblur's first number is the luma radius; reuse it for chroma
		// too (param "amount" maps 1:1 to radius) rather than exposing
		// separate luma/chroma controls - not a distinction most people
		// editing a video actually want to think about.
		radius := paramOr(e.Params, "amount", 2.0)
		return fmt.Sprintf("boxblur=%.2f:%.2f", radius, radius), nil

	case models.EffectSharpen:
		// unsharp's amount parameter ("luma_amount") ranges roughly
		// -2..5 in practice; we expose it 1:1 as "amount" with a sane
		// default matching the verified test render.
		amount := paramOr(e.Params, "amount", 1.0)
		return fmt.Sprintf("unsharp=5:5:%.3f:5:5:%.3f", amount, amount), nil

	case models.EffectVignette:
		strength := paramOr(e.Params, "amount", 1.0) // 0..1, scales how far the vignette's PI/5 default angle extends by widening the angle for stronger looks
		angle := 0.35 + (1.0-strength)*0.6           // empirically: smaller angle = stronger/tighter vignette
		return fmt.Sprintf("vignette=eval=frame:angle=%.4f", angle), nil

	case models.EffectGrain:
		strength := paramOr(e.Params, "amount", 8.0) // noise's alls is roughly 0-100 in practice; 8 matched the verified test render well
		return fmt.Sprintf("noise=alls=%.2f:allf=t", strength), nil

	case models.EffectRGBShift:
		shift := paramOr(e.Params, "amount", 3.0)
		return fmt.Sprintf("rgbashift=rh=%.2f:bv=%.2f", shift, -shift), nil

	case models.EffectVHS:
		// Composite look: soft blur + grain + a gentle vignette + a
		// slight saturation pull, approximating a VHS tape's softness,
		// noise floor, and corner darkening - not a single ffmpeg
		// filter, by design (see package doc comment).
		return strings.Join([]string{
			"eq=eval=frame:saturation=0.85:contrast=1.05",
			"boxblur=1:0.5",
			"noise=alls=8:allf=t",
			"vignette=eval=frame:angle=0.4",
		}, ","), nil

	default:
		return "", fmt.Errorf("unknown effect type %q", e.Type)
	}
}

// paramOr reads a float64 param by key, returning a default if the key
// is absent. Effect.Params is a flat map (see models.Effect doc comment)
// so every effect type reads from it defensively rather than assuming
// the frontend always sent every expected key.
func paramOr(params map[string]float64, key string, def float64) float64 {
	if params == nil {
		return def
	}
	if v, ok := params[key]; ok {
		return v
	}
	return def
}

// buildEffectsChain joins a clip's enabled effects into one
// comma-separated filter fragment ready to be appended after a clip's
// existing trim/scale/pad stage, or "" if there are no enabled effects
// (the caller must not append a trailing/leading comma in that case).
func buildEffectsChain(effects []models.Effect) (string, error) {
	var stages []string
	for _, e := range effects {
		stage, err := buildEffectFilter(e)
		if err != nil {
			return "", fmt.Errorf("effect %s: %w", e.ID, err)
		}
		if stage != "" {
			stages = append(stages, stage)
		}
	}
	return strings.Join(stages, ","), nil
}
