#!/usr/bin/env python3
"""Validate SKILL.md YAML frontmatter with smart description checks and auto-fix.

Checks:
1. Frontmatter exists and is properly closed with ---
2. description field exists and is non-empty
3. YAML parses without errors
4. If description uses double-quoted string: escape quotes (\") must be paired
5. If description uses double-quoted string with many escapes (>= 4 \"): warn to use >-
6. If description uses >- block scalar: content must not contain standalone --- line
7. If description is unquoted plain string: error (colons/quotes may break YAML)

Auto-fix (--fix):
- Converts problematic double-quoted descriptions to >- block scalar (unescaping \\")
- Preserves all other frontmatter fields exactly

Usage:
  python3 scripts/validate-skill-yaml.py skills/*/SKILL.md
  python3 scripts/validate-skill-yaml.py --fix skills/*/SKILL.md
  python3 scripts/validate-skill-yaml.py ~/.pi/agent/skills/*/SKILL.md
"""

import re
import sys
import yaml
import glob
import os
import argparse


def _find_block_scalar_end(fm_lines: list[str], start: int) -> tuple[int, int]:
    """Find the end of a block scalar (>- or |) starting at `start`.

    Block scalar ends when a new top-level key appears at same or less
    indentation than the description key, or at end of frontmatter.
    """
    line = fm_lines[start]
    desc_indent = len(line) - len(line.lstrip())
    j = start + 1
    while j < len(fm_lines):
        if fm_lines[j].strip() == '':
            j += 1
            continue
        line_indent = len(fm_lines[j]) - len(fm_lines[j].lstrip())
        # A new key at same or less indentation ends the block
        if line_indent <= desc_indent and not fm_lines[j].lstrip().startswith('-'):
            return (start, j - 1)
        j += 1
    return (start, len(fm_lines) - 1)


def find_description_lines(fm_lines: list[str]) -> tuple[int, int] | None:
    """Find start/end line indices of description field in frontmatter lines.

    Handles three forms:
    - Inline quoted: description: "..."
    - Inline quoted multiline: description: "line1
                                               line2"
    - Block scalar:     description: >-
                          line1
                          line2
    Returns (start_idx, end_idx_inclusive) or None if not found.
    """
    for i, line in enumerate(fm_lines):
        stripped = line.lstrip()
        if stripped.startswith('description:'):
            raw_after = stripped[len('description:'):]
            # Inline value (possibly multiline quoted string)
            if raw_after.strip():
                val = raw_after.strip()
                # Block scalar indicator on same line
                if val.startswith('>-') or val.startswith('|'):
                    return _find_block_scalar_end(fm_lines, i)
                # Quoted string
                if val.startswith('"') and not val.endswith('"'):
                    # Multiline double-quoted string
                    j = i + 1
                    while j < len(fm_lines):
                        if fm_lines[j].rstrip().endswith('"'):
                            return (i, j)
                        j += 1
                    return (i, len(fm_lines) - 1)
                elif val.startswith("'") and not val.endswith("'"):
                    # Multiline single-quoted string
                    j = i + 1
                    while j < len(fm_lines):
                        if fm_lines[j].rstrip().endswith("'"):
                            return (i, j)
                        j += 1
                    return (i, len(fm_lines) - 1)
                else:
                    return (i, i)
            # Block scalar (value starts on next line)
            else:
                return _find_block_scalar_end(fm_lines, i)
    return None


def detect_description_type(fm_lines: list[str], start: int) -> str:
    """Detect whether description is quoted string, >-, |, or plain."""
    first_line = fm_lines[start]
    raw_after = first_line.split(':', 1)[1].strip()
    if raw_after.startswith('"'):
        return 'double-quoted'
    if raw_after.startswith("'"):
        return 'single-quoted'
    if raw_after.startswith('>-'):
        return 'folded-block'
    if raw_after.startswith('|'):
        return 'literal-block'
    if raw_after == '':
        # Could be block scalar on next line
        if start + 1 < len(fm_lines):
            next_stripped = fm_lines[start + 1].strip()
            if next_stripped.startswith('>-'):
                return 'folded-block'
            if next_stripped.startswith('|'):
                return 'literal-block'
    return 'plain'


