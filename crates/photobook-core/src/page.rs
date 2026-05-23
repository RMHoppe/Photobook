use serde::{Deserialize, Serialize};
use crate::grid_layout::GridLayout;
use crate::layout::SplitAxis;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum SpreadKind {
    /// Front cover + spine + back cover as one unified layout.
    Cover,
    /// Two interior pages side by side.
    Content,
}

// ---------------------------------------------------------------------------
// Text elements — freely positioned, not part of the layout
// ---------------------------------------------------------------------------

/// A free-floating text element on a spread.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct TextElement {
    /// Globally unique ID (assigned from PhotobookDocument::next_text_id).
    pub id: u32,
    /// Text content; `\n` separates lines.
    pub content: String,
    /// X position of the bounding-box top-left corner in mm (from spread left).
    pub x_mm: f32,
    /// Y position of the bounding-box top-left corner in mm (from spread top).
    pub y_mm: f32,
    /// Font family name: "Helvetica", "Times New Roman", or "Courier".
    pub font_family: String,
    /// Font size in typographic points (1 pt = 1/72 inch).
    pub font_size_pt: f32,
    /// Text colour as "#RRGGBB".
    pub color: String,
    /// Rotation in degrees counter-clockwise.
    pub rotation_deg: f32,
    pub bold: bool,
    pub italic: bool,
    /// Text alignment: "left" | "center" | "right".
    pub align: String,
}

impl TextElement {
    pub fn new(id: u32, x_mm: f32, y_mm: f32) -> Self {
        TextElement {
            id,
            content: "Text".into(),
            x_mm,
            y_mm,
            font_family: "Helvetica".into(),
            font_size_pt: 24.0,
            color: "#000000".into(),
            rotation_deg: 0.0,
            bold: false,
            italic: false,
            align: "left".into(),
        }
    }
}

// ---------------------------------------------------------------------------
// Spread
// ---------------------------------------------------------------------------

/// A single spread (cover or content pair) with its grid layout.
#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Spread {
    pub id: u32,
    #[serde(rename = "grid_layout")]
    pub layout: GridLayout,
    pub kind: SpreadKind,
    pub label: String,
    #[serde(default)]
    pub text_elements: Vec<TextElement>,
    /// Face IDs of pinwheel center panels on this spread.
    #[serde(default)]
    pub pinwheel_centers: Vec<u32>,
    /// Background fill colour for the left page (back cover for cover spreads). Empty = transparent.
    #[serde(default)]
    pub left_bg: String,
    /// Background fill colour for the right page (front cover for cover spreads). Empty = transparent.
    #[serde(default)]
    pub right_bg: String,
    /// Outer layout margin for this spread in mm (shrinks the root layout rect).
    #[serde(default)]
    pub margin_top: f32,
    #[serde(default)]
    pub margin_right: f32,
    #[serde(default)]
    pub margin_bottom: f32,
    #[serde(default)]
    pub margin_left: f32,
}

