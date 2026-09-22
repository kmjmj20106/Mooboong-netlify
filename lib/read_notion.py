"""Read a Notion HTML export without executing scripts or extracting ZIP files."""
import base64, html, io, json, mimetypes, posixpath, re, sys, zipfile
from html.parser import HTMLParser
from urllib.parse import urlsplit, unquote

MAX_BYTES = 20 * 1024 * 1024
TAGS = set('article section main header footer div span p h1 h2 h3 h4 h5 h6 br hr a img figure figcaption table thead tbody tfoot tr td th caption colgroup col ul ol li blockquote pre code strong b em i u s del mark small sub sup details summary time dl dt dd'.split())
VOID = {'br', 'hr', 'img', 'col'}
DROP = {'script', 'iframe', 'object', 'embed', 'svg', 'math', 'form', 'button', 'textarea', 'select', 'template'}

def safe_url(value):
    value = value.strip()
    if re.search(r'[\x00-\x20\x7f]', value):
        return ''
    if value.startswith('#'):
        return value
    url = urlsplit(value)
    return value if url.scheme.lower() in ('https', 'http', 'mailto') and not url.username else ''

def css(value):
    # CSS is isolated in a script-free iframe; disallow all network and legacy execution syntax.
    if re.search(r'url\s*\(|expression|@import|behavior|binding|\\|<', value, re.I):
        return ''
    return value

class Cleaner(HTMLParser):
    def __init__(self, assets, page):
        super().__init__(convert_charrefs=True)
        self.assets, self.page, self.out, self.depth, self.in_style = assets, page, [], 0, False
        self.in_title, self.title, self.text = False, [], []
    def handle_starttag(self, tag, attrs):
        if self.depth:
            if tag in DROP: self.depth += 1
            return
        if tag in DROP:
            self.depth = 1
            return
        if tag == 'title': self.in_title = True; return
        if tag == 'style': self.in_style = True; return
        if tag not in TAGS: return
        result = []
        attrs = dict(attrs)
        for key, value in attrs.items():
            if value is None: continue
            if key in ('class', 'id', 'title', 'alt', 'colspan', 'rowspan', 'start', 'width', 'height'):
                result.append((key, value[:500]))
            elif key == 'style' and css(value): result.append((key, css(value)))
        if tag == 'a':
            href = safe_url(attrs.get('href', ''))
            if href: result += [('href', href), ('target', '_blank'), ('rel', 'noopener noreferrer')]
        if tag == 'img':
            src = attrs.get('src', '')
            path = posixpath.normpath(posixpath.join(posixpath.dirname(self.page), unquote(urlsplit(src).path)))
            asset = self.assets.get(path)
            if asset:
                mime = mimetypes.guess_type(path)[0]
                if mime in ('image/png','image/jpeg','image/gif','image/webp'):
                    src = 'data:' + mime + ';base64,' + base64.b64encode(asset).decode()
                else: src = ''
            else:
                src = safe_url(src) if urlsplit(src).scheme in ('https','http') else ''
            if not src: return
            result += [('src', src), ('loading', 'lazy'), ('referrerpolicy', 'no-referrer')]
        self.out.append('<'+tag+''.join(' '+k+'="'+html.escape(v, quote=True)+'"' for k,v in result)+'>')
    def handle_endtag(self, tag):
        if self.depth:
            if tag in DROP: self.depth -= 1
            return
        if tag == 'title': self.in_title = False; return
        if tag == 'style': self.in_style = False; return
        if tag in TAGS and tag not in VOID: self.out.append('</'+tag+'>')
    def handle_data(self, data):
        if self.depth: return
        if self.in_title: self.title.append(data); return
        if self.in_style:
            safe = css(data)
            if safe: self.out.append('<style>'+safe+'</style>')
            return
        self.out.append(html.escape(data))
        self.text.append(data)

def parse(raw, entry=''):
    if len(raw)>MAX_BYTES: raise ValueError('20MB 이하의 파일을 선택해 주세요.')
    assets = {}
    page = 'index.html'
    if raw[:2] == b'PK':
        with zipfile.ZipFile(io.BytesIO(raw)) as archive:
            infos = archive.infolist()
            if len(infos)>1000 or sum(i.file_size for i in infos)>40*1024*1024: raise ValueError('압축을 푼 크기가 너무 큽니다. 한 페이지씩 내보내 주세요.')
            for i in infos:
                name = posixpath.normpath(i.filename)
                if name.startswith(('../','/')) or '\\' in name or i.flag_bits & 1: raise ValueError('지원하지 않는 ZIP 파일입니다.')
                if i.file_size>MAX_BYTES: raise ValueError('ZIP 안의 파일이 너무 큽니다.')
                if not i.is_dir(): assets[name] = archive.read(i)
        pages = sorted((p for p in assets if p.lower().endswith(('.html','.htm'))), key=lambda p:(p.count('/'),p))
        if not pages: raise ValueError('ZIP 안에 HTML 페이지가 없습니다.')
        if not entry and len(pages)>1: return {'pages':pages}
        page = entry or pages[0]
        if page not in pages: raise ValueError('가져올 HTML 페이지를 선택해 주세요.')
        raw = assets[page]
    text = raw.decode('utf-8-sig')
    if not re.search(r'<(?:html|article|div|p|h1)\b', text, re.I): raise ValueError('노션에서 내보낸 HTML 또는 ZIP 파일을 선택해 주세요.')
    parser = Cleaner(assets,page)
    parser.feed(text)
    document = '<!doctype html><html lang="ko"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><style>body{font:16px/1.8 -apple-system,sans-serif;max-width:900px;margin:24px auto;padding:0 20px;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{display:block;overflow:auto}pre{overflow:auto}a{color:#bd4633}</style></head><body>'+''.join(parser.out)+'</body></html>'
    if len(document.encode())>32*1024*1024: raise ValueError('페이지와 이미지의 크기가 너무 큽니다.')
    return {'title':''.join(parser.title).strip()[:150] or '노션 문서','html':document,'text':' '.join(parser.text).strip()[:2000]}

if __name__ == '__main__':
    try:
        result = parse(sys.stdin.buffer.read(MAX_BYTES+1), sys.argv[1] if len(sys.argv)>1 else '')
        print(json.dumps(result,ensure_ascii=False))
    except Exception as exc:
        print(json.dumps({'error':str(exc) if isinstance(exc,ValueError) else 'HTML 파일을 읽지 못했습니다.'},ensure_ascii=False))
        sys.exit(1)