def get_description_raw_text(fm_lines: list[str], start: int, end: int, dtype: str) -> str:
    """Extract the raw text value of description from frontmatter lines."""
    if dtype in ('double-quoted', 'single-quoted'):
        # Collect lines from start to end, strip quotes
        first = fm_lines[start].split(':', 1)[1].strip()
        # Remove opening quote from first
        if first.startswith('"'):
            first = first[1:]
        elif first.startswith("'"):
            first = first[1:]
        if end == start:
            # Single line
            if first.endswith('"'):
                first = first[:-1]
            elif first.endswith("'"):
                first = first[:-1]
            return first
        # Multiline: first line (without opening quote), middle lines, last line (without closing quote)
        parts = [first] if first else []
        for i in range(start + 1, end):
            parts.append(fm_lines[i])
        last = fm_lines[end].rstrip()
        if last.endswith('"'):
            last = last[:-1]
        elif last.endswith("'"):
            last = last[:-1]
        parts.append(last)
        return '\n'.join(parts)
    elif dtype in ('folded-block', 'literal-block'):
        # Block scalar: content starts after the indicator line
        # The indicator is either on the same line or next line
        first = fm_lines[start].split(':', 1)[1].strip()
        content_start = start
        if first == '':
            # Indicator on next line
            content_start = start + 1
        # Skip the indicator line, collect indented content
        parts = []
        for i in range(content_start + 1, end + 1):
            parts.append(fm_lines[i])
        return '\n'.join(parts)
    else:
        # Plain string
        first = fm_lines[start].split(':', 1)[1].strip()
        parts = [first] if first else []
        for i in range(start + 1, end + 1):
            parts.append(fm_lines[i])
        return '\n'.join(parts)


def fix_description_to_folded_block(fm_lines: list[str], start: int, end: int, dtype: str) -> list[str]:
    """Convert a problematic description to >- block scalar. Returns modified frontmatter lines."""
    raw_text = get_description_raw_text(fm_lines, start, end, dtype)
    # Unescape escaped quotes
    raw_text = raw_text.replace('\\"', '"')
    # Normalize whitespace: collapse multiple spaces/newlines into single spaces
    raw_text = ' '.join(raw_text.split())

    new_lines = fm_lines[:start]
    new_lines.append('description: >-')
    new_lines.append('  ' + raw_text)
    new_lines.extend(fm_lines[end + 1:])
    return new_lines


