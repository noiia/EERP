#!/usr/bin/env python3
"""Rewrite the README's coverage badges from the figures a CI run measured.

Usage: update-coverage-badges.py README.md name=percent [name=percent ...]
  e.g. update-coverage-badges.py README.md core=85.6 pdf-service=72.1 front-shell=82.9

Only the lines between `<!-- coverage-badges:start -->` and
`<!-- coverage-badges:end -->` are replaced, one shields.io badge per service, in
the order given. A service with an empty or non-numeric value keeps its current
badge (its job didn't report a figure). Exits 0 whether or not anything changed;
the workflow commits only when `git diff` sees a change.
"""
import re
import sys
from pathlib import Path

START, END = '<!-- coverage-badges:start -->', '<!-- coverage-badges:end -->'

# Where each badge links: the gate that enforces that service's floor.
LINKS = {
    'core': '.github/.testcoverage.yml',
    'pdf-service': '.github/.testcoverage-pdf-service.yml',
    'front-shell': 'core-front/apps/shell/vitest.config.ts',
    'front-engine': 'core-front/packages/core-front/vitest.config.ts',
}


def color(pct: float) -> str:
    return 'brightgreen' if pct >= 80 else 'yellow' if pct >= 70 else 'orange' if pct >= 50 else 'red'


def badge(name: str, pct: float) -> str:
    label = f'coverage/{name}'
    enc = label.replace('-', '--').replace('/', '%2F')
    return f'[![{label}](https://img.shields.io/badge/{enc}-{pct:.1f}%25-{color(pct)})]({LINKS.get(name, ".github/workflows/test-check.yml")})'


def main() -> int:
    readme, pairs = Path(sys.argv[1]), sys.argv[2:]
    text = readme.read_text()
    if START not in text or END not in text:
        print(f'{readme}: no {START} … {END} block', file=sys.stderr)
        return 1
    head, rest = text.split(START, 1)
    block, tail = rest.split(END, 1)
    current = {m.group(1): m.group(0) for m in re.finditer(r'\[!\[coverage/([\w-]+)\]\([^)]*\)\]\([^)]*\)', block)}
    lines = []
    for pair in pairs:
        name, _, value = pair.partition('=')
        value = value.strip().rstrip('%')
        try:
            lines.append(badge(name, float(value)))
        except ValueError:
            if name in current:
                lines.append(current[name])
    readme.write_text(head + START + '\n' + '\n'.join(lines) + '\n' + END + tail)
    return 0


if __name__ == '__main__':
    sys.exit(main())
