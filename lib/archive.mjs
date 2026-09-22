import yauzl from 'yauzl';

export function invalid(message) { const error = new Error(message); error.status = 400; throw error; }

// Validate sizes before opening entries; also count actual decompressed bytes.
export async function readArchive(bytes, { maxInput = 20*1024*1024, maxExpanded = 40*1024*1024, maxEntries = 1000, maxEntry = 20*1024*1024 } = {}) {
  if (bytes.length > maxInput) invalid('파일 크기가 너무 큽니다.');
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(Buffer.from(bytes), { lazyEntries: true, validateEntrySizes: true, strictFileNames: true }, (error, zip) => {
      if (error) { reject(Object.assign(new Error('ZIP 또는 XLSX 파일을 읽지 못했습니다.'), { status: 400 })); return; }
      const files = new Map(), names = new Set(); let declared = 0, actual = 0, count = 0, failed = false;
      function fail() { if (failed) return; failed = true; zip.close(); reject(Object.assign(new Error('지원하지 않거나 압축 해제 크기가 너무 큰 파일입니다.'), { status: 400 })); }
      zip.on('error', fail);
      zip.on('entry', entry => {
        const name = entry.fileName;
        if (++count > maxEntries || (declared += entry.uncompressedSize) > maxExpanded || entry.uncompressedSize > maxEntry || entry.generalPurposeBitFlag & 1 || names.has(name) || name.startsWith('/') || name.split('/').includes('..') || name.includes('\\')) return fail();
        names.add(name);
        if (name.endsWith('/')) { zip.readEntry(); return; }
        zip.openReadStream(entry, (error, stream) => {
          if (error) return fail();
          const chunks = []; let size = 0;
          stream.on('error', fail);
          stream.on('data', chunk => {
            size += chunk.length; actual += chunk.length;
            if (size > maxEntry || actual > maxExpanded) { stream.destroy(); fail(); } else chunks.push(chunk);
          });
          stream.on('end', () => { if (!failed) { files.set(name, Buffer.concat(chunks)); zip.readEntry(); } });
        });
      });
      zip.on('end', () => { if (!failed) resolve(files); });
      zip.readEntry();
    });
  });
}
