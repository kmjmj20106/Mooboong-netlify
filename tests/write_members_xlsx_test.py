import io
import sys
import unittest
import xml.etree.ElementTree as ET
from pathlib import Path
from zipfile import ZipFile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'lib'))
from write_members_xlsx import build_workbook, NS, TEMPLATE
from read_xlsx import parse_xlsx


class MemberExportTests(unittest.TestCase):
    def test_values_are_strings_and_existing_form_is_preserved(self):
        original = TEMPLATE.read_bytes()
        payload = {'members': [{'id': '=1+1', 'name': '김 & <민준>', 'phone': '01001230000', 'session': '보컬', 'generation': '02', 'admin': True, 'password_hash': 'secret-hash', 'teams': [{'name': '팀 A'}, {'name': '팀 B'}]}],
                   'teams': [{'name': '팀 A', 'slots': {'vocal': '=1+1'}}]}
        data = build_workbook(payload)
        workbook = parse_xlsx(data)
        self.assertEqual(workbook['members'][0]['아이디'], '=1+1')
        self.assertEqual(workbook['members'][0]['이름'], '김 & <민준>')
        self.assertEqual(workbook['members'][0]['전화번호'], '01001230000')
        self.assertEqual(workbook['members'][0]['기수'], '02')
        self.assertEqual(workbook['members'][0]['비밀번호'], '')
        self.assertEqual(workbook['members'][0]['팀'], '팀 A, 팀 B')
        self.assertEqual(workbook['teams'][0]['보컬'], '=1+1')
        self.assertEqual(workbook['teams'][0]['기타1'], '')
        with ZipFile(io.BytesIO(data)) as z:
            self.assertNotIn(b'secret-hash', b''.join(z.read(n) for n in z.namelist()))
            for name in ('xl/worksheets/sheet1.xml', 'xl/worksheets/sheet2.xml'):
                root = ET.fromstring(z.read(name))
                self.assertEqual(root.findall(f'.//{{{NS}}}f'), [])
        self.assertEqual(TEMPLATE.read_bytes(), original)

    def test_empty_and_large_exports(self):
        self.assertEqual(parse_xlsx(build_workbook({'members': [], 'teams': []})), {'members': [], 'teams': []})
        payload = {'members': [{'id': str(i), 'name': f'멤버{i}'} for i in range(1000)], 'teams': []}
        self.assertEqual(len(parse_xlsx(build_workbook(payload))['members']), 1000)


if __name__ == '__main__':
    unittest.main()
