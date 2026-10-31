//! A client-ready timesheet PDF, generated locally. Pure Rust, no network. Uses the standard Helvetica
//! fonts, so text outside Windows-1252 prints as `?`; nothing else about the file depends on the OS.

use std::collections::BTreeMap;

use chrono_tz::Tz;
use pdf_writer::{Content, Filter, Finish, Name, Pdf, Rect, Ref, Str};
use serde::Deserialize;

use crate::billing::{cents_from_numerator, money};
use crate::error::CoreError;
use crate::report::{ExportSource, hms};
use crate::validate::parse_zone;

const WIDTH: f32 = 595.28;
const HEIGHT: f32 = 841.89;
const MARGIN: f32 = 48.0;
const ROW: f32 = 16.0;
const MAX_LOGO_PIXELS: u32 = 4096;
pub const MAX_LOGO_BYTES: u64 = 5 * 1024 * 1024;

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PdfRequest {
    #[serde(default)]
    pub project_id: Option<String>,
    /// Inclusive days, `YYYY-MM-DD`, in `zone`.
    pub from: String,
    pub to: String,
    /// The client's zone, for days and totals.
    pub zone: String,
    #[serde(default)]
    pub title: String,
    pub include_prices: bool,
    #[serde(default)]
    pub use_logo: bool,
    /// Only these Timeline entries. Their days are in `zone`.
    #[serde(default)]
    pub selection: Option<Vec<crate::report::SelectedEntry>>,
}

/// A decoded logo ready for embedding.
#[derive(Clone, Debug)]
pub struct Logo {
    pub width: u32,
    pub height: u32,
    pub rgb: Vec<u8>,
}

/// Checks and decodes a PNG. Transparent parts are flattened onto white.
pub fn decode_logo(bytes: &[u8]) -> Result<Logo, CoreError> {
    let bad = || CoreError::Validation("the logo must be a PNG image".into());
    let mut decoder = png::Decoder::new(std::io::Cursor::new(bytes));
    decoder.set_transformations(png::Transformations::normalize_to_color8());
    let mut reader = decoder.read_info().map_err(|_| bad())?;
    let (w, h) = {
        let info = reader.info();
        (info.width, info.height)
    };
    if w == 0 || h == 0 || w > MAX_LOGO_PIXELS || h > MAX_LOGO_PIXELS {
        return Err(CoreError::Validation(format!(
            "the logo must be at most {MAX_LOGO_PIXELS} pixels wide and tall"
        )));
    }
    let size = reader.output_buffer_size().ok_or_else(bad)?;
    let mut buf = vec![0; size];
    let frame = reader.next_frame(&mut buf).map_err(|_| bad())?;
    let channels = frame.color_type.samples();
    let mut rgb = Vec::with_capacity(w as usize * h as usize * 3);
    for px in buf
        .get(..frame.buffer_size())
        .ok_or_else(bad)?
        .chunks_exact(channels)
    {
        let (r, g, b, a) = match *px {
            [v] => (v, v, v, 255),
            [v, a] => (v, v, v, a),
            [r, g, b] => (r, g, b, 255),
            [r, g, b, a] => (r, g, b, a),
            _ => return Err(bad()),
        };
        let over = |c: u8| {
            u8::try_from((u16::from(c) * u16::from(a) + 255 * (255 - u16::from(a))) / 255)
                .unwrap_or(255)
        };
        rgb.extend([over(r), over(g), over(b)]);
    }
    Ok(Logo {
        width: w,
        height: h,
        rgb,
    })
}

/// Encodes to Windows-1252. Anything else becomes `?`, so the document stays valid.
fn winansi(text: &str) -> Vec<u8> {
    text.chars()
        .map(|c| match c {
            '\u{20}'..='\u{7e}' | '\u{a0}'..='\u{ff}' => u8::try_from(c as u32).unwrap_or(b'?'),
            '€' => 0x80,
            '‘' => 0x91,
            '’' => 0x92,
            '“' => 0x93,
            '”' => 0x94,
            '–' => 0x96,
            '—' => 0x97,
            '…' => 0x85,
            _ => b'?',
        })
        .collect()
}

/// Cuts text to about `max` width at a font size, by Helvetica's average character width.
fn fit(text: &str, width: f32, size: f32) -> String {
    #[allow(clippy::cast_possible_truncation, clippy::cast_sign_loss)]
    let max = (width / (size * 0.5)) as usize;
    if text.chars().count() <= max {
        return text.to_owned();
    }
    let mut out: String = text.chars().take(max.saturating_sub(1)).collect();
    out.push('…');
    out
}

struct Writer {
    pages: Vec<Content>,
    y: f32,
}

