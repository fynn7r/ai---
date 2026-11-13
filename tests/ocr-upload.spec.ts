import { test, expect } from '@playwright/test';

/**
 * 图片识别入口的端到端行为。
 *
 * 这里不依赖真实视觉模型：`/api/ocr` 由 route 拦截成固定响应，
 * 测的是「选了图 / 粘了图之后界面怎么反应」，服务端识别质量由 server/ocr.test.mjs 负责。
 * 混在一起的话，模型抽风会连带界面回归挂掉，反而看不出是谁的问题。
 */

/** 只需文件头对得上：上传请求被 route 截走，图片内容不会被解码。 */
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(64)]);

const ocrReply = (body: unknown, status = 200) => ({
  status,
  contentType: 'application/json',
  body: JSON.stringify(body),
});

test.beforeEach(async ({ page }) => {
  // 解析页挂在根路径 `/`，不是 /parse。
  await page.goto('/parse');
});

test('上传截图后成为可删除的参考材料，字数如实显示', async ({ page }) => {
  const text = '关于举办校园摄影大赛的通知：请于 11 月 15 日 14:00 前提交作品。';
  await page.route('**/api/ocr', (route) => route.fulfill(ocrReply({
    items: [{ index: 1, name: '通知截图.png', kind: 'text', text, truncated: false }],
    warnings: ['图片文字由模型识别，关键时间、地点、金额请对照原图核对。'],
  })));

  await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
    name: '通知截图.png', mimeType: 'image/png', buffer: PNG,
  });

  const material = page.getByText('通知截图.png', { exact: true });
  await expect(material).toBeVisible();
  await expect(page.getByText(`${text.length} 字`, { exact: false })).toBeVisible();
  // 图片材料的字数来自识别结果，不是文件大小；说错了会让人以为模型读到了别的东西。
  await expect(page.getByRole('button', { name: '移除参考材料 通知截图.png' })).toBeVisible();
  await expect(page.getByText(/图片里的文字由模型识别.*对照原图核对/)).toBeVisible();
});

test('在输入框里直接粘贴截图同样会识别', async ({ page }) => {
  await page.route('**/api/ocr', (route) => route.fulfill(ocrReply({
    items: [{ index: 1, name: '粘贴的截图.png', kind: 'text', text: '截止时间 11 月 7 日 17:00', truncated: false }],
    warnings: [],
  })));

  await page.evaluate(() => {
    const textarea = document.querySelector('textarea[aria-label="通知原文"]');
    if (!textarea) throw new Error('找不到通知原文输入框');
    const file = new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])], '粘贴的截图.png', { type: 'image/png' });
    const data = new DataTransfer();
    data.items.add(file);
    textarea.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
  });

  await expect(page.getByText('粘贴的截图.png', { exact: true })).toBeVisible();
});

test('视觉模型没配置时说明原因，不留下空材料', async ({ page }) => {
  await page.route('**/api/ocr', (route) => route.fulfill(ocrReply({
    error: { code: 'VISION_NOT_CONFIGURED', message: '还没配置视觉模型，暂时读不了图片里的文字。' },
  }, 503)));

  await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
    name: '通知截图.png', mimeType: 'image/png', buffer: PNG,
  });

  await expect(page.getByText('还没配置视觉模型，暂时读不了图片里的文字。')).toBeVisible();
  await expect(page.getByRole('button', { name: '移除参考材料 通知截图.png' })).toHaveCount(0);
});

test('图里没读到字时明确说出来，而不是加一条 0 字材料', async ({ page }) => {
  await page.route('**/api/ocr', (route) => route.fulfill(ocrReply({
    items: [{ index: 1, name: '海报.png', kind: 'empty', text: '', truncated: false }],
    warnings: ['这些图片都没读到文字。可能是纯海报/纯图案，也可能字太小或太糊，建议重新截图或直接粘贴文字。'],
  })));

  await page.locator('input[type="file"][accept="image/*"]').setInputFiles({
    name: '海报.png', mimeType: 'image/png', buffer: PNG,
  });

  await expect(page.getByText(/这些图片都没读到文字/)).toBeVisible();
  await expect(page.getByRole('button', { name: '移除参考材料 海报.png' })).toHaveCount(0);
});
