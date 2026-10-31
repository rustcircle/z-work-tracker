#!/usr/bin/env python3
"""Reads a sample export with openpyxl, an independent reader, and checks it against expected figures.

Run with: uv run --with openpyxl scripts/verify_xlsx.py <sample.xlsx>
"""
import datetime as dt
import re
import sys
import zipfile

from openpyxl import load_workbook

path = sys.argv[1]
values = load_workbook(path, data_only=True)
formulas = load_workbook(path, data_only=False)
fails = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""))
    if not ok:
        fails.append(name)


v = values.worksheets[0]
f = formulas.worksheets[0]
check("first sheet is the requested one", v.title == "Labor by project", v.title)
check("header row is exact", [c.value for c in v[2]] == ["Project", "Day", "Time", "Task name", "Subtasks"], str([c.value for c in v[2]]))
title = v["A1"].value
check("title states zone, increment and method", "zone: UTC" in title and "15 min, nearest" in title, title)
check("freeze sits below the header", f.freeze_panes == "A3", str(f.freeze_panes))
check("autofilter starts on the header row", f.auto_filter.ref.startswith("A2:E"), f.auto_filter.ref)
check("column widths are set", f.column_dimensions["D"].width > 30 and f.column_dimensions["E"].width > 50)

rows = []
last_total = None
for r in range(3, v.max_row + 1):
    rows.append((r, v.cell(r, 1).value, v.cell(r, 2).value, v.cell(r, 3).value, v.cell(r, 4).value, v.cell(r, 5).value))

data = [x for x in rows if x[2] not in ("Subtotal", None)]
subs = [x for x in rows if x[2] == "Subtotal"]
grand = [x for x in rows if x[1] == "Grand total"]
secs = lambda val: round(val.total_seconds()) if isinstance(val, dt.timedelta) else round(val * 86400)


# Expected from the sample's segments (rule: 15 min nearest, UTC days, pauses excluded):
# =Beta, Support, 03-22: 2:07:30 exact, nearest 2:15:00.
# Alpha, Write report, 03-20: 1:00:00. 03-21: 0:20 + 0:40 = 1:00:00. =HYPERLINK task 03-21: 0:03 to 0.
expected = [
    ("=Beta", dt.date(2026, 3, 22), 8100, "Support"),
    ("Alpha", dt.date(2026, 3, 20), 3600, "Write report"),
    ("Alpha", dt.date(2026, 3, 21), 3600, "Write report"),
    ("Alpha", dt.date(2026, 3, 21), 0, '=HYPERLINK("http://x")'),
]
got = sorted((x[1], x[2].date() if hasattr(x[2], "date") else x[2], secs(x[3]), x[4]) for x in data)
want = sorted(expected)
check("sorted rows match the segments, one per task per day", got == want, str(got))
order = [(x[1], x[2]) for x in data]
check("sorted by project then day", order == sorted(order, key=lambda t: (t[0].lower(), t[1])), str(order))

cell = f.cell(data[0][0], 2)
check("Day is a real date formatted yyyy-mm-dd", cell.is_date and cell.number_format == "yyyy-mm-dd", cell.number_format)
cell = f.cell(data[0][0], 3)
# openpyxl reports duration formats as "d" while parsing, so the stored cell type is read from the XML.
with zipfile.ZipFile(path) as z:
    sheet_xml = z.read("xl/worksheets/sheet1.xml").decode()
raw = re.search(rf'<c r="{cell.coordinate}"([^>]*)><v>([^<]+)</v>', sheet_xml)
check(
    "Time is a real number formatted [h]:mm:ss",
    cell.number_format == "[h]:mm:ss" and raw is not None and " t=" not in raw.group(1) and float(raw.group(2)) > 0,
    f"{cell.number_format} {raw.group(0) if raw else None}",
)
sub_row = next(x for x in data if x[4] == "Write report" and x[2].day == 20)[0]
check("subtasks are list items only, with numbering and nesting", v.cell(sub_row, 5).value == "1. Draft\n    • Outline\n2. Review", repr(v.cell(sub_row, 5).value))
check("subtasks wrap", f.cell(sub_row, 5).alignment.wrap_text is True)
none_row = next(x for x in data if x[4] == "Support")[0]
check("no list items leaves the cell empty", v.cell(none_row, 5).value is None)

