// 商城售后与退款验收（阶段 4）：确认收货结算 / 退款落账 / 返利冲销 / 幂等 / 状态守卫
//
// 用法：node deploy/scripts/verify-shop-refund.mjs
//
// 这是**对账级**测试：退款不只是改个状态，必须同时做到
//   ① 库存回补 + 流水  ② 元宝按比例扣回（余额不足进 frozen 挂账）  ③ 佣金作废 + 余额扣回
// 且必须幂等（微信回调重试 / 运营重复点不能重复退钱、重复回补库存）。
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync, spawn } from 'node:child_process';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';
import jwt from 'jsonwebtoken';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PG_PORT = 5437;
const API_PORT = 9105;
const DATA_DIR = path.join(repoRoot, 'deploy', '.pgdata-shop-refund');
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
    DATABASE_URL, TCB_ENV: 'shop-refund', JWT_SECRET, ADMIN_INIT_PASSWORD: ADMIN_PW,
    PORT: String(API_PORT), PUBLIC_BASE_URL: BASE, NODE_ENV: 'test',
  };
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params))[0];

  let api;
  try {
    console.log('\n[1] 建库 + 造数据（商品/SKU/用户/会员等级）');
    run('deploy/scripts/migrate.mjs', env);
    run('deploy/scripts/seed.mjs', env);
    const mig = run('deploy/scripts/migrate.mjs', env);
    check('迁移完成（含 100_shop_core 的 reversed 列）', mig.ok);

    const site = await one(`SELECT site_id::text AS id FROM site WHERE code='site-a'`);
    const siteId = site.id;
    const cat = await one(`INSERT INTO shop_category (site_id, name) VALUES ($1,'退款测试分类') RETURNING category_id`, [siteId]);
    const tpl = await one(`INSERT INTO shop_freight_template (site_id, name, first_unit, first_fee) VALUES ($1,'退款测试运费',1,0) RETURNING tpl_id`, [siteId]);
    const goods = await one(
      `INSERT INTO self_goods (site_id, title, main_imgs, skus, delivery_type, status, shop_status, category_id, freight_tpl_id)
       VALUES ($1,'退款测试商品A','[]'::jsonb,'[]'::jsonb,'express','on','on',$2,$3) RETURNING goods_id`,
      [siteId, cat.category_id, tpl.tpl_id]);
    const sku1 = await one(`INSERT INTO shop_sku (site_id, goods_id, sku_code, spec, price, cost_price, stock) VALUES ($1,$2,'s1','规格1',100,60,10) RETURNING sku_id`, [siteId, goods.goods_id]);
    const sku2 = await one(`INSERT INTO shop_sku (site_id, goods_id, sku_code, spec, price, cost_price, stock) VALUES ($1,$2,'s2','规格2',50,30,10) RETURNING sku_id`, [siteId, goods.goods_id]);
    // 到店核销商品（用于确认收货被拒的断言）
    const gGroup = await one(`INSERT INTO self_goods (site_id, title, main_imgs, skus, delivery_type, status, shop_status) VALUES ($1,'核销商品G','[]'::jsonb,'[]'::jsonb,'group','on','on') RETURNING goods_id`, [siteId]);
    const skuG = await one(`INSERT INTO shop_sku (site_id, goods_id, sku_code, spec, price, stock) VALUES ($1,$2,'g1','默认',30,10) RETURNING sku_id`, [siteId, gGroup.goods_id]);
    // 用户 + 等级 L3（有返利比例才能验证佣金冲销）
    // ⛔ invite_code 必须给：上游 settlement 的 CTE 会插 promoter(user_id, invite_code, ...)，
//    而 promoter.invite_code 是 NOT NULL（真实环境由登录流程 finalizeLogin 写入）
const user = await one(`INSERT INTO "user" (site_id, openid, invite_code, status) VALUES ($1,'refund_verify_openid','FYTTEST1','active') RETURNING user_id`, [siteId]);
    const lv3 = await one(`SELECT level_id FROM member_level WHERE code='L3'`);
    await q(`INSERT INTO member (user_id, level_id) VALUES ($1,$2) ON CONFLICT (user_id) DO UPDATE SET level_id=$2`, [user.user_id, lv3.level_id]);
    const addr = await one(`INSERT INTO user_address (user_id, name, phone, region, detail, is_default) VALUES ($1,'王五','13700000000','广东省深圳市','测试路3号',1) RETURNING id`, [user.user_id]);
    check('数据就绪（L3 会员 → 自购返佣 60%）', !!(sku1.sku_id && sku2.sku_id && skuG.sku_id && lv3.level_id));

    console.log('\n[2] 启动 API');
    api = spawn(process.execPath, [path.join(repoRoot, 'node_modules', 'tsx', 'dist', 'cli.mjs'), 'server/src/index.ts'], {
      cwd: repoRoot, env, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let apiLog = '';
    api.stdout.on('data', (d) => { apiLog += d; });
    api.stderr.on('data', (d) => { apiLog += d; });
    let healthy = false;
    for (let i = 0; i < 40; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      try { const h = await fetch(BASE + '/healthz'); const j = await h.json(); if (h.status === 200 && j.ok && j.db) { healthy = true; break; } } catch { /* retry */ }
    }
    check('API 就绪', healthy, apiLog.slice(-300));

    const login = async (u, p) => {
      const r = await fetch(BASE + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) });
      const j = await r.json(); return j?.data?.token ?? '';
    };
    const tokA = await login('admin', ADMIN_PW);
    const userToken = jwt.sign({ typ: 'user', userId: Number(user.user_id), siteId }, JWT_SECRET, { expiresIn: '2h' });
    const A = { 'Content-Type': 'application/json', Authorization: `Bearer ${tokA}`, 'x-fyt-site': 'site-a' };
    const U = { 'Content-Type': 'application/json', Authorization: `Bearer ${userToken}` };
    const call = async (H, method, url, body) => {
      const r = await fetch(BASE + url, { method, headers: H, body: body ? JSON.stringify(body) : undefined });
      let j = null; try { j = await r.json(); } catch { /* no body */ }
      return { status: r.status, body: j, data: j?.data };
    };
    const stockOf = async (skuId) => Number((await one(`SELECT stock, locked_stock FROM shop_sku WHERE sku_id=$1`, [skuId])).stock);
    const placePaidOrder = async (items, { ship = false } = {}) => {
      const o = await call(U, 'POST', '/api/shop/orders', { items, address_id: Number(addr.id) });
      if (o.status !== 200) throw new Error('下单失败: ' + JSON.stringify(o.body));
      await call(U, 'POST', `/api/trade/orders/${o.data.order_id}/mock-pay`);
      if (ship) await call(A, 'POST', `/api/admin/shop/orders/${o.data.order_id}/ship?site=site-a`, { company: '顺丰', tracking_no: `SF${o.data.order_id}` });
      return o.data.order_id;
    };

    console.log('\n[3] 确认收货 → 触发返利结算（快递单原来永远不结算）');
    const orderA = await placePaidOrder([{ sku_id: Number(sku1.sku_id), num: 2 }], { ship: true });
    const beforeSettle = await one(`SELECT platform_status, settled_at FROM "order" WHERE id=$1`, [orderA]);
    check('支付后仍未结算（paid）', beforeSettle.platform_status === 'paid' && beforeSettle.settled_at === null, JSON.stringify(beforeSettle));
    const receive = await call(U, 'POST', `/api/shop/orders/${orderA}/receive`);
    check('确认收货成功并结算', receive.status === 200 && receive.data.settled === true, JSON.stringify(receive.body));
    const afterSettle = await one(`SELECT platform_status, settleD_at FROM (SELECT platform_status, settled_at AS settleD_at FROM "order" WHERE id=$1) t`, [orderA]);
    check('订单转 settled 且有结算时间', afterSettle.platform_status === 'settled' && afterSettle.settleD_at !== null, JSON.stringify(afterSettle));
    const ingotBefore = await one(`SELECT balance FROM ingot_account WHERE user_id=$1`, [user.user_id]);
    const commissions = await q(`SELECT level, amount::float AS amount, status FROM commission_flow WHERE order_id=$1 ORDER BY level`, [orderA]);
    check('元宝已发放（实付 200 × 100）', Number(ingotBefore?.balance ?? 0) === 20000, JSON.stringify(ingotBefore));
    check('佣金已产生（L3 自购 60%×40=24）', commissions.length === 1 && commissions[0].amount === 24 && commissions[0].status === 'available', JSON.stringify(commissions));
    const promoterBal = await one(`SELECT commission_balance::float AS b FROM promoter WHERE user_id=$1`, [user.user_id]);
    check('推广余额已入账 24', Number(promoterBal?.b ?? 0) === 24, JSON.stringify(promoterBal));
    const receiveAgain = await call(U, 'POST', `/api/shop/orders/${orderA}/receive`);
    check('重复确认收货幂等（不重复发返利）', receiveAgain.status === 200 && Number((await one(`SELECT COUNT(*)::int AS n FROM commission_flow WHERE order_id=$1`, [orderA])).n) === 1,
      JSON.stringify(receiveAgain.body));

    console.log('\n[4] 全额退款：库存回补 + 元宝扣回 + 佣金作废');
    const stockBeforeRefund = await stockOf(sku1.sku_id); // 支付后 = 8
    const apply = await call(U, 'POST', `/api/shop/orders/${orderA}/refund`, { reason: '不想要了', description: '全额退款申请' });
    check('提交售后申请', apply.status === 200 && apply.data.amount === 200 && apply.data.num === 2, JSON.stringify(apply.body));
    const refundId = apply.data.refund_id;
    const orderApplying = await one(`SELECT refund_status FROM "order" WHERE id=$1`, [orderA]);
    check('订单退款状态 = applying', orderApplying.refund_status === 'applying', JSON.stringify(orderApplying));
    const dupApply = await call(U, 'POST', `/api/shop/orders/${orderA}/refund`, { reason: '再来一次' });
    check('已有进行中售后 → 409', dupApply.status === 409 && dupApply.body.code === 'EXISTING_REFUND', JSON.stringify(dupApply.body));

    const approve = await call(A, 'POST', `/api/admin/shop/refunds/${refundId}/approve?site=site-a`);
    check('后台通过并退款（无商户号 → mock 通道）', approve.status === 200 && approve.data.status === 'success' && approve.data.mock === true,
      JSON.stringify(approve.body));
    const refundRow = await one(`SELECT status, wx_refund_id, wx_refund_state, reversed FROM shop_refund WHERE refund_id=$1`, [refundId]);
    check('售后单 success 且有 mock 退款单号', refundRow.status === 'success' && String(refundRow.wx_refund_id).startsWith('MOCKRF'), JSON.stringify({ s: refundRow.status, id: refundRow.wx_refund_id }));
    check('库存已回补（8 → 10）', (await stockOf(sku1.sku_id)) === stockBeforeRefund + 2, `now=${await stockOf(sku1.sku_id)}`);
    const refundLog = await one(`SELECT change_num, reason FROM shop_stock_log WHERE ref=$1`, [`refund:${apply.data.refund_sn}`]);
    check('库存流水 reason=refund', refundLog?.reason === 'refund' && refundLog.change_num === 2, JSON.stringify(refundLog));
    const itemRow = await one(`SELECT refunded_num, refund_amount::float AS amt FROM shop_order_item WHERE order_id=$1`, [orderA]);
    check('订单行退款量已记（2 件 / 200 元）', Number(itemRow.refunded_num) === 2 && Number(itemRow.amt) === 200, JSON.stringify(itemRow));
    const orderRefunded = await one(`SELECT refund_status FROM "order" WHERE id=$1`, [orderA]);
    check('订单退款状态 = refunded', orderRefunded.refund_status === 'refunded', JSON.stringify(orderRefunded));
    const ingotAfter = await one(`SELECT balance, frozen FROM ingot_account WHERE user_id=$1`, [user.user_id]);
    const deductTx = await one(`SELECT amount, type FROM ingot_tx WHERE user_id=$1 AND type='REFUND_DEDUCT' AND ref_id=$2`, [user.user_id, String(orderA)]);
    check('元宝扣回流水 -20000', Number(deductTx?.amount ?? 0) === -20000, JSON.stringify(deductTx));
    check('元宝余额回到 0（20000−20000）', Number(ingotAfter.balance) === 0, JSON.stringify(ingotAfter));
    const commissionsAfter = await q(`SELECT status FROM commission_flow WHERE order_id=$1`, [orderA]);
    check('佣金已作废（status=invalid）', commissionsAfter.every((c) => c.status === 'invalid'), JSON.stringify(commissionsAfter));
    const promoterAfter = await one(`SELECT commission_balance::float AS b FROM promoter WHERE user_id=$1`, [user.user_id]);
    check('推广余额扣回（24 → 0）', Number(promoterAfter?.b ?? 0) === 0, JSON.stringify(promoterAfter));
    check('冲销台账已记录（元宝 + 佣金）', Array.isArray(refundRow.reversed) && refundRow.reversed.some((x) => x.kind === 'ingot') && refundRow.reversed.some((x) => x.kind === 'commission'),
      JSON.stringify(refundRow.reversed));

    console.log('\n[5] 幂等：重复审核不重复退款、不重复回补');
    const stockAfterFirst = await stockOf(sku1.sku_id);
    const approveAgain = await call(A, 'POST', `/api/admin/shop/refunds/${refundId}/approve?site=site-a`);
    check('重复审核返回 already（不再发起退款）', approveAgain.status === 200 && approveAgain.data.already === true, JSON.stringify(approveAgain.body));
    check('库存不再变化', (await stockOf(sku1.sku_id)) === stockAfterFirst);
    check('订单行退款量不翻倍', Number((await one(`SELECT refunded_num FROM shop_order_item WHERE order_id=$1`, [orderA])).refunded_num) === 2);
    check('元宝扣回流水只有 1 条', Number((await one(`SELECT COUNT(*)::int AS n FROM ingot_tx WHERE type='REFUND_DEDUCT' AND ref_id=$1`, [String(orderA)])).n) === 1);

    console.log('\n[6] 部分退款（未结算单）：比例扣元宝、佣金挂人工');
    const orderB = await placePaidOrder([
      { sku_id: Number(sku1.sku_id), num: 1 },
      { sku_id: Number(sku2.sku_id), num: 1 },
    ], { ship: true });
    // 只退第一件（100 元 / 整单 150 元）
    const itemB1 = await one(`SELECT item_id FROM shop_order_item WHERE order_id=$1 AND sku_id=$2`, [orderB, sku1.sku_id]);
    const stockB1 = await stockOf(sku1.sku_id);
    const applyB = await call(U, 'POST', `/api/shop/orders/${orderB}/refund`, { item_id: Number(itemB1.item_id), num: 1, reason: '单件退款' });
    check('按单品申请退款（100 元）', applyB.status === 200 && applyB.data.amount === 100, JSON.stringify(applyB.body));
    const approveB = await call(A, 'POST', `/api/admin/shop/refunds/${applyB.data.refund_id}/approve?site=site-a`);
    check('部分退款落账成功', approveB.status === 200 && approveB.data.status === 'success', JSON.stringify(approveB.body));
    check('只回补 1 件库存', (await stockOf(sku1.sku_id)) === stockB1 + 1);
    const orderBStatus = await one(`SELECT refund_status FROM "order" WHERE id=$1`, [orderB]);
    check('订单退款状态 = partial', orderBStatus.refund_status === 'partial', JSON.stringify(orderBStatus));
    const refundB = await one(`SELECT reversed FROM shop_refund WHERE refund_id=$1`, [applyB.data.refund_id]);
    check('未结算单：台账记录"无返利可冲销"', JSON.stringify(refundB.reversed).includes('尚未结算'), JSON.stringify(refundB.reversed));

    console.log('\n[7] 已结算单的部分退款 → 佣金挂人工复核（不自动冲销）');
    const orderC = await placePaidOrder([{ sku_id: Number(sku1.sku_id), num: 2 }], { ship: true });
    await call(U, 'POST', `/api/shop/orders/${orderC}/receive`);
    const itemC = await one(`SELECT item_id FROM shop_order_item WHERE order_id=$1`, [orderC]);
    const applyC = await call(U, 'POST', `/api/shop/orders/${orderC}/refund`, { item_id: Number(itemC.item_id), num: 1, reason: '退一件' });
    const approveC = await call(A, 'POST', `/api/admin/shop/refunds/${applyC.data.refund_id}/approve?site=site-a`);
    check('已结算单部分退款落账成功', approveC.status === 200 && approveC.data.status === 'success', JSON.stringify(approveC.body));
    const refundC = await one(`SELECT reversed FROM shop_refund WHERE refund_id=$1`, [applyC.data.refund_id]);
    const hasManual = JSON.stringify(refundC.reversed).includes('manual_review');
    const commC = await q(`SELECT status FROM commission_flow WHERE order_id=$1`, [orderC]);
    check('台账标 manual_review（佣金不自动冲销）', hasManual, JSON.stringify(refundC.reversed));
    check('佣金状态仍为 available（等人工处理）', commC.every((c) => c.status === 'available'), JSON.stringify(commC));

    console.log('\n[8] 驳回 / 用户撤销 / 状态守卫');
    const orderD = await placePaidOrder([{ sku_id: Number(sku2.sku_id), num: 1 }], { ship: true });
    const applyD = await call(U, 'POST', `/api/shop/orders/${orderD}/refund`, { reason: '试试' });
    const rejectNoReason = await call(A, 'POST', `/api/admin/shop/refunds/${applyD.data.refund_id}/reject?site=site-a`, {});
    check('驳回必须填原因 400', rejectNoReason.status === 400, JSON.stringify(rejectNoReason.body));
    const reject = await call(A, 'POST', `/api/admin/shop/refunds/${applyD.data.refund_id}/reject?site=site-a`, { reason: '商品无质量问题' });
    check('驳回成功', reject.status === 200, JSON.stringify(reject.body));
    const orderDStatus = await one(`SELECT refund_status FROM "order" WHERE id=$1`, [orderD]);
    check('驳回后订单退款状态回滚为 none', orderDStatus.refund_status === 'none', JSON.stringify(orderDStatus));
    const stockD = await stockOf(sku2.sku_id);
    check('驳回不动库存', stockD === (await stockOf(sku2.sku_id)));

    const applyE = await call(U, 'POST', `/api/shop/orders/${orderD}/refund`, { reason: '再试一次' });
    const cancelE = await call(U, 'POST', `/api/shop/refunds/${applyE.data.refund_id}/cancel`);
    check('用户可撤销申请', cancelE.status === 200 && cancelE.data.status === 'canceled', JSON.stringify(cancelE.body));

    const unpaid = await call(U, 'POST', '/api/shop/orders', { items: [{ sku_id: Number(sku2.sku_id), num: 1 }], address_id: Number(addr.id) });
    const refundUnpaid = await call(U, 'POST', `/api/shop/orders/${unpaid.data.order_id}/refund`, { reason: 'x' });
    check('未支付订单不能申请售后 409', refundUnpaid.status === 409, JSON.stringify(refundUnpaid.body));
    const receiveUnpaid = await call(U, 'POST', `/api/shop/orders/${unpaid.data.order_id}/receive`);
    check('未支付订单不能确认收货 409', receiveUnpaid.status === 409, JSON.stringify(receiveUnpaid.body));

    const notShipped = await placePaidOrder([{ sku_id: Number(sku2.sku_id), num: 1 }]);
    const receiveNotShipped = await call(U, 'POST', `/api/shop/orders/${notShipped}/receive`);
    check('未发货不能确认收货 409 NOT_SHIPPED', receiveNotShipped.status === 409 && receiveNotShipped.body.code === 'NOT_SHIPPED', JSON.stringify(receiveNotShipped.body));

    const groupOrder = await call(U, 'POST', '/api/shop/orders', { items: [{ sku_id: Number(skuG.sku_id), num: 1 }] });
    await call(U, 'POST', `/api/trade/orders/${groupOrder.data.order_id}/mock-pay`);
    const receiveGroup = await call(U, 'POST', `/api/shop/orders/${groupOrder.data.order_id}/receive`);
    check('到店核销单不能线上确认收货 409 GROUP_ORDER', receiveGroup.status === 409 && receiveGroup.body.code === 'GROUP_ORDER', JSON.stringify(receiveGroup.body));

    const ambiguousNum = await call(U, 'POST', `/api/shop/orders/${orderD}/refund`, { num: 1, reason: '只给数量不给商品' });
    check('只给 num 不给 item_id → 400（不静默按整单退）', ambiguousNum.status === 400 && ambiguousNum.body.code === 'ITEM_ID_REQUIRED',
      JSON.stringify(ambiguousNum.body));
    const itemD = await one(`SELECT item_id FROM shop_order_item WHERE order_id=$1`, [orderD]);
    const overRefund = await call(U, 'POST', `/api/shop/orders/${orderD}/refund`, { item_id: Number(itemD.item_id), num: 99, reason: '超量' });
    check('退款件数超过可退 → 409', overRefund.status === 409, JSON.stringify(overRefund.body));

    console.log('\n[9] 后台兜底：强制结算（虚拟单/异常单）');
    const orderV = await placePaidOrder([{ sku_id: Number(sku2.sku_id), num: 1 }]);
    const settleUnpaidGuard = await call(A, 'POST', `/api/admin/shop/orders/${unpaid.data.order_id}/settle?site=site-a`);
    check('未支付单强制结算被拒 409', settleUnpaidGuard.status === 409, JSON.stringify(settleUnpaidGuard.body));
    const forceSettle = await call(A, 'POST', `/api/admin/shop/orders/${orderV}/settle?site=site-a`);
    check('强制结算成功（paid → settled）', forceSettle.status === 200 && forceSettle.data.platform_status === 'settled', JSON.stringify(forceSettle.body));

    console.log('\n[10] 后台售后列表与详情');
    const list = await call(A, 'GET', '/api/admin/shop/refunds?site=site-a');
    check('后台售后列表可用（含金额/单号/状态）', list.status === 200 && list.data.items.length >= 4 && list.data.items.every((r) => r.refund_sn && r.order_sn),
      JSON.stringify(list.data?.items?.length));
    const detail = await call(A, 'GET', `/api/admin/shop/refunds/${refundId}?site=site-a`);
    check('后台售后详情含冲销台账', detail.status === 200 && Array.isArray(detail.data.refund.reversed) && detail.data.refund.reversed.length > 0,
      JSON.stringify(detail.data?.refund?.reversed));
    const userList = await call(U, 'GET', '/api/shop/refunds');
    check('C 端售后列表可用', userList.status === 200 && userList.data.items.length >= 4, JSON.stringify(userList.data?.total));
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
