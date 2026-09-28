#!/usr/bin/env python3
"""claims-check: read a report, post, or draft and flag claims that can be checked mechanically.

    python3 checks/claims_check.py report.md [more files]  [--year 2026] [--json]
    cat draft.txt | python3 checks/claims_check.py -

What it checks:
  FAIL  a weekday that doesn't match its date        ("Thu 10/2" when Oct 2 is a Friday)
  FAIL  arithmetic written out that is wrong         ("12 x 40 = 460", "$1,200 + $300 = $1,400")
  FAIL  "N of M (P%)" where P isn't N/M               ("3 of 12 (30%)")
  FAIL  percent change that doesn't match its ends   ("from 40 to 50, up 20%")
  FAIL  a markdown table "Total" row that doesn't add up
  WARN  money with more than 2 decimals              ("$14,543.111")
  WARN  statistics with no source in the same paragraph (a link, a [1] style citation, or "Source:")

No network, no dependencies: Python 3.9+ standard library only. Exit code 1 if anything FAILs.
"""
from __future__ import annotations

import datetime as dt
import json
import re
import sys
from dataclasses import dataclass, asdict

WEEKDAYS = {
    'mon': 0, 'monday': 0, 'tue': 1, 'tues': 1, 'tuesday': 1, 'wed': 2, 'weds': 2, 'wednesday': 2,
    'thu': 3, 'thur': 3, 'thurs': 3, 'thursday': 3, 'fri': 4, 'friday': 4, 'sat': 5, 'saturday': 5,
    'sun': 6, 'sunday': 6,
}
DAY_NAMES = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday']
MONTHS = {m: i + 1 for i, m in enumerate(['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'])}
MONTHS.update({'sept': 9, 'january': 1, 'february': 2, 'march': 3, 'april': 4, 'june': 6, 'july': 7, 'august': 8,
               'september': 9, 'october': 10, 'november': 11, 'december': 12})

WD = r'(?P<wd>' + '|'.join(sorted(WEEKDAYS, key=len, reverse=True)) + r')\.?'
MON = r'(?P<mon>' + '|'.join(sorted(MONTHS, key=len, reverse=True)) + r')\.?'
DATE_PATTERNS = [
    # Mon 9/28, Monday 9/28/2026, Mon, 9/28
    re.compile(WD + r',?\s+(?P<m>\d{1,2})/(?P<d>\d{1,2})(?:/(?P<y>\d{2,4}))?\b', re.I),
    # Monday, September 28 / Mon Sep 28, 2026 / Mon Sept. 28th
    re.compile(WD + r',?\s+' + MON + r'\s+(?P<d>\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(?P<y>\d{4}))?\b', re.I),
    # Sat 14 Jun / Saturday 14 June 2026
    re.compile(WD + r',?\s+(?P<d>\d{1,2})(?:st|nd|rd|th)?\s+' + MON + r'(?:\s+(?P<y>\d{4}))?\b', re.I),
    # 2026-09-28 (Mon) / 2026-09-28, Monday
    re.compile(r'(?P<y>\d{4})-(?P<m>\d{2})-(?P<d>\d{2})\s*[,(]?\s*' + WD, re.I),
    # September 28 (Mon) / Sep 28, Monday
    re.compile(MON + r'\s+(?P<d>\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(?P<y>\d{4}))?\s*[,(]\s*' + WD + r'\)?', re.I),
]

NUM = r'[-−]?\$?\d[\d,]*(?:\.\d+)?%?[KkMmBb]?'
ARITH = re.compile(r'(?P<a>' + NUM + r')\s*(?P<op>[x×*+\-−/÷])\s*(?P<b>' + NUM + r')\s*=\s*(?P<c>' + NUM + r')')
N_OF_M = re.compile(r'\b(?P<n>\d[\d,]*)\s+(?:of|out of)\s+(?P<m>\d[\d,]*)\b[^.\n]{0,25}?\(?\s*(?P<p>\d+(?:\.\d+)?)\s*%', re.I)
CHANGE = re.compile(
    r'from\s+(?P<a>' + NUM + r')\s+to\s+(?P<b>' + NUM + r')[^.\n]{0,30}?(?P<dir>up|down|increase|decrease|drop|rise|gain|\+|−|-)\s*(?:of\s+|by\s+)?(?P<p>\d+(?:\.\d+)?)\s*%'
    r'|(?P<dir2>up|down|increased?|decreased?|dropped|rose|grew|fell)\s+(?:by\s+)?(?P<p2>\d+(?:\.\d+)?)\s*%\s+from\s+(?P<a2>' + NUM + r')\s+to\s+(?P<b2>' + NUM + r')',
    re.I)
