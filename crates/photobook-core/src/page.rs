use serde::{Deserialize, Serialize};
use crate::grid_layout::GridLayout;
use crate::layout::SplitAxis;

#[derive(Clone, Copy, Debug, Serialize, Deserialize, PartialEq)]
pub enum SpreadKind {
    /// Front cover + spine + back cover as one unified layout.
    Cover,
    /// Front cover as a standalone single page (cover-as-pages export mode).
    CoverFront,
    /// Back cover as a standalone single page (cover-as-pages export mode).
    CoverBack,
    /// Two interior pages side by side.
    Content,
}

impl SpreadKind {
    /// Any cover variant (wraparound or standalone front/back page).
    pub fn is_cover(self) -> bool {
        matches!(self, SpreadKind::Cover | SpreadKind::CoverFront | SpreadKind::CoverBack)
    }

    /// Spread is a single page wide (no fold, no spine).
    pub fn is_single_page(self) -> bool {
        matches!(self, SpreadKind::CoverFront | SpreadKind::CoverBack)
    }
}

// ---------------------------------------------------------------------------
// Text elements — freely positioned, not part of the layout
// ---------------------------------------------------------------------------

/// A free-floating text element on a spread.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
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
    #[serde(default)]
    pub underline: bool,
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
            underline: false,
            align: "left".into(),
        }
    }
}

// ---------------------------------------------------------------------------
// Spread
// ---------------------------------------------------------------------------

/// A single spread (cover or content pair) with its grid layout.
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
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
}