def validate_skill(fpath: str, fix: bool = False) -> tuple[list[str], list[str], bool]:
    """Validate a single SKILL.md file.

    Returns: (errors, warnings, was_fixed)
    """
    errors = []
    warnings = []
    name = os.path.basename(os.path.dirname(fpath))
    was_fixed = False

    with open(fpath) as f:
        content = f.read()

    # Check 1: frontmatter exists
    fm_match = re.match(r'^---\n(.*?)\n---', content, re.DOTALL)
    if not fm_match:
        errors.append(f'{name}: no valid YAML frontmatter (missing ---)')
        return errors, warnings, was_fixed

    fm_text = fm_match.group(1)
    fm_lines = fm_text.split('\n')
    content_after_fm = content[fm_match.end():]

    # Locate description in frontmatter lines
    desc_range = find_description_lines(fm_lines)
    if desc_range is None:
        errors.append(f'{name}: missing description field')
        return errors, warnings, was_fixed

    desc_start, desc_end = desc_range
    dtype = detect_description_type(fm_lines, desc_start)

    # Check 2: description is quoted or block scalar (not plain string)
    if dtype == 'plain':
        errors.append(f'{name}: description is unquoted plain string (will break on colons/quotes)')
        if fix:
            fm_lines = fix_description_to_folded_block(fm_lines, desc_start, desc_end, dtype)
            was_fixed = True
            # Re-analyze
            desc_range = find_description_lines(fm_lines)
            if desc_range:
                desc_start, desc_end = desc_range
                dtype = detect_description_type(fm_lines, desc_start)

    # Check 3: YAML parses
    try:
        data = yaml.safe_load(fm_text)
    except yaml.YAMLError as e:
        line = str(e).split('\n')[0][:80]
        errors.append(f'{name}: YAML parse error: {line}')
        return errors, warnings, was_fixed

    if not data:
        errors.append(f'{name}: frontmatter is empty')
        return errors, warnings, was_fixed

    desc_value = data.get('description', '')
    if not desc_value or not str(desc_value).strip():
        errors.append(f'{name}: description is empty')
        return errors, warnings, was_fixed

    # Check 4: Double-quoted string: escape pairing
    if dtype == 'double-quoted':
        raw_text = get_description_raw_text(fm_lines, desc_start, desc_end, dtype)
        # Count unescaped quotes (they are escaped as \\" in the raw text)
        # In the raw text, \\" represents an escaped quote in the YAML source
        escape_count = raw_text.count('\\"')
        if escape_count % 2 != 0:
            errors.append(
                f'{name}: description has unpaired escaped quotes ({escape_count} \\") — '
                f'YAML parser will fail with "Missing closing quote"'
            )
            if fix:
                fm_lines = fix_description_to_folded_block(fm_lines, desc_start, desc_end, dtype)
                was_fixed = True
        elif escape_count >= 4:
            warnings.append(
                f'{name}: description has {escape_count} escaped quotes (\\") — '
                f'consider using ">-" block scalar to avoid escape pairing issues'
            )
            if fix:
                fm_lines = fix_description_to_folded_block(fm_lines, desc_start, desc_end, dtype)
                was_fixed = True

    # Check 5: Block scalar: no standalone --- line inside
    if dtype in ('folded-block', 'literal-block'):
        block_text = get_description_raw_text(fm_lines, desc_start, desc_end, dtype)
        for line in block_text.split('\n'):
            if line.strip() == '---':
                errors.append(
                    f'{name}: block scalar description contains standalone "---" line — '
                    f'this is parsed as YAML document end marker'
                )
                break

    # If fixed, rewrite the file
    if was_fixed:
        new_fm = '\n'.join(fm_lines)
        new_content = '---\n' + new_fm + '\n---' + content_after_fm
        with open(fpath, 'w') as f:
            f.write(new_content)

    return errors, warnings, was_fixed


def main():
    parser = argparse.ArgumentParser(description='Validate SKILL.md YAML frontmatter')
    parser.add_argument('files', nargs='+', help='SKILL.md files to validate')
    parser.add_argument('--fix', action='store_true', help='Auto-fix problems in place')
    args = parser.parse_args()

    file_list = []
    for arg in args.files:
        file_list.extend(glob.glob(arg))

    if not file_list:
        print('No files matched.')
        sys.exit(1)

    total_errors = 0
    total_warnings = 0
    total_fixed = 0
    ok = 0

    for fpath in sorted(file_list):
        errors, warnings, was_fixed = validate_skill(fpath, fix=args.fix)
        label = os.path.basename(os.path.dirname(fpath))

        if was_fixed:
            print(f'  FIXED: {label}')
            total_fixed += 1

        for err in errors:
            print(f'  ERROR: {err}')
        for warn in warnings:
            print(f'  WARN:  {warn}')

        if errors:
            total_errors += len(errors)
        elif warnings:
            total_warnings += len(warnings)
            ok += 1
        else:
            ok += 1

    print(f'\n{ok}/{len(file_list)} files OK.')
    if total_fixed:
        print(f'{total_fixed} file(s) auto-fixed.')
    if total_warnings:
        print(f'{total_warnings} warning(s).')
    if total_errors:
        print(f'{total_errors} error(s) found.')
        sys.exit(1)
    else:
        print('All good.')


if __name__ == '__main__':
    main()
