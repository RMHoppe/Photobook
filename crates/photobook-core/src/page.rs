use serde::{Deserialize, Serialize};
use crate::bsp::BspTree;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum SpreadKind {
    /// Front cover + spine + back cover as one unified layout.
    Cover,
    /// Two interior pages side by side.
    Content,
}

// ---------------------------------------------------------------------------
// Text elements — freely positioned, not part of the BSP tree
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

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Spread {
    pub id: u32,
    pub tree: BspTree,
    pub kind: SpreadKind,
    pub label: String,
    /// Free-floating text elements on this spread (not part of the BSP tree).
    #[serde(default)]
    pub text_elements: Vec<TextElement>,
}

impl Spread {
    pub fn new(id: u32, kind: SpreadKind) -> Self {
        let label = match kind {
            SpreadKind::Cover   => "Cover".into(),
            SpreadKind::Content => format!("Spread {}", id),
        };
        Spread {
            id,
            // Each spread starts its node IDs at id * 1_000_000 — globally unique.
            tree: BspTree::new_with_start(id * 1_000_000),
            kind,
            label,
            text_elements: Vec::new(),
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
    /// Starts at 500_000_000 to avoid collision with BSP node IDs.
    #[serde(default = "default_next_text_id")]
    pub next_text_id: u32,
}

fn default_print_dpi() -> f32 { 300.0 }
fn default_next_text_id() -> u32 { 500_000_000 }

impl PhotobookDocument {
    pub fn new(width_mm: f32, height_mm: f32, bleed_mm: f32) -> Self {
        PhotobookDocument {
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
        }
    }

    pub fn add_spread(&mut self) {
        let id = self.next_spread_id;
        self.next_spread_id += 1;
        self.spreads.push(Spread::new(id, SpreadKind::Content));
    }

    pub fn remove_spread(&mut self, spread_idx: usize) {
        if spread_idx == 0 { return; } // never remove cover
        if self.content_spread_count() <= 1 { return; } // keep at least one content spread
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