MONEY_PRECISION = re.compile(r'\$\s?\d[\d,]*\.\d{3,}\b')
STAT_HINT = re.compile(r'\d[\d,.]*\s*(?:%|percent|[KMB]\b|million|billion|thousand|users|members|visitors|monthly|MAU|DAU|searches|downloads|subscribers|followers)', re.I)
SOURCE_HINT = re.compile(r'https?://|\]\(|\[\d+\]|\bsources?:|\baccording to\b|\bper\s+[A-Z]|\(\s*[A-Z][\w.]+(?:\s[\w.]+){0,3},\s*\d{4}\s*\)', re.I)


@dataclass
class Finding:
    level: str
    line: int
    msg: str
    text: str


def to_number(s: str) -> float | None:
    s = s.replace('−', '-').replace('$', '').replace(',', '').strip()
    mult = 1.0
    if s and s[-1] in 'KkMmBb':
        mult = {'k': 1e3, 'm': 1e6, 'b': 1e9}[s[-1].lower()]
        s = s[:-1]
    s = s.rstrip('%')
    try:
        return float(s) * mult
    except ValueError:
        return None


def decimals(s: str) -> int:
    m = re.search(r'\.(\d+)', s)
    return len(m.group(1)) if m else 0


def close(expected: float, stated: float, stated_text: str, rel: float = 0.005) -> bool:
    """True if `stated` matches `expected`, allowing for rounding to the precision it was written with."""
    step = 10 ** -decimals(stated_text)
    if stated_text.rstrip()[-1:] in 'KkMmBb':
        step *= {'k': 1e3, 'm': 1e6, 'b': 1e9}[stated_text.rstrip()[-1].lower()]
    return abs(expected - stated) <= max(step / 2 + 1e-9, abs(expected) * rel)


def check_dates(line: str, n: int, year: int, out: list[Finding]) -> None:
    seen = set()
    for pat in DATE_PATTERNS:
        for m in pat.finditer(line):
            if m.span() in seen:
                continue
            seen.add(m.span())
            g = m.groupdict()
            try:
                month = int(g['m']) if g.get('m') else MONTHS[g['mon'].lower().rstrip('.')]
                day = int(g['d'])
                y = int(g['y']) if g.get('y') else year
                if y < 100:
                    y += 2000
                date = dt.date(y, month, day)
            except (ValueError, KeyError, TypeError):
                out.append(Finding('FAIL', n, f'"{m.group(0)}" is not a real date', line.strip()))
                continue
            said = WEEKDAYS[g['wd'].lower().rstrip('.')]
            if date.weekday() != said:
                out.append(Finding('FAIL', n,
                                   f'"{m.group(0)}": {date:%B} {date.day}, {date.year} is a {DAY_NAMES[date.weekday()]}, not a {DAY_NAMES[said]}',
                                   line.strip()))


def check_arith(line: str, n: int, out: list[Finding]) -> None:
    for m in ARITH.finditer(line):
        a, b, c = (to_number(m.group(k)) for k in 'abc')
        if None in (a, b, c):
            continue
        op = m.group('op')
        # "9/28 = ..." style dates and "1-2" ranges are not arithmetic claims.
        if op in '-−' and not re.search(r'\s[-−]\s', m.group(0)):
            continue
        if op == '/' and not re.search(r'\s/\s', m.group(0)):
            continue
        if op in 'x×*':
            exp = a * b
        elif op == '+':
            exp = a + b
        elif op in '-−':
            exp = a - b
        else:
            if b == 0:
                continue
            exp = a / b
        if not close(exp, c, m.group('c')):
            out.append(Finding('FAIL', n, f'"{m.group(0).strip()}" is wrong: it comes to {fmt(exp)}', line.strip()))


def check_ratios(line: str, n: int, out: list[Finding]) -> None:
    for m in N_OF_M.finditer(line):
        num, den, p = to_number(m.group('n')), to_number(m.group('m')), to_number(m.group('p'))
        if not den or num is None or p is None or num > den:
            continue
        exp = num / den * 100
        if not close(exp, p, m.group('p'), rel=0.0) and abs(exp - p) >= 0.5 + 1e-9:
            out.append(Finding('FAIL', n, f'{m.group("n")} of {m.group("m")} is {fmt(exp)}%, not {m.group("p")}%', line.strip()))


def check_changes(line: str, n: int, out: list[Finding]) -> None:
    for m in CHANGE.finditer(line):
        g = m.groupdict()
        a_t, b_t, p_t, d = (g['a'], g['b'], g['p'], g['dir']) if g.get('a') else (g['a2'], g['b2'], g['p2'], g['dir2'])
        a, b, p = to_number(a_t), to_number(b_t), to_number(p_t)
        if not a or b is None or p is None:
            continue
        # A change stated in percent between two percentages is ambiguous (points vs percent); skip it.
        if a_t.endswith('%') and b_t.endswith('%'):
            continue
        exp = (b - a) / abs(a) * 100
        down = d.lower().startswith(('down', 'decrease', 'drop', 'fell', '-', '−'))
        if down:
            exp = -exp
        # Allow rounding to the precision written, and up to 1 point for "about 20%" style rounding.
        if abs(exp - p) > max(0.5 * 10 ** -decimals(p_t), 1.0):
            out.append(Finding('FAIL', n, f'{a_t} to {b_t} is {"down" if (b - a) < 0 else "up"} {fmt(abs((b - a) / abs(a) * 100))}%, not {"down" if down else "up"} {p_t}%', line.strip()))


