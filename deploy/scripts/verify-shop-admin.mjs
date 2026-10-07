// 商城后台验收（阶段 3）：分类 / 商品(SPU) / SKU / 运费模板 / 订单 / 发货 + 多租户隔离
//
// 用法：node deploy/scripts/verify-shop-admin.mjs
//
// 重点：
//   ① 多租户隔离（B 站管理员碰不到 A 站的商品 —— 服务端强制，不是前端置灰）
//   ② 商品上架前的完整性校验（无在售 SKU 不许上架、价格必须 > 0）
//   ③ 手工调库存必须留流水；库存不能低于未支付订单占用
//   ④ 已售 SKU 不许硬删（改下架保留历史）；有未支付订单的商品不许删
//   ⑤ 发货只对已支付的快递单开放，重复发货被拒
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PG_PORT = 5436;
const API_PORT = 9104;
const DATA_DIR = path.join(repoRoot, 'deploy', '.pgdata-shop-admin');
const JWT_SECRET = 'verify-secret';
const BASE = `http://127.0.0.1:${API_PORT}`;
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
    DATABASE_URL, TCB_ENV: 'shop-admin', JWT_SECRET, ADMIN_INIT_PASSWORD: ADMIN_PW,
    PORT: String(API_PORT), PUBLIC_BASE_URL: BASE, NODE_ENV: 'test',
  };
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params))[0];

  let api;
  try {
    console.log('\n[1] 建库');
    run('deploy/scripts/migrate.mjs', env);
    const seeded = run('deploy/scripts/seed.mjs', env);
    const mig = run('deploy/scripts/migrate.mjs', env);
    check('迁移与 seed 完成', seeded.ok && mig.ok && /100_shop_core\.sql .*OK/.test(mig.out));

    console.log('\n[2] 造第二个站点 + 其管理员（多租户隔离用）');
    const siteA = await one(`SELECT site_id::text AS id FROM site WHERE code='site-a'`);
    const siteB = await one(`INSERT INTO site (code, name, status) VALUES ('site-b','测试B站','active') RETURNING site_id::text AS id`);
    const hash = bcrypt.hashSync('SiteB@2026', 10);
    const adminB = await one(
      `INSERT INTO admin_user (username, password_hash, role, must_change_password, status)
       VALUES ('badmin', $1, 'site_admin', FALSE, 'active') RETURNING admin_id`, [hash]);
    await q(`INSERT INTO admin_user_site (admin_id, site_id, site_role, is_owner) VALUES ($1,$2,'site_admin',TRUE)`, [adminB.admin_id, siteB.id]);
    // 站 B 自己的一件商品（用于"能管自己的"）
    const gB = await one(
      `INSERT INTO self_goods (site_id, title, main_imgs, skus, delivery_type, status, shop_status)
       VALUES ($1,'B站商品','[]'::jsonb,'[]'::jsonb,'express','on','on') RETURNING goods_id`, [siteB.id]);
    await q(`INSERT INTO shop_sku (site_id, goods_id, sku_code, spec, price, stock) VALUES ($1,$2,'b1','默认',3,5)`, [siteB.id, gB.goods_id]);
    check('站点与两套管理员就绪', !!siteA.id && !!siteB.id && !!adminB.admin_id);

    console.log('\n[3] 启动 API 并登录两个管理员');
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
    check('API 就绪', healthy, apiLog.slice(-300));

    const login = async (username, password) => {
      const r = await fetch(BASE + '/api/auth/login', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const j = await r.json();
      return j?.data?.token ?? '';
    };
    const tokA = await login('admin', ADMIN_PW);
    const tokB = await login('badmin', 'SiteB@2026');
    check('平台超管登录', !!tokA);
    check('B 站管理员登录', !!tokB);

    const A = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokA}`, 'x-fyt-site': 'site-a' };
    const B = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokB}`, 'x-fyt-site': 'site-b' };
    const call = async (headers, method, url, body) => {
      const r = await fetch(BASE + url, { method, headers, body: body ? JSON.stringify(body) : undefined });
      let j = null; try { j = await r.json(); } catch { /* 无 body */ }
      return { status: r.status, body: j, data: j?.data };
    };

    console.log('\n[4] 多租户隔离（服务端强制）');
    const crossRead = await call(B, 'GET', '/api/admin/shop/goods?site=site-a');
    check('B 站管理员读 A 站商品 → 403', crossRead.status === 403, JSON.stringify(crossRead.body));
    const crossWrite = await call(B, 'POST', '/api/admin/shop/categories?site=site-a', { name: '越权分类' });
    check('B 站管理员往 A 站建分类 → 403', crossWrite.status === 403, JSON.stringify(crossWrite.body));
    // 不带 site 参数、也不带 x-fyt-site 头：走 adminSite 的"单站管理员回退到自己站点"分支
    const ownList = await call({ 'Content-Type': 'application/json', Authorization: `Bearer ${tokB}` }, 'GET', '/api/admin/shop/goods');
    check('B 站管理员不带 site 参数只能看到自己的商品', ownList.status === 200 && ownList.data.items.length === 1 && ownList.data.items[0].title === 'B站商品',
      JSON.stringify(ownList.data?.items?.map((i) => i.title)));

    console.log('\n[5] 分类 CRUD');
    const cat = await call(A, 'POST', '/api/admin/shop/categories', { name: '数码', sort: 5 });
    check('建分类', cat.status === 200 && cat.data.category_id > 0, JSON.stringify(cat.body));
    const catDup = await call(A, 'POST', '/api/admin/shop/categories', { name: '数码' });
    check('同名分类被拒 409', catDup.status === 409, JSON.stringify(catDup.body));
    const catChild = await call(A, 'POST', '/api/admin/shop/categories', { name: '手机', parent_id: cat.data.category_id });
    check('建子分类', catChild.status === 200, JSON.stringify(catChild.body));
    const delParent = await call(A, 'DELETE', `/api/admin/shop/categories/${cat.data.category_id}?site=site-a`);
    check('有子分类不许删 409', delParent.status === 409, JSON.stringify(delParent.body));
    const patchCat = await call(A, 'PATCH', `/api/admin/shop/categories/${catChild.data.category_id}?site=site-a`, { name: '手机壳' });
    check('改分类名', patchCat.status === 200);
    const catBadParent = await call(A, 'POST', '/api/admin/shop/categories', { name: '孤儿', parent_id: 999999 });
    check('父分类不存在 404', catBadParent.status === 404, JSON.stringify(catBadParent.body));

    console.log('\n[6] 运费模板');
    const tpl = await call(A, 'POST', '/api/admin/shop/freight-templates', {
      name: '全国快递', charge_mode: 'qty', free_over: 99, first_unit: 1, first_fee: 6, add_unit: 1, add_fee: 3,
    });
    check('建运费模板', tpl.status === 200 && tpl.data.tpl_id > 0, JSON.stringify(tpl.body));
    const tplBad = await call(A, 'POST', '/api/admin/shop/freight-templates', { name: '全国快递' });
    check('同名模板被拒 409', tplBad.status === 409, JSON.stringify(tplBad.body));

    console.log('\n[7] 商品与 SKU 创建 + 校验');
    const noSku = await call(A, 'POST', '/api/admin/shop/goods', { title: '无SKU商品', skus: [] });
    check('没有 SKU 的商品被拒 400', noSku.status === 400, JSON.stringify(noSku.body));
    const zeroPrice = await call(A, 'POST', '/api/admin/shop/goods', { title: '零元商品', skus: [{ spec: '默认', price: 0 }] });
    check('价格 0 被拒 400', zeroPrice.status === 400, JSON.stringify(zeroPrice.body));
    const badCat = await call(A, 'POST', '/api/admin/shop/goods', { title: '错分类', category_id: 999999, skus: [{ spec: '默认', price: 1 }] });
    check('分类不属于本站 → 404', badCat.status === 404, JSON.stringify(badCat.body));

    const create = await call(A, 'POST', '/api/admin/shop/goods', {
      title: '无线耳机', category_id: catChild.data.category_id, freight_tpl_id: tpl.data.tpl_id,
      delivery_type: 'express', brand: 'TestBrand', main_imgs: ['https://cdn/x.jpg'], detail_html: '<p>详情</p>',
      skus: [
        { sku_code: 'black', spec: '黑色', price: 199, cost_price: 120, market_price: 259, stock: 20, weight_gram: 300 },
        { sku_code: 'white', spec: '白色', price: 209, cost_price: 125, stock: 10, weight_gram: 300 },
      ],
    });
    check('建商品 + 2 个 SKU', create.status === 200 && create.data.sku_count === 2 && create.data.shop_status === 'draft',
      JSON.stringify(create.body));
    const goodsId = create.data.goods_id;

    console.log('\n[8] 草稿不上架 → 公开接口看不到');
    const pubBefore = await call(A, 'GET', '/api/shop/goods?site=site-a');
    check('公开列表看不到草稿商品', !pubBefore.data.items.some((i) => i.goods_id === goodsId), JSON.stringify(pubBefore.data?.items?.length));

    const offSku = await call(A, 'PATCH', `/api/admin/shop/skus/${(await one(`SELECT sku_id FROM shop_sku WHERE goods_id=$1 AND sku_code='white'`, [goodsId])).sku_id}?site=site-a`, { status: 'off' });
    check('下架一个 SKU', offSku.status === 200);
    const pub = await call(A, 'POST', `/api/admin/shop/goods/${goodsId}/publish?site=site-a`, { publish: true });
    check('上架成功', pub.status === 200 && pub.data.shop_status === 'on', JSON.stringify(pub.body));
    const pubAfter = await call(A, 'GET', '/api/shop/goods?site=site-a');
    const pubItem = pubAfter.data.items.find((i) => i.goods_id === goodsId);
    check('公开列表出现该商品（只算在售 SKU）', !!pubItem && pubItem.sku_count === 1 && pubItem.min_price === 199 && pubItem.available === 20,
      JSON.stringify(pubItem));

    console.log('\n[9] 改价 / 调库存（留流水）');
    const skuBlack = await one(`SELECT sku_id FROM shop_sku WHERE goods_id=$1 AND sku_code='black'`, [goodsId]);
    const setStock = await call(A, 'POST', `/api/admin/shop/skus/${skuBlack.sku_id}/stock?site=site-a`, { mode: 'set', value: 15, reason: 'admin_adjust' });
    check('设置库存 20→15 且记录变化量 -5', setStock.status === 200 && setStock.data.stock === 15 && setStock.data.change === -5, JSON.stringify(setStock.body));
    const deltaStock = await call(A, 'POST', `/api/admin/shop/skus/${skuBlack.sku_id}/stock?site=site-a`, { mode: 'delta', value: 5 });
    check('增量 +5 → 20', deltaStock.data?.stock === 20, JSON.stringify(deltaStock.body));
    const logs = await call(A, 'GET', `/api/admin/shop/skus/${skuBlack.sku_id}/stock-logs?site=site-a`);
    check('库存流水 2 条（可追溯）', logs.data?.items?.length === 2 && logs.data.items[0].operator.includes('admin'), JSON.stringify(logs.data?.items?.length));
    const negStock = await call(A, 'POST', `/api/admin/shop/skus/${skuBlack.sku_id}/stock?site=site-a`, { mode: 'delta', value: -999 });
    check('库存不能为负 400', negStock.status === 400, JSON.stringify(negStock.body));
    const priceUpd = await call(A, 'PATCH', `/api/admin/shop/skus/${skuBlack.sku_id}?site=site-a`, { price: 188.8 });
    check('改价成功', priceUpd.status === 200);
    const detail = await call(A, 'GET', `/api/shop/goods/${goodsId}?site=site-a`);
    check('公开详情价格已更新为 188.8', detail.data?.skus?.some((s) => s.price === 188.8), JSON.stringify(detail.data?.skus?.map((s) => s.price)));

    console.log('\n[10] 下单占库存后，调库存不能低于占用量');
    const user = await one(`INSERT INTO "user" (site_id, openid, status) VALUES ($1,'admin_verify_openid','active') RETURNING user_id`, [siteA.id]);
    const addr = await one(`INSERT INTO user_address (user_id, name, phone, region, detail, is_default) VALUES ($1,'李四','13900000000','浙江省杭州市','测试路2号',1) RETURNING id`, [user.user_id]);
    const userToken = jwt.sign({ typ: 'user', userId: Number(user.user_id), siteId: siteA.id }, JWT_SECRET, { expiresIn: '1h' });
    const U = { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}` };
    const order = await call(U, 'POST', '/api/shop/orders', {
      items: [{ sku_id: Number(skuBlack.sku_id), num: 18 }], address_id: Number(addr.id),
    });
    check('C 端下单 18 件成功（占用 18）', order.status === 200, JSON.stringify(order.body));
    const belowLocked = await call(A, 'POST', `/api/admin/shop/skus/${skuBlack.sku_id}/stock?site=site-a`, { mode: 'set', value: 5 });
    check('库存调到低于占用量被拒 409', belowLocked.status === 409, JSON.stringify(belowLocked.body));
    const okStock = await call(A, 'POST', `/api/admin/shop/skus/${skuBlack.sku_id}/stock?site=site-a`, { mode: 'set', value: 18 });
    check('调到等于占用量允许', okStock.status === 200 && okStock.data.stock === 18, JSON.stringify(okStock.body));

    console.log('\n[11] 后台订单列表/详情/发货');
    const adminOrders = await call(A, 'GET', '/api/admin/shop/orders?site=site-a');
    check('后台订单列表含该单与收件人', adminOrders.data?.items?.some((o) => o.order_id === order.data.order_id && o.receiver.phone === '13900000000'),
      JSON.stringify(adminOrders.data?.items?.map((o) => o.order_sn)));
    const adminOrder = await call(A, 'GET', `/api/admin/shop/orders/${order.data.order_id}?site=site-a`);
    check('订单详情含订单行与地址快照', adminOrder.data?.items?.length === 1 && adminOrder.data.order.address?.name === '李四', JSON.stringify(adminOrder.data?.items));
    const shipBeforePay = await call(A, 'POST', `/api/admin/shop/orders/${order.data.order_id}/ship?site=site-a`, { company: '顺丰', tracking_no: 'SF123' });
    check('未支付不能发货 409', shipBeforePay.status === 409, JSON.stringify(shipBeforePay.body));
    await call(U, 'POST', `/api/trade/orders/${order.data.order_id}/mock-pay`);
    const ship = await call(A, 'POST', `/api/admin/shop/orders/${order.data.order_id}/ship?site=site-a`, { company: '顺丰', tracking_no: 'SF123456' });
    check('发货成功并写物流快照', ship.status === 200 && ship.data.fulfill_status === 'shipped', JSON.stringify(ship.body));
    const shipRow = await one(`SELECT logistics_snapshot, fulfill_status FROM "order" WHERE id=$1`, [order.data.order_id]);
    check('物流快照含公司与运单号', shipRow.logistics_snapshot?.company === '顺丰' && shipRow.logistics_snapshot?.tracking_no === 'SF123456', JSON.stringify(shipRow));
    const shipAgain = await call(A, 'POST', `/api/admin/shop/orders/${order.data.order_id}/ship?site=site-a`, { company: '顺丰', tracking_no: 'SF999' });
    check('重复发货被拒 409', shipAgain.status === 409, JSON.stringify(shipAgain.body));
    const vGoods = await call(A, 'POST', '/api/admin/shop/goods', {
      title: '虚拟券', delivery_type: 'virtual', publish: true, skus: [{ spec: '10元券', price: 9.9, stock: 100 }],
    });
    const vOrder = await call(U, 'POST', '/api/shop/orders', { items: [{ sku_id: Number((await one(`SELECT sku_id FROM shop_sku WHERE goods_id=$1`, [vGoods.data.goods_id])).sku_id), num: 1 }] });
    await call(U, 'POST', `/api/trade/orders/${vOrder.data.order_id}/mock-pay`);
    const vShip = await call(A, 'POST', `/api/admin/shop/orders/${vOrder.data.order_id}/ship?site=site-a`, { company: '顺丰', tracking_no: 'X1' });
    check('虚拟单不能发货 409 NOT_EXPRESS', vShip.status === 409 && vShip.body?.message?.includes('无需物流'), JSON.stringify(vShip.body));

    console.log('\n[12] 删除保护');
    const delGoodsPending = await call(A, 'DELETE', `/api/admin/shop/goods/${goodsId}?site=site-a`);
    check('有未支付订单的商品不许删（该单已支付→允许）', delGoodsPending.status === 200, JSON.stringify(delGoodsPending.body));
    const delGoods = await call(A, 'DELETE', `/api/admin/shop/goods/${vGoods.data.goods_id}?site=site-a`);
    check('无未支付订单 → 软删下架', delGoods.status === 200 && delGoods.data.shop_status === 'off', JSON.stringify(delGoods.body));
    const delSkuOrdered = await call(A, 'DELETE', `/api/admin/shop/skus/${skuBlack.sku_id}?site=site-a`);
    check('已售 SKU 改为下架（不硬删，保历史）', delSkuOrdered.status === 200 && delSkuOrdered.data.deleted === false && delSkuOrdered.data.status === 'off',
      JSON.stringify(delSkuOrdered.body));
    const delSkuFresh = await call(A, 'DELETE', `/api/admin/shop/skus/${(await one(`SELECT sku_id FROM shop_sku WHERE goods_id=$1 AND sku_code='white'`, [goodsId])).sku_id}?site=site-a`);
    check('从未售出的 SKU 真删', delSkuFresh.status === 200 && delSkuFresh.data.deleted === true, JSON.stringify(delSkuFresh.body));
    const delTplUsed = await call(A, 'DELETE', `/api/admin/shop/freight-templates/${tpl.data.tpl_id}?site=site-a`);
    check('被商品使用的运费模板不许删 409', delTplUsed.status === 409, JSON.stringify(delTplUsed.body));
    const delCatUsed = await call(A, 'DELETE', `/api/admin/shop/categories/${catChild.data.category_id}?site=site-a`);
    check('有商品的分类不许删 409', delCatUsed.status === 409, JSON.stringify(delCatUsed.body));

    console.log('\n[13] 未登录/无权限访问后台商城接口');
    const noAuth = await fetch(`${BASE}/api/admin/shop/goods?site=site-a`);
    check('无 token → 401', noAuth.status === 401);
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
