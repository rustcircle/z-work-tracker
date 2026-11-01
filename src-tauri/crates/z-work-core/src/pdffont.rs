//! The timesheet's font: Noto Sans (SIL OFL 1.1, see `fonts/SOURCE.md`) compiled into the program and
//! cut down per document to the glyphs that document prints, so it carries nothing else and the app
//! stays offline. No shaping: glyphs are placed one after the other.
//!
//! Each distinct character gets its own CID, and `ToUnicode` maps it back, so text stays selectable
//! and copyable. That holds for a character the font lacks as well: it prints as the font's empty box
//! (glyph 0) but copies as typed. Those characters are collected so the export can warn about them.

use std::collections::{BTreeMap, BTreeSet};

use pdf_writer::types::{CidFontType, FontFlags, SystemInfo, UnicodeCmap};
use pdf_writer::{Filter, Finish, Name, Pdf, Rect, Ref, Str};
use subsetter::GlyphRemapper;
use ttf_parser::{Face, GlyphId};

use crate::error::CoreError;

const REGULAR: &[u8] = include_bytes!("../fonts/NotoSans-Regular.ttf");
const BOLD: &[u8] = include_bytes!("../fonts/NotoSans-Bold.ttf");

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Weight {
    Regular,
    Bold,
}

/// Marks that take no space and change nothing visible here, since nothing is shaped: joiners,
/// direction marks and emoji variation selectors. Left out instead of being reported as missing.
fn is_invisible(c: char) -> bool {
    matches!(c,
        '\u{ad}' | '\u{200b}'..='\u{200f}' | '\u{202a}'..='\u{202e}' | '\u{2060}'..='\u{2064}'
        | '\u{2066}'..='\u{206f}' | '\u{fe00}'..='\u{fe0f}' | '\u{feff}')
}

/// Scripts written right to left: Hebrew through N'Ko and friends, their presentation forms, and the
/// historic ones in the supplementary planes.
fn is_rtl(c: char) -> bool {
    matches!(c,
        '\u{590}'..='\u{8ff}' | '\u{fb1d}'..='\u{fdff}' | '\u{fe70}'..='\u{fefc}'
        | '\u{10800}'..='\u{10fff}' | '\u{1e800}'..='\u{1efff}')
}

/// PDF text is stored in the order it is drawn, and readers turn right-to-left runs back when text is
/// copied. So each such run goes in reversed, spaces inside it included, and copies as typed.
fn visual_order(mut chars: Vec<char>) -> Vec<char> {
    let mut i = 0;
    while i < chars.len() {
        if !chars.get(i).copied().is_some_and(is_rtl) {
            i += 1;
            continue;
        }
        let mut end = i + 1;
        for (j, c) in chars.iter().enumerate().skip(i + 1) {
            if is_rtl(*c) {
                end = j + 1;
            } else if !c.is_whitespace() {
                break;
            }
        }
        if let Some(run) = chars.get_mut(i..end) {
            run.reverse();
        }
        i = end;
    }
    chars
}

struct Font {
    data: &'static [u8],
    face: Face<'static>,
    base_name: &'static str,
    /// CID of each character used, starting at 1. CID 0 is the font's own empty box.
    used: BTreeMap<char, u16>,
}

impl Font {
    fn parse(data: &'static [u8], base_name: &'static str) -> Result<Self, CoreError> {
        let face =
            Face::parse(data, 0).map_err(|e| CoreError::Pdf(format!("the built-in font: {e}")))?;
        Ok(Self {
            data,
            face,
            base_name,
            used: BTreeMap::new(),
        })
    }

    /// Thousandths of the font size.
    fn scaled(&self, units: f32) -> f32 {
        units * 1000.0 / f32::from(self.face.units_per_em())
    }

    fn advance(&self, gid: GlyphId) -> f32 {
        self.scaled(f32::from(self.face.glyph_hor_advance(gid).unwrap_or(0)))
    }

    fn glyph(&self, c: char) -> Option<GlyphId> {
        self.face.glyph_index(c).filter(|g| g.0 != 0)
    }

    fn width(&self, c: char) -> f32 {
        self.advance(self.glyph(c).unwrap_or(GlyphId(0)))
    }

    fn cid(&mut self, c: char) -> u16 {
        let next = u16::try_from(self.used.len() + 1).unwrap_or(u16::MAX);
        *self.used.entry(c).or_insert(next)
    }

