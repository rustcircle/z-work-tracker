#!/usr/bin/env python3
"""Reads an export of a selection with openpyxl and the raw zip, to show nothing else got in.

Selected: Alpha's task `Write` on 1 March only, 10 minutes rounded Up to 15, at 60 an hour.
Not selected: `Write` on 2 and 3 March, and `Secret`.

Make the file with: ZWT_SAMPLE_SELECTION_XLSX=<path> cargo test -p z-work-core the_workbook_builds
Run with: uv run --no-project --with openpyxl scripts/verify_selection.py <path>
"""
import datetime as dt
import sys
import zipfile

from openpyxl import load_workbook

path = sys.argv[1]
values = load_workbook(path, data_only=True)
fails = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""))
    if not ok:
        fails.append(name)


check("no analytics sheet", "Leak" not in values.sheetnames, str(values.sheetnames))
check("it says it is a selection", "About this selection" in values.sheetnames)

raw = b""
with zipfile.ZipFile(path) as z:
    for name in z.namelist():
        raw += z.read(name)
for needle in [b"Secret", b"Leak", b"2026-03-02", b"2026-03-03"]:
    check(f"nothing in the file mentions {needle.decode()}", needle not in raw)

cells = [c for sheet in values.worksheets for row in sheet.iter_rows(values_only=True) for c in row]
for day in (dt.date(2026, 3, 2), dt.date(2026, 3, 3)):
    hit = any(isinstance(c, (dt.date, dt.datetime)) and c.strftime("%Y-%m-%d") == str(day) for c in cells)
    check(f"no date cell holds {day}", not hit)

labor = values.worksheets[0]
rows = [r for r in labor.iter_rows(values_only=True) if any("Write" == c for c in r)]
check("one row for the selected task-day", len(rows) == 1, str(len(rows)))

earnings = values["Earnings"]
money = [c for r in earnings.iter_rows(values_only=True) for c in r if isinstance(c, (int, float))]
check("the amount is 15 minutes at 60 an hour", 15 in money, str(money))
check("no amount from an unselected row", all(c < 60 for c in money), str(money))

if fails:
    print(f"{len(fails)} FAILED")
    sys.exit(1)
print("all checks passed")
