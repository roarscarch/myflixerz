// Regression tests for the embed decoders — the most fragile part of the app.
// If upstream ever changes the cipher or response shapes, these fail instantly.
// Fixtures are self-generated (encrypt/encode with the known key & alphabet),
// so the suite never depends on live upstream availability.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const {
  decryptPayload,
  vidnestDecode,
  vidnestToResult,
  toResult,
  PEACHIFY_KEY_HEX,
  VIDNEST_ALPHABET,
} = require('../src/services/extractor');

const STANDARD_B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const b64url = (buf) => buf.toString('base64url');

// ---- peachify: AES-256-GCM ----

test('peachify: AES-256-GCM round-trip', () => {
  const plain = { sources: [{ url: 'https://x.eat-peach.sbs/hls/example.m3u8', dub: 'Hindi' }] };
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(PEACHIFY_KEY_HEX, 'hex'), iv);
  const ct = Buffer.concat([cipher.update(JSON.stringify(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = `${b64url(iv)}.${b64url(ct)}.${b64url(tag)}`;
  assert.deepStrictEqual(decryptPayload(payload), plain);
});

test('peachify: decryptPayload rejects a tampered payload (auth tag mismatch)', () => {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', Buffer.from(PEACHIFY_KEY_HEX, 'hex'), iv);
  const ct = Buffer.concat([cipher.update('{"sources":[]}', 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  const payload = `${b64url(iv)}.${b64url(ct)}.${b64url(Buffer.from([tag[0] ^ 1, ...tag.subarray(1)]))}`;
  assert.throws(() => decryptPayload(payload));
});

// ---- vidnest: custom base64 ----

test('vidnest: custom-base64 round-trip', () => {
  const plain = { url: 'https://tiktoks.animanga.fun/v/xyz.m3u8', headers: { Referer: 'https://vidnest.fun/' } };
  const std = Buffer.from(JSON.stringify(plain)).toString('base64');
  const encoded = [...std]
    .map((c) => (c === '=' ? '=' : VIDNEST_ALPHABET[STANDARD_B64.indexOf(c)]))
    .join('');
  assert.deepStrictEqual(JSON.parse(vidnestDecode(encoded)), plain);
});

test('vidnest: alphabet is a permutation (no duplicate / missing chars)', () => {
  assert.strictEqual(VIDNEST_ALPHABET.length, 65);
  const stripEq = (s) => [...s].filter((c) => c !== '=').sort().join('');
  assert.strictEqual(stripEq(VIDNEST_ALPHABET), stripEq(STANDARD_B64));
});

// ---- vidnest response shapes ----

test('vidnest: shape 1 relay {url, headers} → hls source with referer', () => {
  const r = vidnestToResult(
    { name: 'videasy' },
    { url: 'https://tiktoks.animanga.fun/v/a.m3u8', headers: { Referer: 'https://vidnest.fun/' } }
  );
  assert.strictEqual(r.sources.length, 1);
  assert.strictEqual(r.sources[0].isM3U8, true);
  assert.strictEqual(r.sources[0].referer, 'https://vidnest.fun/');
});

test('vidnest: shape 2 {streams:[...]} → each normalized, hls flagged', () => {
  const r = vidnestToResult(
    { name: 'hollymoviehd' },
    {
      streams: [
        { url: 'https://cdn.example/movie.mp4', type: 'mp4', language: 'English' },
        { url: 'https://cdn.example/hls/index.m3u8', type: 'hls' },
      ],
    }
  );
  assert.strictEqual(r.sources.length, 2);
  assert.strictEqual(r.sources[0].isM3U8, false);
  assert.strictEqual(r.sources[0].lang, 'English');
  assert.strictEqual(r.sources[1].isM3U8, true);
});

test('vidnest: shape 3 direct {url, headers, referer} → tokenized m3u8 detected', () => {
  const r = vidnestToResult(
    { name: 'buzz' },
    { url: 'https://azionedge.example/hls/main.m3u8?token=abc', headers: { Referer: 'https://buzz.example/' } }
  );
  assert.strictEqual(r.sources[0].isM3U8, true);
});

test('vidnest: url-less stream entries are dropped, not crashes', () => {
  const r = vidnestToResult({ name: 'rogflix' }, { streams: [{ type: 'hls' }, { url: 'https://ok.example/a.m3u8' }] });
  assert.strictEqual(r.sources.length, 1);
  assert.strictEqual(r.sources[0].url, 'https://ok.example/a.m3u8');
});

// ---- peachify toResult ----

test('peachify: toResult keeps dub/quality, skips url-less sources', () => {
  const data = {
    sources: [
      { url: 'https://x.eat-peach.sbs/stream.mp4', dub: 'Original Audio', quality: '1080p' },
      { sizeBytes: 123 }, // no url — must be dropped
    ],
  };
  const r = toResult({ name: 'iron' }, data);
  assert.strictEqual(r.sources.length, 1);
  assert.strictEqual(r.sources[0].dub, 'Original Audio');
  assert.strictEqual(r.sources[0].quality, '1080p');
  assert.strictEqual(r.sources[0].isM3U8, false);
});

test('peachify: toResult unwraps dead m3u8-proxy into real CDN url + headers', () => {
  const real = 'https://remoteconsultinggroup.site/Y7Q4/pl/master.m3u8';
  const proxy =
    'https://x.eat-peach.sbs/m3u8-proxy?url=' +
    encodeURIComponent(real) +
    '&headers=' +
    encodeURIComponent(JSON.stringify({ origin: 'https://nextgencloudfabric.com', referer: 'https://nextgencloudfabric.com/' }));
  const r = toResult({ name: 'wolf' }, { sources: [{ url: proxy, dub: 'English', type: 'hls' }] });
  assert.strictEqual(r.sources.length, 1);
  assert.strictEqual(r.sources[0].url, real);
  assert.strictEqual(r.sources[0].isM3U8, true);
  assert.strictEqual(r.sources[0].origin, 'https://nextgencloudfabric.com');
  assert.strictEqual(r.sources[0].referer, 'https://nextgencloudfabric.com/');
  assert.strictEqual(r.sources[0].dub, 'English');
});

test('peachify: toResult unwraps mp4-proxy (any host) into real CDN url', () => {
  const real = 'https://bcdnxw.hakunaymatata.com/convert-h264/302da107.mp4?sign=23dd6af3&t=1788022';
  const proxy = 'https://twist-range-1049499.fastedge.app/mp4-proxy?url=' + encodeURIComponent(real);
  const r = toResult({ name: 'iron' }, { sources: [{ url: proxy, dub: 'English', type: 'mp4' }] });
  assert.strictEqual(r.sources.length, 1);
  assert.strictEqual(r.sources[0].url, real);
  assert.strictEqual(r.sources[0].isM3U8, false);
  assert.strictEqual(r.sources[0].referer, null); // no headers param → no header gating
});