impl Spread {
    pub fn new(id: u32, kind: SpreadKind) -> Self {
        let label = match kind {
            SpreadKind::Cover      => "Cover".into(),
            SpreadKind::CoverFront => "Front Cover".into(),
            SpreadKind::CoverBack  => "Back Cover".into(),
            SpreadKind::Content    => format!("Spread {}", id),
        };
        let mut layout = GridLayout::new();
        // Two-page spreads start pre-split at the fold; single pages keep one face.
        if !kind.is_single_page() {
            let face_id = *layout.faces.keys().next().unwrap();
            layout.split_face(face_id, 0.5, SplitAxis::Vertical);
        }

        Spread {
            id,
            layout,
            kind,
            label,
            text_elements: Vec::new(),
            pinwheel_centers: Vec::new(),
            left_bg: String::new(),
            right_bg: String::new(),
        }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub struct PageSize {
    pub width_mm: f32,
    pub height_mm: f32,
}

impl Default for PageSize {
    fn default() -> Self {
        PageSize { width_mm: 210.0, height_mm: 297.0 }
    }
}

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
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
    /// Target print resolution in pixels per inch (used when exporting PDF).
    #[serde(default = "default_print_dpi")]
    pub print_dpi: f32,
    next_spread_id: u32,
    /// Counter used to assign globally unique IDs to text elements.
    #[serde(default = "default_next_text_id")]
    pub next_text_id: u32,
    /// When true, the first and last content spread each have one non-printable inner page.
    #[serde(default)]
    pub endpapers: bool,
    /// Draw printer's crop marks at the trim corners on export. Off by default —
    /// automated print workflows read the TrimBox instead.
    #[serde(default)]
    pub export_crop_marks: bool,
    /// Export the cover as a separate PDF from the interior pages.
    #[serde(default)]
    pub export_split_cover: bool,
    /// Export interior spreads as two single pages each (perfect binding)
    /// instead of one full-spread page (layflat binding).
    #[serde(default)]
    pub export_body_pages: bool,
    /// Extra wrap/turn-in allowance beyond the bleed on every cover edge, in mm
    /// (hardcover case wrap). Applied to cover spreads only.
    #[serde(default)]
    pub cover_wrap_mm: f32,
    /// Id of the print-shop spec preset selected in project settings (TS-side
    /// catalog); empty = custom settings. Drives preflight rules.
    #[serde(default)]
    pub print_spec_id: String,
    /// Export the cover as two single pages — front cover first, back cover
    /// last — instead of one wraparound spread. For shops (e.g. Peecho) that
    /// compute the spine themselves and want one PDF of single pages.
    #[serde(default)]
    pub export_cover_pages: bool,
    /// Page-count rules from the selected print-shop spec, enforced when
    /// adding/removing spreads. 0 disables a rule. Counts are interior pages
    /// (2 per content spread).
    #[serde(default)]
    pub page_rule_min: u32,
    #[serde(default)]
    pub page_rule_max: u32,
    #[serde(default)]
    pub page_rule_multiple: u32,
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
            print_dpi: 300.0,
            next_spread_id: 2,
            next_text_id: 500_000_000,
            endpapers: false,
            export_crop_marks: false,
            export_split_cover: false,
            export_body_pages: false,
            cover_wrap_mm: 0.0,
            print_spec_id: String::new(),
            export_cover_pages: false,
            page_rule_min: 0,
            page_rule_max: 0,
            page_rule_multiple: 0,
        }
    }

    pub fn add_spread(&mut self) {
        let id = self.next_spread_id;
        self.next_spread_id += 1;
        // The back cover (cover-as-pages mode) stays the last spread.
        let pos = if self.spreads.last().is_some_and(|s| s.kind == SpreadKind::CoverBack) {
            self.spreads.len() - 1
        } else {
            self.spreads.len()
        };
        self.spreads.insert(pos, Spread::new(id, SpreadKind::Content));
    }

    /// How many content spreads each add/remove must step by to keep the
    /// interior page count on the spec's multiple (1 when unconstrained —
    /// a spread is always 2 pages, so "multiple of 2" needs no stepping).
    pub fn spread_step(&self) -> usize {
        if self.page_rule_multiple > 2 {
            (self.page_rule_multiple as usize / 2).max(1)
        } else {
            1
        }
    }

    /// True if `step` more content spreads would stay within the spec's
    /// maximum interior page count.
    pub fn can_add_spreads(&self, step: usize) -> bool {
        self.page_rule_max == 0
            || self.interior_page_count() + 2 * step as u32 <= self.page_rule_max
    }

    /// True if `step` fewer content spreads would stay above both the spec's
    /// minimum page count and the structural minimum (cover + endpapers).
    pub fn can_remove_spreads(&self, step: usize) -> bool {
        let structural_min = if self.endpapers { 2 } else { 1 };
        let remaining = self.content_spread_count().saturating_sub(step);
        remaining >= structural_min && remaining as u32 * 2 >= self.page_rule_min
    }

    /// Append content spreads until the interior page count satisfies the
    /// spec's minimum and multiple. Returns how many spreads were added.
    pub fn enforce_page_count_rules(&mut self) -> usize {
        let mut added = 0;
        loop {
            let pages = self.interior_page_count();
            let below_min = self.page_rule_min > 0 && pages < self.page_rule_min;
            let off_multiple = self.page_rule_multiple > 1 && pages % self.page_rule_multiple != 0;
            let within_max = self.page_rule_max == 0 || pages + 2 <= self.page_rule_max;
            if !(below_min || off_multiple) || !within_max || added > 512 { break; }
            self.add_spread();
            added += 1;
        }
        added
    }

    pub fn remove_spread(&mut self, spread_idx: usize) {
        // Only content spreads are removable (never any cover variant).
        if self.spreads.get(spread_idx).is_none_or(|s| s.kind != SpreadKind::Content) { return; }
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
    /// "left"  → left page is non-printable (first content spread with endpapers enabled).
    /// "right" → right page is non-printable (last content spread with endpapers enabled).
    pub fn endpaper_side(&self, spread_idx: usize) -> Option<&'static str> {
        if !self.endpapers { return None; }
        if self.spreads.get(spread_idx).is_none_or(|s| s.kind != SpreadKind::Content) { return None; }
        let first = self.spreads.iter().position(|s| s.kind == SpreadKind::Content)?;
        let last  = self.spreads.iter().rposition(|s| s.kind == SpreadKind::Content)?;
        match (spread_idx == first, spread_idx == last) {
            (true, false)  => Some("left"),
            (false, true)  => Some("right"),
            (true, true)   => None, // only one content spread — shouldn't happen when endpapers are on
            (false, false) => None,
        }
    }

    /// Index of the last content spread (the highest index a spread may be
    /// moved to / removed from). Falls back to 0 for degenerate documents.
    pub fn last_content_idx(&self) -> usize {
        self.spreads.iter().rposition(|s| s.kind == SpreadKind::Content).unwrap_or(0)
    }

    /// Computed spine thickness in mm.
    pub fn spine_mm(&self) -> f32 {
        let linear = self.spine_mm_per_page * self.interior_page_count() as f32;
        linear.max(self.spine_min_mm)
    }

    /// Width of the given spread in mm.
    pub fn spread_width_mm(&self, spread: &Spread) -> f32 {
        match spread.kind {
            SpreadKind::Cover      => self.page_size.width_mm * 2.0 + self.spine_mm(),
            SpreadKind::CoverFront |
            SpreadKind::CoverBack  => self.page_size.width_mm,
            SpreadKind::Content    => self.page_size.width_mm * 2.0,
        }
    }

    /// Restructure the cover to match the cover-as-pages export mode:
    /// `true`  → split the wraparound cover into a standalone front-cover page
    ///           (first spread) and back-cover page (last spread),
    /// `false` → merge the two cover pages back into one wraparound spread.
    ///
    /// Background colours and text elements are carried over; the cover's
    /// frame layout is reset (a wraparound layout cannot be split losslessly).
    /// Returns true when the structure changed.
    pub fn set_cover_pages_mode(&mut self, pages: bool) -> bool {
        let page_w = self.page_size.width_mm;
        if pages {
            if self.spreads.first().is_none_or(|s| s.kind != SpreadKind::Cover) { return false; }
            let spine = self.spine_mm();
            let old = self.spreads.remove(0);

            let mut front = Spread::new(self.next_spread_id, SpreadKind::CoverFront);
            let mut back  = Spread::new(self.next_spread_id + 1, SpreadKind::CoverBack);
            self.next_spread_id += 2;

            // Single-page spreads keep left_bg == right_bg (renderers fill both halves).
            front.left_bg = old.right_bg.clone();
            front.right_bg = old.right_bg;
            back.left_bg = old.left_bg.clone();
            back.right_bg = old.left_bg;

            // Texts right of the spine centre belong to the front cover.
            for mut t in old.text_elements {
                if t.x_mm >= page_w + spine / 2.0 {
                    t.x_mm -= page_w + spine;
                    front.text_elements.push(t);
                } else {
                    back.text_elements.push(t);
                }
            }

            self.spreads.insert(0, front);
            self.spreads.push(back);
            self.current_spread = self.current_spread.min(self.spreads.len() - 1);
            true
        } else {
            if self.spreads.first().is_none_or(|s| s.kind != SpreadKind::CoverFront) { return false; }
            let front = self.spreads.remove(0);
            let back_idx = self.spreads.iter().position(|s| s.kind == SpreadKind::CoverBack);
            let back = back_idx.map(|i| self.spreads.remove(i));

            let mut cover = Spread::new(self.next_spread_id, SpreadKind::Cover);
            self.next_spread_id += 1;
            cover.right_bg = front.right_bg;
            let spine = self.spine_mm();
            for mut t in front.text_elements {
                t.x_mm += page_w + spine;
                cover.text_elements.push(t);
            }
            if let Some(back) = back {
                cover.left_bg = back.left_bg;
                cover.text_elements.extend(back.text_elements);
            }

            self.spreads.insert(0, cover);
            self.current_spread = self.current_spread.min(self.spreads.len() - 1);
            true
        }
    }

    /// Bring the cover structure in line with `export_cover_pages` — used when
    /// loading projects saved before the mode became structural (or saved with
    /// the flag but a wraparound cover).
    pub fn normalize_cover_structure(&mut self) -> bool {
        self.set_cover_pages_mode(self.export_cover_pages)
    }
}
