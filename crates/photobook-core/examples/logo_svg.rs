//! Renders SVG logo variants from a real Coincident-Edge Grid layout.
//!
//! The mark is a non-guillotine (pinwheel) layout — the thing the grid model
//! can do that plain nested splits cannot. It is built with the same
//! operations the editor uses (`split_face`, the pinwheel spawn at an
//! X-junction) and then drawn straight from the resulting faces and edges.
//!
//! Usage: `cargo run --example logo_svg -- <out_dir>`   (default: design/logo)

use photobook_core::grid_layout::{FaceId, GridLayout, SplitAxis};
use photobook_core::PhotobookEditor;
use serde_json::{json, Value};
use std::fmt::Write as _;
use std::fs;
use std::path::Path;

// ---------------------------------------------------------------------------
// Layout construction
// ---------------------------------------------------------------------------

/// Build the eight-face pinwheel layout. `cw` flips the pinwheel's rotation
/// sense, which mirrors the whole composition.
fn build_layout(cw: bool) -> (GridLayout, Vec<FaceId>) {
    // 1. A 2×2 grid with an X-junction at (0.6, 0.5).
    let mut g = GridLayout::new();
    let root = *g.faces.keys().next().expect("fresh layout has one face");
    let right = g.split_face(root, 0.6, SplitAxis::Vertical).unwrap();
    g.split_face(root, 0.5, SplitAxis::Horizontal).unwrap();
    g.split_face(right, 0.5, SplitAxis::Horizontal).unwrap();

    // 2. Spawn the pinwheel through the editor so the real interaction code
    //    rotates the four arms and inserts the centre face.
    let mut ed = PhotobookEditor::new(200.0, 200.0, 0.0);
    let mut state: Value = serde_json::from_str(&ed.save_state()).unwrap();
    let mut spread = state["spreads"][0].clone();
    spread["kind"] = json!("CoverFront"); // single page → unit square
    spread["grid_layout"] = serde_json::to_value(&g).unwrap();
    state["spreads"] = json!([spread]);
    state["current_spread"] = json!(0);
    state["export_cover_pages"] = json!(true);
    assert!(ed.load_state(&state.to_string()));

    let junctions: Vec<Value> = serde_json::from_str(&ed.get_xjunctions()).unwrap();
    let j = &junctions[0];
    let (nx, ny) = (j["nx"].as_f64().unwrap() as f32, j["ny"].as_f64().unwrap() as f32);
    let id = |k: &str| j[k].as_u64().unwrap() as u32;
    ed.begin_pinwheel_spawn(id("tl_id"), id("tr_id"), id("bl_id"), id("br_id"), nx, ny);
    // Drag distance sets the centre size; the quadrant sets the rotation sense.
    let (dx, dy) = (0.12, 0.105);
    let mx = if cw { nx + dx } else { nx - dx };
    ed.update_pinwheel_spawn(mx, ny - dy);
    ed.end_pinwheel_spawn();

    let state: Value = serde_json::from_str(&ed.save_state()).unwrap();
    let mut g: GridLayout = serde_json::from_value(state["spreads"][0]["grid_layout"].clone()).unwrap();
    let centers: Vec<FaceId> = serde_json::from_value(state["spreads"][0]["pinwheel_centers"].clone()).unwrap();

    // 3. Sub-divide two of the arms for a livelier rhythm. Cuts are placed as
    //    fractions of each face so the clockwise (mirrored) arms work too.
    let m = |x: f32| if cw { 1.0 - x } else { x };
    let top = g.face_at(m(0.1), 0.1).unwrap();
    split_at_frac(&mut g, top, m(1.0 / 3.0), SplitAxis::Vertical);
    let side = g.face_at(m(0.1), 0.6).unwrap();
    let bottom = split_at_frac(&mut g, side, 2.0 / 3.0, SplitAxis::Horizontal);
    split_at_frac(&mut g, bottom, 0.5, SplitAxis::Vertical);

    (g, centers)
}

/// Split `face` at `frac` of its own extent along `axis`; returns the new face.
fn split_at_frac(g: &mut GridLayout, face: FaceId, frac: f32, axis: SplitAxis) -> FaceId {
    let (x, y, w, h) = g.face_rect(face).unwrap();
    let pos = match axis {
        SplitAxis::Vertical => x + w * frac,
        SplitAxis::Horizontal => y + h * frac,
    };
    g.split_face(face, pos, axis).unwrap()
}

