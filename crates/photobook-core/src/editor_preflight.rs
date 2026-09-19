// Document-wide pre-export checks ("preflight"). Rules come from the selected
// print-shop spec on the TS side; the report is shown before export starts so
// problems are fixed before a print shop rejects the file.

use wasm_bindgen::prelude::*;
use serde::{Deserialize, Serialize};
use crate::grid_resolver::resolve_frames_mm;
use crate::utils::image_cover_factors;
use crate::page::SpreadKind;
use crate::PhotobookEditor;

#[derive(Deserialize, Default)]
pub struct PreflightRules {
    /// Minimum acceptable effective image resolution in dpi. 0 disables the check.
    #[serde(default)]
    pub min_effective_dpi: f32,
    /// Minimum interior page count (2 per content spread). 0 disables.
    #[serde(default)]
    pub min_interior_pages: u32,
    /// Maximum interior page count. 0 disables.
    #[serde(default)]
    pub max_interior_pages: u32,
    /// Interior page count must be a multiple of this. 0/1 disables.
    #[serde(default)]
    pub page_count_multiple_of: u32,
    /// Check the safe zone along the gutter (page fold) of content spreads.
    /// Layflat books open flat, so their specs need no inner margin.
    #[serde(default = "default_true")]
    pub check_gutter: bool,
}

fn default_true() -> bool { true }

#[derive(Serialize)]
struct PreflightIssue {
    severity: &'static str, // "error" | "warning"
    code: &'static str,
    message: String,
    spread_idx: Option<usize>,
    face_id: Option<u32>,
}

/// Natural image resolution assumed when computing effective dpi — matches
/// the convention used by `get_low_dpi_frames` and the PDF placement math.
const NAT_DPI: f32 = 300.0;