def check_money(line: str, n: int, out: list[Finding]) -> None:
    for m in MONEY_PRECISION.finditer(line):
        out.append(Finding('WARN', n, f'"{m.group(0)}" has more than 2 decimal places; real money amounts don\'t', line.strip()))


def check_tables(lines: list[str], out: list[Finding]) -> None:
    i = 0
    while i < len(lines):
        if lines[i].lstrip().startswith('|') and i + 1 < len(lines) and re.match(r'^\s*\|?\s*:?-{2,}', lines[i + 1]):
            header = split_row(lines[i])
            rows = []
            j = i + 2
            while j < len(lines) and lines[j].lstrip().startswith('|'):
                rows.append((j + 1, split_row(lines[j])))
                j += 1
            body = []
            for ln, cells in rows:
                if cells and re.search(r'\btotal\b', cells[0], re.I):
                    for col in range(1, len(cells)):
                        vals = [to_number(r[col]) for _, r in body if col < len(r)]
                        stated = to_number(cells[col]) if cells[col].strip() else None
                        if stated is None or not vals or any(v is None for v in vals):
                            continue
                        name = header[col] if col < len(header) else f'column {col + 1}'
                        if name.strip().endswith('%') or '%' in cells[col]:
                            continue
                        s = sum(vals)
                        if not close(s, stated, cells[col]):
                            out.append(Finding('FAIL', ln, f'table total for "{name.strip()}" says {cells[col].strip()} but the rows add up to {fmt(s)}', lines[ln - 1].strip()))
                else:
                    body.append((ln, cells))
            i = j
        else:
            i += 1


def split_row(row: str) -> list[str]:
    row = row.strip()
    if row.startswith('|'):
        row = row[1:]
    if row.endswith('|'):
        row = row[:-1]
    return [c.strip().strip('*') for c in row.split('|')]


def check_sources(text: str, out: list[Finding]) -> None:
    line_no = 1
    for para in re.split(r'\n\s*\n', text):
        start = line_no
        line_no += para.count('\n') + 2
        if para.lstrip().startswith(('|', '```', '#')):
            continue
        stats = [m.group(0) for m in STAT_HINT.finditer(para)]
        if stats and not SOURCE_HINT.search(para):
            first = para.strip().splitlines()[0][:100]
            out.append(Finding('WARN', start, f'figures with no source nearby: {", ".join(dict.fromkeys(stats[:4]))}', first))


def fmt(x: float) -> str:
    if abs(x - round(x)) < 1e-9:
        return f'{int(round(x)):,}'
    return f'{x:,.2f}'.rstrip('0').rstrip('.')


def check_text(text: str, year: int) -> list[Finding]:
    out: list[Finding] = []
    lines = text.splitlines()
    in_code = False
    for n, line in enumerate(lines, 1):
        if line.strip().startswith('```'):
            in_code = not in_code
            continue
        if in_code:
            continue
        check_dates(line, n, year, out)
        check_arith(line, n, out)
        check_ratios(line, n, out)
        check_changes(line, n, out)
        check_money(line, n, out)
    check_tables(lines, out)
    check_sources(text, out)
    order = {'FAIL': 0, 'WARN': 1}
    return sorted(out, key=lambda f: (order[f.level], f.line))


def main(argv: list[str]) -> int:
    year = dt.date.today().year
    as_json = False
    files = []
    i = 0
    while i < len(argv):
        if argv[i] == '--year':
            year = int(argv[i + 1]); i += 2; continue
        if argv[i] == '--json':
            as_json = True; i += 1; continue
        if argv[i] in ('-h', '--help'):
            print(__doc__); return 0
        files.append(argv[i]); i += 1
    if not files:
        files = ['-']
    results = {}
    for f in files:
        text = sys.stdin.read() if f == '-' else open(f, encoding='utf-8').read()
        results[f] = check_text(text, year)
    fails = sum(1 for fs in results.values() for x in fs if x.level == 'FAIL')
    if as_json:
        print(json.dumps({k: [asdict(x) for x in v] for k, v in results.items()}, indent=2))
    else:
        for f, fs in results.items():
            print(f'\n{f if f != "-" else "(stdin)"}')
            if not fs:
                print('  nothing found')
            for x in fs:
                print(f'  {x.level} line {x.line}: {x.msg}')
                print(f'       > {x.text[:110]}')
        print(f'\n{fails} FAIL finding(s)' if fails else '\nno FAIL findings')
    return 1 if fails else 0


if __name__ == '__main__':
    sys.exit(main(sys.argv[1:]))
