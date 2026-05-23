/// Compute cover-fit scale factors for image placement.
/// Works in any consistent unit (both frame and image dimensions must use the same unit).
///
/// Returns `(cover_scale, rot_factor, total_scale)`:
/// - `cover_scale`  — minimum scale to fully cover the frame (ignoring rotation)
/// - `rot_factor`   — additional multiplier to maintain coverage under rotation (≥ 1.0)
/// - `total_scale`  — `cover_scale × rot_factor × user_scale.max(1.0)`
pub fn image_cover_factors(
    frame_w: f32, frame_h: f32,
    img_w: f32, img_h: f32,
    rotation_deg: f32,
    user_scale: f32,
) -> (f32, f32, f32) {
    if img_w <= 0.0 || img_h <= 0.0 || frame_w <= 0.0 || frame_h <= 0.0 {
        return (1.0, 1.0, 1.0);
    }
    let img_ratio   = img_w / img_h;
    let frame_ratio = frame_w / frame_h;
    // Minimum scale to cover the frame in the non-rotated case.
    let cover_scale = if img_ratio > frame_ratio { frame_h / img_h } else { frame_w / img_w };

    // Extra scale needed so the rotated image still covers the frame.
    let rad   = rotation_deg.to_radians();
    let cos_a = rad.cos().abs();
    let sin_a = rad.sin().abs();
    let sw0 = img_w * cover_scale;
    let sh0 = img_h * cover_scale;
    let rot_factor = if sw0 > 0.0 && sh0 > 0.0 {
        ((frame_w * cos_a + frame_h * sin_a) / sw0)
            .max((frame_w * sin_a + frame_h * cos_a) / sh0)
            .max(1.0)
    } else {
        1.0
    };

    let total_scale = cover_scale * rot_factor * user_scale.max(1.0);
    (cover_scale, rot_factor, total_scale)
}

#[cfg(test)]
mod tests {
    use super::*;

    const EPS: f32 = 1e-4;

    #[test]
    fn zero_frame_dimension_returns_identity() {
        let (cs, rf, ts) = image_cover_factors(0.0, 100.0, 100.0, 100.0, 0.0, 1.0);
        assert_eq!((cs, rf, ts), (1.0, 1.0, 1.0));
        let (cs, rf, ts) = image_cover_factors(100.0, 0.0, 100.0, 100.0, 0.0, 1.0);
        assert_eq!((cs, rf, ts), (1.0, 1.0, 1.0));
    }

    #[test]
    fn zero_image_dimension_returns_identity() {
        let (cs, rf, ts) = image_cover_factors(100.0, 100.0, 0.0, 100.0, 0.0, 1.0);
        assert_eq!((cs, rf, ts), (1.0, 1.0, 1.0));
        let (cs, rf, ts) = image_cover_factors(100.0, 100.0, 100.0, 0.0, 0.0, 1.0);
        assert_eq!((cs, rf, ts), (1.0, 1.0, 1.0));
    }

    #[test]
    fn square_image_square_frame_no_rotation_is_unit_scale() {
        let (cs, rf, ts) = image_cover_factors(100.0, 100.0, 100.0, 100.0, 0.0, 1.0);
        assert!((cs - 1.0).abs() < EPS, "cover_scale={cs}");
        assert!((rf - 1.0).abs() < EPS, "rot_factor={rf}");
        assert!((ts - 1.0).abs() < EPS, "total_scale={ts}");
    }

    #[test]
    fn landscape_image_into_portrait_frame_scales_by_height() {
        // img 200×100 (wide), frame 50×100 (tall) — must scale to fill frame height
        // img_ratio=2.0, frame_ratio=0.5 → img_ratio > frame_ratio → cover_scale = frame_h/img_h
        let (cs, _, _) = image_cover_factors(50.0, 100.0, 200.0, 100.0, 0.0, 1.0);
        assert!((cs - 1.0).abs() < EPS, "cover_scale should be 1.0, got {cs}");
    }

    #[test]
    fn portrait_image_into_landscape_frame_scales_by_width() {
        // img 100×200 (tall), frame 200×100 (wide) — must scale to fill frame width
        // img_ratio=0.5, frame_ratio=2.0 → img_ratio < frame_ratio → cover_scale = frame_w/img_w
        let (cs, _, _) = image_cover_factors(200.0, 100.0, 100.0, 200.0, 0.0, 1.0);
        assert!((cs - 2.0).abs() < EPS, "cover_scale should be 2.0, got {cs}");
    }

    #[test]
    fn rotation_at_45_degrees_increases_rot_factor_to_sqrt2_for_square() {
        let (_, rf, _) = image_cover_factors(100.0, 100.0, 100.0, 100.0, 45.0, 1.0);
        let expected = std::f32::consts::SQRT_2;
        assert!(rf > 1.0, "rot_factor at 45° should be > 1.0, got {rf}");
        assert!(
            (rf - expected).abs() < 0.01,
            "rot_factor at 45° should be ~√2={expected:.4}, got {rf:.4}",
        );
    }

    #[test]
    fn rotation_at_90_degrees_rot_factor_near_one_for_square() {
        // A square image in a square frame at 90° needs the same scale as 0°.
        let (_, rf, _) = image_cover_factors(100.0, 100.0, 100.0, 100.0, 90.0, 1.0);
        assert!((rf - 1.0).abs() < 0.01, "rot_factor at 90° for square should be ~1.0, got {rf}");
    }

    #[test]
    fn user_scale_below_1_is_clamped_to_1() {
        let (_, _, ts_one)  = image_cover_factors(100.0, 100.0, 100.0, 100.0, 0.0, 1.0);
        let (_, _, ts_half) = image_cover_factors(100.0, 100.0, 100.0, 100.0, 0.0, 0.5);
        assert!((ts_one - ts_half).abs() < EPS, "user_scale<1.0 must clamp to 1.0");
    }

    #[test]
    fn user_scale_above_1_multiplies_total_scale() {
        let (_, _, ts_base)   = image_cover_factors(100.0, 100.0, 100.0, 100.0, 0.0, 1.0);
        let (_, _, ts_double) = image_cover_factors(100.0, 100.0, 100.0, 100.0, 0.0, 2.0);
        assert!((ts_double - ts_base * 2.0).abs() < EPS, "user_scale=2.0 must double total_scale");
    }
}

