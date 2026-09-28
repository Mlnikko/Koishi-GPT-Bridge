const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { downloadImage, sniffImage, pngSize, isPrivateAddress, decodeDataUrl, messageImages, messageText } = require('../../src/lib/image.cjs');

const temp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qq-image-test-'));
// A minimal but structurally valid PNG: signature + IHDR + padding to a size the
// result validator accepts. Only the header matters to the checks under test.
function png(width = 8, height = 8, size = 256) {
  const bytes = Buffer.alloc(size);
  Buffer.from('89504e470d0a1a0a', 'hex').copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  Buffer.from('IHDR', 'latin1').copy(bytes, 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}
const jpeg = (size = 64) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(size)]);
const body = (bytes, headers = {}) => ({ ok: true, status: 200,
  headers: { get: key => headers[key.toLowerCase()] ?? null }, body: null,
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) });
const redirect = location => ({ ok: false, status: 302, headers: { get: key => key.toLowerCase() === 'location' ? location : null } });

test('png header is parsed in pure JavaScript so no host image tool is required', () => {
  assert.deepEqual(pngSize(png(1254, 900)), { width: 1254, height: 900 });
  assert.throws(() => pngSize(Buffer.from('not a png, definitely not')), /PNG/);
  assert.throws(() => pngSize(Buffer.alloc(0)), /不完整/);
});

test('only raster image formats are accepted; svg and html are refused', () => {
  assert.equal(sniffImage(png()).mime, 'image/png');
  assert.equal(sniffImage(jpeg()).mime, 'image/jpeg');
  assert.equal(sniffImage(Buffer.concat([Buffer.from('GIF89a', 'latin1'), Buffer.alloc(64)])).mime, 'image/gif');
  assert.equal(sniffImage(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(64)])).mime, 'image/webp');
  assert.throws(() => sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script/></svg>')), /不支持的图片格式/);
  assert.throws(() => sniffImage(Buffer.from('<!doctype html><html><body>hi</body></html>')), /不支持的图片格式/);
  assert.throws(() => sniffImage(Buffer.alloc(64)), /不支持的图片格式/);
});

test('loopback, private and reserved addresses are recognised', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '172.31.255.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fe80::1', 'fd00::1', '::ffff:127.0.0.1'])
    assert.equal(isPrivateAddress(address), true, address);
  for (const address of ['1.1.1.1', '8.8.8.8', '172.32.0.1', '2606:4700:4700::1111'])
    assert.equal(isPrivateAddress(address), false, address);
});

test('message elements are normalised across adapter spellings', () => {
  assert.deepEqual(messageImages([{ type: 'img', attrs: { src: 'http://a/1.png' } }, { type: 'text', attrs: { content: 'x' } }, { type: 'image', attrs: { url: 'http://a/2.png' } }]), ['http://a/1.png', 'http://a/2.png']);
  assert.deepEqual(messageImages([{ type: 'img', attrs: { file: 'base64://AAA' } }]), ['base64://AAA']);
  assert.deepEqual(messageImages([{ type: 'text', attrs: { content: 'hi' } }]), []);
  assert.deepEqual(messageImages(undefined), []);
  assert.equal(messageText([{ type: 'text', attrs: { content: ' 改成夜晚 ' } }, { type: 'img', attrs: {} }]), '改成夜晚');
});

test('inline data urls are decoded locally and written with owner-only permissions', async () => {
  const dir = temp();
  const result = await downloadImage(`data:image/png;base64,${png(4, 4).toString('base64')}`, dir);
  assert.equal(result.mime, 'image/png');
  assert.equal(result.ext, 'png');
  assert.equal(result.size, 256);
  assert.equal(fs.existsSync(result.file), true);
  if (process.platform !== 'win32') assert.equal(fs.statSync(result.file).mode & 0o777, 0o600);
  assert.deepEqual(pngSize(fs.readFileSync(result.file)), { width: 4, height: 4 });
});

test('onebot base64 payloads are accepted without any network access', async () => {
  const dir = temp();
  const result = await downloadImage(`base64://${jpeg(120).toString('base64')}`, dir);
  assert.equal(result.mime, 'image/jpeg');
  assert.equal(result.ext, 'jpg');
});

test('non-http protocols and malformed sources never touch the filesystem', async () => {
  const dir = temp();
  for (const source of ['file:///etc/passwd', 'ftp://example.com/a.png', 'not a url', '', 'data:'])
    await assert.rejects(downloadImage(source, dir), /image_invalid|图片|地址/);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a source resolving to a loopback or private address is refused before any fetch', async () => {
  const dir = temp();
  let fetched = 0;
  const fetchImpl = async () => { fetched++; return body(png()); };
  await assert.rejects(downloadImage('http://qq.example/a.png', dir, { lookup: async () => [{ address: '127.0.0.1' }], fetchImpl }),
    err => err.code === 'image_blocked');
  await assert.rejects(downloadImage('http://qq.example/a.png', dir, { lookup: async () => [{ address: '1.1.1.1' }, { address: '192.168.0.5' }], fetchImpl }),
    err => err.code === 'image_blocked');
  assert.equal(fetched, 0);
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a redirect is re-validated, so a public link cannot bounce to the local network', async () => {
  const dir = temp();
  const lookup = async host => [{ address: host === 'internal.example' ? '127.0.0.1' : '1.1.1.1' }];
  await assert.rejects(downloadImage('http://public.example/a.png', dir, { lookup, fetchImpl: async () => redirect('http://internal.example/b.png') }),
    err => err.code === 'image_blocked');
  await assert.rejects(downloadImage('http://public.example/a.png', dir, { lookup, fetchImpl: async () => redirect('file:///etc/passwd') }),
    err => err.code === 'image_invalid');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('oversized and non-image downloads are rejected by declared size, streamed size and content', async () => {
  const dir = temp();
  const publicHost = { lookup: async () => [{ address: '1.1.1.1' }] };
  await assert.rejects(downloadImage('http://qq.example/a.png', dir, { ...publicHost, maxBytes: 100, fetchImpl: async () => body(png(8, 8, 4096)) }),
    err => err.code === 'image_too_large');
  const streamed = { ok: true, status: 200, headers: { get: () => null },
    body: { async *[Symbol.asyncIterator]() { for (let i = 0; i < 8; i++) yield Buffer.alloc(64, 1); } } };
  await assert.rejects(downloadImage('http://qq.example/a.png', dir, { ...publicHost, maxBytes: 100, fetchImpl: async () => streamed }),
    err => err.code === 'image_too_large');
  await assert.rejects(downloadImage('http://qq.example/a.png', dir, { ...publicHost, fetchImpl: async () => body(Buffer.from('<html>nope</html>'.padEnd(80, ' '))) }),
    err => err.code === 'image_invalid');
  await assert.rejects(downloadImage('http://qq.example/a.png', dir, { ...publicHost, fetchImpl: async () => ({ ok: false, status: 404, headers: { get: () => null } }) }),
    err => err.code === 'image_download');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('a public image download is validated and stored under a generated name', async () => {
  const dir = temp();
  const result = await downloadImage('http://qq.example/a.png', dir, {
    lookup: async () => [{ address: '1.1.1.1' }],
    fetchImpl: async url => { assert.equal(url, 'http://qq.example/a.png'); return body(png(12, 34)); },
  });
  assert.match(path.basename(result.file), /^image-[a-f0-9]{8}\.png$/);
  assert.deepEqual(pngSize(fs.readFileSync(result.file)), { width: 12, height: 34 });
  assert.equal(decodeDataUrl('data:image/png;base64,AAAA').toString('base64'), 'AAAA');
});
