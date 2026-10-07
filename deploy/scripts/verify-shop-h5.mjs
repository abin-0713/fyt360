// 商城 H5 前端验收（阶段 5）：真实浏览器跑通「浏览 → 加购 → 结算下单 → 支付 → 收货 → 售后」
//
// 用法：node deploy/scripts/verify-shop-h5.mjs
//   前置：npm run build:h5（本脚本直接消费 apps/h5/dist/build/h5 产物）
//   依赖：playwright + chromium（PLAYWRIGHT_BROWSERS_PATH 指向仓库内 .pw-browsers）
//
// 为什么值得单独做浏览器验收：
//   后端 191 项断言只能证明"接口对"，证明不了"用户点得动"——页面里 typo 一个字段名、
//   token 没带上、路由 path 写错，接口测试全绿而用户看到的是白屏。这个脚本专门补这一段。
import path from 'node:path';
import fs from 'node:fs';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import jwt from 'jsonwebtoken';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PG_PORT = 5438;
const API_PORT = 9106;
const WEB_PORT = 8086;
const DATA_DIR = path.join(repoRoot, 'deploy', '.pgdata-shop-h5');
const DIST = path.join(repoRoot, 'apps', 'h5', 'dist', 'build', 'h5');
const JWT_SECRET = 'verify-secret';
const API_BASE = `http://127.0.0.1:${API_PORT}`;
const WEB_BASE = `http://127.0.0.1:${WEB_PORT}`;

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name} ${extra}`); }
};
const run = (script, env) => {
  const r = spawnSync(process.execPath, [script], { cwd: repoRoot, env: { ...process.env, ...env }, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '') + (r.stderr ?? '') };
};

/** 极简静态服务器：/h5/* 出 dist，/api/* 反代到 API（H5 的 API_BASE 是相对路径） */
function startWeb() {
  const types = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html', '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml', '.woff2': 'font/woff2' };
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
    if (rel === '/h5' || rel === '/h5/') rel = '/h5/index.html';
    if (!rel.startsWith('/h5/')) { res.writeHead(404); res.end('not found'); return; }
    const file = path.join(DIST, decodeURIComponent(rel.slice(4)));
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
    console.error('✗ 找不到 H5 产物，请先运行：npm run build:h5');
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
    DATABASE_URL, TCB_ENV: 'shop-h5', JWT_SECRET, ADMIN_INIT_PASSWORD: 'Fyt360@2026',
    PORT: String(API_PORT), PUBLIC_BASE_URL: WEB_BASE, NODE_ENV: 'test',
  };
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params))[0];

  let api; let web; let browser;
  try {
    console.log('\n[1] 建库 + 造数据');
    run('deploy/scripts/migrate.mjs', env);
    run('deploy/scripts/seed.mjs', env);
    const mig = run('deploy/scripts/migrate.mjs', env);
    if (!mig.ok) throw new Error('迁移失败: ' + mig.out.slice(-400));

    const site = await one(`SELECT site_id::text AS id FROM site WHERE code='site-a'`);
    const siteId = site.id;
    const cat = await one(`INSERT INTO shop_category (site_id, name, sort) VALUES ($1,'数码配件',10) RETURNING category_id`, [siteId]);
    const tpl = await one(`INSERT INTO shop_freight_template (site_id, name, first_unit, first_fee, add_unit, add_fee) VALUES ($1,'默认快递',1,6,1,3) RETURNING tpl_id`, [siteId]);
    const goods = await one(
      `INSERT INTO self_goods (site_id, title, main_imgs, skus, delivery_type, status, shop_status, category_id, freight_tpl_id, brand)
       VALUES ($1,'无线蓝牙耳机','["https://example.com/a.jpg"]'::jsonb,'[]'::jsonb,'express','on','on',$2,$3,'TestBrand') RETURNING goods_id`,
      [siteId, cat.category_id, tpl.tpl_id]);
    const sku1 = await one(`INSERT INTO shop_sku (site_id, goods_id, sku_code, spec, price, cost_price, stock) VALUES ($1,$2,'black','黑色',199,120,20) RETURNING sku_id`, [siteId, goods.goods_id]);
    await q(`INSERT INTO shop_sku (site_id, goods_id, sku_code, spec, price, cost_price, stock) VALUES ($1,$2,'white','白色',209,125,10)`, [siteId, goods.goods_id]);
    const user = await one(`INSERT INTO "user" (site_id, openid, invite_code, status) VALUES ($1,'h5_verify_openid','FYTH5TEST','active') RETURNING user_id`, [siteId]);
    await q(`INSERT INTO user_address (user_id, name, phone, region, detail, is_default) VALUES ($1,'赵六','13600000000','北京市朝阳区','测试路9号',1)`, [user.user_id]);
    check('数据就绪（商品 无线蓝牙耳机 / 2 规格 / 1 地址）', !!(sku1.sku_id && user.user_id));

    console.log('\n[2] 启动 API 与静态站点（/api 反代）');
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
    const idx = await fetch(`${WEB_BASE}/h5/index.html`);
    check('H5 静态站点可访问', idx.status === 200);

    console.log('\n[3] 启动浏览器（注入 C 端登录态）');
    const token = jwt.sign({ typ: 'user', userId: Number(user.user_id), siteId }, JWT_SECRET, { expiresIn: '2h' });
    browser = await chromium.launch();
    const ctx = await browser.newContext({ viewport: { width: 420, height: 900 } });
    await ctx.addInitScript((t) => {
      try { window.localStorage.setItem('fyt_token_site-a', t); } catch (e) { /* ignore */ }
    }, token);
    const page = await ctx.newPage();
    const pageErrors = [];
    page.on('pageerror', (e) => pageErrors.push(`@${page.url()} :: ${e.message}`));
    page.on('console', (m) => { if (m.type() === 'error') pageErrors.push(`[console] ${m.text()}`); });

    console.log('\n[4] 商城首页：分类 + 商品列表');
    await page.goto(`${WEB_BASE}/h5/#/pages/shop/index`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.card', { timeout: 20000 });
    const cardText = await page.locator('.card').first().innerText();
    check('商品卡片渲染出标题与价格', cardText.includes('无线蓝牙耳机') && cardText.includes('199'), JSON.stringify(cardText));
    const catTexts = await page.locator('.cat').allInnerTexts();
    check('分类栏含"全部"与新建分类', catTexts.includes('全部') && catTexts.includes('数码配件'), JSON.stringify(catTexts));

    console.log('\n[5] 商品详情：规格选择（白色 209）/ 加购');
    await page.locator('.card').first().click();
    await page.waitForSelector('.sku', { timeout: 20000 });
    const skuTexts = await page.locator('.sku').allInnerTexts();
    check('两个规格都渲染', skuTexts.length === 2 && skuTexts.join('|').includes('黑色') && skuTexts.join('|').includes('白色'), JSON.stringify(skuTexts));
    await page.locator('.sku', { hasText: '白色' }).click();
    const whiteSku = await one(`SELECT sku_id FROM shop_sku WHERE goods_id=$1 AND sku_code='white'`, [goods.goods_id]);
    const whiteSkuId = Number(whiteSku.sku_id);
    const priceShown = await page.locator('.price').first().innerText();
    check('切换规格后价格联动为 209', priceShown.includes('209'), priceShown);
    await page.locator('text=加入购物车').click();
    await page.waitForTimeout(1200);
    const cartRows = await q(`SELECT c.num, s.sku_code FROM shop_cart c JOIN shop_sku s ON s.sku_id = c.sku_id WHERE c.user_id = $1`, [user.user_id]);
    check('加购已落库（白色 ×1）', cartRows.length === 1 && cartRows[0].sku_code === 'white' && Number(cartRows[0].num) === 1, JSON.stringify(cartRows));

    console.log('\n[6] 购物车 → 结算 → 提交订单');
    await page.goto(`${WEB_BASE}/h5/#/pages/shop/cart`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.row', { timeout: 20000 });
    const cartText = await page.locator('.row').first().innerText();
    check('购物车行渲染标题/规格/价格', cartText.includes('无线蓝牙耳机') && cartText.includes('白色') && cartText.includes('209'), JSON.stringify(cartText));
    const sumBefore = await page.locator('.sum-price').innerText();
    check('合计显示 209（仅商品金额，运费在结算页加）', sumBefore.includes('209'), sumBefore);
    await page.locator('text=去结算').click();
    await page.waitForSelector('.addr-on', { timeout: 20000 });
    const addrText = await page.locator('.addr-on').first().innerText();
    check('结算页自动选中默认地址', addrText.includes('赵六') && addrText.includes('北京市朝阳区'), JSON.stringify(addrText));
    await page.waitForTimeout(1200);
    const payText = await page.locator('.sum-price').innerText();
    check('结算页应付 = 商品 209 + 运费 6 = 215', payText.includes('215'), payText);
    await page.locator('text=提交订单').click();
    await page.waitForSelector('.big-status', { timeout: 20000 });
    const statusText = await page.locator('.big-status').innerText();
    check('跳转订单详情且状态为待支付', statusText.includes('待支付'), statusText);
    const order = await one(
      `SELECT o.id, o.order_sn, o.pay_price::float AS pay, o.platform_status,
              (SELECT COUNT(*)::int FROM shop_order_item i WHERE i.order_id=o.id) AS items,
              (SELECT locked_stock FROM shop_sku WHERE sku_id=$2) AS locked
         FROM "order" o WHERE o.buyer_id = $1::bigint ORDER BY o.id DESC LIMIT 1`,
      [user.user_id, whiteSkuId]);
    check('订单落库：金额 215 / 1 个订单行 / 占用库存 1', Number(order.pay) === 215 && Number(order.items) === 1 && Number(order.locked) === 1, JSON.stringify(order));
    const cartLeft = await q(`SELECT COUNT(*)::int AS n FROM shop_cart WHERE user_id=$1`, [user.user_id]);
    check('下单后购物车已清空', Number(cartLeft[0].n) === 0, JSON.stringify(cartLeft));

    console.log('\n[7] 支付（无商户号 → 页面提供模拟支付）');
    await page.locator('text=立即支付').click();
    await page.waitForTimeout(800);
    // uni.showModal 在 H5 渲染为弹层，点确认按钮触发模拟支付
    const modalOk = page.locator('text=模拟支付').last();
    if (await modalOk.count()) {
      await modalOk.click();
    } else {
      check('支付失败时弹出模拟支付入口', false, '未出现模拟支付按钮');
    }
    await page.waitForTimeout(1500);
    const paidStatus = await one(`SELECT platform_status, paid_at FROM "order" WHERE id=$1`, [order.id]);
    check('订单已支付（paid）', paidStatus.platform_status === 'paid' && paidStatus.paid_at !== null, JSON.stringify(paidStatus));
    const stockAfterPay = await one(`SELECT stock, locked_stock, sales FROM shop_sku WHERE sku_id=$1`, [whiteSkuId]);
    check('支付后（白色 SKU）库存 10→9、占用归零、销量 1',
      Number(stockAfterPay.stock) === 9 && Number(stockAfterPay.locked_stock) === 0 && Number(stockAfterPay.sales) === 1,
      JSON.stringify(stockAfterPay));

    console.log('\n[8] 订单列表');
    await page.goto(`${WEB_BASE}/h5/#/pages/shop/orders`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.card', { timeout: 20000 });
    const listText = await page.locator('.card').first().innerText();
    check('订单列表显示单号与已付款状态', listText.includes(String(order.order_sn)) && listText.includes('已付款'), JSON.stringify(listText));

    console.log('\n[9] 发货 → 确认收货（触发结算）→ 售后申请');
    // 后台发货（走接口，后台 UI 属于另一套页面）
    const adminToken = (await (await fetch(`${API_BASE}/api/auth/login`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: 'admin', password: 'Fyt360@2026' }),
    })).json()).data.token;
    const shipRes = await fetch(`${API_BASE}/api/admin/shop/orders/${order.id}/ship?site=site-a`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${adminToken}`, 'x-fyt-site': 'site-a' },
      body: JSON.stringify({ company: '顺丰', tracking_no: 'SFH5TEST' }),
    });
    check('后台发货成功', shipRes.status === 200, `HTTP ${shipRes.status}`);

    await page.goto(`${WEB_BASE}/h5/#/pages/shop/order-detail?id=${order.id}`, { waitUntil: 'networkidle' });
    await page.waitForSelector('.big-status', { timeout: 20000 });
    const shippedText = await page.locator('.panel').first().innerText();
    check('详情页状态显示待收货', shippedText.includes('待收货'), JSON.stringify(shippedText));
    const logisticsText = await page.locator('text=物流信息').first().isVisible();
    check('物流信息区块可见', logisticsText);
    await page.locator('text=确认收货').click();
    await page.waitForTimeout(1500);
    const settled = await one(`SELECT platform_status, fulfill_status, settled_at FROM "order" WHERE id=$1`, [order.id]);
    check('确认收货后订单已结算（settled）', settled.platform_status === 'settled' && settled.fulfill_status === 'delivered' && settled.settled_at !== null,
      JSON.stringify(settled));

    // 售后申请
    await page.waitForSelector('text=申请售后', { timeout: 20000 });
    // uni-app 的 <input> 编译成 <uni-input>，真实输入框在它内部
    await page.locator('.ipt input').first().fill('测试不想要了');
    await page.locator('text=提交申请').click();
    await page.waitForTimeout(1500);
    const refundRow = await one(`SELECT refund_sn, amount::float AS amount, num, status FROM shop_refund WHERE order_id=$1`, [order.id]);
    check('售后申请已落库（待审核）', refundRefundCheck(refundRow), JSON.stringify(refundRow));
    const refundPanelText = await page.locator('text=售后状态').first().isVisible();
    check('页面出现售后状态区块', refundPanelText);

    console.log('\n[10] 页面无 JS 报错');
    const realErrors = pageErrors.filter((e) => !/favicon|Failed to load resource/i.test(e));
    if (realErrors.length) console.log('    诊断：' + realErrors.join('\n    '));
    check('无未捕获的页面错误', realErrors.length === 0, '\n' + realErrors.slice(0, 2).join('\n---\n'));
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

function refundRefundCheck(row) {
  // 退完最后一件 → 金额含运费：209 + 6 = 215
  return !!row && String(row.status) === 'applied' && Number(row.num) === 1 && Number(row.amount) === 215;
}

main().catch((e) => { console.error(e); process.exit(1); });
