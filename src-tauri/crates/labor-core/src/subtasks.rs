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

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

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