impl Writer {
    fn new() -> Self {
        Self {
            pages: vec![Content::new()],
            y: HEIGHT - MARGIN,
        }
    }
    #[expect(
        clippy::expect_used,
        reason = "the list starts with a page and only grows"
    )]
    fn page(&mut self) -> &mut Content {
        self.pages
            .last_mut()
            .expect("invariant: starts with a page")
    }
    fn text(&mut self, x: f32, y: f32, font: &[u8], size: f32, text: &str) {
        let bytes = winansi(text);
        let c = self.page();
        c.begin_text();
        c.set_font(Name(font), size);
        c.next_line(x, y);
        c.show(Str(&bytes));
        c.end_text();
    }
    fn line(&mut self, y: f32) {
        let c = self.page();
        c.set_line_width(0.5);
        c.move_to(MARGIN, y);
        c.line_to(WIDTH - MARGIN, y);
        c.stroke();
    }
    fn ensure(&mut self, needed: f32) -> bool {
        if self.y - needed < MARGIN + ROW {
            self.pages.push(Content::new());
            self.y = HEIGHT - MARGIN;
            return true;
        }
        false
    }
}

struct Row {
    day: String,
    project: String,
    task: String,
    hours: String,
    amount: String,
}

/// Builds the timesheet. With `include_prices` off, no price appears anywhere in the file.
pub fn build(
    source: &ExportSource,
    request: &PdfRequest,
    logo: Option<&Logo>,
) -> Result<Vec<u8>, CoreError> {
    let tz: Tz = parse_zone(&request.zone)?;
    let narrowed;
    let source = match &request.selection {
        Some(entries) => {
            narrowed = source.narrowed(tz, entries)?;
            &narrowed
        }
        None => source,
    };
    crate::validate::check_date(&request.from, "the start date")?;
    crate::validate::check_date(&request.to, "the end date")?;
    let mut totals: BTreeMap<String, i64> = BTreeMap::new();
    let mut total_secs = 0i64;
    let mut pause_secs = 0i64;
    let mut rows = Vec::new();
    for r in source.rows(tz) {
        let day = r.row.day.format("%Y-%m-%d").to_string();
        if day < request.from || day > request.to {
            continue;
        }
        if request
            .project_id
            .as_ref()
            .is_some_and(|p| *p != r.row.project_id)
        {
            continue;
        }
        total_secs += r.row.billable_secs;
        pause_secs += r.row.pause_secs;
        let mut amount = Vec::new();
        for (cur, n) in r.row.numerators() {
            let cents = cents_from_numerator(n);
            *totals.entry(cur.clone()).or_insert(0) += cents;
            amount.push(money(&cur, cents));
        }
        rows.push(Row {
            day,
            project: r.project_name,
            task: r.task_name,
            hours: hms(r.row.billable_secs),
            amount: amount.join(" + "),
        });
    }

    let mut w = Writer::new();
    let title = if request.title.trim().is_empty() {
        "Timesheet"
    } else {
        request.title.trim()
    };
    let mut top = HEIGHT - MARGIN;
    if logo.is_some() {
        top -= 60.0;
    }
    w.text(
        MARGIN,
        top - 18.0,
        b"Bold",
        18.0,
        &fit(title, WIDTH - 2.0 * MARGIN, 18.0),
    );
    w.text(
        MARGIN,
        top - 36.0,
        b"Reg",
        10.0,
        &format!(
            "Period {} to {}. Days and times in {}.",
            request.from, request.to, request.zone
        ),
    );
    if let Some(count) = source.selected_count() {
        w.text(
            MARGIN,
            top - 50.0,
            b"Reg",
            10.0,
            &format!("Selection of {count} entries. Totals cover those only."),
        );
    }
    w.y = top - 66.0;

    let (col_day, col_project, col_task, col_hours, col_amount) = (
        MARGIN,
        MARGIN + 66.0,
        MARGIN + 170.0,
        MARGIN + 340.0,
        MARGIN + 400.0,
    );
    let header = |w: &mut Writer, prices: bool| {
        let y = w.y;
        w.text(col_day, y, b"Bold", 9.0, "Day");
        w.text(col_project, y, b"Bold", 9.0, "Project");
        w.text(col_task, y, b"Bold", 9.0, "Task");
        w.text(col_hours, y, b"Bold", 9.0, "Time");
        if prices {
            w.text(col_amount, y, b"Bold", 9.0, "Amount");
        }
        w.line(y - 4.0);
        w.y -= ROW + 2.0;
    };
    header(&mut w, request.include_prices);
    for r in &rows {
        if w.ensure(ROW) {
            header(&mut w, request.include_prices);
        }
        let y = w.y;
        w.text(col_day, y, b"Reg", 9.0, &r.day);
        w.text(col_project, y, b"Reg", 9.0, &fit(&r.project, 98.0, 9.0));
        w.text(col_task, y, b"Reg", 9.0, &fit(&r.task, 164.0, 9.0));
        w.text(col_hours, y, b"Reg", 9.0, &r.hours);
        if request.include_prices {
            w.text(col_amount, y, b"Reg", 9.0, &fit(&r.amount, 100.0, 9.0));
        }
        w.y -= ROW;
    }
    if rows.is_empty() {
        let y = w.y;
        w.text(MARGIN, y, b"Reg", 10.0, "No time in this period.");
        w.y -= ROW;
    }
    w.ensure(ROW * 4.0);
    let y = w.y;
    w.line(y + 8.0);
    w.text(
        MARGIN,
        y - 6.0,
        b"Bold",
        10.0,
        &format!("Total time: {}", hms(total_secs)),
    );
    w.y -= ROW + 6.0;
    if pause_secs > 0 {
        let y = w.y;
        w.text(
            MARGIN,
            y,
            b"Reg",
            9.0,
            &format!("Includes pauses billed as work: {}", hms(pause_secs)),
        );
        w.y -= ROW;
    }
    if request.include_prices && !totals.is_empty() {
        let text: Vec<String> = totals.iter().map(|(c, v)| money(c, *v)).collect();
        let y = w.y;
        w.text(
            MARGIN,
            y,
            b"Bold",
            10.0,
            &format!("Total: {}", text.join(" + ")),
        );
        w.y -= ROW;
    }

    Ok(assemble(w.pages, logo))
}

