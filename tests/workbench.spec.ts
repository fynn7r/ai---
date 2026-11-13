import { test, expect, type Page } from '@playwright/test';

/**
 * 工作台首页的验收。
 *
 * 三个口径：
 * 1. 首页回答「今天要做什么」——指标按今天/7 天内/已逾期分堆，不按创建顺序；
 * 2. 底部导航默认 5 项，通知生成与历史记录收进工作台卡片；
 * 3. 自定义导航改完要立刻生效，且刷新后仍然有效。
 */

const DAY = 86_400_000;

function reminder(id: string, deadlineOffsetDays: number) {
  const deadline = new Date(Date.now() + deadlineOffsetDays * DAY).toISOString();
  return {
    id,
    title: `待办 ${id}`,
    type: '其他',
    importance: 'medium',
    deadline,
    remindAt: deadline,
    completed: false,
    source: 'personal',
    createdAt: Date.now(),
  };
}

async function seed(page: Page, items: unknown[]) {
  await page.addInitScript((data) => {
    localStorage.setItem('__app_notizhi_onboarded', '1');
    localStorage.setItem('__app_notizhi_reminders_init', '1');
    localStorage.setItem('__app_notizhi_reminders', JSON.stringify(data));
  }, items);
}

/** 提示条不止一条（还有「过期提醒被标记为错过」的常驻提示），按文案筛，别用整页选择器。 */
function toastWith(page: Page, text: string) {
  return page.locator('[data-sonner-toast]').filter({ hasText: text });
}

test('首页是工作台：今天到期的单独计数，逾期的单独提示', async ({ page }) => {
  // 用「2 小时后」而不是「今天 23:59」：浏览器时区是 America/New_York（见 playwright.config），
  // 与跑测试的机器时区不同，按当天算的断言会随机器时区漂。
  await seed(page, [reminder('a', 2 / 24), reminder('b', 3), reminder('c', -2)]);
  await page.goto('/');

  await expect(page.getByRole('heading', { name: '工作台', exact: true })).toBeVisible();
  await expect(page.getByText('今天到期')).toBeVisible();
  await expect(page.getByText('7 天内')).toBeVisible();
  await expect(page.getByText(/有 1 条已过截止时间/)).toBeVisible();
  // 接下来要做：最近的排在最前
  await expect(page.getByText('待办 c', { exact: true })).toBeVisible();
});

test('默认导航收起通知生成，自定义后立刻出现在导航里并持久化', async ({ page }) => {  await seed(page, []);
  await page.goto('/');

  const nav = page.locator('nav');
  await expect(nav.getByRole('link')).toHaveCount(5);
  await expect(nav.getByRole('link', { name: '通知生成', exact: true })).toHaveCount(0);

  await page.getByRole('button', { name: '自定义导航' }).click();
  await page.getByRole('button', { name: /通知生成/ }).last().click();
  await page.getByRole('button', { name: '保存' }).click();

  await expect(nav.getByRole('link', { name: '通知生成', exact: true })).toBeVisible();
  await page.reload();
  await expect(page.locator('nav').getByRole('link', { name: '通知生成', exact: true })).toBeVisible();
});

/**
 * 下面三条守的是「工作台不等于仪表盘」这条线：
 * 首页要能直接把事做完，而不是只显示数字再把人送去别的页面。
 */

test('首屏贴通知：文本带进解析页，不用从零开始', async ({ page }) => {
  await seed(page, []);
  await page.goto('/');

  const notice = '本周五 18:00 前把实验报告交到教务处，逾期不再受理。';
  await page.getByLabel('贴一条通知').fill(notice);
  await page.getByRole('button', { name: '解析这条通知' }).click();

  await expect(page).toHaveURL(/\/parse$/);
  await expect(page.getByLabel('通知原文')).toHaveValue(notice);
});

test('待办就地勾完成：数字当场减，不跳页', async ({ page }) => {
  await seed(page, [reminder('a', 2 / 24)]);
  await page.goto('/');

  await expect(page.locator('[data-metric="今天到期"]')).toContainText('1');
  await page.getByRole('checkbox', { name: '标记完成：待办 a' }).click();

  await expect(toastWith(page, '已完成')).toBeVisible();
  await expect(page.locator('[data-metric="今天到期"]')).toContainText('0');
  await expect(page.locator('[data-metric="已完成"]')).toContainText('1');
  // 只看列表项：提示条里也带着标题，按整页文本断言会误判
  await expect(page.getByRole('listitem').filter({ hasText: '待办 a' })).toHaveCount(0);
});

test('逾期待办就地顺延一天：从逾期挪回今天', async ({ page }) => {
  // 取 20 小时前：顺延一天后落在「今天 4 小时后」，既离开逾期区，也不会跨到明天。
  // remindAt 必须留在未来，否则到期闹钟会弹出来盖住页面，点不到顺延按钮。
  await seed(page, [{
    ...reminder('d', -20 / 24),
    remindAt: new Date(Date.now() + 30 * DAY).toISOString(),
  }]);
  await page.goto('/');

  await expect(page.locator('[data-metric="已逾期"]')).toContainText('1');
  await page.getByRole('button', { name: '顺延一天：待办 d' }).click();

  await expect(toastWith(page, '已顺延一天')).toBeVisible();
  await expect(page.locator('[data-metric="已逾期"]')).toContainText('0');
  await expect(page.locator('[data-metric="今天到期"]')).toContainText('1');
});
