import importlib.util
import io
from pathlib import Path
import unittest
from xml.sax.saxutils import escape
import zipfile

ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location('read_xlsx', ROOT / 'lib' / 'read_xlsx.py')
reader = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(reader)


def workbook_xml(rows, headers=None):
    headers = headers or reader.HEADERS['members']
    header_xml = ''.join(f'<c r="{chr(65+i)}1" t="inlineStr"><is><t>{escape(name)}</t></is></c>' for i,name in enumerate(headers))
    stream = io.BytesIO()
    with zipfile.ZipFile(stream,'w',zipfile.ZIP_DEFLATED) as archive:
        archive.writestr('xl/workbook.xml', '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="멤버" r:id="rId1"/></sheets></workbook>')
        archive.writestr('xl/_rels/workbook.xml.rels', '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>')
        archive.writestr('xl/worksheets/sheet1.xml', f'<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">{header_xml}</row>{rows}</sheetData></worksheet>')
    return stream.getvalue()


class ReaderTests(unittest.TestCase):
    def test_downloadable_template(self):
        self.assertEqual(reader.parse_xlsx((ROOT/'public/templates/mooboong-import.xlsx').read_bytes()), {'members': [], 'teams': []})

    def test_text_phone_and_actual_row_number_preserved(self):
        data=workbook_xml('<row r="8"><c r="B8" t="inlineStr"><is><t>테스트</t></is></c><c r="F8" t="inlineStr"><is><t>01012345678</t></is></c></row>')
        row=reader.parse_xlsx(data)['members'][0]
        self.assertEqual(row['__row'],8)
        self.assertEqual(row['전화번호'],'01012345678')

    def test_numeric_phone_remains_numeric_for_validation(self):
        data=workbook_xml('<row r="2"><c r="F2"><v>1012345678</v></c></row>')
        self.assertIsInstance(reader.parse_xlsx(data)['members'][0]['전화번호'], int)

    def test_formula_rejected_even_with_cached_value(self):
        with self.assertRaisesRegex(reader.InvalidFile,'수식'):
            reader.parse_xlsx(workbook_xml('<row r="2"><c r="B2"><f>1+1</f><v>2</v></c></row>'))

    def test_unknown_duplicate_headers_rejected(self):
        for headers in [['이름']*8, ['ID','Name']]:
            with self.assertRaisesRegex(reader.InvalidFile,'열 제목'):
                reader.parse_xlsx(workbook_xml('',headers))

    def test_extra_data_column_rejected(self):
        with self.assertRaisesRegex(reader.InvalidFile,'양식 범위'):
            reader.parse_xlsx(workbook_xml('<row r="2"><c r="J2" t="inlineStr"><is><t>추가</t></is></c></row>'))

    def test_input_limit(self):
        with self.assertRaisesRegex(reader.InvalidFile,'4 MB'):
            reader.parse_xlsx(b'PK'+b'0'*reader.MAX_INPUT)

    def test_xml_entities_rejected(self):
        for encoding in ('utf-8', 'utf-16', 'utf-32'):
            stream=io.BytesIO()
            with zipfile.ZipFile(stream,'w') as archive:
                archive.writestr('xl/workbook.xml','<!DOCTYPE a [<!ENTITY b "test">]><a>&b;</a>'.encode(encoding))
            with self.assertRaisesRegex(reader.InvalidFile,'XML'):
                reader.parse_xlsx(stream.getvalue())


if __name__ == '__main__':
    unittest.main()