    /// Writes this font's objects from what the document used. Returns nothing to the caller but the
    /// `root` object it references from the page resources.
    fn embed(
        &self,
        pdf: &mut Pdf,
        root: Ref,
        alloc: &mut dyn FnMut() -> Ref,
    ) -> Result<(), CoreError> {
        let mut remapper = GlyphRemapper::new();
        let mut by_cid: Vec<(u16, char, GlyphId)> = self
            .used
            .iter()
            .map(|(c, cid)| (*cid, *c, self.glyph(*c).unwrap_or(GlyphId(0))))
            .collect();
        by_cid.sort_unstable_by_key(|x| x.0);

        let mut cid_to_gid: Vec<u8> = vec![0, 0];
        let mut widths = Vec::with_capacity(by_cid.len());
        let mut unicode = UnicodeCmap::new(
            Name(b"Custom"),
            SystemInfo {
                registry: Str(b"Adobe"),
                ordering: Str(b"UCS"),
                supplement: 0,
            },
        );
        for (cid, c, gid) in &by_cid {
            cid_to_gid.extend(remapper.remap(gid.0).to_be_bytes());
            widths.push(self.advance(*gid));
            unicode.pair(*cid, *c);
        }
        let subset = subsetter::subset(self.data, 0, &remapper)
            .map_err(|e| CoreError::Pdf(format!("the built-in font: {e}")))?;

        let name = format!("{}+{}", subset_tag(&by_cid), self.base_name);
        let name = Name(name.as_bytes());
        let (cid_font, descriptor, to_unicode, map, file) =
            (alloc(), alloc(), alloc(), alloc(), alloc());

        pdf.type0_font(root)
            .base_font(name)
            .encoding_predefined(Name(b"Identity-H"))
            .descendant_font(cid_font)
            .to_unicode(to_unicode);

        let mut cid = pdf.cid_font(cid_font);
        cid.subtype(CidFontType::Type2)
            .base_font(name)
            .system_info(SystemInfo {
                registry: Str(b"Adobe"),
                ordering: Str(b"Identity"),
                supplement: 0,
            })
            .font_descriptor(descriptor)
            .default_width(self.advance(GlyphId(0)))
            .cid_to_gid_map_stream(map);
        cid.widths().consecutive(1, widths);
        cid.finish();

        let b = self.face.global_bounding_box();
        let mut d = pdf.font_descriptor(descriptor);
        d.name(name)
            .flags(FontFlags::SYMBOLIC)
            .bbox(Rect::new(
                self.scaled(f32::from(b.x_min)),
                self.scaled(f32::from(b.y_min)),
                self.scaled(f32::from(b.x_max)),
                self.scaled(f32::from(b.y_max)),
            ))
            .italic_angle(0.0)
            .ascent(self.scaled(f32::from(self.face.ascender())))
            .descent(self.scaled(f32::from(self.face.descender())))
            .cap_height(self.scaled(f32::from(self.face.capital_height().unwrap_or(714))))
            .stem_v(if self.base_name.ends_with("Bold") {
                140.0
            } else {
                80.0
            })
            .font_file2(file);
        d.finish();

        pdf.cmap(to_unicode, &unicode.finish());
        pdf.stream(map, &cid_to_gid);
        let packed = miniz_oxide::deflate::compress_to_vec_zlib(&subset, 6);
        let mut stream = pdf.stream(file, &packed);
        stream.filter(Filter::FlateDecode);
        stream.pair(
            Name(b"Length1"),
            i32::try_from(subset.len()).unwrap_or(i32::MAX),
        );
        stream.finish();
        Ok(())
    }
}

/// Six capitals naming the subset, as PDF requires, from what it holds, so the same text gives the
/// same file.
fn subset_tag(glyphs: &[(u16, char, GlyphId)]) -> String {
    let mut hash: u32 = 0x811c_9dc5;
    for (_, c, _) in glyphs {
        hash = (hash ^ u32::from(*c)).wrapping_mul(0x0100_0193);
    }
    (0..6)
        .map(|i| {
            let letter = (hash >> (i * 5)) % 26;
            char::from(b'A' + u8::try_from(letter).unwrap_or(0))
        })
        .collect()
}

/// The document's two fonts, and what it has asked them to print so far.
pub(crate) struct Fonts {
    regular: Font,
    bold: Font,
    missing: BTreeSet<char>,
}

impl Fonts {
    pub(crate) fn new() -> Result<Self, CoreError> {
        Ok(Self {
            regular: Font::parse(REGULAR, "NotoSans-Regular")?,
            bold: Font::parse(BOLD, "NotoSans-Bold")?,
            missing: BTreeSet::new(),
        })
    }

    fn font(&self, weight: Weight) -> &Font {
        match weight {
            Weight::Regular => &self.regular,
            Weight::Bold => &self.bold,
        }
    }

    /// The width of text at a size, in points.
    pub(crate) fn measure(&self, weight: Weight, text: &str, size: f32) -> f32 {
        let font = self.font(weight);
        let units: f32 = printed(text).map(|c| font.width(c)).sum();
        units * size / 1000.0
    }