fn assemble(pages: Vec<Content>, logo: Option<&Logo>) -> Vec<u8> {
    let mut pdf = Pdf::new();
    let catalog = Ref::new(1);
    let tree = Ref::new(2);
    let regular = Ref::new(3);
    let bold = Ref::new(4);
    let image = Ref::new(5);
    let mut next = 6;
    let mut alloc = || {
        let r = Ref::new(next);
        next += 1;
        r
    };
    let ids: Vec<(Ref, Ref)> = pages.iter().map(|_| (alloc(), alloc())).collect();

    pdf.catalog(catalog).pages(tree);
    pdf.pages(tree)
        .kids(ids.iter().map(|p| p.0))
        .count(i32::try_from(ids.len()).unwrap_or(i32::MAX));
    pdf.type1_font(regular)
        .base_font(Name(b"Helvetica"))
        .encoding_predefined(Name(b"WinAnsiEncoding"));
    pdf.type1_font(bold)
        .base_font(Name(b"Helvetica-Bold"))
        .encoding_predefined(Name(b"WinAnsiEncoding"));

    if let Some(l) = logo {
        let packed = miniz_oxide::deflate::compress_to_vec_zlib(&l.rgb, 6);
        let mut x = pdf.image_xobject(image, &packed);
        x.filter(Filter::FlateDecode);
        x.width(i32::try_from(l.width).unwrap_or(1));
        x.height(i32::try_from(l.height).unwrap_or(1));
        x.color_space().device_rgb();
        x.bits_per_component(8);
        x.finish();
    }

    let page_count = ids.len();
    for (i, (mut content, (page_ref, content_ref))) in pages.into_iter().zip(ids).enumerate() {
        if i == 0
            && let Some(l) = logo
        {
            #[allow(clippy::cast_precision_loss)]
            let (w, h) = {
                let scale = (160.0 / l.width as f32).min(50.0 / l.height as f32);
                (l.width as f32 * scale, l.height as f32 * scale)
            };
            content.save_state();
            content.transform([w, 0.0, 0.0, h, MARGIN, HEIGHT - MARGIN - h]);
            content.x_object(Name(b"Logo"));
            content.restore_state();
        }
        let footer = winansi(&format!(
            "Generated by zWorkTracker. Page {} of {page_count}.",
            i + 1
        ));
        content.begin_text();
        content.set_font(Name(b"Reg"), 8.0);
        content.next_line(MARGIN, MARGIN - 18.0);
        content.show(Str(&footer));
        content.end_text();
        let stream = content.finish();
        pdf.stream(content_ref, stream.as_slice());
        let mut page = pdf.page(page_ref);
        page.media_box(Rect::new(0.0, 0.0, WIDTH, HEIGHT));
        page.parent(tree);
        page.contents(content_ref);
        let mut res = page.resources();
        let mut fonts = res.fonts();
        fonts.pair(Name(b"Reg"), regular);
        fonts.pair(Name(b"Bold"), bold);
        fonts.finish();
        if logo.is_some() {
            res.x_objects().pair(Name(b"Logo"), image);
        }
    }
    pdf.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::billing::tests::{fixture, seg};
    use crate::report::tests::source;

    fn contains(hay: &[u8], needle: &[u8]) -> bool {
        hay.windows(needle.len()).any(|w| w == needle)
    }
    fn src(n: usize) -> ExportSource {
        let (mut s, _, t) = fixture(None);
        for i in 0..n {
            let day = 1 + i % 28;
            let month = 1 + i / 28;
            seg(
                &mut s,
                &t,
                &format!("s{i}"),
                &format!("2026-{month:02}-{day:02}T09:00:00Z"),
                &format!("2026-{month:02}-{day:02}T10:00:00Z"),
            );
        }
        source(s, "2026-12-31T00:00:00Z")
    }
    fn req(prices: bool) -> PdfRequest {
        PdfRequest {
            project_id: None,
            from: "2026-01-01".into(),
            to: "2026-12-31".into(),
            zone: "America/New_York".into(),
            title: "March".into(),
            include_prices: prices,
            use_logo: false,
            selection: None,
        }
    }

    #[test]
    fn it_is_a_pdf_naming_the_zone_with_a_total() {
        let b = build(&src(2), &req(true), None).unwrap();
        assert!(b.starts_with(b"%PDF-"));
        assert!(contains(&b, b"America/New_York"));
        assert!(contains(&b, b"Total time"));
        if let Ok(path) = std::env::var("ZWT_SAMPLE_PDF") {
            std::fs::write(path, &b).unwrap();
        }
    }

    #[test]
    fn with_prices_off_no_money_appears() {
        let b = build(&src(2), &req(false), None).unwrap();
        assert!(!contains(&b, b"Amount"));
        assert!(!contains(&b, b"Total:"));
        for currency_mark in [&[0x80u8][..], b"$", b"EUR", b"USD"] {
            // The first bytes are the binary marker comment every PDF header carries.
            assert!(!contains(&b[16..], currency_mark), "{currency_mark:?}");
        }
    }

    #[test]
    fn long_timesheets_paginate() {
        let b = build(&src(120), &req(true), None).unwrap();
        assert!(contains(&b, b"Page 3 of"));
    }

    #[test]
    fn text_outside_the_font_prints_as_a_question_mark_and_never_breaks_the_file() {
        assert_eq!(
            winansi("Ação €5 日本"),
            [b'A', 0xe7, 0xe3, b'o', b' ', 0x80, b'5', b' ', b'?', b'?']
        );
    }

    #[test]
    fn a_png_logo_is_embedded_and_a_non_png_is_refused() {
        let mut bytes = Vec::new();
        {
            let mut e = png::Encoder::new(&mut bytes, 2, 1);
            e.set_color(png::ColorType::Rgba);
            e.set_depth(png::BitDepth::Eight);
            let mut w = e.write_header().unwrap();
            w.write_image_data(&[255, 0, 0, 255, 0, 0, 0, 0]).unwrap();
        }
        let logo = decode_logo(&bytes).unwrap();
        assert_eq!(
            logo.rgb,
            [255, 0, 0, 255, 255, 255],
            "transparent flattens onto white"
        );
        let b = build(
            &src(1),
            &PdfRequest {
                use_logo: true,
                ..req(true)
            },
            Some(&logo),
        )
        .unwrap();
        assert!(contains(&b, b"/Logo"));
        assert!(decode_logo(b"not a png").is_err());
    }

    #[test]
    fn a_selection_prints_only_its_own_task_day_and_says_so() {
        let (mut s, p, t) = fixture(None);
        let c = crate::machine::tests::ctx("2026-01-01T00:00:00Z");
        let other = s
            .create_task(&c, &crate::machine::tests::task_input("Secret", &p))
            .unwrap();
        seg(
            &mut s,
            &t,
            "a",
            "2026-03-01T09:00:00Z",
            "2026-03-01T10:00:00Z",
        );
        seg(
            &mut s,
            &t,
            "b",
            "2026-03-02T09:00:00Z",
            "2026-03-02T10:00:00Z",
        );
        seg(
            &mut s,
            &other,
            "z",
            "2026-03-01T11:00:00Z",
            "2026-03-01T12:00:00Z",
        );
        let src = source(s, "2026-04-01T00:00:00Z");
        let request = PdfRequest {
            selection: Some(vec![crate::report::SelectedEntry {
                task_id: t.clone(),
                day: "2026-03-01".to_owned(),
            }]),
            ..req(true)
        };
        let bytes = build(&src, &request, None).unwrap();
        assert!(contains(&bytes, b"Selection of 1 entries"));
        assert!(!contains(&bytes, b"Secret"));
        assert!(!contains(&bytes, b"2026-03-02"));
        let empty = PdfRequest {
            selection: Some(Vec::new()),
            ..req(true)
        };
        assert!(build(&src, &empty, None).is_err());
    }
}
