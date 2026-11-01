#!/usr/bin/env python3
"""Reads an export of a selection with openpyxl and the raw zip, to show nothing else got in.

Selected: Alpha's task `Write` on 1 March only, 10 minutes rounded Up to 15, at 60 an hour, tagged
`Shown tag`. 1 March 2026 is a Sunday.
Not selected: `Write` on 2 and 3 March; `Secret` (tagged `Hidden tag`) on 1 March; `LeakTask` in
`LeakProject` at 99.99 an hour on 1 March. `Weekday shift` runs on no selected day. The UI also sent a
sheet named `Leak`, which must be ignored.

Make the file with: ZWT_SAMPLE_SELECTION_XLSX=<path> cargo test -p z-work-core the_workbook_builds
Run with: uv run --no-project --with openpyxl scripts/verify_selection.py <path>
"""
import datetime as dt
import sys
import zipfile

from openpyxl import load_workbook

path = sys.argv[1]
values = load_workbook(path, data_only=True)
formulas = load_workbook(path)
fails = []


def check(name, ok, detail=""):
    print(("PASS " if ok else "FAIL ") + name + (f"  ({detail})" if detail else ""))
    if not ok:
        fails.append(name)


def duration(secs):
    return dt.timedelta(seconds=secs)


def near(a, b):
    if isinstance(a, dt.timedelta) and isinstance(b, dt.timedelta):
        return abs((a - b).total_seconds()) < 1e-3
    return isinstance(a, (int, float)) and isinstance(b, (int, float)) and abs(a - b) < 1e-9


wanted = ["KPI summary", "Bands", "Projects", "Weekdays", "Tags", "Shifts", "Earnings by period", "Earnings by project"]
for name in wanted:
    check(f"has the {name} sheet", name in values.sheetnames)
check("the sheet the UI sent is ignored", "Leak" not in values.sheetnames, str(values.sheetnames))
check("it says it is a selection", "About this selection" in values.sheetnames)
about = " ".join(str(c) for r in values["About this selection"].iter_rows(values_only=True) for c in r if c)
check("the note no longer says analytics are left out", "left out" not in about)
check("the note says it is a selection", "selection of 1 task-day" in about, about[:80])
for sheet in values.worksheets:
    if sheet.title in wanted:
        check(f"{sheet.title}'s title says selected", "Selected entries" in str(sheet["A1"].value), str(sheet["A1"].value)[:60])
check("no hidden sheet", all(s.sheet_state == "visible" for s in values.worksheets))
check("no defined name holds data", all("Leak" not in n and "Secret" not in n for n in formulas.defined_names))

# Every part of the file: sheets with cached formula values, shared strings, charts if any, docProps.
raw = b""
with zipfile.ZipFile(path) as z:
    parts = z.namelist()
    for name in parts:
        raw += z.read(name)
    print("parts:", ", ".join(parts))
    check("no external links", not any("externalLink" in n for n in parts))
    props = b"".join(z.read(n) for n in parts if n.startswith("docProps/"))
for needle in [b"Secret", b"Leak", b"Hidden tag", b"Weekday shift", b"2026-03-02", b"2026-03-03", b"99.99", b"USD 0", b"LeakProject", b"LeakTask"]:
    check(f"nothing in the file mentions {needle.decode()}", needle not in raw)
check("docProps name none of it", all(n not in props for n in [b"Secret", b"Leak", b"Write"]))
for needle in [b"Write", b"Shown tag", b"Sunday shift"]:
    check(f"the file does hold {needle.decode()}", needle in raw)

cells = [(s.title, c) for s in values.worksheets for row in s.iter_rows(values_only=True) for c in row]
for day in (dt.date(2026, 3, 2), dt.date(2026, 3, 3)):
    hit = any(isinstance(c, (dt.date, dt.datetime)) and c.strftime("%Y-%m-%d") == str(day) for _, c in cells)
    check(f"no date cell holds {day}", not hit)
# 1 hour is the time of each thing left out, so no cell in any sheet may hold it. Cached values included.
check("no cell holds an unselected hour", not any(near(c, duration(3600)) for _, c in cells))

labor = values.worksheets[0]
rows = [r for r in labor.iter_rows(values_only=True) if any("Write" == c for c in r)]
check("one row for the selected task-day", len(rows) == 1, str(len(rows)))

earnings = values["Earnings"]
money = [c for r in earnings.iter_rows(values_only=True) for c in r if isinstance(c, (int, float)) and not isinstance(c, bool)]
check("the amount is 15 minutes at 60 an hour", 15 in money, str(money))
check("no amount from an unselected row", all(c < 60 for c in money), str(money))


def rows_of(name):
    return list(values[name].iter_rows(min_row=3, values_only=True))


def kpi(metric, column):
    return next(r[column] for r in rows_of("KPI summary") if r[0] == metric)


check("KPI Exact is the 10 selected minutes", near(kpi("Total time (Exact)", 1), duration(600)))
check("KPI Billable is the 15 rounded minutes", near(kpi("Total time (Billable)", 1), duration(900)))
check("KPI counts one active day and one session", kpi("Active days", 2) == 1 and kpi("Sessions", 2) == 1)
check("KPI sees no other task to switch to", kpi("Context switches", 2) == 0)

projects = rows_of("Projects")
check("Projects lists Alpha alone", [r[0] for r in projects] == ["Alpha"], str([r[0] for r in projects]))
check("Projects' Billable matches", near(projects[0][2], duration(900)))
check("Projects' share is all of it", near(projects[0][3], 1))

bands = rows_of("Bands")
check("Bands total 10 minutes", sum(r[3].total_seconds() for r in bands if r[0] == "Band" and r[2] == "All projects") == 600)

weekdays = {r[0]: r[1] for r in rows_of("Weekdays")}
check("Weekdays hold Sunday only", near(weekdays.pop("Sunday"), duration(600)) and all(near(v, duration(0)) for v in weekdays.values()))

tags = [r[0] for r in rows_of("Tags")]
check("Tags list the selected task's tag alone", tags == ["Shown tag"], str(tags))

shifts = [r[0] for r in rows_of("Shifts")]
check("Shifts name those of the selected day", shifts == ["Sunday shift", "Outside any shift"], str(shifts))

period = rows_of("Earnings by period")
check("Earnings by period is that day and the total", [r[0] for r in period] == ["Sun 1", "Total"], str([r[0] for r in period]))
check("its total matches the selection", near(period[-1][1], duration(900)) and near(period[-1][3], 15) and period[-1][4] is None, str(period[-1]))
by_project = rows_of("Earnings by project")
check("Earnings by project is Alpha's 15", [r[0] for r in by_project] == ["Alpha"] and near(by_project[0][2], 15), str(by_project))

if fails:
    print(f"{len(fails)} FAILED")
    sys.exit(1)
print("all checks passed")