impl Spread {
    pub fn new(id: u32, kind: SpreadKind) -> Self {
        let label = match kind {
            SpreadKind::Cover   => "Cover".into(),
            SpreadKind::Content => format!("Spread {}", id),
        };
        let mut layout = GridLayout::new();
        let face_id = *layout.faces.keys().next().unwrap();
        layout.split_face(face_id, 0.5, SplitAxis::Vertical);

        Spread {
            id,
            layout,
            kind,
            label,
            text_elements: Vec::new(),
            pinwheel_centers: Vec::new(),
            left_bg: String::new(),
            right_bg: String::new(),
            margin_top: 0.0,
            margin_right: 0.0,
            margin_bottom: 0.0,
            margin_left: 0.0,
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PageSize {
    pub width_mm: f32,
    pub height_mm: f32,
}

impl Default for PageSize {
    fn default() -> Self {
        PageSize { width_mm: 210.0, height_mm: 297.0 }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct PhotobookDocument {
    /// File format version. Used to reject files saved by newer application versions.
    #[serde(default = "PhotobookDocument::schema_v1")]
    pub schema_version: u32,
    pub spreads: Vec<Spread>,
    pub current_spread: usize,
    pub page_size: PageSize,
    pub bleed_mm: f32,
    pub safe_zone_mm: f32,
    /// Paper thickness per interior page in mm (spine = max(min, this × interior_page_count)).
    pub spine_mm_per_page: f32,
    /// Minimum spine width in mm regardless of page count.
    pub spine_min_mm: f32,
    /// Snapping step for the transform box margin handles (0 = continuous).
    #[serde(default)]
    pub margin_step_mm: f32,
    /// Target print resolution in pixels per inch (used when exporting PDF).
    #[serde(default = "default_print_dpi")]
    pub print_dpi: f32,
    /// Default margin applied to the root node of each newly created spread (mm).
    #[serde(default)]
    pub default_margin_top: f32,
    #[serde(default)]
    pub default_margin_right: f32,
    #[serde(default)]
    pub default_margin_bottom: f32,
    #[serde(default)]
    pub default_margin_left: f32,
    next_spread_id: u32,
    /// Counter used to assign globally unique IDs to text elements.
    #[serde(default = "default_next_text_id")]
    pub next_text_id: u32,
    /// When true, the first and last content spread each have one non-printable inner page.
    #[serde(default)]
    pub endpapers: bool,
}

fn default_print_dpi() -> f32 { 300.0 }
fn default_next_text_id() -> u32 { 500_000_000 }

impl PhotobookDocument {
    fn schema_v1() -> u32 { 1 }

    pub fn new(width_mm: f32, height_mm: f32, bleed_mm: f32) -> Self {
        PhotobookDocument {
            schema_version: 1,
            spreads: vec![
                Spread::new(0, SpreadKind::Cover),
                Spread::new(1, SpreadKind::Content),
            ],
            current_spread: 1,
            page_size: PageSize { width_mm, height_mm },
            bleed_mm,
            safe_zone_mm: 5.0,
            spine_mm_per_page: 0.12,
            spine_min_mm: 5.0,
            margin_step_mm: 0.0,
            print_dpi: 300.0,
            default_margin_top: 0.0,
            default_margin_right: 0.0,
            default_margin_bottom: 0.0,
            default_margin_left: 0.0,
            next_spread_id: 2,
            next_text_id: 500_000_000,
            endpapers: false,
        }
    }

    pub fn add_spread(&mut self) {
        let id = self.next_spread_id;
        self.next_spread_id += 1;
        self.spreads.push(Spread::new(id, SpreadKind::Content));
    }

    pub fn remove_spread(&mut self, spread_idx: usize) {
        if spread_idx == 0 { return; } // never remove cover
        let min = if self.endpapers { 2 } else { 1 };
        if self.content_spread_count() <= min { return; }
        self.spreads.remove(spread_idx);
        if self.current_spread >= self.spreads.len() {
            self.current_spread = self.spreads.len().saturating_sub(1);
        }
    }

    pub fn current_spread(&self) -> &Spread {
        &self.spreads[self.current_spread]
    }

    pub fn current_spread_mut(&mut self) -> &mut Spread {
        &mut self.spreads[self.current_spread]
    }

    pub fn content_spread_count(&self) -> usize {
        self.spreads.iter().filter(|s| s.kind == SpreadKind::Content).count()
    }

    /// Total interior page count (each content spread = 2 pages).
    pub fn interior_page_count(&self) -> u32 {
        self.content_spread_count() as u32 * 2
    }

    /// Returns "left", "right", or None for the given spread index.
    /// "left"  → left page is non-printable (Spread 1 with endpapers enabled).
    /// "right" → right page is non-printable (last content spread with endpapers enabled).
    pub fn endpaper_side(&self, spread_idx: usize) -> Option<&'static str> {
        if !self.endpapers || spread_idx == 0 { return None; }
        let last = self.spreads.len().saturating_sub(1);
        match (spread_idx == 1, spread_idx == last) {
            (true, false)  => Some("left"),
            (false, true)  => Some("right"),
            (true, true)   => None, // only one content spread — shouldn't happen when endpapers are on
            (false, false) => None,
        }
    }

    /// Computed spine thickness in mm.
    pub fn spine_mm(&self) -> f32 {
        let linear = self.spine_mm_per_page * self.interior_page_count() as f32;
        linear.max(self.spine_min_mm)
    }

    /// Width of the given spread in mm.
    pub fn spread_width_mm(&self, spread: &Spread) -> f32 {
        match spread.kind {
            SpreadKind::Cover   => self.page_size.width_mm * 2.0 + self.spine_mm(),
            SpreadKind::Content => self.page_size.width_mm * 2.0,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc() -> PhotobookDocument {
        PhotobookDocument::new(210.0, 297.0, 3.0)
    }

    #[test]
    fn new_document_has_cover_and_one_content_spread() {
        let d = doc();
        assert_eq!(d.spreads.len(), 2);
        assert_eq!(d.spreads[0].kind, SpreadKind::Cover);
        assert_eq!(d.spreads[1].kind, SpreadKind::Content);
    }

    #[test]
    fn add_spread_increments_content_count() {
        let mut d = doc();
        let before = d.content_spread_count();
        d.add_spread();
        assert_eq!(d.content_spread_count(), before + 1);
        assert_eq!(d.spreads.last().unwrap().kind, SpreadKind::Content);
    }

    #[test]
    fn remove_spread_does_not_drop_below_minimum_one_content() {
        let mut d = doc();
        assert_eq!(d.content_spread_count(), 1);
        d.remove_spread(1); // only content spread — must be no-op
        assert_eq!(d.content_spread_count(), 1, "cannot drop below 1 content spread");
    }

    #[test]
    fn remove_spread_0_cover_is_always_noop() {
        let mut d = doc();
        let count = d.spreads.len();
        d.remove_spread(0);
        assert_eq!(d.spreads.len(), count, "cover spread is protected");
        assert_eq!(d.spreads[0].kind, SpreadKind::Cover);
    }

    #[test]
    fn remove_spread_with_multiple_content_spreads_decrements_count() {
        let mut d = doc();
        d.add_spread();
        d.add_spread();
        assert_eq!(d.content_spread_count(), 3);
        d.remove_spread(1);
        assert_eq!(d.content_spread_count(), 2);
    }

    #[test]
    fn content_spread_count_ignores_cover_spread() {
        let d = doc();
        let total = d.spreads.len();
        let content = d.content_spread_count();
        let covers = d.spreads.iter().filter(|s| s.kind == SpreadKind::Cover).count();
        assert_eq!(covers, 1);
        assert_eq!(content + covers, total);
    }

    #[test]
    fn interior_page_count_is_two_per_content_spread() {
        let mut d = doc();
        assert_eq!(d.interior_page_count(), 2);
        d.add_spread();
        assert_eq!(d.interior_page_count(), 4);
        d.add_spread();
        assert_eq!(d.interior_page_count(), 6);
    }

    #[test]
    fn spine_mm_clamps_to_minimum_for_few_pages() {
        let d = doc(); // 1 content spread → 2 pages → linear = 0.12*2 = 0.24 < 5.0 min
        assert_eq!(d.spine_mm(), d.spine_min_mm, "spine should clamp to minimum");
    }

    #[test]
    fn spine_mm_grows_linearly_above_minimum() {
        let mut d = doc();
        // Need 42+ pages (21+ content spreads) so that 0.12*pages > 5.0.
        for _ in 0..21 { d.add_spread(); }
        let linear = d.spine_mm_per_page * d.interior_page_count() as f32;
        assert!(linear > d.spine_min_mm, "sanity: linear spine exceeds minimum");
        assert!(
            (d.spine_mm() - linear).abs() < 1e-4,
            "spine_mm should equal the linear value when above minimum",
        );
    }

    #[test]
    fn endpaper_side_all_none_when_endpapers_disabled() {
        let mut d = doc();
        d.endpapers = false;
        for i in 0..d.spreads.len() {
            assert!(d.endpaper_side(i).is_none(), "spread {i} should not be an endpaper");
        }
    }

    #[test]
    fn endpaper_side_cover_is_always_none() {
        let mut d = doc();
        d.add_spread(); // ensure there are ≥2 content spreads
        d.endpapers = true;
        assert_eq!(d.endpaper_side(0), None, "cover spread is never an endpaper");
    }

    #[test]
    fn endpaper_side_first_content_is_left_when_enabled() {
        let mut d = doc();
        d.add_spread(); // need ≥2 content spreads for both endpapers to exist
        d.endpapers = true;
        assert_eq!(d.endpaper_side(1), Some("left"), "first content spread → left endpaper");
    }

    #[test]
    fn endpaper_side_last_content_is_right_when_enabled() {
        let mut d = doc();
        d.add_spread();
        d.endpapers = true;
        let last = d.spreads.len() - 1;
        assert_eq!(d.endpaper_side(last), Some("right"), "last content spread → right endpaper");
    }

    #[test]
    fn endpaper_side_middle_spreads_are_none() {
        let mut d = doc();
        d.add_spread();
        d.add_spread();
        d.endpapers = true;
        // Middle content spread (index 2) is neither first nor last.
        assert_eq!(d.endpaper_side(2), None);
    }

    #[test]
    fn spread_width_cover_includes_spine() {
        let d = doc();
        let cover = &d.spreads[0];
        let expected = d.page_size.width_mm * 2.0 + d.spine_mm();
        assert!((d.spread_width_mm(cover) - expected).abs() < 1e-4);
    }

    #[test]
    fn spread_width_content_is_two_page_widths() {
        let d = doc();
        let content = &d.spreads[1];
        let expected = d.page_size.width_mm * 2.0;
        assert!((d.spread_width_mm(content) - expected).abs() < 1e-4);
    }

    #[test]
    fn remove_spread_clamps_current_spread_index() {
        let mut d = doc();
        d.add_spread();
        let last = d.spreads.len() - 1;
        d.current_spread = last;
        d.remove_spread(last);
        assert!(
            d.current_spread < d.spreads.len(),
            "current_spread must not be out-of-bounds after removing the active spread",
        );
    }
}
