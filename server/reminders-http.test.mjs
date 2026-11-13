import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { openKnowledgeDb } from './knowledge/db.mjs';
import { createFirstAdmin, createInvite } from './knowledge/auth.mjs';
import { createApiServer } from './index.mjs';

const BASE_CONFIG = {
  apiKey: 'test-key', baseUrl: 'https://mock.local', model: 'mock-model',
  interpretationModel: '', generateModel: '', consoleUrl: '', timeoutMs: 5000,
};

function hreq(server, method, path, { body, headers = {} } = {}) {
  const { port } = server.address();
  return new Promise((resolvePromise, reject) => {
    const payload = body === undefined ? null : JSON.stringify(body);
    const req = httpRequest({
      host: '127.0.0.1', port, method, path,
      headers: {
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(payload) } : {}),
        ...headers,
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* 非 JSON */ }
        resolvePromise({ status: res.statusCode, headers: res.headers, body: json, text });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function listen(server) {
  return new Promise((resolvePromise) => server.listen(0, '127.0.0.1', () => resolvePromise(server)));
}

function makeClient(server) {
  const jar = new Map();
  let csrf = '';
  const capture = (res) => {
    const setCookie = res.headers['set-cookie'];
    if (!setCookie) return;
    for (const item of setCookie) {
      const pair = item.split(';')[0];
      const index = pair.indexOf('=');
      const name = pair.slice(0, index);
      const value = pair.slice(index + 1);
      if (!value) jar.delete(name);
      else jar.set(name, value);
    }
  };
  const cookieHeader = () => [...jar].map(([name, value]) => `${name}=${value}`).join('; ');
  return {
    getCsrf: () => csrf,
    async call(method, path, body) {
      const current = cookieHeader();
      const res = await hreq(server, method, path, {
        body,
        headers: { ...(current ? { Cookie: current } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) },
      });
      capture(res);
      if (res.body?.csrfToken) csrf = res.body.csrfToken;
      return res;
    },
    /** 故意不带 CSRF，用来验证写接口确实校验了它。 */
    async callWithoutCsrf(method, path, body) {
      const current = cookieHeader();
      return hreq(server, method, path, { body, headers: current ? { Cookie: current } : {} });
    },
  };
}

function reminder(overrides = {}) {
  return {
    id: 'r-1',
    title: '交纸质材料',
    type: '作业任务',
    importance: 'high',
    deadline: '2026-11-10T17:00:00+08:00',
    remindAt: '2026-11-09T17:00:00+08:00',
    remindLeadMinutes: 1440,
    remindOffset: '截止前1天',
    completed: false,
    source: 'notification',
    createdAt: 1761000000000,
    ...overrides,
  };
}

describe('待办接口', () => {
  let store;
  let server;
  let tmp;
  let admin;
  let other;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'notizhi-reminders-http-'));
    store = openKnowledgeDb({ dir: tmp });
    server = createApiServer(BASE_CONFIG, fetch, null, store);
    await listen(server);
    await createFirstAdmin(store.db, { username: 'root', displayName: '管理员', password: 'admin-password-123' });
    admin = makeClient(server);
    await admin.call('POST', '/api/auth/login', { username: 'root', password: 'admin-password-123' });

    const invite = createInvite(store.db, { createdBy: 1 });
    other = makeClient(server);
    await other.call('POST', '/api/auth/register', {
      code: invite.code, username: 'bob', displayName: 'B', password: 'bob-password-123',
    });
  });

  after(() => {
    server.close();
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('未登录一律 401', async () => {
    const anonymous = makeClient(server);
    assert.equal((await anonymous.call('GET', '/api/reminders')).status, 401);
    assert.equal((await anonymous.call('POST', '/api/reminders', reminder())).status, 401);
    assert.equal((await anonymous.call('GET', '/api/reminders/export.ics')).status, 401);
  });

  it('写接口必须带 CSRF', async () => {
    const res = await admin.callWithoutCsrf('POST', '/api/reminders', reminder({ id: 'csrf-test' }));
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'INVALID_CSRF');
  });

  it('创建后能在列表里读到', async () => {
    const created = await admin.call('POST', '/api/reminders', reminder());
    assert.equal(created.status, 201, created.text);
    assert.equal(created.body.reminder.id, 'r-1');
    const list = await admin.call('GET', '/api/reminders');
    assert.equal(list.status, 200);
    assert.deepEqual(list.body.reminders.map((item) => item.id), ['r-1']);
  });

  it('同 id 重复提交不产生第二条', async () => {
    await admin.call('POST', '/api/reminders', reminder({ title: '改过的标题' }));
    const list = await admin.call('GET', '/api/reminders?status=all');
    assert.equal(list.body.reminders.length, 1);
    assert.equal(list.body.reminders[0].title, '改过的标题');
  });

  it('PATCH 能标记完成，DELETE 后从列表消失', async () => {
    const patched = await admin.call('PATCH', '/api/reminders/r-1', { completed: true });
    assert.equal(patched.status, 200);
    assert.equal(patched.body.reminder.completed, true);
    assert.equal((await admin.call('GET', '/api/reminders')).body.reminders.length, 0);

    const removed = await admin.call('DELETE', '/api/reminders/r-1');
    assert.equal(removed.status, 200);
    assert.equal((await admin.call('GET', '/api/reminders?status=all')).body.reminders.length, 0);
  });

  it('别人的待办既看不到也改不了', async () => {
    await admin.call('POST', '/api/reminders', reminder({ id: 'admin-only' }));
    const list = await other.call('GET', '/api/reminders?status=all');
    assert.equal(list.body.reminders.length, 0);
    const patched = await other.call('PATCH', '/api/reminders/admin-only', { completed: true });
    assert.equal(patched.status, 404);
    const removed = await other.call('DELETE', '/api/reminders/admin-only');
    assert.equal(removed.status, 404);
  });

  it('导入跳过示例数据与重复项', async () => {
    const res = await other.call('POST', '/api/reminders/import-local', {
      reminders: [
        reminder({ id: 'mock-reminder-001', title: '数学建模竞赛报名截止' }),
        reminder({ id: 'import-1' }),
        reminder({ id: 'import-2' }),
      ],
    });
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body.imported, 2);
    assert.equal(res.body.skippedMock, 1);

    const again = await other.call('POST', '/api/reminders/import-local', {
      reminders: [reminder({ id: 'import-1' })],
    });
    assert.equal(again.body.imported, 0);
    assert.equal(again.body.skippedDuplicate, 1);

    const list = await other.call('GET', '/api/reminders?status=all');
    assert.equal(list.body.reminders.length, 2);
  });

  it('导出的 ics 是标准日历且带 UTC 时间', async () => {
    const res = await admin.call('GET', '/api/reminders/export.ics');
    assert.equal(res.status, 200, res.text);
    assert.match(res.headers['content-type'], /text\/calendar/);
    assert.match(res.headers['content-disposition'], /attachment; filename="notizhi-reminders\.ics"/);
    assert.ok(res.text.startsWith('BEGIN:VCALENDAR\r\n'));
    assert.ok(res.text.includes('BEGIN:VEVENT'));
    assert.ok(res.text.includes('DTSTART:20261110T090000Z'));
    assert.ok(res.text.includes('TRIGGER:-P1D'));
    assert.equal(/[\r\n]/.test(res.text.replace(/\r\n/g, '')), false);
  });

  it('导出的 csv 带 BOM，Excel 打开不乱码', async () => {
    const res = await admin.call('GET', '/api/reminders/export.csv');
    assert.equal(res.status, 200, res.text);
    assert.ok(res.text.startsWith('\uFEFF'), '应当以 BOM 开头');
    assert.match(res.text, /标题,类型,重要度/);
  });

  it('没有日期可写时不返回空文件，而是说明原因', async () => {
    await other.call('DELETE', '/api/reminders/import-1');
    await other.call('DELETE', '/api/reminders/import-2');
    await other.call('POST', '/api/reminders', reminder({ id: 'no-time', title: '没有时间的待办', deadline: '', remindAt: '' }));
    const res = await other.call('GET', '/api/reminders/export.ics');
    assert.equal(res.status, 200);
    assert.equal(res.body.error.code, 'NOTHING_TO_EXPORT');
    assert.deepEqual(res.body.skipped, ['没有时间的待办']);
  });
});

