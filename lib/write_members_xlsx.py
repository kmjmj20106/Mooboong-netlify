#!/usr/bin/env python3
"""Fill a copy of the existing club template at runtime; no external packages."""
import io
import json
import re
import sys
from pathlib import Path
import xml.etree.ElementTree as ET
from zipfile import ZipFile, ZIP_DEFLATED

NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main'
ET.register_namespace('x', NS)
SLOTS = ('vocal', 'guitar1', 'guitar2', 'bass', 'drums', 'keyboard')
TEMPLATE = Path(__file__).resolve().parents[1] / 'public/templates/mooboong-import.xlsx'


def xml_text(value):
    # XML 1.0 excludes control characters and unpaired surrogate code points.
    return re.sub(r'[\x00-\x08\x0b\x0c\x0e-\x1f\ud800-\udfff\ufffe\uffff]', '', str(value or ''))


def fill_sheet(content, values):
    root = ET.fromstring(content)
    data = root.find(f'{{{NS}}}sheetData')
    styles = []
    for row in list(data)[1:3]:
        styles.append([cell.get('s', '0') for cell in row])
    for row in list(data):
        if row.get('r') != '1':
            data.remove(row)
    for index, fields in enumerate(values, 2):
        row = ET.SubElement(data, f'{{{NS}}}row', {'r': str(index), 'ht': '30', 'customHeight': '1'})
        for col, value in enumerate(fields):
            # Explicit strings preserve phone zeros and prevent formula injection.
            cell = ET.SubElement(row, f'{{{NS}}}c', {'r': f'{chr(65 + col)}{index}', 't': 'inlineStr', 's': styles[(index - 2) % len(styles)][col]})
            text = ET.SubElement(ET.SubElement(cell, f'{{{NS}}}is'), f'{{{NS}}}t', {'{http://www.w3.org/XML/1998/namespace}space': 'preserve'})
            text.text = xml_text(value)
    last = max(1, len(values) + 1)
    dimension = root.find(f'{{{NS}}}dimension')
    if dimension is not None:
        dimension.set('ref', f'A1:{chr(64 + len(data[0]))}{last}')
    return ET.tostring(root, encoding='utf-8', xml_declaration=True)


def build_workbook(payload):
    sheets = {
        'xl/worksheets/sheet1.xml': [
            [m['id'], m['name'], '', m.get('session', ''), m.get('generation', ''), m.get('phone', ''),
             ', '.join(t['name'] for t in m.get('teams', [])), 'Y' if m.get('admin') else 'N']
            for m in payload['members']
        ],
        'xl/worksheets/sheet2.xml': [
            [t['name'], *(t['slots'].get(slot, '') for slot in SLOTS)] for t in payload['teams']
        ],
    }
    output = io.BytesIO()
    with ZipFile(TEMPLATE) as source, ZipFile(output, 'w', ZIP_DEFLATED) as target:
        for item in source.infolist():
            content = source.read(item.filename)
            if item.filename in sheets:
                content = fill_sheet(content, sheets[item.filename])
            target.writestr(item.filename, content)
    return output.getvalue()


if __name__ == '__main__':
    sys.stdout.buffer.write(build_workbook(json.load(sys.stdin)))
