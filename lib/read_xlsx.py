#!/usr/bin/env python3
"""Bounded, dependency-free XLSX values reader for the club import form."""
import io
import json
import math
import posixpath
import re
import sys
import zipfile
import xml.etree.ElementTree as ET

MAX_INPUT = 4 * 1024 * 1024
MAX_EXPANDED = 25 * 1024 * 1024
MAX_ROWS = 1000
NS = {'s': 'http://schemas.openxmlformats.org/spreadsheetml/2006/main',
      'r': 'http://schemas.openxmlformats.org/officeDocument/2006/relationships'}
HEADERS = {
    'members': ['아이디', '이름', '비밀번호', '세션', '기수', '전화번호', '팀', '관리자여부'],
    'teams': ['팀명', '보컬', '기타1', '기타2', '베이스', '드럼', '키보드'],
}
SHEETS = {'멤버': 'members', '회원': 'members', 'members': 'members', '팀': 'teams', 'teams': 'teams'}


class InvalidFile(ValueError):
    pass


def parse_xlsx(data):
    if len(data) > MAX_INPUT:
        raise InvalidFile('파일은 4 MB 이하로 올려 주세요.')
    if not data.startswith(b'PK'):
        raise InvalidFile('.xlsx 형식으로 저장한 파일을 올려 주세요.')
    with zipfile.ZipFile(io.BytesIO(data)) as archive:
        infos = archive.infolist()
        if len(infos) > 400 or sum(i.file_size for i in infos) > MAX_EXPANDED:
            raise InvalidFile('압축 해제 크기가 너무 큰 파일입니다.')
        names = [i.filename for i in infos]
        if len(names) != len(set(names)):
            raise InvalidFile('중복된 압축 항목이 있는 파일입니다.')
        for item in infos:
            if item.file_size > MAX_EXPANDED or item.flag_bits & 1:
                raise InvalidFile('암호로 잠긴 파일이나 지나치게 큰 파일은 읽을 수 없습니다.')

        def xml(path):
            try:
                content = archive.read(path)
            except KeyError:
                raise InvalidFile('엑셀 파일에 필요한 정보가 없습니다.') from None
            # Removing NUL bytes also catches DTD declarations in UTF-16/32 XML.
            declarations = content.replace(b'\x00', b'').upper()
            if b'<!DOCTYPE' in declarations or b'<!ENTITY' in declarations:
                raise InvalidFile('외부 XML 정의가 있는 파일은 읽을 수 없습니다.')
            return ET.fromstring(content)

        shared = []
        if 'xl/sharedStrings.xml' in names:
            for item in xml('xl/sharedStrings.xml').findall('s:si', NS):
                value = ''.join(t.text or '' for t in item.findall('.//s:t', NS))
                if len(value) > 4096 or len(shared) > 20000:
                    raise InvalidFile('셀의 내용이 너무 깁니다.')
                shared.append(value)
        workbook = xml('xl/workbook.xml')
        relations = {}
        for rel in xml('xl/_rels/workbook.xml.rels'):
            if rel.get('TargetMode') == 'External':
                continue
            target = rel.get('Target', '')
            path = posixpath.normpath(target.lstrip('/') if target.startswith('/') else posixpath.join('xl', target))
            if not path.startswith('xl/') or '..' in path.split('/'):
                raise InvalidFile('엑셀 시트 경로가 올바르지 않습니다.')
            relations[rel.get('Id')] = path
        result = {'members': [], 'teams': []}
        found = set()
        for sheet in workbook.findall('s:sheets/s:sheet', NS):
            key = SHEETS.get(sheet.get('name', '').strip())
            if not key:
                continue
            if key in found:
                raise InvalidFile('같은 종류의 시트가 여러 개 있습니다. 멤버와 팀은 각각 한 시트만 사용해 주세요.')
            found.add(key)
            relation_id = sheet.get('{%s}id' % NS['r'])
            if relation_id not in relations:
                raise InvalidFile('시트 정보를 찾을 수 없습니다.')
            root = xml(relations[relation_id])
            header = None
            visited_rows = set()
            for row in root.findall('s:sheetData/s:row', NS):
                try:
                    row_num = int(row.get('r', '0'))
                except ValueError:
                    raise InvalidFile('행 번호가 올바르지 않습니다.') from None
                if row_num < 1 or row_num > 100001 or row_num in visited_rows:
                    raise InvalidFile('행 번호가 올바르지 않거나 중복됩니다.')
                visited_rows.add(row_num)
                cells = {}
                visited_cells = set()
                for cell in row.findall('s:c', NS):
                    ref = cell.get('r', '')
                    match = re.fullmatch(r'([A-Z]{1,3})([1-9][0-9]*)', ref)
                    if not match or int(match.group(2)) != row_num:
                        raise InvalidFile('셀 주소가 올바르지 않습니다.')
                    col = 0
                    for letter in match.group(1):
                        col = col * 26 + ord(letter) - 64
                    if col in visited_cells:
                        raise InvalidFile('중복된 셀이 있습니다.')
                    visited_cells.add(col)
                    if cell.find('s:f', NS) is not None:
                        raise InvalidFile('등록 양식에는 수식 대신 값을 입력해 주세요.')
                    cell_type = cell.get('t', 'n')
                    value_element = cell.find('s:v', NS)
                    value = value_element.text if value_element is not None else None
                    if cell_type == 's':
                        try:
                            index = int(value)
                            if index < 0:
                                raise ValueError()
                            value = shared[index]
                        except (ValueError, TypeError, IndexError):
                            raise InvalidFile('셀 문자열 정보가 올바르지 않습니다.') from None
                    elif cell_type == 'inlineStr':
                        value = ''.join(t.text or '' for t in cell.findall('.//s:t', NS))
                    elif cell_type in ('n', '') and value not in (None, ''):
                        try:
                            number = float(value)
                            if not math.isfinite(number):
                                raise ValueError()
                            value = int(number) if number.is_integer() else number
                        except ValueError:
                            raise InvalidFile('숫자 셀의 값이 올바르지 않습니다.') from None
                    elif cell_type == 'b':
                        value = value == '1'
                    elif cell_type not in ('str', 'n', ''):
                        raise InvalidFile('오류 또는 날짜 형식의 셀이 있습니다. 등록 항목은 문자로 입력해 주세요.')
                    if isinstance(value, str) and len(value) > 4096:
                        raise InvalidFile('셀의 내용이 너무 깁니다.')
                    if value not in (None, ''):
                        if col > 32:
                            raise InvalidFile('양식 범위를 벗어난 열에 내용이 있습니다.')
                        cells[col] = value
                if not cells:
                    continue
                if header is None:
                    if row_num != 1:
                        raise InvalidFile('첫 번째 행에 양식의 열 제목을 넣어 주세요.')
                    header = {col: str(value).strip() for col, value in cells.items()}
                    if len(header.values()) != len(set(header.values())) or set(header.values()) != set(HEADERS[key]):
                        raise InvalidFile('열 제목이 양식과 다릅니다. 내려받은 양식의 제목을 그대로 사용해 주세요.')
                    continue
                if any(col not in header for col in cells):
                    raise InvalidFile('양식 범위를 벗어난 열에 내용이 있습니다.')
                if len(result[key]) >= MAX_ROWS:
                    raise InvalidFile('한 시트에 최대 1000행까지 등록할 수 있습니다.')
                values = {name: cells.get(col, '') for col, name in header.items()}
                values['__row'] = row_num
                result[key].append(values)
            if header is None:
                raise InvalidFile('첫 번째 행에 양식의 열 제목이 필요합니다.')
        if not found:
            raise InvalidFile('멤버 또는 팀 시트를 찾을 수 없습니다. 양식의 시트 이름을 유지해 주세요.')
        return result


if __name__ == '__main__':
    try:
        if len(sys.argv) > 1 and sys.argv[1] != '-':
            with open(sys.argv[1], 'rb') as source:
                data = source.read(MAX_INPUT + 1)
        else:
            data = sys.stdin.buffer.read(MAX_INPUT + 1)
        print(json.dumps(parse_xlsx(data), ensure_ascii=False))
    except InvalidFile as exc:
        print(json.dumps({'error': str(exc)}, ensure_ascii=False))
        sys.exit(1)
    except (zipfile.BadZipFile, ET.ParseError, OSError, RuntimeError, ValueError, OverflowError):
        print(json.dumps({'error': '엑셀 파일을 읽을 수 없습니다. .xlsx 형식으로 다시 저장해 주세요.'}, ensure_ascii=False))
        sys.exit(1)
