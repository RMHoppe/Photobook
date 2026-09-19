//! JSON-lines adapter for scripts/test_outer_margins.py; uses the current native core.
use photobook_core::{grid_layout::GridLayout, PhotobookEditor};
use serde_json::{json, Value};
use std::io::{self, BufRead};

fn frames(ed: &PhotobookEditor) -> Value {
    serde_json::from_str(&ed.get_thumbnail_data(0, 200.0, 200.0)).unwrap()
}

fn main() {
    for line in io::stdin().lock().lines() {
        let req: Value = serde_json::from_str(&line.unwrap()).unwrap();
        let mut ed = PhotobookEditor::new(200.0, 200.0, 0.0);
        let mut state: Value = serde_json::from_str(&ed.save_state()).unwrap();
        let mut spread = state["spreads"][0].clone();
        spread["kind"] = json!("CoverFront");
        spread["grid_layout"] = serde_json::to_value(GridLayout::new()).unwrap();
        state["spreads"] = json!([spread]);
        state["current_spread"] = json!(0);
        state["export_cover_pages"] = json!(true);
        assert!(ed.load_state(&state.to_string()));
        let id = frames(&ed)[0]["id"].as_u64().unwrap() as u32;
        let rows = req["rows"].as_array().unwrap();
        assert!(ed.split_face_into_n(id, "h", rows.len() as u32));
        let mut row_frames = frames(&ed).as_array().unwrap().clone();
        row_frames.sort_by(|a, b| {
            a["rect"]["y"]
                .as_f64()
                .partial_cmp(&b["rect"]["y"].as_f64())
                .unwrap()
        });
        for (row, cuts) in row_frames.iter().zip(rows) {
            let mut id = row["id"].as_u64().unwrap() as u32;
            let mut prev = 0.0;
            for cut in cuts.as_array().unwrap() {
                let x = cut.as_f64().unwrap() as f32;
                assert!(ed.split_face_at(id, "v", (x - prev) / (1.0 - prev)));
                let fs = frames(&ed);
                id = fs
                    .as_array()
                    .unwrap()
                    .iter()
                    .find(|f| {
                        (f["rect"]["y"].as_f64().unwrap() - row["rect"]["y"].as_f64().unwrap())
                            .abs()
                            < 0.01
                            && (f["rect"]["x"].as_f64().unwrap() - x as f64 * 200.0).abs() < 0.01
                    })
                    .unwrap()["id"]
                    .as_u64()
                    .unwrap() as u32;
                prev = x;
            }
        }
        let mut fs = frames(&ed).as_array().unwrap().clone();
        fs.sort_by(|a, b| {
            a["rect"]["y"]
                .as_f64()
                .partial_cmp(&b["rect"]["y"].as_f64())
                .unwrap()
                .then(
                    a["rect"]["x"]
                        .as_f64()
                        .partial_cmp(&b["rect"]["x"].as_f64())
                        .unwrap(),
                )
        });
        let mut ids: Vec<u32> = fs
            .iter()
            .map(|f| f["id"].as_u64().unwrap() as u32)
            .collect();
        // Give each interior side half of the requested initial gap.
        let mut state: Value = serde_json::from_str(&ed.save_state()).unwrap();
        for edge in state["spreads"][0]["grid_layout"]["edges"]
            .as_object_mut()
            .unwrap()
            .values_mut()
        {
            if edge["is_boundary"] == false {
                edge["half_gap"] = json!(req["gap"].as_f64().unwrap() / 2.0);
            }
        }
        assert!(ed.load_state(&state.to_string()));
        ed.select_face(photobook_core::grid_layout::OUTER_FACE);
        for index in req["selection"].as_array().unwrap() {
            ed.toggle_selection(ids[index.as_u64().unwrap() as usize]);
        }
        let before = frames(&ed);
        let offsets = ed.get_inner_edge_offsets();
        let margins = ed.get_selection_outer_margins();
        ed.snapshot_undo();
        for step in req["steps"].as_array().unwrap() {
            ed.set_selection_outer_margins_and_adjust(&step.to_string(), &offsets, &margins);
        }
        let margin_after = frames(&ed);
        let mut roundtrip = PhotobookEditor::new(200.0, 200.0, 0.0);
        assert!(roundtrip.load_state(&ed.save_state()));
        let margin_reloaded = frames(&roundtrip);
        let readback: Value = serde_json::from_str(&ed.get_selection_outer_margins()).unwrap();
        assert!(ed.undo());
        let margin_undone = frames(&ed);
        assert!(ed.redo());
        let margin_redone = frames(&ed);
        if req.get("pinwheel").is_some() {
            ed.snapshot_undo();
        }
        // Spawn via the same begin/update/end API used by the pointer tool.
        // Keep A–I identities and append the new panel as J.
        if let Some(pinwheel) = req.get("pinwheel") {
            let anchor = ids[pinwheel["anchor_index"].as_u64().unwrap() as usize];
            let junctions: Value = serde_json::from_str(&ed.get_xjunctions()).unwrap();
            let junction = junctions
                .as_array()
                .unwrap()
                .iter()
                .find(|j| j["bl_id"].as_u64() == Some(anchor as u64))
                .expect("the anchor's top-right corner must be an X-junction");
            let jx = junction["nx"].as_f64().unwrap() as f32;
            let jy = junction["ny"].as_f64().unwrap() as f32;
            ed.begin_pinwheel_spawn(
                junction["tl_id"].as_u64().unwrap() as u32,
                junction["tr_id"].as_u64().unwrap() as u32,
                junction["bl_id"].as_u64().unwrap() as u32,
                junction["br_id"].as_u64().unwrap() as u32,
                jx,
                jy,
            );
            let radius = pinwheel["size_mm"].as_f64().unwrap() as f32 / 400.0;
            ed.update_pinwheel_spawn(jx + radius, jy - radius);
            ed.end_pinwheel_spawn();
            let centers: Vec<u32> = serde_json::from_str(&ed.get_pinwheel_centers()).unwrap();
            assert_eq!(centers.len(), 1, "pinwheel must create exactly one panel");
            ids.push(centers[0]);
            assert_eq!(frames(&ed).as_array().unwrap().len(), ids.len());
        }
        let after = frames(&ed);
        let saved = ed.save_state();
        assert!(ed.undo());
        let undone = frames(&ed);
        assert!(ed.redo());
        let redone = frames(&ed);
        assert!(ed.load_state(&saved));
        println!(
            "{}",
            json!({"ids": ids, "before": before, "after": after,
            "margin_after": margin_after, "margin_reloaded": margin_reloaded, "margin_undone": margin_undone, "margin_redone": margin_redone,
            "undone": undone, "redone": redone, "reloaded": frames(&ed), "readback": readback})
        );
    }
}
