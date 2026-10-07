// 商城后台页面验收（阶段 3 的 UI 部分）：Playwright 真点 Element Plus 表单
//
// 用法：npm run build:admin 后
//   PLAYWRIGHT_BROWSERS_PATH=$PWD/.pw-browsers node deploy/scripts/verify-shop-admin-ui.mjs
//
// 覆盖：登录 → 商城菜单可达（未被"未开通"锁死）→ 建分类 → 建运费模板 → 建商品+SKU 并上架
//       → 商城订单列表发货 → 售后审核通过退款
// 每步都同时断言界面反馈与数据库落库。
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PG_PORT = 5439;
const API_PORT = 9107;
const WEB_PORT = 8087;
const DATA_DIR = path.join(repoRoot, 'deploy', '.pgdata-shop-admin-ui');
const DIST = path.join(repoRoot, 'apps', 'admin', 'dist');
const JWT_SECRET = 'verify-secret';
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const WEB_BASE = `http://127.0.0.1:${WEB_PORT}`;
const ADMIN_PW = 'Fyt360@2026';

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name} ${extra}`); }
};
const run = (script, env) => {
  const r = spawnSync(process.execPath, [script], { cwd: repoRoot, env: { ...process.env, ...env }, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '') + (r.stderr ?? '') };
};

function startWeb() {
  const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
  const server = http.createServer((req, res) => {
    const url = req.url || '/';
    if (url.startsWith('/api/')) {
      const proxy = http.request(
        { host: '127.0.0.1', port: API_PORT, path: url, method: req.method, headers: { ...req.headers, host: `127.0.0.1:${API_PORT}` } },
        (up) => { res.writeHead(up.statusCode || 502, up.headers); up.pipe(res); },
      );
      proxy.on('error', () => { res.writeHead(502); res.end('proxy error'); });
      req.pipe(proxy);
      return;
    }
    let rel = url.split('?')[0];
    if (rel === '/admin' || rel === '/admin/') rel = '/admin/index.html';
    if (!rel.startsWith('/admin/')) { res.writeHead(404); res.end('not found'); return; }
    const file = path.join(DIST, decodeURIComponent(rel.slice(7)));
    if (!file.startsWith(DIST) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404); res.end('not found'); return;
    }
    res.writeHead(200, { 'Content-Type': types[path.extname(file)] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(WEB_PORT, '127.0.0.1', () => resolve(server)));
}

async function main() {
  if (!fs.existsSync(path.join(DIST, 'index.html'))) {
    console.error('✗ 找不到后台产物，请先运行：npm run build:admin');
    process.exit(1);
  }
  const { chromium } = await import('playwright');

  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  const pgInst = new EmbeddedPostgres({
    databaseDir: DATA_DIR, user: 'fyt360_tester', password: 'fyt360_local_pw', port: PG_PORT, persistent: false,
  });
  await pgInst.initialise();
  await pgInst.start();
  await pgInst.createDatabase('fyt360');

  const DATABASE_URL = `postgresql://fyt360_tester:fyt360_local_pw@127.0.0.1:${PG_PORT}/fyt360`;
  const env = {
    DATABASE_URL, TCB_ENV: 'shop-admin-ui', JWT_SECRET, ADMIN_INIT_PASSWORD: ADMIN_PW,
    PORT: String(API_PORT), PUBLIC_BASE_URL: WEB_BASE, NODE_ENV: 'test',
  };
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params))[0];

  let api; let web; let browser;
  try {
    console.log('\n[1] 建库（不配置支付凭据 → 售后走模拟退款通道）');
    run('deploy/scripts/migrate.mjs', env);
    run('deploy/scripts/seed.mjs', env);
    const mig = run('deploy/scripts/migrate.mjs', env);
    if (!mig.ok) throw new Error('迁移失败: ' + mig.out.slice(-300));
    const site = await one(`SELECT site_id::text AS id FROM site WHERE code='site-a'`);
    const siteId = site.id;
    const user = await one(`INSERT INTO "user" (site_id, openid, invite_code, status) VALUES ($1,'admin_ui_openid','FYTADMINUI','active') RETURNING user_id`, [siteId]);
    await q(`INSERT INTO user_address (user_id, name, phone, region, detail, is_default) VALUES ($1,'钱七','13500000000','上海市浦东新区','测试路8号',1)`, [user.user_id]);
    // 真实部署里 deploy-bt.sh 会把超管设为本站负责人；这里补齐，否则开通状态接口 403
    await q(`INSERT INTO admin_user_site (admin_id, site_id, site_role, is_owner)
             SELECT a.admin_id, s.site_id, 'site_admin', TRUE FROM admin_user a, site s
              WHERE a.username='admin' AND s.code='site-a'
             ON CONFLICT (admin_id, site_id) DO UPDATE SET is_owner = TRUE`);
    check('数据就绪（含 admin 站点负责人）', !!siteId && !!user.user_id);

    console.log('\n[2] 启动 API 与后台静态站点');
    api = spawn(process.execPath, [path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'server/src/index.ts'], {
      cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let apiLog = '';
    api.stdout.on('data', (d) => { apiLog += d; });
    api.stderr.on('data', (d) => { apiLog += d; });
    let healthy = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try { const h = await fetch(API_BASE + '/healthz'); const j = await h.json(); if (h.status === 200 && j.ok && j.db) { healthy = true; break; } } catch { /* retry */ }
    }
    check('API 就绪', healthy, apiLog.slice(-300));
    web = await startWeb();
    check('后台静态站点可访问', (await fetch(`${WEB_BASE}/admin/index.html`)).status === 200);

    // 登录拿 token（登录表单本身由 verify-shop-admin 的接口测试覆盖，这里直接注入会话态）
    const loginBody = await (await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: ADMIN_PW }),
    })).json();
    const token = loginBody.data.token;

    console.log('\n[3] 打开后台（注入会话：当前站 site-a）');
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await ctx.addInitScript(([t, info, siteCtx]) => {
      window.localStorage.setItem('fyt_admin_token', t);
      window.localStorage.setItem('fyt_admin_info', info);
      window.localStorage.setItem('fyt_admin_site', siteCtx);
    }, [token, JSON.stringify(loginBody.data.admin), JSON.stringify({ scope: 'site', code: 'site-a', site_id: siteId, name: '示例站点 A' })]);
    const page = await ctx.newPage();
    /** el-select 选择助手：popper 是 teleport 且常驻 DOM，必须限定到可见的那一层 */
    const pickSelect = async (scope, index, text) => {
      await scope.locator('.el-select').nth(index).click();
      const opt = page.locator('.el-select-dropdown:visible .el-select-dropdown__item', { hasText: text }).first();
      await opt.waitFor({ state: 'visible', timeout: 10000 });
      await opt.click();
      await page.waitForTimeout(300);
    };
    const errs = [];
    page.on('pageerror', (e) => errs.push(e.message));
    await page.goto(`${WEB_BASE}/admin/#/`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.menu-item', { timeout: 20000 });
    const shopMenuVisible = await page.locator('.menu-item', { hasText: '商城' }).first().isVisible();
    check('侧栏出现「商城」菜单', shopMenuVisible);
    const shopDisabled = await page.locator('.menu-item', { hasText: '商城' }).first().isDisabled();
    check('商城菜单未被"站点未开通"锁死（自营不依赖 CPS 凭据）', !shopDisabled);

    console.log('\n[4] 商品分类：界面新建分类');
    await page.locator('.menu-item.sub', { hasText: '商品分类' }).click();
    await page.waitForSelector('text=新建一级分类', { timeout: 15000 });
    await page.locator('text=新建一级分类').click();
    await page.waitForSelector('.el-dialog', { timeout: 10000 });
    await page.locator('.el-dialog input[placeholder="如：数码配件"]').fill('界面测试分类');
    await page.locator('.el-dialog button:has-text("保存")').click();
    await page.waitForTimeout(1200);
    const catRow = await one(`SELECT category_id, name FROM shop_category WHERE site_id=$1 AND name='界面测试分类'`, [siteId]);
    check('分类已落库', !!catRow, JSON.stringify(catRow));

    console.log('\n[5] 运费模板：界面新建模板');
    await page.locator('.menu-item.sub', { hasText: '运费模板' }).click();
    await page.waitForSelector('text=新建运费模板', { timeout: 15000 });
    await page.locator('text=新建运费模板').click();
    await page.waitForSelector('.el-dialog', { timeout: 10000 });
    await page.locator('.el-dialog input[placeholder="如：全国快递"]').fill('界面测试运费');
    await page.locator('.el-dialog button:has-text("保存")').click();
    await page.waitForTimeout(1200);
    const tplRow = await one(`SELECT tpl_id, name FROM shop_freight_template WHERE site_id=$1 AND name='界面测试运费'`, [siteId]);
    check('运费模板已落库', !!tplRow, JSON.stringify(tplRow));

    console.log('\n[6] 商品管理：界面新建商品 + SKU 并上架');
    await page.locator('.menu-item.sub', { hasText: '商品管理' }).click();
    await page.waitForSelector('text=新建商品', { timeout: 15000 });
    await page.locator('text=新建商品').click();
    await page.waitForSelector('.el-dialog', { timeout: 10000 });
    const dlg = page.locator('.el-dialog').last();
    await dlg.locator('input[placeholder="商品标题"]').fill('界面测试商品');
    // 分类（第一个 el-select：分类）
    await pickSelect(dlg, 0, '界面测试分类');   // 分类
    await pickSelect(dlg, 2, '界面测试运费');   // 运费模板（分类/履约/运费 三个下拉的第三个）
    // SKU 第一行：规格 / 售价 / 库存
    const skuRow = dlg.locator('.el-table__body tr').first();
    await skuRow.locator('input').nth(0).fill('默认');
    await skuRow.locator('input').nth(2).fill('88');
    await skuRow.locator('input').nth(4).fill('30');
    await dlg.locator('button:has-text("保存并上架")').click();
    await page.waitForTimeout(1800);
    const goods = await one(
      `SELECT g.goods_id, g.shop_status, g.category_id, g.freight_tpl_id,
              (SELECT COUNT(*)::int FROM shop_sku s WHERE s.goods_id=g.goods_id) AS skus,
              (SELECT price::float FROM shop_sku s WHERE s.goods_id=g.goods_id LIMIT 1) AS price,
              (SELECT stock FROM shop_sku s WHERE s.goods_id=g.goods_id LIMIT 1) AS stock
         FROM self_goods g WHERE g.site_id=$1 AND g.title='界面测试商品'`, [siteId]);
    check('商品已落库且已上架', goods && goods.shop_status === 'on' && Number(goods.skus) === 1, JSON.stringify(goods));
    check('SKU 价格/库存按填写落库', goods && Number(goods.price) === 88 && Number(goods.stock) === 30, JSON.stringify(goods));
    check('分类与运费模板已绑定', goods && Number(goods.category_id) === Number(catRow.category_id) && Number(goods.freight_tpl_id) === Number(tplRow.tpl_id), JSON.stringify(goods));
    // 商城前台应能看到（只读断言，证明上架真的生效）
    const pub = await (await fetch(`${API_BASE}/api/shop/goods?site=site-a`)).json();
    check('商城公开列表已出现该商品', pub.data.items.some((i) => i.title === '界面测试商品'), JSON.stringify(pub.data.items.map((i) => i.title)));

    console.log('\n[7] 商城订单：界面发货');
    const skuId = Number((await one(`SELECT sku_id FROM shop_sku WHERE goods_id=$1 LIMIT 1`, [goods.goods_id])).sku_id);
    const userToken = (await import('jsonwebtoken')).default.sign({ typ: 'user', userId: Number(user.user_id), siteId }, JWT_SECRET, { expiresIn: '1h' });
    const orderRes = await (await fetch(`${API_BASE}/api/shop/orders`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ items: [{ sku_id: skuId, num: 1 }], address_id: Number((await one(`SELECT id FROM user_address WHERE user_id=$1`, [user.user_id])).id) }),
    })).json();
    const orderId = orderRes.data.order_id;
    await fetch(`${API_BASE}/api/trade/orders/${orderId}/mock-pay`, { method: 'POST', headers: { Authorization: `Bearer ${userToken}` } });
    await page.locator('.menu-item.sub', { hasText: '商城订单' }).click();
    await page.waitForSelector('.el-table__body tr', { timeout: 15000 });
    await page.waitForTimeout(600);
    const hasOrder = (await page.locator('.el-table__body').innerText()).includes('SHOP_');
    check('订单列表出现商城订单', hasOrder);
    await page.locator('button:has-text("发货")').first().click();
    await page.waitForSelector('.el-dialog', { timeout: 10000 });
    const shipDlg = page.locator('.el-dialog').last();
    await shipDlg.locator('input[placeholder="如：顺丰速运"]').fill('顺丰速运');
    await shipDlg.locator('input[placeholder="如：SF1234567890"]').fill('SFUI123456');
    await shipDlg.locator('button:has-text("确认发货")').click();
    await page.waitForTimeout(1500);
    const shipped = await one(`SELECT fulfill_status, logistics_snapshot FROM "order" WHERE id=$1`, [orderId]);
    check('发货已落库（状态 + 物流快照）',
      shipped?.fulfill_status === 'shipped' && shipped.logistics_snapshot?.tracking_no === 'SFUI123456',
      JSON.stringify(shipped));

    console.log('\n[8] 售后审核：界面通过并退款');
    await fetch(`${API_BASE}/api/shop/orders/${orderId}/refund`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}` },
      body: JSON.stringify({ reason: '界面测试退款' }),
    });
    await page.locator('.menu-item.sub', { hasText: '售后审核' }).click();
    await page.waitForSelector('.el-table__body tr', { timeout: 15000 });
    await page.waitForTimeout(600);
    const refundTable = await page.locator('.el-table__body').innerText();
    check('售后列表出现待审核单', refundTable.includes('待审核') && refundTable.includes('界面测试退款'), refundTable.slice(0, 120));
    await page.locator('button:has-text("通过并退款")').first().click();
    await page.waitForTimeout(600);
    await page.locator('.el-message-box__btns .el-button--primary').click();  // 主按钮（已中文化为"确定"）
    await page.waitForTimeout(2000);
    const refund = await one(
      `SELECT r.status, r.amount::float AS amount, r.reversed,
              (SELECT stock FROM shop_sku WHERE sku_id=$2) AS stock
         FROM shop_refund r WHERE r.order_id=$1`, [orderId, skuId]);
    check('售后单已退款成功', refund?.status === 'success', JSON.stringify({ s: refund?.status }));
    check('库存已回补（支付扣 1 → 退款补回 = 30）', Number(refund?.stock) === 30, JSON.stringify({ stock: refund?.stock }));
    check('冲销台账已写入', Array.isArray(refund?.reversed) && refund.reversed.length > 0, JSON.stringify(refund?.reversed));

    console.log('\n[9] 页面无未捕获错误');
    check('无 JS 报错', errs.length === 0, JSON.stringify(errs.slice(0, 2)));
  } finally {
    if (browser) await browser.close().catch(() => {});
    if (web) web.close();
    if (api) api.kill('SIGKILL');
    await db.end().catch(() => {});
    await pgInst.stop().catch(() => {});
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  console.log('\n' + (failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