/// Give one face per-side margins — in the CEG these are the `half_gap`s of
/// the face's own four edges, exactly what the editor's margin panel writes.
/// `probe` is a point inside the face; insets are (top, right, bottom, left)
/// in normalised units.
fn set_margins(g: &mut GridLayout, probe: (f32, f32), insets: [f32; 4]) {
    let id = g.face_at(probe.0, probe.1).expect("probe inside a face");
    let f = g.faces[&id].clone();
    let [t, r, b, l] = insets;
    g.set_half_gap(f.top_edge_id, t);
    g.set_half_gap(f.right_edge_id, r);
    g.set_half_gap(f.bottom_edge_id, b);
    g.set_half_gap(f.left_edge_id, l);
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

struct Style {
    name: &'static str,
    size: f32,
    /// Colour of the dividers (what shows through the gaps between faces).
    line: &'static str,
    /// Full width of an interior divider, px.
    gap: f32,
    /// Width of the outer frame, px.
    border: f32,
    /// Corner radius of each face and of the whole mark, px.
    face_rx: f32,
    outer_rx: f32,
    /// Fill per face, indexed by reading order (top→bottom, left→right).
    fills: [&'static str; 8],
    /// Fill for the pinwheel centre, overriding `fills`.
    center: Option<&'static str>,
    /// Optional wordmark to the right of the mark.
    wordmark: Option<(&'static str, &'static str)>,
    cw: bool,
    /// Optional per-side margins on one face: (probe point, [top, right, bottom, left]).
    margins: Option<((f32, f32), [f32; 4])>,
    /// Extra `<defs>` (gradients) that `fills` may reference via `url(#id)`.
    defs: &'static str,
    /// Stroke drawn around every face (outline styles); `None` for filled tiles.
    stroke: Option<(&'static str, f32)>,
}

fn fmt(v: f32) -> String {
    let s = format!("{:.2}", v);
    s.trim_end_matches('0').trim_end_matches('.').to_string()
}

fn render(g: &GridLayout, centers: &[FaceId], st: &Style) -> String {
    let s = st.size;
    let mut g = g.clone();
    if let Some((probe, insets)) = st.margins { set_margins(&mut g, probe, insets); }
    let g = &g;
    let mut faces: Vec<(FaceId, (f32, f32, f32, f32))> =
        g.faces.keys().map(|&id| (id, g.face_rect(id).unwrap())).collect();
    faces.sort_by(|a, b| a.1 .1.total_cmp(&b.1 .1).then(a.1 .0.total_cmp(&b.1 .0)));

    let (vw, text) = match st.wordmark {
        Some((word, color)) => {
            let font = s * 0.9;
            let x = s + s * 0.16;
            // Baseline on the mark's bottom edge ("Photobook" has no descenders).
            let y = s - st.border;
            // Helvetica Bold advance widths (per em) so the viewBox hugs the text;
            // unknown glyphs fall back to a generous average.
            let advance = |c: char| match c {
                'P' => 0.667, 'h' | 'o' | 'b' | 'd' | 'p' | 'q' => 0.611, 't' => 0.333,
                'k' | 'a' | 'e' | 'n' | 'u' | 'v' | 'x' | 'y' => 0.556, 'i' | 'l' | 'j' => 0.278,
                'r' | 's' | 'f' => 0.333, 'c' | 'g' => 0.556, 'm' | 'w' => 0.889,
                ' ' => 0.278, _ => 0.66,
            };
            let letter_spacing = -font * 0.02;
            let n = word.chars().count() as f32;
            let text_w: f32 = word.chars().map(advance).sum::<f32>() * font + n * letter_spacing;
            // Small right bearing so the last glyph's ink never touches the edge.
            let w = x + text_w + font * 0.06;
            (w, format!(
                "  <text x=\"{}\" y=\"{}\" font-family=\"Helvetica Neue, Helvetica, Arial, sans-serif\" \
                 font-weight=\"600\" font-size=\"{}\" letter-spacing=\"{}\" fill=\"{}\">{}</text>\n",
                fmt(x), fmt(y), fmt(font), fmt(letter_spacing), color, word))
        }
        None => (s, String::new()),
    };

    let mut out = String::new();
    writeln!(out, "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {} {}\" width=\"{}\" height=\"{}\">",
        fmt(vw), fmt(s), fmt(vw), fmt(s)).unwrap();
    writeln!(out, "  <!-- Generated by examples/logo_svg.rs from a Coincident-Edge Grid layout ({}) -->", st.name).unwrap();
    if !st.defs.is_empty() { writeln!(out, "  <defs>{}</defs>", st.defs).unwrap(); }
    writeln!(out, "  <rect width=\"{}\" height=\"{}\" rx=\"{}\" fill=\"{}\"/>", fmt(s), fmt(s), fmt(st.outer_rx), st.line).unwrap();
    let stroke = st.stroke.map_or(String::new(), |(c, w)| format!(" stroke=\"{}\" stroke-width=\"{}\"", c, fmt(w)));

    for (i, (id, (x, y, w, h))) in faces.iter().enumerate() {
        let f = &g.faces[id];
        // Every face owns its four edges; boundary edges get the frame width,
        // interior ones half the divider, plus the edge's own half_gap (the
        // per-side margin) — the same rule the editor's gaps use.
        let inset = |eid| {
            let base = if g.is_boundary_edge(eid) { st.border } else { st.gap * 0.5 };
            base + g.get_half_gap(eid).unwrap_or(0.0) * s
        };
        let l = inset(f.left_edge_id);
        let t = inset(f.top_edge_id);
        let r = inset(f.right_edge_id);
        let b = inset(f.bottom_edge_id);
        let fill = if centers.contains(id) { st.center.unwrap_or(st.fills[i]) } else { st.fills[i] };
        writeln!(out, "  <rect x=\"{}\" y=\"{}\" width=\"{}\" height=\"{}\" rx=\"{}\" fill=\"{}\"{}/>",
            fmt(x * s + l), fmt(y * s + t), fmt(w * s - l - r), fmt(h * s - t - b), fmt(st.face_rx), fill, stroke).unwrap();
    }
    out.push_str(&text);
    out.push_str("</svg>\n");
    out
}

// ---------------------------------------------------------------------------
// Variants
// ---------------------------------------------------------------------------

const WHITE: &str = "#F5F2EA";
const RED: &str = "#D8292F";
const BLUE: &str = "#1F4FA3";
const YELLOW: &str = "#F5CF1B";
const BLACK: &str = "#111111";

// Web-app palette (web/style.css): --bg, --surface, --canvas-bg, --accent,
// the amber used for low-DPI / pending states, and --text.
const APP_BG: &str = "#1e1e1e";
const APP_SURFACE: &str = "#2a2a2a";
const APP_CANVAS: &str = "#3c3c3c";
const APP_ACCENT: &str = "#4a90e2";
const APP_AMBER: &str = "#e0a030";
const APP_TEXT: &str = "#e0e0e0";
// Warm neutrals for the tiles, desaturated a little so they sit on the dark UI.
const SAND: &str = "#cfc4b2";
const LINEN: &str = "#e2d9ca";
const CLAY: &str = "#c4573b";

fn variants() -> Vec<Style> {
    let base = Style {
        name: "", size: 256.0, line: BLACK, gap: 12.0, border: 12.0, face_rx: 0.0, outer_rx: 0.0,
        fills: [WHITE; 8], center: None, wordmark: None, cw: false, margins: None,
        defs: "", stroke: None,
    };
    // Probe points inside faces of the counter-clockwise layout.
    let bottom_mid = (0.36, 0.9);
    let top_left = (0.1, 0.1);
    vec![
        // Classic Mondrian: mostly white, the three primaries on the pinwheel.
        Style { name: "mondrian-classic",
            fills: [WHITE, WHITE, BLUE, WHITE, YELLOW, RED, WHITE, WHITE], ..base },
        // Same, with a wider right margin on the bottom-middle tile so its right
        // edge no longer lines up with the face above — the editor's per-side
        // margins, showing that gaps needn't be uniform.
        Style { name: "mondrian-classic-inset",
            fills: [WHITE, WHITE, BLUE, WHITE, YELLOW, RED, WHITE, WHITE],
            margins: Some((bottom_mid, [0.0, 0.07, 0.0, 0.0])), ..base },
        // Inset on all four sides but unequal, right still the largest.
        Style { name: "mondrian-classic-float",
            fills: [WHITE, WHITE, BLUE, WHITE, YELLOW, RED, WHITE, WHITE],
            margins: Some((bottom_mid, [0.02, 0.08, 0.02, 0.03])), ..base },
        // Inset tile in a colour, so the extra black reads as a deliberate frame.
        Style { name: "mondrian-classic-inset-red",
            fills: [WHITE, WHITE, BLUE, WHITE, YELLOW, RED, WHITE, RED],
            margins: Some((bottom_mid, [0.0, 0.07, 0.0, 0.0])), ..base },
        // Alternative: a small top margin on the top-left tile instead.
        Style { name: "mondrian-classic-topleft",
            fills: [WHITE, WHITE, BLUE, WHITE, YELLOW, RED, WHITE, WHITE],
            margins: Some((top_left, [0.05, 0.0, 0.0, 0.0])), ..base },
        // ---- Muted-warm tiles on the web app's palette ----

        // Warm neutrals + the app's accent blue and amber, gaps in --bg.
        Style { name: "app-warm", line: APP_BG, gap: 8.0, border: 0.0, face_rx: 3.0,
            fills: [SAND, LINEN, APP_ACCENT, LINEN, APP_AMBER, CLAY, SAND, LINEN],
            margins: Some((top_left, [0.05, 0.0, 0.0, 0.0])), ..base },
        // Same on a --surface card with rounded outer corners (sidebar / header chip).
        Style { name: "app-warm-card", line: APP_SURFACE, gap: 8.0, border: 10.0, face_rx: 3.0, outer_rx: 16.0,
            fills: [SAND, LINEN, APP_ACCENT, LINEN, APP_AMBER, CLAY, SAND, LINEN],
            margins: Some((top_left, [0.05, 0.0, 0.0, 0.0])), ..base },
        // Quieter: neutrals in the app's greys, only accent + amber + clay coloured.
        Style { name: "app-dark", line: APP_BG, gap: 8.0, border: 0.0, face_rx: 3.0,
            fills: [APP_CANVAS, "#4a4a4a", APP_ACCENT, "#4a4a4a", APP_AMBER, CLAY, APP_CANVAS, "#4a4a4a"],
            margins: Some((top_left, [0.05, 0.0, 0.0, 0.0])), ..base },
        // Header lockup: app-warm mark + wordmark in --text.
        Style { name: "app-warm-wordmark", size: 96.0, line: APP_BG, gap: 3.0, border: 0.0, face_rx: 1.5,
            fills: [SAND, LINEN, APP_ACCENT, LINEN, APP_AMBER, CLAY, SAND, LINEN],
            margins: Some((top_left, [0.05, 0.0, 0.0, 0.0])),
            wordmark: Some(("Photobook", APP_TEXT)), ..base },
        // Bare mark for the toolbar: gaps in --surface so it sits flat on the header bar.
        Style { name: "app-warm-mark", size: 64.0, line: APP_SURFACE, gap: 4.0, border: 0.0, face_rx: 1.0,
            fills: [SAND, LINEN, APP_ACCENT, LINEN, APP_AMBER, CLAY, SAND, LINEN],
            margins: Some((top_left, [0.05, 0.0, 0.0, 0.0])), ..base },
        // Favicon on --bg with rounded corners.
        Style { name: "app-warm-favicon", size: 64.0, line: APP_BG, gap: 4.0, border: 4.0, outer_rx: 10.0,
            fills: [SAND, LINEN, APP_ACCENT, LINEN, APP_AMBER, CLAY, SAND, LINEN],
            margins: Some((top_left, [0.05, 0.0, 0.0, 0.0])), ..base },

        // ---- Less De Stijl: drop the primaries, the black lines, or both ----

        // Muted, warm palette (terracotta / ochre / teal / sand) on ivory gaps.
        Style { name: "muted-warm", line: "#F3EEE4", gap: 8.0, border: 0.0, face_rx: 3.0,
            fills: ["#D9CDB8", "#E4DACB", "#3E6F73", "#E4DACB", "#D9A441", "#C4573B", "#D9CDB8", "#E4DACB"],
            margins: Some((top_left, [0.05, 0.0, 0.0, 0.0])), ..base },
        // Cool photographic tones — sea, slate, sand — thin dark gaps.
        Style { name: "muted-cool", line: "#1F2A33", gap: 6.0, border: 6.0, outer_rx: 12.0,
            fills: ["#D8D3C8", "#C5CFD6", "#2F6D8C", "#D8D3C8", "#E6B85C", "#7FA3B5", "#B8C2C9", "#D8D3C8"], ..base },
        // Gradient "photos" in the frames: sky, sunset, foliage, sea.
        Style { name: "photo-tiles", line: "#FFFFFF", gap: 8.0, border: 0.0, face_rx: 2.0,
            defs: concat!(
                "<linearGradient id=\"sky\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\"><stop offset=\"0\" stop-color=\"#7FB3E0\"/><stop offset=\"1\" stop-color=\"#DCEAF6\"/></linearGradient>",
                "<linearGradient id=\"dusk\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\"><stop offset=\"0\" stop-color=\"#F2A65A\"/><stop offset=\"1\" stop-color=\"#C0424F\"/></linearGradient>",
                "<linearGradient id=\"leaf\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\"><stop offset=\"0\" stop-color=\"#6FA86B\"/><stop offset=\"1\" stop-color=\"#2F6B45\"/></linearGradient>",
                "<linearGradient id=\"sea\" x1=\"0\" y1=\"0\" x2=\"0\" y2=\"1\"><stop offset=\"0\" stop-color=\"#2B6F8E\"/><stop offset=\"1\" stop-color=\"#134A63\"/></linearGradient>",
                "<linearGradient id=\"sand\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"0\"><stop offset=\"0\" stop-color=\"#E8D9B8\"/><stop offset=\"1\" stop-color=\"#CDB88F\"/></linearGradient>",
                "<linearGradient id=\"stone\" x1=\"0\" y1=\"0\" x2=\"1\" y2=\"1\"><stop offset=\"0\" stop-color=\"#B9B4AD\"/><stop offset=\"1\" stop-color=\"#8C8781\"/></linearGradient>"),
            fills: ["url(#sand)", "url(#sky)", "url(#leaf)", "url(#stone)", "url(#dusk)", "url(#sea)", "url(#sky)", "url(#sand)"], ..base },
        // Greys with one accent — matches a neutral UI, accent on the pinwheel centre.
        Style { name: "mono-accent", line: "#FFFFFF", gap: 8.0, border: 0.0, face_rx: 4.0,
            fills: ["#D5D5D5", "#BDBDBD", "#8F8F8F", "#C9C9C9", "#F0A030", "#6E6E6E", "#BDBDBD", "#D5D5D5"], ..base },
        // Line art: thin grey outlines on white, only the centre filled.
        Style { name: "outline", line: "#FFFFFF", gap: 10.0, border: 4.0,
            fills: ["none"; 8], center: Some("#F0A030"), stroke: Some(("#3A3A3A", 2.5)), ..base },
        // Blueprint: single hue, faces as tints, no black at all.
        Style { name: "blueprint", line: "#173F6B", gap: 6.0, border: 6.0, outer_rx: 12.0,
            fills: ["#2F5F94", "#4A7DB4", "#A9C4E2", "#4A7DB4", "#F2F6FB", "#7FA5CF", "#2F5F94", "#4A7DB4"], ..base },

        // Every face coloured — louder, reads well at small sizes.
        Style { name: "mondrian-bold",
            fills: [WHITE, RED, BLUE, YELLOW, WHITE, RED, BLUE, WHITE], ..base },
        // Mirrored composition (clockwise pinwheel), centre highlighted.
        Style { name: "mondrian-mirrored", cw: true,
            fills: [BLUE, WHITE, WHITE, WHITE, WHITE, RED, WHITE, WHITE], center: Some(YELLOW), ..base },
        // App-icon feel: white gaps, rounded faces, no hard frame.
        Style { name: "soft-tiles", line: "#FFFFFF", gap: 10.0, border: 0.0, face_rx: 10.0, outer_rx: 0.0,
            fills: ["#E9E4D8", "#E9E4D8", BLUE, "#E9E4D8", YELLOW, RED, "#E9E4D8", "#E9E4D8"], ..base },
        // For a dark landing page: charcoal tiles, primaries as accents.
        Style { name: "dark", line: "#0B0B0B", gap: 8.0, border: 0.0, face_rx: 4.0, outer_rx: 24.0,
            fills: ["#2A2A2A", "#2A2A2A", BLUE, "#2A2A2A", YELLOW, RED, "#2A2A2A", "#2A2A2A"], ..base },
        // Favicon: heavier lines, fewer colours, survives 32 px.
        Style { name: "favicon", size: 64.0, gap: 6.0, border: 6.0, outer_rx: 8.0,
            fills: [WHITE, WHITE, BLUE, WHITE, YELLOW, RED, WHITE, WHITE], ..base },
        // Mark + wordmark for the landing-page header.
        Style { name: "wordmark", size: 96.0, gap: 5.0, border: 5.0,
            fills: [WHITE, WHITE, BLUE, WHITE, YELLOW, RED, WHITE, WHITE],
            wordmark: Some(("Photobook", BLACK)), ..base },
    ]
}

fn main() {
    let out_dir = std::env::args().nth(1).unwrap_or_else(|| "design/logo".into());
    let out_dir = Path::new(&out_dir);
    fs::create_dir_all(out_dir).expect("create output dir");

    let layouts = [build_layout(false), build_layout(true)];
    for st in variants() {
        let (g, centers) = &layouts[st.cw as usize];
        let path = out_dir.join(format!("logo-{}.svg", st.name));
        fs::write(&path, render(g, centers, &st)).expect("write svg");
        println!("wrote {} ({} faces)", path.display(), g.faces.len());
    }
}
