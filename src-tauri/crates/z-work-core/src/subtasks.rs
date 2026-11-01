//! Extracts list items from a TipTap document for the spreadsheet's Subtasks column.

use serde_json::Value;

fn inline_text(node: &Value, out: &mut String) {
    match node.get("type").and_then(Value::as_str) {
        Some("text") => {
            if let Some(t) = node.get("text").and_then(Value::as_str) {
                out.push_str(t);
            }
        }
        Some("hardBreak") => out.push(' '),
        _ => {
            for child in children(node) {
                inline_text(child, out);
            }
        }
    }
}

fn children(node: &Value) -> &[Value] {
    node.get("content")
        .and_then(Value::as_array)
        .map_or(&[], Vec::as_slice)
}

fn is_list(kind: Option<&str>) -> bool {
    matches!(kind, Some("orderedList" | "bulletList" | "taskList"))
}

fn walk_list(list: &Value, depth: usize, lines: &mut Vec<String>) {
    let kind = list.get("type").and_then(Value::as_str);
    let mut number = list
        .get("attrs")
        .and_then(|a| a.get("start"))
        .and_then(Value::as_i64)
        .unwrap_or(1);
    for item in children(list) {
        let marker = match kind {
            Some("orderedList") => {
                let m = format!("{number}.");
                number = number.saturating_add(1);
                m
            }
            Some("taskList") => {
                let checked = item
                    .get("attrs")
                    .and_then(|a| a.get("checked"))
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if checked {
                    "[x]".to_owned()
                } else {
                    "[ ]".to_owned()
                }
            }
            _ => "\u{2022}".to_owned(),
        };
        let mut parts: Vec<String> = Vec::new();
        for child in children(item) {
            if !is_list(child.get("type").and_then(Value::as_str)) {
                let mut text = String::new();
                inline_text(child, &mut text);
                let text = text.trim().to_owned();
                if !text.is_empty() {
                    parts.push(text);
                }
            }
        }
        lines.push(
            format!("{}{marker} {}", "    ".repeat(depth), parts.join(" "))
                .trim_end()
                .to_owned(),
        );
        for child in children(item) {
            if is_list(child.get("type").and_then(Value::as_str)) {
                walk_list(child, depth + 1, lines);
            }
        }
    }
}

fn walk_blocks(node: &Value, lines: &mut Vec<String>) {
    for child in children(node) {
        if is_list(child.get("type").and_then(Value::as_str)) {
            walk_list(child, 0, lines);
        } else {
            walk_blocks(child, lines);
        }
    }
}

/// One line per list item with numbering and nesting kept. Paragraphs outside lists are left out.
#[must_use]
pub fn extract(doc: &Value) -> String {
    let mut lines = Vec::new();
    walk_blocks(doc, &mut lines);
    lines.join("\n")
}

/// All the text of a document, one line per block, for showing words that have nowhere else to go.
#[must_use]
pub fn plain_text(doc: &Value) -> String {
    fn walk(node: &Value, lines: &mut Vec<String>) {
        let inline = children(node).iter().any(|c| {
            matches!(
                c.get("type").and_then(Value::as_str),
                Some("text" | "hardBreak")
            )
        });
        if inline {
            let mut line = String::new();
            inline_text(node, &mut line);
            lines.push(line);
        } else {
            for child in children(node) {
                walk(child, lines);
            }
        }
    }
    let mut lines = Vec::new();
    walk(doc, &mut lines);
    lines.join("\n")
}

/// A task-list item, the unit that can carry its own tracked time.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Item {
    pub id: String,
    pub text: String,
    pub checked: bool,
}

fn item_text(item: &Value) -> String {
    let mut text = String::new();
    for child in children(item) {
        if !is_list(child.get("type").and_then(Value::as_str)) {
            inline_text(child, &mut text);
        }
    }
    text.trim().to_owned()
}