#[wasm_bindgen]
impl PhotobookEditor {
    /// Run document-wide pre-export checks and return the issues as JSON.
    /// `rules_json` is a `PreflightRules` object (unknown fields ignored).
    pub fn get_preflight_report(&self, rules_json: &str) -> String {
        let rules: PreflightRules = serde_json::from_str(rules_json).unwrap_or_default();
        let doc = &self.doc;
        let ph     = doc.page_size.height_mm;
        let page_w = doc.page_size.width_mm;
        let safe   = doc.safe_zone_mm;
        let mut issues: Vec<PreflightIssue> = Vec::new();

        // --- Page-count rules -------------------------------------------------
        let pages = doc.interior_page_count();
        if rules.min_interior_pages > 0 && pages < rules.min_interior_pages {
            issues.push(PreflightIssue {
                severity: "error", code: "page-count-min",
                message: format!("Book has {pages} interior pages; the shop requires at least {}.",
                                 rules.min_interior_pages),
                spread_idx: None, face_id: None,
            });
        }
        if rules.max_interior_pages > 0 && pages > rules.max_interior_pages {
            issues.push(PreflightIssue {
                severity: "error", code: "page-count-max",
                message: format!("Book has {pages} interior pages; the shop allows at most {}.",
                                 rules.max_interior_pages),
                spread_idx: None, face_id: None,
            });
        }
        if rules.page_count_multiple_of > 1 && pages % rules.page_count_multiple_of != 0 {
            issues.push(PreflightIssue {
                severity: "error", code: "page-count-multiple",
                message: format!("Book has {pages} interior pages; the shop requires a multiple of {}.",
                                 rules.page_count_multiple_of),
                spread_idx: None, face_id: None,
            });
        }

        // --- Per-spread checks ------------------------------------------------
        for (i, spread) in doc.spreads.iter().enumerate() {
            let spread_w = doc.spread_width_mm(spread);
            let endpaper_side = doc.endpaper_side(i);
            let (layout_w, layout_offset_x) = match endpaper_side {
                Some("left")  => (page_w, page_w),
                Some("right") => (page_w, 0.0),
                _             => (spread_w, 0.0),
            };
            let _ = layout_offset_x; // frames are checked in layout-local coords

            let mut empty_frame_ids: Vec<u32> = Vec::new();
            let mut worst_dpi: Option<(u32, u32)> = None; // (effective_dpi_rounded, face_id)

            for (face_id, rect) in resolve_frames_mm(&spread.layout, layout_w, ph, doc.bleed_mm) {
                let Some(face) = spread.layout.faces.get(&face_id) else { continue };
                let Some(ref image_id) = face.image.image_id else {
                    empty_frame_ids.push(face_id);
                    continue;
                };
                if rules.min_effective_dpi <= 0.0 { continue; }
                let Some(&(img_w, img_h)) = self.image_sizes.get(image_id.as_str()) else { continue };
                if img_w == 0 || img_h == 0 || rect.w <= 0.0 || rect.h <= 0.0 { continue; }

                let nat_w_mm = img_w as f32 / NAT_DPI * 25.4;
                let nat_h_mm = img_h as f32 / NAT_DPI * 25.4;
                if nat_w_mm <= 0.0 || nat_h_mm <= 0.0 { continue; }
                let (_, _, total_scale) = image_cover_factors(
                    rect.w, rect.h, nat_w_mm, nat_h_mm,
                    face.image.rotation_deg, face.image.scale,
                );
                let effective_dpi = NAT_DPI / total_scale;
                if effective_dpi < rules.min_effective_dpi {
                    let rounded = effective_dpi.round() as u32;
                    if worst_dpi.is_none_or(|(d, _)| rounded < d) {
                        worst_dpi = Some((rounded, face_id));
                    }
                }
            }

            // One empty-frame warning per spread (avoids a wall of identical messages).
            if !empty_frame_ids.is_empty() {
                let count = empty_frame_ids.len();
                let msg = if count == 1 {
                    format!("{}: 1 frame has no image.", spread.label)
                } else {
                    format!("{}: {} frames have no image.", spread.label, count)
                };
                issues.push(PreflightIssue {
                    severity: "warning", code: "empty-frame",
                    message: msg,
                    spread_idx: Some(i),
                    face_id: if count == 1 { Some(empty_frame_ids[0]) } else { None },
                });
            }

            // One low-DPI warning per spread (show the worst offender).
            if let Some((dpi, face_id)) = worst_dpi {
                issues.push(PreflightIssue {
                    severity: "warning", code: "low-dpi",
                    message: format!("{}: an image prints at ~{} dpi (shop minimum {} dpi).",
                                     spread.label, dpi, rules.min_effective_dpi.round() as u32),
                    spread_idx: Some(i), face_id: Some(face_id),
                });
            }

            // Text anchors near the trim edges or the spine. Text width isn't
            // known here (no font metrics outside export), so this checks the
            // anchor and the approximate text height.
            if safe > 0.0 {
                // Vertical trim/fold boundaries in spread space.
                let mut boundaries = vec![0.0, spread_w];
                match spread.kind {
                    // The spine zone of the cover is always critical — it is
                    // folded or replaced by a generated spine.
                    SpreadKind::Cover => {
                        boundaries.push(page_w);
                        boundaries.push(spread_w - page_w);
                    }
                    SpreadKind::Content => {
                        if rules.check_gutter {
                            boundaries.push(page_w);
                        }
                    }
                    // Standalone cover pages have no fold or spine; the trim
                    // edges (0 / spread_w) are already in the list.
                    SpreadKind::CoverFront | SpreadKind::CoverBack => {}
                }
                for t in &spread.text_elements {
                    let line_count = t.content.split('\n').count().max(1) as f32;
                    let approx_h = line_count * t.font_size_pt * (25.4 / 72.0) * 1.2;
                    let near_x = boundaries.iter().any(|b| (t.x_mm - b).abs() < safe);
                    let near_y = t.y_mm < safe || t.y_mm + approx_h > ph - safe;
                    if near_x || near_y {
                        let snippet: String = t.content.chars().take(20).collect();
                        issues.push(PreflightIssue {
                            severity: "warning", code: "text-safe-zone",
                            message: format!("{}: text \u{201c}{}\u{201d} starts inside the safe zone and may be trimmed.",
                                             spread.label, snippet),
                            spread_idx: Some(i), face_id: None,
                        });
                    }
                }
            }
        }

        serde_json::to_string(&issues).unwrap_or_else(|_| "[]".into())
    }

    pub fn get_print_spec_id(&self) -> String {
        self.doc.print_spec_id.clone()
    }

    pub fn set_print_spec_id(&mut self, id: &str) {
        self.doc.print_spec_id = id.to_string();
    }
}
