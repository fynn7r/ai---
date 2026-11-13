import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { ocrImages, sniffImageMime } from './ocr-service.mjs';
import { createApiServer } from './index.mjs';
import { OCR_MAX_FILES } from '../shared/ocr-contract.ts';

const visionConfig = { apiKey: 'test-vision-key', baseUrl: 'https://vision.invalid/v1', model: 'vision-1', timeoutMs: 1000 };

/** 只要文件头对得上就能过 sniff；内容不必是真能解码的图片，模型调用由 fetchImpl 兜住。 */
const png = (size = 128) => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(size)]);
const jpeg = () => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(128)]);
const webp = () => Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WEBP'), Buffer.alloc(128)]);
const gif = () => Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(128)]);
const pdf = () => Buffer.from('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n');
const heic = () => Buffer.concat([Buffer.alloc(4), Buffer.from('ftypheic'), Buffer.alloc(64)]);

const visionReply = (images) => async () => ({
  ok: true,
  json: async () => ({ choices: [{ message: { content: JSON.stringify({ images }) } }] }),
});

describe('图片识别：文件头判定', () => {
  it('认得出 PNG / JPEG / WebP', () => {
    assert.equal(sniffImageMime(png()), 'image/png');
    assert.equal(sniffImageMime(jpeg()), 'image/jpeg');
    assert.equal(sniffImageMime(webp()), 'image/webp');
  });

  it('GIF、PDF、HEIC 一律不认', () => {
    assert.equal(sniffImageMime(gif()), null);
    assert.equal(sniffImageMime(pdf()), null);
    assert.equal(sniffImageMime(heic()), null);
    assert.equal(sniffImageMime(Buffer.alloc(0)), null);
  });
});

describe('图片识别：校验与结果', () => {
  it('认不出的格式要说清是什么、该怎么办', async () => {
    for (const [buffer, keyword] of [[gif(), 'GIF'], [pdf(), 'PDF'], [heic(), 'HEIC']]) {
      await assert.rejects(
        ocrImages([{ name: 'x.bin', buffer }], visionConfig, visionReply([])),
        (error) => error.status === 415 && error.code === 'UNSUPPORTED_IMAGE_TYPE' && error.message.includes(keyword),
      );
    }
  });

  it('张数超限、单张超限、没选图片都给出对应错误码', async () => {
    const tooMany = Array.from({ length: OCR_MAX_FILES + 1 }, (_, i) => ({ name: `p${i}.png`, buffer: png() }));
    await assert.rejects(ocrImages(tooMany, visionConfig, visionReply([])),
      (error) => error.status === 400 && error.code === 'TOO_MANY_IMAGES');
    await assert.rejects(ocrImages([], visionConfig, visionReply([])),
      (error) => error.status === 400 && error.code === 'INVALID_IMAGE_UPLOAD');
    await assert.rejects(ocrImages([{ name: 'huge.png', buffer: png(6 * 1024 * 1024) }], visionConfig, visionReply([])),
      (error) => error.status === 413 && error.code === 'IMAGE_TOO_LARGE');
  });

  it('没配视觉模型时直接说没配，不假装能读', async () => {
    await assert.rejects(
      ocrImages([{ name: 'a.png', buffer: png() }], { ...visionConfig, model: '' }, visionReply([])),
      (error) => error.status === 503 && error.code === 'VISION_NOT_CONFIGURED',
    );
  });

  it('识别成功的图片带上文件名与行内换行', async () => {
    const result = await ocrImages(
      [{ name: '通知截图.png', buffer: png() }],
      visionConfig,
      visionReply([{ index: 1, kind: 'info', text: '第一行主题\n第二行时间 11月7日' }]),
    );
    assert.equal(result.items.length, 1);
    assert.equal(result.items[0].kind, 'text');
    // 换行是版面信息：通知截图第一行常常是主题、第二行才是时间，压成一行会丢结构。
    assert.equal(result.items[0].text, '第一行主题\n第二行时间 11月7日');
    assert.equal(result.items[0].name, '通知截图.png');
    assert.match(result.warnings.join(' '), /核对/);
  });

  it('模型漏答的图片按「没识别成功」处理，不臆造内容', async () => {
    const result = await ocrImages(
      [{ name: 'a.png', buffer: png() }, { name: 'b.png', buffer: png() }],
      visionConfig,
      visionReply([{ index: 1, kind: 'info', text: '只有第一张有结果' }]),
    );
    assert.deepEqual(result.items.map((item) => item.kind), ['text', 'unread']);
    assert.equal(result.items[1].text, '');
  });

  it('全部没读到字时提醒可能字太小，而不是静默返回空', async () => {
    const result = await ocrImages(
      [{ name: '海报.png', buffer: png() }],
      visionConfig,
      visionReply([{ index: 1, kind: 'deco', text: '' }]),
    );
    assert.equal(result.items[0].kind, 'empty');
    assert.match(result.warnings.join(' '), /没读到文字/);
  });

  it('视觉接口报错时降级为未识别，不抛出整页失败', async () => {
    const result = await ocrImages(
      [{ name: 'a.png', buffer: png() }],
      visionConfig,
      async () => ({ ok: false, status: 500, text: async () => 'boom' }),
    );
    assert.equal(result.items[0].kind, 'unread');
    assert.match(result.warnings.join(' '), /未能识别/);
  });
});

describe('图片识别：HTTP 接线', () => {
  let server;
  let base;
  const config = {
    apiKey: 'test-key', baseUrl: 'https://mock.local/v1', model: 'mock-model',
    interpretationModel: '', generateModel: '', consoleUrl: '', timeoutMs: 5000,
  };

  before(async () => {
    process.env.AI_VISION_MODEL = 'vision-1';
    server = createApiServer(config, visionReply([{ index: 1, kind: 'info', text: '图上写着 11月7日截止' }]), null, null, null);
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    delete process.env.AI_VISION_MODEL;
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  const upload = (files) => {
    const form = new FormData();
    for (const [name, buffer] of files) form.append('file', new Blob([buffer], { type: 'image/png' }), name);
    return fetch(`${base}/api/ocr`, { method: 'POST', body: form });
  };

  it('multipart 上传一张图返回识别文字', async () => {
    const response = await upload([['a.png', png()]]);
    assert.equal(response.status, 200);
    const payload = await response.json();
    assert.equal(payload.items[0].kind, 'text');
    assert.match(payload.items[0].text, /11月7日/);
  });

  it('用 JSON 提交会被要求改用文件上传', async () => {
    const response = await fetch(`${base}/api/ocr`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}),
    });
    assert.equal(response.status, 415);
    assert.match((await response.json()).error.message, /文件上传/);
  });

  it('文件头不对的请求被 415 拒绝', async () => {
    const response = await upload([['not-image.pdf', pdf()]]);
    assert.equal(response.status, 415);
    const payload = await response.json();
    assert.equal(payload.error.code, 'UNSUPPORTED_IMAGE_TYPE');
    assert.match(payload.error.message, /PDF/);
  });

  it('超过总大小上限时在读取阶段就拒收', async () => {
    const response = await upload([['big.png', png(13 * 1024 * 1024)]]);
    assert.equal(response.status, 413);
    assert.equal((await response.json()).error.code, 'REQUEST_TOO_LARGE');
  });
});