    /// Cuts text to fit `width` points, ending in an ellipsis when it had to.
    pub(crate) fn fit(&self, weight: Weight, text: &str, width: f32, size: f32) -> String {
        if self.measure(weight, text, size) <= width {
            return text.to_owned();
        }
        let font = self.font(weight);
        let room = width * 1000.0 / size - font.width('…');
        let mut used = 0.0;
        let mut out = String::new();
        for c in printed(text) {
            used += font.width(c);
            if used > room {
                break;
            }
            out.push(c);
        }
        out.push('…');
        out
    }

    /// Two bytes per character, for a show-text operator with this font selected.
    pub(crate) fn encode(&mut self, weight: Weight, text: &str) -> Vec<u8> {
        let mut out = Vec::with_capacity(text.len() * 2);
        for c in visual_order(printed(text).collect()) {
            if self.font(weight).glyph(c).is_none() {
                self.missing.insert(c);
            }
            let font = match weight {
                Weight::Regular => &mut self.regular,
                Weight::Bold => &mut self.bold,
            };
            out.extend(font.cid(c).to_be_bytes());
        }
        out
    }

    /// Characters this document asked for that print as an empty box, in code point order.
    pub(crate) fn missing(&self) -> Vec<char> {
        self.missing.iter().copied().collect()
    }

    pub(crate) fn embed(
        &self,
        pdf: &mut Pdf,
        regular: Ref,
        bold: Ref,
        alloc: &mut dyn FnMut() -> Ref,
    ) -> Result<(), CoreError> {
        self.regular.embed(pdf, regular, alloc)?;
        self.bold.embed(pdf, bold, alloc)
    }
}

/// The characters of text that go on the page: controls such as a newline become a space.
fn printed(text: &str) -> impl Iterator<Item = char> + '_ {
    text.chars()
        .filter(|c| !is_invisible(*c))
        .map(|c| if c.is_control() { ' ' } else { c })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn greek_cyrillic_and_accents_have_glyphs_and_cjk_and_emoji_are_reported() {
        let mut f = Fonts::new().unwrap();
        f.encode(Weight::Regular, "Ação Ωμέγα Привет Łódź ñ €");
        assert!(f.missing().is_empty(), "{:?}", f.missing());
        f.encode(Weight::Bold, "日本 שלום سلام 😀");
        for c in ['日', '本', 'ש', 'س', '😀'] {
            assert!(f.missing().contains(&c), "{c}");
        }
    }

    #[test]
    fn joiners_and_variation_selectors_are_not_reported_and_controls_become_spaces() {
        let mut f = Fonts::new().unwrap();
        let bytes = f.encode(Weight::Regular, "a\u{200d}b\u{fe0f}\nc");
        assert!(f.missing().is_empty());
        assert_eq!(bytes.len(), 2 * 4, "a, b, a space, c");
    }

    #[test]
    fn each_missing_character_keeps_a_cid_of_its_own_so_it_copies_as_typed() {
        let mut f = Fonts::new().unwrap();
        let bytes = f.encode(Weight::Regular, "日本日");
        assert_eq!(bytes, [0, 1, 0, 2, 0, 1]);
    }

    #[test]
    fn right_to_left_runs_are_stored_reversed_and_nothing_else_moves() {
        let order = |t: &str| visual_order(t.chars().collect()).iter().collect::<String>();
        assert_eq!(order("abc"), "abc");
        assert_eq!(order("אב Hebrew"), "בא Hebrew");
        assert_eq!(order("x אב גד y"), "x דג בא y");
        assert_eq!(order("סשׂ"), "\u{5c2}\u{5e9}\u{5e1}");
    }

    #[test]
    fn fit_measures_real_widths_and_keeps_short_text_whole() {
        let f = Fonts::new().unwrap();
        assert_eq!(f.fit(Weight::Regular, "Short", 100.0, 9.0), "Short");
        let cut = f.fit(Weight::Regular, &"Ω".repeat(200), 100.0, 9.0);
        assert!(cut.ends_with('…'));
        assert!(f.measure(Weight::Regular, &cut, 9.0) <= 100.0);
        // A narrow letter fits more often than a wide one in the same width.
        let narrow = f.fit(Weight::Regular, &"i".repeat(200), 100.0, 9.0);
        assert!(narrow.chars().count() > cut.chars().count());
    }

    #[test]
    fn the_same_text_gives_the_same_subset_name() {
        let a = subset_tag(&[(1, 'a', GlyphId(1))]);
        assert_eq!(a, subset_tag(&[(1, 'a', GlyphId(1))]));
        assert_eq!(a.len(), 6);
        assert_ne!(a, subset_tag(&[(1, 'b', GlyphId(1))]));
    }
}