/**
 * 多端同时编辑同一条待办。
 *
 * 要守住的是三件事：带对的版本号能正常写；带旧版本号必须被拒且能拿到服务端副本；
 * 完全不带版本号的老客户端不能被这次改动打死（否则老页面再也存不上东西）。
 */
describe('待办版本冲突', () => {
  let store;
  let server;
  let tmp;
  let laptop;
  let dorm;

  before(async () => {
    tmp = mkdtempSync(join(tmpdir(), 'notizhi-reminders-revision-'));
    store = openKnowledgeDb({ dir: tmp });
    server = createApiServer(BASE_CONFIG, fetch, null, store);
    await listen(server);
    await createFirstAdmin(store.db, { username: 'root', displayName: '管理员', password: 'admin-password-123' });
    // 同一个账号在「宿舍电脑」和「图书馆电脑」各开一个会话。
    laptop = makeClient(server);
    dorm = makeClient(server);
    await laptop.call('POST', '/api/auth/login', { username: 'root', password: 'admin-password-123' });
    await dorm.call('POST', '/api/auth/login', { username: 'root', password: 'admin-password-123' });
  });

  after(() => {
    server.close();
    store.close();
    rmSync(tmp, { recursive: true, force: true });
  });

  it('新建返回 revision=1，带着它再提交能写进去且版本自增', async () => {
    const created = await laptop.call('POST', '/api/reminders', reminder({ id: 'v-1' }));
    assert.equal(created.status, 201, created.text);
    assert.equal(created.body.reminder.revision, 1);

    const updated = await laptop.call('POST', '/api/reminders', reminder({ id: 'v-1', title: '改过的标题', revision: 1 }));
    assert.equal(updated.status, 201, updated.text);
    assert.equal(updated.body.reminder.title, '改过的标题');
    assert.equal(updated.body.reminder.revision, 2);
  });

  it('拿着旧版本号覆盖会被拒，并带回服务端当前副本', async () => {
    // 两台都停在 revision=2：宿舍先改，图书馆后改。
    const dormWrite = await dorm.call('POST', '/api/reminders', reminder({ id: 'v-1', title: '宿舍改的', revision: 2 }));
    assert.equal(dormWrite.status, 201, dormWrite.text);

    const stale = await laptop.call('POST', '/api/reminders', reminder({ id: 'v-1', title: '图书馆改的', revision: 2 }));
    assert.equal(stale.status, 409, stale.text);
    assert.equal(stale.body.error.code, 'REMINDER_REVISION_CONFLICT');
    // 关键：必须能拿到对方那一版，否则用户无从判断该保留谁。
    assert.equal(stale.body.error.current.title, '宿舍改的');
    assert.equal(stale.body.error.current.revision, 3);

    // 被拒之后服务端内容没有被图书馆那份覆盖掉。
    const list = await laptop.call('GET', '/api/reminders?status=all');
    assert.equal(list.body.reminders.find((item) => item.id === 'v-1').title, '宿舍改的');
  });

  it('接上最新版本号后能正常写入，不再冲突', async () => {
    const retry = await laptop.call('POST', '/api/reminders', reminder({ id: 'v-1', title: '图书馆改的', revision: 3 }));
    assert.equal(retry.status, 201, retry.text);
    assert.equal(retry.body.reminder.title, '图书馆改的');
    assert.equal(retry.body.reminder.revision, 4);
  });

  it('不带版本号的老客户端仍按覆盖处理（向后兼容）', async () => {
    const legacy = await laptop.call('POST', '/api/reminders', reminder({ id: 'v-1', title: '老页面写的' }));
    assert.equal(legacy.status, 201, legacy.text);
    assert.equal(legacy.body.reminder.title, '老页面写的');
  });

  it('删除也认版本号：过期版本先 409，不静默抹掉对方改动', async () => {
    const current = (await laptop.call('GET', '/api/reminders?status=all')).body.reminders
      .find((item) => item.id === 'v-1');
    // 宿舍那边又改了一次，图书馆手里的版本落后。
    await dorm.call('POST', '/api/reminders', reminder({ id: 'v-1', title: '宿舍又改', revision: current.revision }));

    const stale = await laptop.call('DELETE', `/api/reminders/v-1?revision=${current.revision}`);
    assert.equal(stale.status, 409, stale.text);
    assert.equal(stale.body.error.code, 'REMINDER_REVISION_CONFLICT');

    const fresh = await laptop.call('DELETE', `/api/reminders/v-1?revision=${stale.body.error.current.revision}`);
    assert.equal(fresh.status, 200, fresh.text);
    assert.equal((await laptop.call('GET', '/api/reminders?status=all')).body.reminders.length, 0);
  });

  it('PATCH 也能带期望版本号', async () => {
    await laptop.call('POST', '/api/reminders', reminder({ id: 'p-1' }));
    const stale = await laptop.call('PATCH', '/api/reminders/p-1', { completed: true, expectedRevision: 99 });
    assert.equal(stale.status, 409, stale.text);
    const ok = await laptop.call('PATCH', '/api/reminders/p-1', { completed: true, expectedRevision: 1 });
    assert.equal(ok.status, 200, ok.text);
    assert.equal(ok.body.reminder.completed, true);
    assert.equal(ok.body.reminder.revision, 2);
  });
});
