// 商城交易链验收（阶段 2）：购物车 → 试算 → 多商品下单 → 支付扣减 → 取消/兜底释放
//
// 用法：node deploy/scripts/verify-shop-chain.mjs
//
// 这是**钱与库存路径**的测试，重点覆盖三件容易出事的地方：
//   ① 并发不超卖（最后 1 件被 5 个请求同时抢）
//   ② 支付回调幂等（mock-pay 打两次，库存只扣一次）
//   ③ 试算不落库（checkout 后订单数/占用库存必须零变化 —— 靠事务回滚保证预览金额==真实金额）
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import jwt from 'jsonwebtoken';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PG_PORT = 5435;
const API_PORT = 9103;
const DATA_DIR = path.join(repoRoot, 'deploy', '.pgdata-shop-chain');
const JWT_SECRET = 'verify-secret';
const BASE = `http://127.0.0.1:${API_PORT}`;

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name} ${extra}`); }
};
const run = (script, env) => {
  const r = spawnSync(process.execPath, [script], { cwd: repoRoot, env: { ...process.env, ...env }, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '') + (r.stderr ?? '') };
};

async function main() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  const pgInst = new EmbeddedPostgres({
    databaseDir: DATA_DIR, user: 'fyt360_tester', password: 'fyt360_local_pw', port: PG_PORT, persistent: false,
  });
  await pgInst.initialise();
  await pgInst.start();
  await pgInst.createDatabase('fyt360');

  const DATABASE_URL = `postgresql://fyt360_tester:fyt360_local_pw@127.0.0.1:${PG_PORT}/fyt360`;
  const env = {
    DATABASE_URL, TCB_ENV: 'shop-chain', JWT_SECRET, ADMIN_INIT_PASSWORD: 'Fyt360@2026',
    PORT: String(API_PORT), PUBLIC_BASE_URL: BASE, NODE_ENV: 'test',
  };
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params))[0];

  let api;
  try {
    console.log('\n[1] 建库：migrate → seed → migrate');
    run('deploy/scripts/migrate.mjs', env);
    const seeded = run('deploy/scripts/seed.mjs', env);
    check('seed 成功', seeded.ok, seeded.out.slice(-200));
    const mig = run('deploy/scripts/migrate.mjs', env);
    check('迁移全部完成', mig.ok && /100_shop_core\.sql .*OK/.test(mig.out));

    console.log('\n[2] 造测试数据（分类 / 运费模板 / 商品 / SKU / 用户 / 地址 / 券）');
    const site = await one(`SELECT site_id::text AS site_id FROM site WHERE code='site-a'`);
    const siteId = site.site_id;
    const cat = await one(`INSERT INTO shop_category (site_id, name, sort) VALUES ($1,'测试分类',10) RETURNING category_id`, [siteId]);
    const tpl = await one(
      `INSERT INTO shop_freight_template (site_id, name, charge_mode, free_over, first_unit, first_fee, add_unit, add_fee)
       VALUES ($1,'默认快递','qty',100,1,5,1,2) RETURNING tpl_id`, [siteId]);
    // 实物商品 A：两个 SKU（10 元 ×10 件、20 元 ×5 件），成本 4 / 8
    const ga = await one(
      `INSERT INTO self_goods (site_id, title, main_imgs, skus, delivery_type, status, shop_status, category_id, freight_tpl_id)
       VALUES ($1,'实物商品A','["a.jpg"]'::jsonb,'[]'::jsonb,'express','on','on',$2,$3) RETURNING goods_id`,
      [siteId, cat.category_id, tpl.tpl_id]);
    const skuA1 = await one(`INSERT INTO shop_sku (site_id, goods_id, sku_code, spec, price, cost_price, stock) VALUES ($1,$2,'a1','红色',10,4,10) RETURNING sku_id`, [siteId, ga.goods_id]);
    await q(`INSERT INTO shop_sku (site_id, goods_id, sku_code, spec, price, cost_price, stock) VALUES ($1,$2,'a2','蓝色',20,8,5)`, [siteId, ga.goods_id]);
    // 虚拟商品 V
    const gv = await one(
      `INSERT INTO self_goods (site_id, title, main_imgs, skus, delivery_type, status, shop_status)
       VALUES ($1,'虚拟卡券V','["v.jpg"]'::jsonb,'[]'::jsonb,'virtual','on','on') RETURNING goods_id`, [siteId]);
    const skuV1 = await one(`INSERT INTO shop_sku (site_id, goods_id, sku_code, spec, price, cost_price, stock) VALUES ($1,$2,'v1','10元券',9.9,7,100) RETURNING sku_id`, [siteId, gv.goods_id]);
    // 最后 1 件商品 B（并发测试用）
    const gb = await one(
      `INSERT INTO self_goods (site_id, title, main_imgs, skus, delivery_type, status, shop_status, freight_tpl_id)
       VALUES ($1,'抢购商品B','["b.jpg"]'::jsonb,'[]'::jsonb,'express','on','on',$2) RETURNING goods_id`, [siteId, tpl.tpl_id]);
    const skuB1 = await one(`INSERT INTO shop_sku (site_id, goods_id, sku_code, spec, price, cost_price, stock) VALUES ($1,$2,'b1','默认',5,2,1) RETURNING sku_id`, [siteId, gb.goods_id]);
    // 用户 + 地址 + 券
    const user = await one(`INSERT INTO "user" (site_id, openid, status) VALUES ($1,'shop_chain_openid','active') RETURNING user_id`, [siteId]);
    const addr = await one(`INSERT INTO user_address (user_id, name, phone, region, detail, is_default) VALUES ($1,'张三','13800000000','江苏省南京市','测试路1号',1) RETURNING id`, [user.user_id]);
    await q(`INSERT INTO coupon (site_id, name, type, amount, threshold, valid_to) VALUES ($1,'满20减5','cash_off',5,20, now() + interval '30 days')`, [siteId]);
    const c = await one(`SELECT id FROM coupon WHERE name='满20减5' LIMIT 1`);
    const uc = await one(`INSERT INTO user_coupon (user_id, coupon_id, status, expire_at) VALUES ($1,$2,'unused', now() + interval '30 days') RETURNING id`, [user.user_id, c.id]);
    check('测试数据就绪', !!(siteId && skuA1.sku_id && skuV1.sku_id && skuB1.sku_id && uc.id));

    console.log('\n[3] 启动 API');
    api = spawn(process.execPath, [path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'server/src/index.ts'], {
      cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let apiLog = '';
    api.stdout.on('data', (d) => { apiLog += d; });
    api.stderr.on('data', (d) => { apiLog += d; });
    let healthy = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const h = await fetch(BASE + '/healthz');
        const j = await h.json();
        if (h.status === 200 && j.ok && j.db) { healthy = true; break; }
      } catch { /* 重试 */ }
    }
    check('API /healthz 就绪', healthy, apiLog.slice(-400));

    const token = jwt.sign({ typ: 'user', userId: Number(user.user_id), siteId }, JWT_SECRET, { expiresIn: '1h' });
    const H = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
    const call = async (method, url, body) => {
      const r = await fetch(BASE + url, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
      let j = null; try { j = await r.json(); } catch { /* 无 body */ }
      return { status: r.status, body: j, data: j?.data };
    };

    console.log('\n[4] 商品目录（公开接口）');
    const cats = await call('GET', '/api/shop/categories?site=site-a');
    check('分类接口返回 1 个分类', cats.status === 200 && cats.data?.flat?.length === 1, JSON.stringify(cats.body));
    const list = await call('GET', '/api/shop/goods?site=site-a');
    check('商品列表 3 个（只出上架且有可售 SKU）', list.data?.items?.length === 3, JSON.stringify(list.data?.items?.map((i) => i.title)));
    const detail = await call('GET', `/api/shop/goods/${ga.goods_id}?site=site-a`);
    check('商品详情带 2 个 SKU 与可售量', detail.data?.skus?.length === 2 && detail.data.skus[0].available === 10, JSON.stringify(detail.data?.skus));

    console.log('\n[5] 购物车');
    const add1 = await call('POST', '/api/me/shop/cart', { sku_id: Number(skuA1.sku_id), num: 2 });
    check('加入购物车 A1×2', add1.status === 200 && add1.data.num === 2, JSON.stringify(add1.body));
    await call('POST', '/api/me/shop/cart', { sku_id: Number(skuV1.sku_id), num: 1 });
    const cart = await call('GET', '/api/me/shop/cart');
    check('购物车 2 行、勾选金额 29.9（实物 20 + 虚拟 9.9）', cart.data?.items?.length === 2 && cart.data.summary.goods_amount === 29.9, JSON.stringify(cart.data?.summary));
    const dup = await call('POST', '/api/me/shop/cart', { sku_id: Number(skuA1.sku_id), num: 3 });
    check('同 SKU 累加（2+3=5）', dup.data?.num === 5, JSON.stringify(dup.body));
    await call('PATCH', `/api/me/shop/cart/${add1.data.cart_id}`, { num: 2 });

    console.log('\n[6] 混类下单必须被拒（实物+虚拟不能合并）');
    const mixed = await call('POST', '/api/shop/orders', { from_cart: 1, address_id: Number(addr.id) });
    check('混类订单 400 MIXED_DELIVERY', mixed.status === 400 && mixed.body?.code === 'MIXED_DELIVERY', JSON.stringify(mixed.body));

    console.log('\n[7] 试算（不落库）');
    const before = await one(`SELECT (SELECT COUNT(*) FROM "order")::int AS orders, (SELECT SUM(locked_stock) FROM shop_sku)::int AS locked`);
    const quote = await call('POST', '/api/shop/checkout', {
      items: [{ sku_id: Number(skuA1.sku_id), num: 2 }], address_id: Number(addr.id), user_coupon_id: Number(uc.id),
    });
    check('试算金额：商品 20 + 运费 7（首件5+续1件×2）− 券 5 = 实付 22',
      quote.data?.goods_amount === 20 && quote.data?.freight === 7 && quote.data?.discount === 5 && quote.data?.pay_price === 22,
      JSON.stringify(quote.data));
    const after = await one(`SELECT (SELECT COUNT(*) FROM "order")::int AS orders, (SELECT SUM(locked_stock) FROM shop_sku)::int AS locked`);
    check('试算零副作用（订单数/占用库存不变）',
      before.orders === after.orders && before.locked === after.locked, `${JSON.stringify(before)} → ${JSON.stringify(after)}`);

    console.log('\n[8] 下单（含券）→ 占用库存 / 订单行 / 清车');
    const ord = await call('POST', '/api/shop/orders', {
      items: [{ sku_id: Number(skuA1.sku_id), num: 2 }], address_id: Number(addr.id), user_coupon_id: Number(uc.id), platform: 'mini',
    });
    check('下单成功', ord.status === 200 && ord.data?.order_id > 0, JSON.stringify(ord.body));
    const orderId = ord.data?.order_id;
    check('订单金额 22 元（20+7−5）', ord.data?.pay_price === 22, JSON.stringify(ord.data));
    const oRow = await one(`SELECT pay_price::float AS pay_price, cost_amount::float AS cost_amount, coupon_discount::float AS cd, fulfillment, platform_status, order_sn, address_snapshot->>'phone' AS phone FROM "order" WHERE id=$1`, [orderId]);
    check('订单成本快照 8 元（4×2）', oRow.cost_amount === 8, JSON.stringify(oRow));
    check('履约=express、地址已快照', oRow.fulfillment === 'express' && oRow.phone === '13800000000' && oRow.platform_status === 'created');
    const items = await q(`SELECT title, spec, unit_price::float AS up, num, amount::float AS amt FROM shop_order_item WHERE order_id=$1`, [orderId]);
    check('订单行 1 行、金额 20', items.length === 1 && items[0].amt === 20, JSON.stringify(items));
    const skuA1After = await one(`SELECT stock, locked_stock FROM shop_sku WHERE sku_id=$1`, [skuA1.sku_id]);
    check('A1 库存仍 10、占用 2', skuA1After.stock === 10 && skuA1After.locked_stock === 2, JSON.stringify(skuA1After));
    const logCreate = await one(`SELECT change_num, after_stock, reason FROM shop_stock_log WHERE ref=$1`, [`create:${oRow.order_sn}`]);
    check('库存流水 order_create 已记（可售 8）', logCreate?.reason === 'order_create' && logCreate.change_num === -2 && logCreate.after_stock === 8, JSON.stringify(logCreate));
    const ucAfter = await one(`SELECT status, used_order_id FROM user_coupon WHERE id=$1`, [uc.id]);
    check('券已锁定到该单', ucAfter.status === 'used' && Number(ucAfter.used_order_id) === Number(orderId), JSON.stringify(ucAfter));
    const cartLeft = await q(`SELECT sku_id FROM shop_cart WHERE user_id=$1`, [user.user_id]);
    check('已下单的 A1 从购物车移除（虚拟品仍在）', cartLeft.length === 1 && Number(cartLeft[0].sku_id) === Number(skuV1.sku_id), JSON.stringify(cartLeft));

    console.log('\n[9] 并发抢最后 1 件：5 个请求只能成功 1 个');
    const results = await Promise.all(Array.from({ length: 5 }, () =>
      call('POST', '/api/shop/orders', { items: [{ sku_id: Number(skuB1.sku_id), num: 1 }], address_id: Number(addr.id) })));
    const okCount = results.filter((r) => r.status === 200).length;
    const outCount = results.filter((r) => r.status === 409 && r.body?.code === 'OUT_OF_STOCK').length;
    check('恰好 1 单成功', okCount === 1, `成功 ${okCount}：${JSON.stringify(results.map((r) => r.status))}`);
    check('其余 4 单 409 OUT_OF_STOCK', outCount === 4, `409 数=${outCount}`);
    const bStock = await one(`SELECT stock, locked_stock FROM shop_sku WHERE sku_id=$1`, [skuB1.sku_id]);
    check('B1 占用=1 且未超卖（stock 仍 1）', bStock.locked_stock === 1 && bStock.stock === 1, JSON.stringify(bStock));
    const bOrders = await one(`SELECT COUNT(*)::int AS n FROM shop_order_item i JOIN "order" o ON o.id=i.order_id WHERE i.sku_id=$1 AND o.platform_status='created'`, [skuB1.sku_id]);
    check('只落库 1 张 B 订单', bOrders.n === 1, JSON.stringify(bOrders));

    console.log('\n[10] 支付成功扣减 + 幂等（mock-pay 打两次）');
    const pay1 = await call('POST', `/api/trade/orders/${orderId}/mock-pay`);
    check('mock 支付成功', pay1.status === 200, JSON.stringify(pay1.body));
    const afterPay = await one(`SELECT o.platform_status, s.stock, s.locked_stock, s.sales FROM "order" o, shop_sku s WHERE o.id=$1 AND s.sku_id=$2`, [orderId, skuA1.sku_id]);
    check('支付后：库存 10→8、占用 2→0、销量 2', afterPay.stock === 8 && afterPay.locked_stock === 0 && afterPay.sales === 2 && afterPay.platform_status === 'paid', JSON.stringify(afterPay));
    const logPay = await one(`SELECT change_num, after_stock FROM shop_stock_log WHERE ref=$1 AND reason='order_pay'`, [`pay:${oRow.order_sn}`]);
    check('流水 order_pay 已记', logPay?.change_num === -2 && logPay.after_stock === 8, JSON.stringify(logPay));
    await call('POST', `/api/trade/orders/${orderId}/mock-pay`);
    const afterPay2 = await one(`SELECT s.stock, s.locked_stock, s.sales, (SELECT COUNT(*)::int FROM shop_stock_log WHERE ref=$1 AND reason='order_pay') AS logs FROM shop_sku s WHERE s.sku_id=$2`, [`pay:${oRow.order_sn}`, skuA1.sku_id]);
    check('重复回调不重复扣（库存仍 8、流水仍 1 条）', afterPay2.stock === 8 && afterPay2.sales === 2 && afterPay2.logs === 1, JSON.stringify(afterPay2));

    console.log('\n[11] 虚拟卡券：支付即成、无物流');
    const vOrd = await call('POST', '/api/shop/orders', { items: [{ sku_id: Number(skuV1.sku_id), num: 1 }] });
    check('虚拟单可不填地址（不要求 address_id）', vOrd.status === 200, JSON.stringify(vOrd.body));
    await call('POST', `/api/trade/orders/${vOrd.data.order_id}/mock-pay`);
    const vRow = await one(`SELECT fulfillment, fulfill_status, platform_status FROM "order" WHERE id=$1`, [vOrd.data.order_id]);
    check('虚拟单 fulfillment=virtual 且直接 delivered', vRow.fulfillment === 'virtual' && vRow.fulfill_status === 'delivered' && vRow.platform_status === 'paid', JSON.stringify(vRow));

    console.log('\n[12] 取消释放 + 兜底扫描');
    const ord2 = await call('POST', '/api/shop/orders', { items: [{ sku_id: Number(skuA1.sku_id), num: 3 }], address_id: Number(addr.id) });
    const lock2 = await one(`SELECT locked_stock FROM shop_sku WHERE sku_id=$1`, [skuA1.sku_id]);
    check('下单占用 +3（1+3=4：A1 上一步释放后为 0，B 单另计）', lock2.locked_stock === 3, JSON.stringify(lock2));
    const cancel = await call('POST', `/api/shop/orders/${ord2.data.order_id}/cancel`);
    check('取消成功并释放', cancel.status === 200 && cancel.data.released_skus === 1, JSON.stringify(cancel.body));
    const lock2After = await one(`SELECT locked_stock FROM shop_sku WHERE sku_id=$1`, [skuA1.sku_id]);
    check('取消后占用归零', lock2After.locked_stock === 0, JSON.stringify(lock2After));
    // 兜底：模拟上游 ordersweep 直接关单（不释放），再跑商城 sweep
    const ord3 = await call('POST', '/api/shop/orders', { items: [{ sku_id: Number(skuA1.sku_id), num: 2 }], address_id: Number(addr.id) });
    await db.query(`UPDATE "order" SET platform_status='closed' WHERE id=$1`, [ord3.data.order_id]);
    const token3 = crypto.createHmac('sha256', JWT_SECRET).update('shop-sweep').digest('hex').slice(0, 32);
    const bad = await fetch(`${BASE}/api/jobs/shop-sweep/cron?token=wrong`, { method: 'POST' });
    check('sweep 错误 token 401', bad.status === 401, `实际 ${bad.status}`);
    const sweep = await fetch(`${BASE}/api/jobs/shop-sweep/cron?token=${token3}`, { method: 'POST' });
    const sweepBody = await sweep.json();
    check('sweep 释放了被上游关单的占用', sweep.status === 200 && sweepBody.data.released >= 1, JSON.stringify(sweepBody));
    const lock3After = await one(`SELECT locked_stock FROM shop_sku WHERE sku_id=$1`, [skuA1.sku_id]);
    check('兜底释放后占用归零', lock3After.locked_stock === 0, JSON.stringify(lock3After));

    console.log('\n[13] 我的商城订单列表 / 详情');
    const myOrders = await call('GET', '/api/shop/orders');
    check('订单列表含订单行数信息', myOrders.data?.items?.length >= 5 && myOrders.data.items[0].item_count === 1, JSON.stringify(myOrders.data?.items?.slice(0, 2)));
    const od = await call('GET', `/api/shop/orders/${orderId}`);
    check('订单详情含 1 行商品与地址', od.data?.items?.length === 1 && od.data.order.address?.phone === '13800000000', JSON.stringify(od.data?.items));
  } finally {
    if (api) api.kill('SIGKILL');
    await db.end().catch(() => {});
    await pgInst.stop().catch(() => {});
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  console.log('\n' + (failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