for x in rows:
    if x[1] == "=Beta" or x[4] == '=HYPERLINK("http://x")':
        for col in (1, 4):
            c = f.cell(x[0], col)
            if isinstance(c.value, str) and c.value.startswith("="):
                check(f"text starting with = stays a string at {c.coordinate}", c.data_type == "s", c.data_type)

alpha = next(x for x in data if x[1] == "Alpha")[0]
fill = f.cell(alpha, 1).fill.fgColor.rgb
font = f.cell(alpha, 1).font.color.rgb
check("project cell tinted with its colour and readable text", fill.endswith("336699") and font.endswith("FFFFFF"), f"{fill} {font}")
beta = next(x for x in data if x[1] == "=Beta")[0]
check("light project colour gets dark text", f.cell(beta, 1).fill.fgColor.rgb.endswith("FDE047") and f.cell(beta, 1).font.color.rgb.endswith("000000"))

check("one subtotal per project", len(subs) == 2)
for s in subs:
    members = [x for x in data if x[1] == s[1]]
    formula = f.cell(s[0], 3).value
    first, last = members[0][0], members[-1][0]
    check(f"subtotal formula covers {s[1]}", formula == f"=SUBTOTAL(9,C{first}:C{last})", formula)
    check(f"subtotal cached value matches {s[1]}", secs(s[3]) == sum(secs(m[3]) for m in members), str(s[3]))
check("grand total row exists", len(grand) == 1)
g = grand[0]
check("grand total is a formula", str(f.cell(g[0], 3).value).startswith("=SUBTOTAL(9,C3:C"), str(f.cell(g[0], 3).value))
check("grand total cached value equals the rows", secs(g[3]) == sum(secs(x[3]) for x in data) == 8100 + 7200, str(g[3]))

d = values["Segment details"]
hdr = [c.value for c in d[2]]
check("details keeps raw UTC and an Exact column", "Start UTC" in hdr and "End UTC" in hdr and "Exact" in hdr and "Shift" in hdr, str(hdr))
check("details shows both zones", "Start Europe/Lisbon" in hdr and "Start America/New_York" in hdr)
idx = {h: i + 1 for i, h in enumerate(hdr)}
first = [c.value for c in d[3]]
check("raw UTC is unrounded", first[idx["Start UTC"] - 1] == "2026-03-20T23:00:00Z" and first[idx["End UTC"] - 1] == "2026-03-21T00:20:00Z", str(first))
total_exact = sum(secs(d.cell(r, idx["Exact"]).value) for r in range(3, d.max_row + 1))
check("Exact sums the segments", total_exact == 4800 + 2400 + 180 + 7650, str(total_exact))
check("earnings columns present when included", "Rate per hour" in hdr and "Currency" in hdr and "Exact amount" in hdr)

e = values["Earnings"]
ef = formulas["Earnings"]
by = {e.cell(r, 1).value: r for r in range(3, e.max_row + 1)}
# Alpha billable 2:00:00 + 0 at 60.00 EUR = 120.00. =Beta 2:15:00 at 80.50 USD = 181.125, rounded at the total to 181.13.
check("per-currency total EUR is a formula with the right value", str(ef.cell(by["Total EUR"], 4).value).startswith("=SUMIF") and abs(e.cell(by["Total EUR"], 4).value - 120.0) < 1e-9)
check("per-currency total USD rounds at the total", str(ef.cell(by["Total USD"], 4).value).startswith("=SUMIF") and e.cell(by["Total USD"], 4).value == 181.13, str(e.cell(by["Total USD"], 4).value))
check("analytics sheets follow", values.sheetnames[3:] == ["KPI summary", "Earnings by month"], str(values.sheetnames))

with zipfile.ZipFile(path) as z:
    xml = z.read("xl/worksheets/sheet1.xml").decode()
    check("no formula holds user text", "HYPERLINK" not in xml and "<f>=" not in xml)

print(f"\n{len(fails)} failed")
sys.exit(1 if fails else 0)
