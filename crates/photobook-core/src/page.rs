use serde::{Deserialize, Serialize};
use crate::bsp::BspTree;

#[derive(Clone, Debug, Serialize, Deserialize, PartialEq)]
pub enum SpreadKind {
    /// Front cover + spine + back cover as one unified layout.
    Cover,
    /// Two interior pages side by side.
    Content,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct Spread {
    pub id: u32,
    pub tree: BspTree,
    pub kind: SpreadKind,
    pub label: String,
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
    next_spread_id: u32,
}

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
            next_spread_id: 2,
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
