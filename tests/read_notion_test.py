import importlib.util
import io
from pathlib import Path
import unittest
import zipfile

spec = importlib.util.spec_from_file_location('read_notion', Path(__file__).resolve().parents[1] / 'lib/read_notion.py')
reader = importlib.util.module_from_spec(spec)
spec.loader.exec_module(reader)

def bundle(files):
    out = io.BytesIO()
    with zipfile.ZipFile(out, 'w') as z:
        for name, data in files.items(): z.writestr(name, data)
    return out.getvalue()

class NotionImport(unittest.TestCase):
    def test_preserves_content_removes_active_markup(self):
        result = reader.parse(b'''<html><title>Flow8</title><style>p{color:red}</style><article><h1>Guide</h1><script>alert(1)</script><p onclick="bad()">Hello <a href="javascript:alert(1)">bad link</a></p><iframe src="https://evil.test"></iframe><a href="https://notion.so">source</a><div style="background:url(https://evil.test)">safe</div></article></html>''')
        self.assertEqual(result['title'], 'Flow8')
        for fragment in ['<script', '<iframe', 'onclick=', 'javascript:', 'url(https://evil.test)']: self.assertNotIn(fragment, result['html'])
        self.assertIn('<h1>Guide</h1>', result['html'])
        self.assertIn('href="https://notion.so"', result['html'])
        self.assertIn('p{color:red}', result['html'])
    def test_zip_selection_and_image(self):
        raw = bundle({'page.html':'<html><title>One</title><img src="assets/test.png"></html>', 'sub/page2.html':'<p>Two</p>', 'assets/test.png':b'fake-image'})
        self.assertEqual(reader.parse(raw)['pages'], ['page.html','sub/page2.html'])
        self.assertIn('data:image/png;base64,', reader.parse(raw,'page.html')['html'])
        with self.assertRaises(ValueError): reader.parse(raw,'missing.html')
    def test_rejects_bad_archives_and_non_html(self):
        for raw in [b'not an HTML page', bundle({'../page.html':'<p>bad</p>'}), bundle({'file.txt':'hello'})]:
            with self.assertRaises(ValueError): reader.parse(raw)
    def test_svg_and_local_missing_images_are_omitted(self):
        self.assertNotIn('<img', reader.parse(b'<html><p>text</p><img src="file:///private/file"><img src="data:image/svg+xml,bad"></html>')['html'])

if __name__ == '__main__': unittest.main()
