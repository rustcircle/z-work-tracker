#!/usr/bin/env python3
"""Reads the mixed-script timesheet with a real PDF reader and renders its first page.

Make the file with: ZWT_SAMPLE_UNICODE_PDF=<path> cargo test -p z-work-core the_mixed_script_sample
Run with: uv run --no-project --with pypdf --with pypdfium2 scripts/verify_pdf.py <path> [page.png]
"""
import sys
import unicodedata

from pypdf import PdfReader

path = sys.argv[1]
reader = PdfReader(path)
text = unicodedata.normalize("NFC", "\n".join(p.extract_text() for p in reader.pages))
fails = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""))
    if not ok:
        fails.append(name)


# Printed with real glyphs, and copied back as typed.
for needle in ["Ωμέγα αρχείο", "Отчёт за март", "Ação Łódź naïve Škoda", "Café decomposed", "Ελληνικά"]:
    check(f"extracts {needle}", needle in text)
# Printed as an empty box, and still copied back as typed.
for needle in ["日本語の作業", "한국어 中文", "😀"]:
    check(f"extracts {needle} though the font lacks it", needle in text)
# Right-to-left runs are stored reversed, in drawing order, and readers turn them back.
for needle in ["שלום", "مرحبا"]:
    check(f"extracts {needle} as typed though the font lacks it", needle in text)
check("the warning is on the page", "as an empty box" in text)
check("no question mark stands in for a character", "?" not in text)
check("a long name is cut with an ellipsis", "…" in text)

fonts = set()
for page in reader.pages:
    for name, ref in page["/Resources"]["/Font"].items():
        font = ref.get_object()
        check(f"{name} is Type0 with a ToUnicode map", font["/Subtype"] == "/Type0" and "/ToUnicode" in font)
        cid = font["/DescendantFonts"][0].get_object()
        check(f"{name} embeds its subset", "/FontFile2" in cid["/FontDescriptor"].get_object())
        fonts.add(str(font["/BaseFont"]))
print("fonts:", sorted(fonts))
check("both are subsets, named as such", all(f[7] == "+" for f in fonts) and len(fonts) == 2)

if len(sys.argv) > 2:
    import pypdfium2

    doc = pypdfium2.PdfDocument(path)
    doc[0].render(scale=2).to_pil().save(sys.argv[2])
    print("rendered", sys.argv[2])
    seen = unicodedata.normalize("NFC", doc[0].get_textpage().get_text_range())
    for needle in ["Ωμέγα αρχείο", "Отчёт за март", "日本語の作業", "😀", "שלום", "مرحبا"]:
        check(f"PDFium extracts {needle} as typed", needle in seen)

if fails:
    print(f"{len(fails)} FAILED")
    sys.exit(1)
print("all checks passed")
