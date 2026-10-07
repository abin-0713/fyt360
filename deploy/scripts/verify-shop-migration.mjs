// 商城数据层验收：全新空库上跑通 100_shop_core.sql 并验证存量回填
//
// 用法：node deploy/scripts/verify-shop-migration.mjs
//
// 覆盖：
//   ① 全新库 001–100 全部迁移可用（含上游"010 依赖 seed"的顺序坑）
//   ② 7 张新表 / self_goods 新列 / delivery_type 扩展为 express|group|virtual
//   ③ 存量 self_goods.skus JSON → shop_sku 回填（price/stock/cost/raw 逐项比对）
//   ④ 存量自营订单 goods_snapshot → shop_order_item 回填
//   ⑤ 迁移可重复执行（幂等，计数不变）
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import EmbeddedPostgres from 'embedded-postgres';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = 5434;
const DATA_DIR = path.join(repoRoot, 'deploy', '.pgdata-shop-test');

const run = (script, env) => {
  const r = spawnSync(process.execPath, [script], {
    cwd: repoRoot,
    env: { ...process.env, ...env },
    encoding: 'utf8',
  });
  return { ok: r.status === 0, out: (r.stdout ?? '') + (r.stderr ?? '') };
};

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`  ✓ ${name}`);
  else { failures++; console.log(`  ✗ ${name} ${extra}`); }
};

