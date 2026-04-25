use wasm_bindgen::prelude::*;
use crate::page::TextElement;
use crate::PhotobookEditor;

#[wasm_bindgen]
impl PhotobookEditor {
    /// Add a new text element at (x_mm, y_mm) on the current spread.
    /// Returns the new element's unique ID.
    pub fn add_text_element(&mut self, x_mm: f32, y_mm: f32) -> u32 {
        let id = self.doc.next_text_id;
        self.doc.next_text_id += 1;
        let el = TextElement::new(id, x_mm, y_mm);
        self.doc.current_spread_mut().text_elements.push(el);
        id
    }

    /// Return JSON array of all text elements on the current spread.
    pub fn get_text_elements(&self) -> String {
        serde_json::to_string(&self.doc.current_spread().text_elements)
            .unwrap_or_else(|_| "[]".into())
    }

    /// Update a text element by full replacement (matched by id field in JSON).
    pub fn update_text_element(&mut self, json: &str) {
        let el: TextElement = match serde_json::from_str(json) {
            Ok(v) => v,
            Err(_) => return,
        };
        let spread = self.doc.current_spread_mut();
        if let Some(existing) = spread.text_elements.iter_mut().find(|e| e.id == el.id) {
            *existing = el;
        }
    }

    /// Delete the text element with `id` from the current spread.
    pub fn delete_text_element(&mut self, id: u32) {
        let spread = self.doc.current_spread_mut();
        spread.text_elements.retain(|e| e.id != id);
    }

    /// Quick position update for a text element (used during drag, avoids full JSON round-trip).
    pub fn move_text_element(&mut self, id: u32, x_mm: f32, y_mm: f32) {
        let spread = self.doc.current_spread_mut();
        if let Some(el) = spread.text_elements.iter_mut().find(|e| e.id == id) {
            el.x_mm = x_mm;
            el.y_mm = y_mm;
        }
    }
}