fn walk_items(node: &Value, out: &mut Vec<Item>) {
    if node.get("type").and_then(Value::as_str) == Some("taskItem") {
        let attrs = node.get("attrs");
        out.push(Item {
            id: attrs
                .and_then(|a| a.get("subtaskId"))
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            text: item_text(node),
            checked: attrs
                .and_then(|a| a.get("checked"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
        });
    }
    for child in children(node) {
        walk_items(child, out);
    }
}

/// Every task-list item, in document order.
#[must_use]
pub fn items(doc: &Value) -> Vec<Item> {
    let mut out = Vec::new();
    walk_items(doc, &mut out);
    out
}

fn map_items(node: &mut Value, f: &mut dyn FnMut(&mut serde_json::Map<String, Value>, &str)) {
    if node.get("type").and_then(Value::as_str) == Some("taskItem") {
        let text = item_text(node);
        if let Some(obj) = node.as_object_mut() {
            let attrs = obj
                .entry("attrs")
                .or_insert_with(|| Value::Object(serde_json::Map::new()));
            if let Some(a) = attrs.as_object_mut() {
                f(a, &text);
            }
        }
    }
    if let Some(content) = node.get_mut("content").and_then(Value::as_array_mut) {
        for child in content {
            map_items(child, f);
        }
    }
}

/// For a copy: keeps the text, unticks everything and forgets ids, so no time carries over.
#[must_use]
pub fn reset(doc: &Value) -> Value {
    let mut out = doc.clone();
    map_items(&mut out, &mut |attrs, _| {
        attrs.insert("checked".to_owned(), Value::Bool(false));
        attrs.remove("subtaskId");
    });
    out
}

/// Gives each task-list item a stable id. An editor may send items back without one, so a missing id
/// is recovered from the previous version by text, then by position, and only then generated.
#[must_use]
pub fn assign_ids(doc: &Value, previous: Option<&Value>) -> Value {
    let old = previous.map(items).unwrap_or_default();
    let mut used: Vec<String> = items(doc)
        .into_iter()
        .map(|i| i.id)
        .filter(|i| !i.is_empty())
        .collect();
    let mut out = doc.clone();
    let mut position = 0usize;
    let mut seen: Vec<String> = Vec::new();
    map_items(&mut out, &mut |attrs, text| {
        let here = position;
        position += 1;
        let current = attrs.get("subtaskId").and_then(Value::as_str);
        if let Some(c) = current.filter(|c| !c.is_empty() && !seen.iter().any(|s| s == c)) {
            seen.push(c.to_owned());
            return;
        }
        let by_text = old
            .iter()
            .find(|o| o.text == text && !o.id.is_empty() && !used.contains(&o.id));
        let by_place = old
            .get(here)
            .filter(|o| !o.id.is_empty() && !used.contains(&o.id));
        let id = by_text
            .or(by_place)
            .map_or_else(|| uuid::Uuid::new_v4().to_string(), |o| o.id.clone());
        used.push(id.clone());
        seen.push(id.clone());
        attrs.insert("subtaskId".to_owned(), Value::String(id));
    });
    out
}

/// Fills in missing or repeated ids from the task id and position, so every device derives the same
/// ones for a list written before subtasks had ids. `None` when nothing needs changing.
#[must_use]
pub fn stable_ids(task_id: &str, doc: &Value) -> Option<Value> {
    let prefix: String = task_id.chars().take(40).collect();
    let mut out = doc.clone();
    let mut position = 0usize;
    let mut seen: Vec<String> = Vec::new();
    let mut changed = false;
    map_items(&mut out, &mut |attrs, _| {
        let here = position;
        position += 1;
        let current = attrs.get("subtaskId").and_then(Value::as_str);
        if let Some(c) = current.filter(|c| !c.is_empty() && !seen.iter().any(|s| s == c)) {
            seen.push(c.to_owned());
            return;
        }
        let id = format!("{prefix}-{here}");
        seen.push(id.clone());
        attrs.insert("subtaskId".to_owned(), Value::String(id));
        changed = true;
    });
    changed.then_some(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn tasks_doc(items: &[(&str, bool, Option<&str>)]) -> Value {
        let list: Vec<Value> = items
            .iter()
            .map(|(t, c, id)| {
                let mut attrs = json!({"checked": c});
                if let Some(id) = id {
                    attrs["subtaskId"] = json!(id);
                }
                json!({"type":"taskItem","attrs":attrs,"content":[{"type":"paragraph","content":[{"type":"text","text":t}]}]})
            })
            .collect();
        json!({"type":"doc","content":[{"type":"taskList","content":list}]})
    }

    #[test]
    fn stable_ids_fill_gaps_the_same_way_on_every_device_and_repeats_are_fixed() {
        let old = tasks_doc(&[("a", false, None), ("b", true, None)]);
        let once = stable_ids("task-1", &old).unwrap();
        assert_eq!(once, stable_ids("task-1", &old).unwrap());
        let ids: Vec<String> = items(&once).into_iter().map(|i| i.id).collect();
        assert_eq!(ids, vec!["task-1-0".to_owned(), "task-1-1".to_owned()]);
        assert!(
            stable_ids("task-1", &once).is_none(),
            "settles after one pass"
        );
        let repeated = tasks_doc(&[("a", false, Some("x")), ("b", false, Some("x"))]);
        let fixed = assign_ids(&repeated, None);
        let ids: Vec<String> = items(&fixed).into_iter().map(|i| i.id).collect();
        assert_eq!(ids[0], "x");
        assert_ne!(ids[1], "x");
        assert!(!ids[1].is_empty());
    }

    #[test]
    fn ids_are_given_once_and_kept_when_the_editor_drops_them() {
        let first = assign_ids(
            &tasks_doc(&[("One", false, None), ("Two", true, None)]),
            None,
        );
        let ids = items(&first);
        assert!(!ids[0].id.is_empty());
        assert_ne!(ids[0].id, ids[1].id);
        let same_text = assign_ids(
            &tasks_doc(&[("Two", true, None), ("One", false, None)]),
            Some(&first),
        );
        assert_eq!(items(&same_text)[0].id, ids[1].id, "by text");
        let renamed = assign_ids(
            &tasks_doc(&[("One!", false, None), ("Two", true, None)]),
            Some(&first),
        );
        assert_eq!(items(&renamed)[0].id, ids[0].id, "by position");
        let kept = assign_ids(&first, Some(&first));
        assert_eq!(kept, first);
    }

    #[test]
    fn a_reset_copy_keeps_text_and_drops_ticks_and_ids() {
        let doc = tasks_doc(&[("One", true, Some("x"))]);
        let copy = items(&reset(&doc));
        assert_eq!(
            (copy[0].text.as_str(), copy[0].checked, copy[0].id.as_str()),
            ("One", false, "")
        );
    }

    fn para(t: &str) -> Value {
        json!({"type":"paragraph","content":[{"type":"text","text":t}]})
    }
    fn li(content: Vec<Value>) -> Value {
        json!({"type":"listItem","content":content})
    }

    #[test]
    fn empty_description_and_plain_paragraphs_give_nothing() {
        assert_eq!(extract(&Value::Null), "");
        assert_eq!(extract(&json!({"type":"doc","content":[]})), "");
        assert_eq!(
            extract(&json!({"type":"doc","content":[para("just prose")]})),
            ""
        );
    }

    #[test]
    fn ordered_bullet_task_and_nested() {
        let doc = json!({"type":"doc","content":[
            para("intro must not appear"),
            {"type":"orderedList","attrs":{"start":3},"content":[
                li(vec![para("three"), json!({"type":"bulletList","content":[
                    li(vec![para("bullet"), json!({"type":"orderedList","content":[li(vec![para("deep")])]})])
                ]})]),
                li(vec![para("four")]),
            ]},
            {"type":"bulletList","content":[li(vec![para("b1")])]},
            {"type":"taskList","content":[
                {"type":"taskItem","attrs":{"checked":true},"content":[para("done")]},
                {"type":"taskItem","attrs":{"checked":false},"content":[para("todo")]},
            ]},
        ]});
        assert_eq!(
            extract(&doc),
            "3. three\n    \u{2022} bullet\n        1. deep\n4. four\n\u{2022} b1\n[x] done\n[ ] todo"
        );
    }

    #[test]
    fn marks_are_flattened_and_breaks_become_spaces() {
        let doc = json!({"type":"doc","content":[{"type":"orderedList","content":[li(vec![json!({"type":"paragraph","content":[
            {"type":"text","text":"a","marks":[{"type":"bold"}]},
            {"type":"hardBreak"},
            {"type":"text","text":"b"}
        ]})])]}]});
        assert_eq!(extract(&doc), "1. a b");
    }
}