async function main() {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  const pgInst = new EmbeddedPostgres({
    databaseDir: DATA_DIR, user: 'fyt360_tester', password: 'fyt360_local_pw', port: PORT, persistent: false,
  });
  await pgInst.initialise();
  await pgInst.start();
  await pgInst.createDatabase('fyt360');

  const DATABASE_URL = `postgresql://fyt360_tester:fyt360_local_pw@127.0.0.1:${PORT}/fyt360`;
  const env = { DATABASE_URL, TCB_ENV: 'shop-verify', JWT_SECRET: 'verify-secret', ADMIN_INIT_PASSWORD: 'Fyt360@2026' };
  const db = new pg.Client({ connectionString: DATABASE_URL });
  await db.connect();
  const q = async (sql, params) => (await db.query(sql, params)).rows;
  const one = async (sql, params) => (await q(sql, params))[0];

  try {
    console.log('\n[1] 全新空库：首次 migrate（预期在上游 010 停下）');
    const m1 = run('deploy/scripts/migrate.mjs', env);
    check('首次 migrate 停在上游 010（已知顺序坑，属预期）',
      !m1.ok && /010_brand_plugin_seed|brand_action_cfg_category_fkey/.test(m1.out),
      m1.ok ? '（竟然全过了）' : '');

    console.log('\n[2] seed 补分类/站点/超管');
    const s1 = run('deploy/scripts/seed.mjs', env);
    check('seed 成功', s1.ok, s1.out.slice(-300));

    console.log('\n[3] 再次 migrate（补齐 010–100，含本商城迁移）');
    const m2 = run('deploy/scripts/migrate.mjs', env);
    check('全部迁移执行完成', m2.ok && /100_shop_core\.sql .*OK/.test(m2.out), m2.out.slice(-400));

    console.log('\n[4] 表与列');
    const tables = await q(`SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename LIKE 'shop\\_%' ORDER BY 1`);
    const names = tables.map((r) => r.tablename);
    check('7 张 shop_* 表齐备', names.length === 7, JSON.stringify(names));
    const cols = await q(`SELECT column_name FROM information_schema.columns WHERE table_name='self_goods'`);
    const cnames = cols.map((r) => r.column_name);
    check('self_goods 新列齐备',
      ['category_id', 'brand', 'detail_html', 'spu_code', 'sales_count', 'sort', 'freight_tpl_id', 'shop_status']
        .every((c) => cnames.includes(c)), JSON.stringify(cnames));

    console.log('\n[5] delivery_type 支持 virtual');
    const site = await one(`SELECT site_id FROM site WHERE code='site-a'`);
    await db.query(
      `INSERT INTO self_goods (site_id, title, skus, delivery_type, status) VALUES ($1,'虚拟卡券测试','[]'::jsonb,'virtual','on')`,
      [site.site_id],
    );
    check('可写入 delivery_type=virtual', true);
    let rejected = false;
    try {
      await db.query(`INSERT INTO self_goods (site_id, title, skus, delivery_type) VALUES ($1,'非法履约','[]'::jsonb,'bogus')`, [site.site_id]);
    } catch { rejected = true; }
    check('非法 delivery_type 被约束拒绝', rejected);

    console.log('\n[6] 存量 skus JSON → shop_sku 回填');
    const g = await one(
      `INSERT INTO self_goods (site_id, title, skus, delivery_type, status, cost_price)
       VALUES ($1, '洗衣团购（存量样本）',
               '[{"sku_id":"s1","spec":"1件","price":0.01,"stock":100,"cost":0.005},
                 {"sku_id":"s2","spec":"10件","price":5.01,"stock":50}]'::jsonb,
               'group', 'on', 1.23)
       RETURNING goods_id`,
      [site.site_id],
    );
    const order = await one(
      `INSERT INTO "order" (order_sn, site_id, provider, platform, pay_price, commission, buyer_id, goods_snapshot, cost_amount)
       VALUES ('SHOPTEST0001', $1, 'self', 'mini', 5.01, 1.00, 1,
               '{"goods_id":${g.goods_id},"title":"洗衣团购（存量样本）","spec":"10件","price":5.01,"num":1}'::jsonb, 0.80)
       RETURNING id`,
      [site.site_id],
    );
    const m3 = run('deploy/scripts/migrate.mjs', env);
    check('第三次 migrate 成功（回填执行）', m3.ok, m3.out.slice(-200));

    const skus = await q(`SELECT sku_code, spec, price::float AS price, stock, cost_price::float AS cost, raw FROM shop_sku WHERE goods_id=$1 ORDER BY sku_code`, [g.goods_id]);
    check('回填 2 条 SKU', skus.length === 2, JSON.stringify(skus));
    check('s1 价格/库存正确', skus[0]?.price === 0.01 && skus[0]?.stock === 100, JSON.stringify(skus[0]));
    check('s1 成本取自身 JSON 的 cost', skus[0]?.cost === 0.005, JSON.stringify(skus[0]));
    check('s2 成本回落商品级 cost_price=1.23', skus[1]?.cost === 1.23, JSON.stringify(skus[1]));
    check('raw 保留原始 JSON 元素', skus[0]?.raw?.sku_id === 's1', JSON.stringify(skus[0]?.raw));

    const items = await q(`SELECT title, spec, unit_price::float AS unit_price, unit_cost::float AS unit_cost, num, amount::float AS amount FROM shop_order_item WHERE order_id=$1`, [order.id]);
    check('自营订单回填 1 条订单行', items.length === 1, JSON.stringify(items));
    check('订单行金额/成本快照正确', items[0]?.amount === 5.01 && items[0]?.unit_cost === 0.8, JSON.stringify(items[0]));

    console.log('\n[7] 幂等：再跑一次迁移，计数不变');
    const before = await one(`SELECT (SELECT COUNT(*) FROM shop_sku)::int AS sku, (SELECT COUNT(*) FROM shop_order_item)::int AS item`);
    run('deploy/scripts/migrate.mjs', env);
    const after = await one(`SELECT (SELECT COUNT(*) FROM shop_sku)::int AS sku, (SELECT COUNT(*) FROM shop_order_item)::int AS item`);
    check('shop_sku / shop_order_item 计数不变',
      before.sku === after.sku && before.item === after.item, `${JSON.stringify(before)} → ${JSON.stringify(after)}`);
    check('shop_sku 无重复回填（每商品唯一）',
      (await one(`SELECT COUNT(*)::int AS n FROM (SELECT goods_id FROM shop_sku GROUP BY goods_id HAVING COUNT(*)>3) t`)).n === 0);

    console.log('\n[8] 购物车唯一约束');
    // seed 只建后台账号，C 端用户要自己造一个
    const u = await one(`INSERT INTO "user" (site_id, openid, status) VALUES ($1, 'shop_verify_openid', 'active') RETURNING user_id`, [site.site_id]);
    const skuRow = await one(`SELECT sku_id FROM shop_sku WHERE goods_id=$1 ORDER BY sku_code LIMIT 1`, [g.goods_id]);
    await db.query(`INSERT INTO shop_cart (site_id, user_id, goods_id, sku_id, num) VALUES ($1,$2,$3,$4,2)`, [site.site_id, u.user_id, g.goods_id, skuRow.sku_id]);
    check('可加入购物车', true);
    let dupRejected = false;
    try {
      await db.query(`INSERT INTO shop_cart (site_id, user_id, goods_id, sku_id, num) VALUES ($1,$2,$3,$4,1)`, [site.site_id, u.user_id, g.goods_id, skuRow.sku_id]);
    } catch { dupRejected = true; }
    check('同一用户同一 SKU 唯一', dupRejected);
    let badNum = false;
    try {
      await db.query(`INSERT INTO shop_cart (site_id, user_id, goods_id, sku_id, num) VALUES ($1,$2,$3,$4,0)`, [site.site_id, u.user_id, g.goods_id, skuRow.sku_id]);
    } catch { badNum = true; }
    check('num=0 被约束拒绝', badNum);
  } finally {
    await db.end().catch(() => {});
    await pgInst.stop().catch(() => {});
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
  }

  console.log('\n' + (failures === 0 ? '✅ 全部通过' : `❌ ${failures} 项失败`));
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
