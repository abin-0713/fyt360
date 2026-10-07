/**
 * 商城（二开）后台管理接口 —— 分类 / 商品(SPU) / SKU / 运费模板 / 订单 / 发货
 *
 * 挂载：`app.use('/api/admin/shop', adminShopRouter)`（router 级 requireAdmin）
 *
 * 多租户铁律（对齐上游 §8.2）：
 *   · 每个请求先用 adminSite() 解析出**本站 site_id**，再交给 assertSiteAccess 判定权限；
 *   · 所有 SQL 带 site_id 条件，跨站 id 一律查不到（不靠前端传参约束）；
 *   · 平台超管也要显式指定站点（避免"忘了选站"操作到别人的商品）。
 *
 * 与上游的关系：只新增文件；`self_goods` 仍是商品主表（本模块只改商城相关列），
 *   旧后台 `admin-goods.ts` 完全不受影响（它走 self_goods.skus JSON，商城走 shop_sku）。
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { pool } from '../db/client.js';
import { HttpError } from '../middleware/errors.js';
import { requireAdmin, assertSiteAccess, type AdminJwtPayload } from '../middleware/auth.js';
import { withTx } from '../lib/shop.js';

export const adminShopRouter = Router();

adminShopRouter.use(requireAdmin);

const clampInt = (v: unknown, min: number, max: number, dflt: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.floor(n)));
};
const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};

/** 解析本站 site_id（query.site / body.site / x-fyt-site 头），并强制站点权限 */
async function adminSite(admin: AdminJwtPayload, req: Request): Promise<string> {
  const code = String(req.query.site ?? (req.body as Record<string, unknown>)?.site ?? req.headers['x-fyt-site'] ?? '')
    .split(',')[0].trim();
  if (code) {
    const { rows } = await pool.query(`SELECT site_id::text AS site_id FROM site WHERE code = $1 LIMIT 1`, [code]);
    if (!rows[0]) throw new HttpError(404, '站点不存在', 'SITE_NOT_FOUND');
    assertSiteAccess(admin, String(rows[0].site_id));
    return String(rows[0].site_id);
  }
  if (Array.isArray(admin.siteIds) && admin.siteIds.length === 1) return admin.siteIds[0];
  if (admin.role === 'platform_admin') {
    const { rows } = await pool.query(`SELECT site_id::text AS site_id FROM site ORDER BY created_at LIMIT 1`);
    if (!rows[0]) throw new HttpError(400, '尚无站点，请先在「站点管理」创建', 'NO_SITE');
    return String(rows[0].site_id);
  }
  throw new HttpError(400, '请指定站点（site 参数）', 'SITE_REQUIRED');
}

// ════════════════════════════════════════════════════════════════════════
// 分类
// ════════════════════════════════════════════════════════════════════════

/** GET /api/admin/shop/categories → 分类（含商品数） */
adminShopRouter.get('/categories', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const siteId = await adminSite(req.admin!, req);
    const { rows } = await pool.query(
      `SELECT c.category_id, c.parent_id, c.name, c.icon, c.sort, c.status,
              (SELECT COUNT(*)::int FROM self_goods g WHERE g.category_id = c.category_id) AS goods_count
         FROM shop_category c WHERE c.site_id = $1::uuid
        ORDER BY c.sort DESC, c.category_id`,
      [siteId],
    );
    res.json({
      ok: true,
      data: {
        items: rows.map((r) => ({
          category_id: Number(r.category_id),
          parent_id: r.parent_id === null ? null : Number(r.parent_id),
          name: String(r.name), icon: r.icon ?? '', sort: Number(r.sort),
          status: String(r.status), goods_count: Number(r.goods_count),
        })),
      },
    });
  } catch (e) { next(e); }
});

/** POST /api/admin/shop/categories {name, parent_id?, icon?, sort?} */
adminShopRouter.post('/categories', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const siteId = await adminSite(req.admin!, req);
    const name = String(req.body?.name ?? '').trim();
    if (!name) throw new HttpError(400, '分类名必填', 'BAD_NAME');
    if (name.length > 64) throw new HttpError(400, '分类名最长 64 字', 'BAD_NAME');
    const parentId = num(req.body?.parent_id);
    if (parentId !== null) {
      const p = await pool.query(`SELECT 1 FROM shop_category WHERE category_id = $1::bigint AND site_id = $2::uuid`, [parentId, siteId]);
      if (!p.rows[0]) throw new HttpError(404, '父分类不存在', 'PARENT_NOT_FOUND');
    }
    const { rows } = await pool.query(
      `INSERT INTO shop_category (site_id, parent_id, name, icon, sort)
       VALUES ($1::uuid, $2::bigint, $3::varchar, $4::text, $5::int)
       ON CONFLICT (site_id, COALESCE(parent_id, 0), name) DO NOTHING
       RETURNING category_id`,
      [siteId, parentId, name, String(req.body?.icon ?? ''), clampInt(req.body?.sort, -9999, 9999, 0)],
    );
    if (!rows[0]) throw new HttpError(409, '同级已有同名分类', 'CATEGORY_EXISTS');
    res.json({ ok: true, data: { category_id: Number(rows[0].category_id) } });
  } catch (e) { next(e); }
});

/** PATCH /api/admin/shop/categories/:id */
adminShopRouter.patch('/categories/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const siteId = await adminSite(req.admin!, req);
    const id = Number(req.params.id);
    const sets: string[] = [];
    const params: unknown[] = [id, siteId];
    if (req.body?.name !== undefined) {
      const name = String(req.body.name).trim();
      if (!name) throw new HttpError(400, '分类名不能为空', 'BAD_NAME');
      params.push(name); sets.push(`name = $${params.length}::varchar`);
    }
    if (req.body?.icon !== undefined) { params.push(String(req.body.icon)); sets.push(`icon = $${params.length}::text`); }
    if (req.body?.sort !== undefined) { params.push(clampInt(req.body.sort, -9999, 9999, 0)); sets.push(`sort = $${params.length}::int`); }
    if (req.body?.status !== undefined) {
      const st = String(req.body.status) === 'off' ? 'off' : 'on';
      params.push(st); sets.push(`status = $${params.length}::varchar`);
    }
    if (!sets.length) throw new HttpError(400, '无可更新字段', 'BAD_REQUEST');
    const { rows } = await pool.query(
      `UPDATE shop_category SET ${sets.join(', ')}, updated_at = now()
        WHERE category_id = $1::bigint AND site_id = $2::uuid RETURNING category_id`,
      params,
    );
    if (!rows[0]) throw new HttpError(404, '分类不存在', 'CATEGORY_NOT_FOUND');
    res.json({ ok: true, data: { category_id: Number(rows[0].category_id) } });
  } catch (e) { next(e); }
});

/** DELETE /api/admin/shop/categories/:id → 有子分类或有商品时拒绝（不静默解绑） */
adminShopRouter.delete('/categories/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const siteId = await adminSite(req.admin!, req);
    const id = Number(req.params.id);
    const child = await pool.query(`SELECT 1 FROM shop_category WHERE parent_id = $1::bigint AND site_id = $2::uuid LIMIT 1`, [id, siteId]);
    if (child.rows[0]) throw new HttpError(409, '该分类下有子分类，请先删除子分类', 'HAS_CHILDREN');
    const goods = await pool.query(`SELECT COUNT(*)::int AS n FROM self_goods WHERE category_id = $1::bigint AND site_id = $2::uuid`, [id, siteId]);
    if (Number(goods.rows[0]?.n ?? 0) > 0) {
      throw new HttpError(409, `该分类下还有 ${goods.rows[0].n} 个商品，请先移出`, 'HAS_GOODS');
    }
    const { rowCount } = await pool.query(`DELETE FROM shop_category WHERE category_id = $1::bigint AND site_id = $2::uuid`, [id, siteId]);
    if (!rowCount) throw new HttpError(404, '分类不存在', 'CATEGORY_NOT_FOUND');
    res.json({ ok: true, data: { deleted: rowCount } });
  } catch (e) { next(e); }
});

// ════════════════════════════════════════════════════════════════════════
// 运费模板
// ════════════════════════════════════════════════════════════════════════

adminShopRouter.get('/freight-templates', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const siteId = await adminSite(req.admin!, req);
    const { rows } = await pool.query(
      `SELECT t.tpl_id, t.name, t.charge_mode, t.free_over::float AS free_over,
              t.first_unit, t.first_fee::float AS first_fee, t.add_unit, t.add_fee::float AS add_fee,
              t.status, (SELECT COUNT(*)::int FROM self_goods g WHERE g.freight_tpl_id = t.tpl_id) AS goods_count
         FROM shop_freight_template t WHERE t.site_id = $1::uuid ORDER BY t.tpl_id`,
      [siteId],
    );
    res.json({
      ok: true,
      data: {
        items: rows.map((r) => ({
          tpl_id: Number(r.tpl_id), name: String(r.name), charge_mode: String(r.charge_mode),
          free_over: Number(r.free_over), first_unit: Number(r.first_unit), first_fee: Number(r.first_fee),
          add_unit: Number(r.add_unit), add_fee: Number(r.add_fee), status: String(r.status),
          goods_count: Number(r.goods_count),
        })),
      },
    });
  } catch (e) { next(e); }
});

function freightPayload(body: Record<string, unknown>) {
  const name = String(body?.name ?? '').trim();
  if (!name) throw new HttpError(400, '模板名必填', 'BAD_NAME');
  const chargeMode = String(body?.charge_mode ?? 'qty') === 'weight' ? 'weight' : 'qty';
  const freeOver = Math.max(0, num(body?.free_over) ?? 0);
  const firstUnit = clampInt(body?.first_unit, 1, 99999, 1);
  const firstFee = Math.max(0, num(body?.first_fee) ?? 0);
  const addUnit = clampInt(body?.add_unit, 1, 99999, 1);
  const addFee = Math.max(0, num(body?.add_fee) ?? 0);
  return { name, chargeMode, freeOver, firstUnit, firstFee, addUnit, addFee };
}

adminShopRouter.post('/freight-templates', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const siteId = await adminSite(req.admin!, req);
    const p = freightPayload(req.body ?? {});
    const { rows } = await pool.query(
      `INSERT INTO shop_freight_template (site_id, name, charge_mode, free_over, first_unit, first_fee, add_unit, add_fee)
       VALUES ($1::uuid,$2::varchar,$3::varchar,$4::numeric,$5::int,$6::numeric,$7::int,$8::numeric)
       ON CONFLICT (site_id, name) DO NOTHING RETURNING tpl_id`,
      [siteId, p.name, p.chargeMode, p.freeOver, p.firstUnit, p.firstFee, p.addUnit, p.addFee],
    );
    if (!rows[0]) throw new HttpError(409, '同名模板已存在', 'TPL_EXISTS');
    res.json({ ok: true, data: { tpl_id: Number(rows[0].tpl_id) } });
  } catch (e) { next(e); }
});

adminShopRouter.patch('/freight-templates/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const siteId = await adminSite(req.admin!, req);
    const id = Number(req.params.id);
    const p = freightPayload({ ...(req.body ?? {}) });
    const { rows } = await pool.query(
      `UPDATE shop_freight_template
          SET name=$3::varchar, charge_mode=$4::varchar, free_over=$5::numeric, first_unit=$6::int,
              first_fee=$7::numeric, add_unit=$8::int, add_fee=$9::numeric,
              status = CASE WHEN $10::varchar IN ('on','off') THEN $10::varchar ELSE status END,
              updated_at = now()
        WHERE tpl_id=$1::bigint AND site_id=$2::uuid RETURNING tpl_id`,
      [id, siteId, p.name, p.chargeMode, p.freeOver, p.firstUnit, p.firstFee, p.addUnit, p.addFee, String(req.body?.status ?? '')],
    );
    if (!rows[0]) throw new HttpError(404, '模板不存在', 'TPL_NOT_FOUND');
    res.json({ ok: true, data: { tpl_id: Number(rows[0].tpl_id) } });
  } catch (e) { next(e); }
});

adminShopRouter.delete('/freight-templates/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const siteId = await adminSite(req.admin!, req);
    const id = Number(req.params.id);
    const used = await pool.query(`SELECT COUNT(*)::int AS n FROM self_goods WHERE freight_tpl_id = $1::bigint AND site_id = $2::uuid`, [id, siteId]);
    if (Number(used.rows[0]?.n ?? 0) > 0) throw new HttpError(409, `有 ${used.rows[0].n} 个商品在用该模板`, 'TPL_IN_USE');
    const { rowCount } = await pool.query(`DELETE FROM shop_freight_template WHERE tpl_id = $1::bigint AND site_id = $2::uuid`, [id, siteId]);
    if (!rowCount) throw new HttpError(404, '模板不存在', 'TPL_NOT_FOUND');
    res.json({ ok: true, data: { deleted: rowCount } });
  } catch (e) { next(e); }
});

// ════════════════════════════════════════════════════════════════════════
// 商品（SPU）
// ════════════════════════════════════════════════════════════════════════

interface SkuInput {
  sku_code?: string | null; spec?: string; price: number; cost_price?: number | null;
  market_price?: number | null; stock?: number; weight_gram?: number; image?: string | null; status?: string;
}

/** SKU 入参校验（价格必须 > 0：0 元 SKU 会让微信支付无法计算金额） */
function parseSku(raw: Record<string, unknown>, idx: number): SkuInput {
  const price = num(raw?.price);
  if (price === null || price <= 0) throw new HttpError(400, `第 ${idx + 1} 个 SKU 售价必须大于 0`, 'BAD_SKU_PRICE');
  const cost = num(raw?.cost_price);
  if (cost !== null && cost < 0) throw new HttpError(400, `第 ${idx + 1} 个 SKU 成本不能为负`, 'BAD_SKU_COST');
  const market = num(raw?.market_price);
  return {
    sku_code: raw?.sku_code === undefined || raw.sku_code === null ? null : String(raw.sku_code).trim() || null,
    spec: String(raw?.spec ?? '').trim() || '默认',
    price: Math.round(price * 10000) / 10000,
    cost_price: cost === null ? null : Math.round(cost * 10000) / 10000,
    market_price: market === null ? null : Math.round(market * 10000) / 10000,
    stock: clampInt(raw?.stock, 0, 9_999_999, 0),
    weight_gram: clampInt(raw?.weight_gram, 0, 9_999_999, 0),
    image: raw?.image ? String(raw.image) : null,
    status: String(raw?.status ?? 'on') === 'off' ? 'off' : 'on',
  };
}

async function assertRefsInSite(siteId: string, categoryId: number | null, freightTplId: number | null): Promise<void> {
  if (categoryId !== null) {
    const r = await pool.query(`SELECT 1 FROM shop_category WHERE category_id = $1::bigint AND site_id = $2::uuid`, [categoryId, siteId]);
    if (!r.rows[0]) throw new HttpError(404, '分类不存在', 'CATEGORY_NOT_FOUND');
  }
  if (freightTplId !== null) {
    const r = await pool.query(`SELECT 1 FROM shop_freight_template WHERE tpl_id = $1::bigint AND site_id = $2::uuid`, [freightTplId, siteId]);
    if (!r.rows[0]) throw new HttpError(404, '运费模板不存在', 'TPL_NOT_FOUND');
  }
}

/** GET /api/admin/shop/goods?keyword=&status=&category_id=&page=&size= */
adminShopRouter.get('/goods', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const siteId = await adminSite(req.admin!, req);
    const page = clampInt(req.query.page, 1, 10_000, 1);
    const size = clampInt(req.query.size, 1, 100, 20);
    const keyword = String(req.query.keyword ?? '').trim();
    const status = String(req.query.status ?? '').trim();
    const categoryId = num(req.query.category_id);
    const params: unknown[] = [siteId];
    let where = `g.site_id = $1::uuid`;
    if (keyword) { params.push(`%${keyword}%`); where += ` AND g.title ILIKE $${params.length}`; }
    if (status === 'on' || status === 'off' || status === 'draft') { params.push(status); where += ` AND g.shop_status = $${params.length}::varchar`; }
    if (categoryId !== null) { params.push(categoryId); where += ` AND g.category_id = $${params.length}::bigint`; }
    const total = Number((await pool.query(`SELECT COUNT(*)::int AS n FROM self_goods g WHERE ${where}`, params)).rows[0]?.n ?? 0);
    params.push(size, (page - 1) * size);
    const { rows } = await pool.query(
      `SELECT g.goods_id, g.title, g.main_imgs, g.brand, g.delivery_type, g.status, g.shop_status,
              g.category_id, g.freight_tpl_id, g.sales_count, g.sort, g.created_at,
              c.name AS category_name,
              (SELECT COUNT(*)::int FROM shop_sku s WHERE s.goods_id = g.goods_id) AS sku_count,
              (SELECT COUNT(*)::int FROM shop_sku s WHERE s.goods_id = g.goods_id AND s.status='on') AS sku_on,
              (SELECT MIN(s.price)::float FROM shop_sku s WHERE s.goods_id = g.goods_id) AS min_price,
              (SELECT COALESCE(SUM(s.stock - s.locked_stock),0)::int FROM shop_sku s WHERE s.goods_id = g.goods_id) AS available
         FROM self_goods g
         LEFT JOIN shop_category c ON c.category_id = g.category_id
        WHERE ${where}
        ORDER BY g.goods_id DESC LIMIT $${params.length - 1}::int OFFSET $${params.length}::int`,
      params,
    );
    res.json({
      ok: true,
      data: {
        page, size, total,
        items: rows.map((r) => ({
          goods_id: Number(r.goods_id), title: String(r.title),
          image: Array.isArray(r.main_imgs) ? String(r.main_imgs[0] ?? '') : '',
          brand: r.brand ?? '', delivery_type: String(r.delivery_type),
          status: String(r.status), shop_status: String(r.shop_status),
          category_id: r.category_id === null ? null : Number(r.category_id),
          category_name: r.category_name ?? '',
          freight_tpl_id: r.freight_tpl_id === null ? null : Number(r.freight_tpl_id),
          sales_count: Number(r.sales_count), sort: Number(r.sort),
          sku_count: Number(r.sku_count), sku_on: Number(r.sku_on),
          min_price: r.min_price === null ? null : Number(r.min_price),
          available: Number(r.available),
          created_at: r.created_at,
        })),
      },
    });
  } catch (e) { next(e); }
});

/** GET /api/admin/shop/goods/:id → 含全部 SKU（含已下架） */
adminShopRouter.get('/goods/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const siteId = await adminSite(req.admin!, req);
    const id = Number(req.params.id);
    const { rows } = await pool.query(
      `SELECT goods_id, title, main_imgs, detail_imgs, detail_html, video_url, brand, delivery_type,
              status, shop_status, category_id, freight_tpl_id, sales_count, sort
         FROM self_goods WHERE goods_id = $1::bigint AND site_id = $2::uuid LIMIT 1`,
      [id, siteId],
    );
    if (!rows[0]) throw new HttpError(404, '商品不存在', 'GOODS_NOT_FOUND');
    const g = rows[0];
    const { rows: skus } = await pool.query(
      `SELECT sku_id, sku_code, spec, spec_values, price::float AS price, cost_price::float AS cost_price,
              market_price::float AS market_price, stock, locked_stock, sales, weight_gram, image, status
         FROM shop_sku WHERE goods_id = $1::bigint AND site_id = $2::uuid ORDER BY sku_id`,
      [id, siteId],
    );
    res.json({
      ok: true,
      data: {
        goods: {
          goods_id: Number(g.goods_id), title: String(g.title),
          main_imgs: g.main_imgs ?? [], detail_imgs: g.detail_imgs ?? [], detail_html: g.detail_html ?? '',
          video_url: g.video_url ?? '', brand: g.brand ?? '', delivery_type: String(g.delivery_type),
          status: String(g.status), shop_status: String(g.shop_status),
          category_id: g.category_id === null ? null : Number(g.category_id),
          freight_tpl_id: g.freight_tpl_id === null ? null : Number(g.freight_tpl_id),
          sales_count: Number(g.sales_count), sort: Number(g.sort),
        },
        skus: skus.map((s) => ({
          sku_id: Number(s.sku_id), sku_code: s.sku_code ?? '', spec: String(s.spec),
          spec_values: s.spec_values ?? {}, price: Number(s.price),
          cost_price: s.cost_price === null ? null : Number(s.cost_price),
          market_price: s.market_price === null ? null : Number(s.market_price),
          stock: Number(s.stock), locked_stock: Number(s.locked_stock), sales: Number(s.sales),
          weight_gram: Number(s.weight_gram), image: s.image ?? '', status: String(s.status),
        })),
      },
    });
  } catch (e) { next(e); }
});

/** POST /api/admin/shop/goods → 建商品 + 批量建 SKU（单事务） */
adminShopRouter.post('/goods', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const siteId = await adminSite(req.admin!, req);
    const title = String(req.body?.title ?? '').trim();
    if (!title) throw new HttpError(400, '商品标题必填', 'BAD_TITLE');
    const deliveryType = ['express', 'group', 'virtual'].includes(String(req.body?.delivery_type))
      ? String(req.body.delivery_type) : 'express';
    const categoryId = num(req.body?.category_id);
    const freightTplId = num(req.body?.freight_tpl_id);
    await assertRefsInSite(siteId, categoryId, freightTplId);
    const rawSkus = Array.isArray(req.body?.skus) ? req.body.skus : [];
    if (!rawSkus.length) throw new HttpError(400, '至少需要一个 SKU', 'NO_SKUS');
    if (rawSkus.length > 50) throw new HttpError(400, 'SKU 数量上限 50', 'TOO_MANY_SKUS');
    const skus = rawSkus.map((s: Record<string, unknown>, i: number) => parseSku(s, i));

    const out = await withTx(async (q) => {
      const { rows } = await q.query(
        `INSERT INTO self_goods (site_id, title, main_imgs, detail_imgs, detail_html, video_url, brand,
                                 delivery_type, status, shop_status, category_id, freight_tpl_id, sort, skus)
         VALUES ($1::uuid,$2::varchar,$3::jsonb,$4::jsonb,$5::text,$6::text,$7::varchar,
                 $8::varchar,'on','draft',$9::bigint,$10::bigint,$11::int,'[]'::jsonb)
         RETURNING goods_id`,
        [
          siteId, title,
          JSON.stringify(Array.isArray(req.body?.main_imgs) ? req.body.main_imgs : []),
          JSON.stringify(Array.isArray(req.body?.detail_imgs) ? req.body.detail_imgs : []),
          String(req.body?.detail_html ?? ''),
          String(req.body?.video_url ?? ''),
          String(req.body?.brand ?? ''),
          deliveryType, categoryId, freightTplId,
          clampInt(req.body?.sort, -9999, 9999, 0),
        ],
      );
      const goodsId = Number((rows[0] as Record<string, unknown>).goods_id);
      for (const s of skus) {
        await q.query(
          `INSERT INTO shop_sku (site_id, goods_id, sku_code, spec, price, cost_price, market_price,
                                 stock, weight_gram, image, status)
           VALUES ($1::uuid,$2::bigint,$3::varchar,$4::varchar,$5::numeric,$6::numeric,$7::numeric,$8::int,$9::int,$10::text,$11::varchar)`,
          [siteId, goodsId, s.sku_code, s.spec, s.price, s.cost_price, s.market_price, s.stock, s.weight_gram, s.image, s.status],
        );
      }
      return goodsId;
    });
    // 建完即上架（运营点"保存并上架"的常见路径）；草稿则留 draft
    if (req.body?.publish === true) {
      await pool.query(`UPDATE self_goods SET shop_status='on' WHERE goods_id=$1::bigint AND site_id=$2::uuid`, [out, siteId]);
    }
    res.json({ ok: true, data: { goods_id: out, sku_count: skus.length, shop_status: req.body?.publish === true ? 'on' : 'draft' } });
  } catch (e) { next(e); }
});

/** PATCH /api/admin/shop/goods/:id → 改商品字段（SKU 走独立接口，避免误覆盖库存） */
adminShopRouter.patch('/goods/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const siteId = await adminSite(req.admin!, req);
    const id = Number(req.params.id);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const categoryId = b.category_id !== undefined ? num(b.category_id) : undefined;
    const freightTplId = b.freight_tpl_id !== undefined ? num(b.freight_tpl_id) : undefined;
    await assertRefsInSite(siteId, categoryId ?? null, freightTplId ?? null);
    const sets: string[] = [];
    const params: unknown[] = [id, siteId];
    const push = (col: string, cast: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}::${cast}`); };
    if (b.title !== undefined) {
      const t = String(b.title).trim();
      if (!t) throw new HttpError(400, '标题不能为空', 'BAD_TITLE');
      push('title', 'varchar', t);
    }
    if (b.main_imgs !== undefined) push('main_imgs', 'jsonb', JSON.stringify(Array.isArray(b.main_imgs) ? b.main_imgs : []));
    if (b.detail_imgs !== undefined) push('detail_imgs', 'jsonb', JSON.stringify(Array.isArray(b.detail_imgs) ? b.detail_imgs : []));
    if (b.detail_html !== undefined) push('detail_html', 'text', String(b.detail_html));
    if (b.video_url !== undefined) push('video_url', 'text', String(b.video_url));
    if (b.brand !== undefined) push('brand', 'varchar', String(b.brand));
    if (b.delivery_type !== undefined) {
      const dt = String(b.delivery_type);
      if (!['express', 'group', 'virtual'].includes(dt)) throw new HttpError(400, '履约方式不合法', 'BAD_DELIVERY');
      push('delivery_type', 'varchar', dt);
    }
    if (b.category_id !== undefined) push('category_id', 'bigint', num(b.category_id));
    if (b.freight_tpl_id !== undefined) push('freight_tpl_id', 'bigint', num(b.freight_tpl_id));
    if (b.sort !== undefined) push('sort', 'int', clampInt(b.sort, -9999, 9999, 0));
    if (!sets.length) throw new HttpError(400, '无可更新字段', 'BAD_REQUEST');
    const { rows } = await pool.query(
      `UPDATE self_goods SET ${sets.join(', ')} WHERE goods_id = $1::bigint AND site_id = $2::uuid RETURNING goods_id`,
      params,
    );
    if (!rows[0]) throw new HttpError(404, '商品不存在', 'GOODS_NOT_FOUND');
    res.json({ ok: true, data: { goods_id: Number(rows[0].goods_id) } });
  } catch (e) { next(e); }
});

/** POST /api/admin/shop/goods/:id/publish {publish:true|false} → 上架/下架（上架前必须有在售 SKU 且有货） */
adminShopRouter.post('/goods/:id/publish', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const siteId = await adminSite(req.admin!, req);
    const id = Number(req.params.id);
    const publish = req.body?.publish !== false;
    if (publish) {
      const { rows } = await pool.query(
        `SELECT COUNT(*)::int AS on_sale,
                COALESCE(SUM(CASE WHEN s.status='on' THEN s.stock - s.locked_stock ELSE 0 END),0)::int AS available
           FROM shop_sku s WHERE s.goods_id = $1::bigint AND s.site_id = $2::uuid`,
        [id, siteId],
      );
      if (Number(rows[0]?.on_sale ?? 0) === 0) throw new HttpError(409, '没有在售 SKU，无法上架', 'NO_ON_SALE_SKU');
    }
    const { rows } = await pool.query(
      `UPDATE self_goods SET shop_status = $3::varchar, status = CASE WHEN $3::varchar='on' THEN 'on' ELSE 'off' END
        WHERE goods_id = $1::bigint AND site_id = $2::uuid RETURNING goods_id, shop_status`,
      [id, siteId, publish ? 'on' : 'off'],
    );
    if (!rows[0]) throw new HttpError(404, '商品不存在', 'GOODS_NOT_FOUND');
    res.json({ ok: true, data: { goods_id: Number(rows[0].goods_id), shop_status: String(rows[0].shop_status) } });
  } catch (e) { next(e); }
});

/** DELETE /api/admin/shop/goods/:id → 软删（下架），有未完成订单时拒绝 */
adminShopRouter.delete('/goods/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const siteId = await adminSite(req.admin!, req);
    const id = Number(req.params.id);
    const pending = await pool.query(
      `SELECT COUNT(*)::int AS n FROM shop_order_item i JOIN "order" o ON o.id = i.order_id
        WHERE i.goods_id = $1::bigint AND o.site_id = $2::uuid AND o.platform_status = 'created'`,
      [id, siteId],
    );
    if (Number(pending.rows[0]?.n ?? 0) > 0) {
      throw new HttpError(409, `还有 ${pending.rows[0].n} 笔未支付订单包含该商品`, 'HAS_PENDING_ORDER');
    }
    const { rows } = await pool.query(
      `UPDATE self_goods SET shop_status='off', status='off' WHERE goods_id=$1::bigint AND site_id=$2::uuid RETURNING goods_id`,
      [id, siteId],
    );
    if (!rows[0]) throw new HttpError(404, '商品不存在', 'GOODS_NOT_FOUND');
    res.json({ ok: true, data: { goods_id: Number(rows[0].goods_id), shop_status: 'off' } });
  } catch (e) { next(e); }
});

// ════════════════════════════════════════════════════════════════════════
// SKU 与库存
// ════════════════════════════════════════════════════════════════════════

/** POST /api/admin/shop/goods/:id/skus → 追加 SKU */
adminShopRouter.post('/goods/:id/skus', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const siteId = await adminSite(req.admin!, req);
    const goodsId = Number(req.params.id);
    const own = await pool.query(`SELECT 1 FROM self_goods WHERE goods_id=$1::bigint AND site_id=$2::uuid`, [goodsId, siteId]);
    if (!own.rows[0]) throw new HttpError(404, '商品不存在', 'GOODS_NOT_FOUND');
    const s = parseSku(req.body ?? {}, 0);
    const { rows } = await pool.query(
      `INSERT INTO shop_sku (site_id, goods_id, sku_code, spec, price, cost_price, market_price, stock, weight_gram, image, status)
       VALUES ($1::uuid,$2::bigint,$3::varchar,$4::varchar,$5::numeric,$6::numeric,$7::numeric,$8::int,$9::int,$10::text,$11::varchar)
       RETURNING sku_id`,
      [siteId, goodsId, s.sku_code, s.spec, s.price, s.cost_price, s.market_price, s.stock, s.weight_gram, s.image, s.status],
    );
    res.json({ ok: true, data: { sku_id: Number(rows[0].sku_id) } });
  } catch (e) { next(e); }
});

/** PATCH /api/admin/shop/skus/:skuId → 改价格/规格/状态（库存走 /stock 接口留痕） */
adminShopRouter.patch('/skus/:skuId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const siteId = await adminSite(req.admin!, req);
    const skuId = Number(req.params.skuId);
    const b = (req.body ?? {}) as Record<string, unknown>;
    const sets: string[] = [];
    const params: unknown[] = [skuId, siteId];
    const push = (col: string, cast: string, v: unknown) => { params.push(v); sets.push(`${col} = $${params.length}::${cast}`); };
    if (b.price !== undefined) {
      const p = num(b.price);
      if (p === null || p <= 0) throw new HttpError(400, '售价必须大于 0', 'BAD_SKU_PRICE');
      push('price', 'numeric', Math.round(p * 10000) / 10000);
    }
    if (b.cost_price !== undefined) push('cost_price', 'numeric', num(b.cost_price));
    if (b.market_price !== undefined) push('market_price', 'numeric', num(b.market_price));
    if (b.spec !== undefined) push('spec', 'varchar', String(b.spec).trim() || '默认');
    if (b.sku_code !== undefined) push('sku_code', 'varchar', b.sku_code === null ? null : String(b.sku_code).trim() || null);
    if (b.weight_gram !== undefined) push('weight_gram', 'int', clampInt(b.weight_gram, 0, 9_999_999, 0));
    if (b.image !== undefined) push('image', 'text', b.image ? String(b.image) : null);
    if (b.status !== undefined) push('status', 'varchar', String(b.status) === 'off' ? 'off' : 'on');
    if (b.spec_values !== undefined) push('spec_values', 'jsonb', JSON.stringify(b.spec_values ?? {}));
    if (!sets.length) throw new HttpError(400, '无可更新字段', 'BAD_REQUEST');
    const { rows } = await pool.query(
      `UPDATE shop_sku SET ${sets.join(', ')}, updated_at = now()
        WHERE sku_id = $1::bigint AND site_id = $2::uuid RETURNING sku_id`,
      params,
    );
    if (!rows[0]) throw new HttpError(404, 'SKU 不存在', 'SKU_NOT_FOUND');
    res.json({ ok: true, data: { sku_id: Number(rows[0].sku_id) } });
  } catch (e) { next(e); }
});

/**
 * POST /api/admin/shop/skus/:skuId/stock {mode:'set'|'delta', value, reason?}
 * 手工调库存必须留流水（shop_stock_log），否则月底对不上账无法取证。
 */
adminShopRouter.post('/skus/:skuId/stock', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const siteId = await adminSite(req.admin!, req);
    const skuId = Number(req.params.skuId);
    const mode = String(req.body?.mode ?? 'delta') === 'set' ? 'set' : 'delta';
    const value = num(req.body?.value);
    if (value === null || !Number.isInteger(value)) throw new HttpError(400, 'value 必须是整数', 'BAD_VALUE');
    const reason = String(req.body?.reason ?? 'admin_adjust').slice(0, 32);
    const out = await withTx(async (q) => {
      const { rows: cur } = await q.query(
        `SELECT stock, locked_stock FROM shop_sku WHERE sku_id = $1::bigint AND site_id = $2::uuid FOR UPDATE`,
        [skuId, siteId],
      );
      if (!cur[0]) throw new HttpError(404, 'SKU 不存在', 'SKU_NOT_FOUND');
      const stock = Number(cur[0].stock);
      const locked = Number(cur[0].locked_stock);
      const next = mode === 'set' ? value : stock + value;
      if (next < 0) throw new HttpError(400, '库存不能为负', 'BAD_STOCK');
      if (next < locked) throw new HttpError(409, `已有 ${locked} 件被未支付订单占用，库存不能低于占用量`, 'BELOW_LOCKED');
      const { rows: upd } = await q.query(
        `UPDATE shop_sku SET stock = $2::int, updated_at = now() WHERE sku_id = $1::bigint RETURNING stock`,
        [skuId, next],
      );
      await q.query(
        `INSERT INTO shop_stock_log (site_id, sku_id, change_num, after_stock, reason, ref, operator)
         VALUES ($1::uuid, $2::bigint, $3::int, $4::int, $5::varchar, $6::varchar, $7::varchar)`,
        [siteId, skuId, next - stock, next, reason, `admin:${Date.now()}`, `admin:${req.admin!.username}`],
      );
      return { sku_id: skuId, stock: Number(upd[0].stock), change: next - stock, mode };
    });
    res.json({ ok: true, data: out });
  } catch (e) { next(e); }
});

/** DELETE /api/admin/shop/skus/:skuId → 有订单引用则软删（下架），从未售出则真删 */
adminShopRouter.delete('/skus/:skuId', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const siteId = await adminSite(req.admin!, req);
    const skuId = Number(req.params.skuId);
    const refs = await pool.query(
      `SELECT (SELECT COUNT(*)::int FROM shop_order_item WHERE sku_id = $1::bigint) AS ordered,
              (SELECT COUNT(*)::int FROM shop_sku WHERE sku_id = $1::bigint AND site_id = $2::uuid) AS own`,
      [skuId, siteId],
    );
    if (Number(refs.rows[0]?.own ?? 0) === 0) throw new HttpError(404, 'SKU 不存在', 'SKU_NOT_FOUND');
    if (Number(refs.rows[0]?.ordered ?? 0) > 0) {
      await pool.query(`UPDATE shop_sku SET status='off', updated_at=now() WHERE sku_id=$1::bigint AND site_id=$2::uuid`, [skuId, siteId]);
      res.json({ ok: true, data: { sku_id: skuId, deleted: false, status: 'off', reason: '该 SKU 已被订单引用，改为下架保留历史' } });
      return;
    }
    const { rowCount } = await pool.query(`DELETE FROM shop_sku WHERE sku_id = $1::bigint AND site_id = $2::uuid`, [skuId, siteId]);
    res.json({ ok: true, data: { deleted: rowCount > 0, sku_id: skuId } });
  } catch (e) { next(e); }
});

/** GET /api/admin/shop/skus/:skuId/stock-logs → 库存流水（排查超卖/对账） */
adminShopRouter.get('/skus/:skuId/stock-logs', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const siteId = await adminSite(req.admin!, req);
    const skuId = Number(req.params.skuId);
    const { rows } = await pool.query(
      `SELECT log_id, change_num, after_stock, reason, ref, operator, created_at
         FROM shop_stock_log WHERE sku_id = $1::bigint AND site_id = $2::uuid
        ORDER BY log_id DESC LIMIT 100`,
      [skuId, siteId],
    );
    res.json({
      ok: true,
      data: {
        items: rows.map((r) => ({
          log_id: Number(r.log_id), change_num: Number(r.change_num), after_stock: Number(r.after_stock),
          reason: String(r.reason), ref: r.ref ?? '', operator: r.operator ?? '', created_at: r.created_at,
        })),
      },
    });
  } catch (e) { next(e); }
});

// ════════════════════════════════════════════════════════════════════════
// 订单与发货
// ════════════════════════════════════════════════════════════════════════

/** GET /api/admin/shop/orders?status=&fulfillment=&keyword=&page=&size= */
adminShopRouter.get('/orders', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const siteId = await adminSite(req.admin!, req);
    const page = clampInt(req.query.page, 1, 10_000, 1);
    const size = clampInt(req.query.size, 1, 100, 20);
    const status = String(req.query.status ?? '').trim();
    const fulfillment = String(req.query.fulfillment ?? '').trim();
    const keyword = String(req.query.keyword ?? '').trim();
    const params: unknown[] = [siteId];
    let where = `o.site_id = $1::uuid AND o.provider='self'
                   AND EXISTS (SELECT 1 FROM shop_order_item i WHERE i.order_id = o.id)`;
    if (['created', 'paid', 'settled', 'closed'].includes(status)) { params.push(status); where += ` AND o.platform_status = $${params.length}::varchar`; }
    if (['express', 'group', 'virtual'].includes(fulfillment)) { params.push(fulfillment); where += ` AND o.fulfillment = $${params.length}::varchar`; }
    if (keyword) { params.push(`%${keyword}%`); where += ` AND o.order_sn ILIKE $${params.length}`; }
    const total = Number((await pool.query(`SELECT COUNT(*)::int AS n FROM "order" o WHERE ${where}`, params)).rows[0]?.n ?? 0);
    params.push(size, (page - 1) * size);
    const { rows } = await pool.query(
      `SELECT o.id, o.order_sn, o.pay_price::float AS pay_price, o.cost_amount::float AS cost_amount,
              o.platform_status, o.fulfill_status, o.refund_status, o.fulfillment,
              o.buyer_id, o.created_at, o.paid_at, o.logistics_snapshot, o.address_snapshot->>'name' AS addr_name,
              o.address_snapshot->>'phone' AS addr_phone,
              (SELECT COUNT(*)::int FROM shop_order_item i WHERE i.order_id=o.id) AS item_count,
              (SELECT COALESCE(SUM(i.num),0)::int FROM shop_order_item i WHERE i.order_id=o.id) AS total_qty
         FROM "order" o WHERE ${where}
        ORDER BY o.id DESC LIMIT $${params.length - 1}::int OFFSET $${params.length}::int`,
      params,
    );
    res.json({
      ok: true,
      data: {
        page, size, total,
        items: rows.map((r) => ({
          order_id: Number(r.id), order_sn: String(r.order_sn),
          pay_price: Number(r.pay_price),
          cost_amount: r.cost_amount === null ? null : Number(r.cost_amount),
          platform_status: String(r.platform_status), fulfill_status: String(r.fulfill_status),
          refund_status: String(r.refund_status), fulfillment: String(r.fulfillment),
          buyer_id: Number(r.buyer_id), item_count: Number(r.item_count), total_qty: Number(r.total_qty),
          receiver: { name: r.addr_name ?? '', phone: r.addr_phone ?? '' },
          logistics: r.logistics_snapshot ?? null,
          created_at: r.created_at, paid_at: r.paid_at,
        })),
      },
    });
  } catch (e) { next(e); }
});

/** GET /api/admin/shop/orders/:id → 订单 + 订单行 + 地址 + 物流 + 库存流水关联 */
adminShopRouter.get('/orders/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const siteId = await adminSite(req.admin!, req);
    const id = Number(req.params.id);
    const { rows } = await pool.query(
      `SELECT id, order_sn, pay_price::float AS pay_price, commission::float AS commission,
              cost_amount::float AS cost_amount, coupon_discount::float AS coupon_discount,
              platform_status, fulfill_status, refund_status, fulfillment, buyer_id, promoter_id,
              address_snapshot, goods_snapshot, logistics_snapshot, payment_no, created_at, paid_at, settled_at
         FROM "order" WHERE id = $1::bigint AND site_id = $2::uuid AND provider='self' LIMIT 1`,
      [id, siteId],
    );
    if (!rows[0]) throw new HttpError(404, '订单不存在', 'ORDER_NOT_FOUND');
    const o = rows[0];
    const { rows: items } = await pool.query(
      `SELECT item_id, goods_id, sku_id, title, spec, image, unit_price::float AS unit_price,
              unit_cost::float AS unit_cost, num, amount::float AS amount, refunded_num, refund_amount::float AS refund_amount
         FROM shop_order_item WHERE order_id = $1::bigint ORDER BY item_id`,
      [id],
    );
    res.json({
      ok: true,
      data: {
        order: {
          order_id: Number(o.id), order_sn: String(o.order_sn),
          pay_price: Number(o.pay_price), commission: Number(o.commission),
          cost_amount: o.cost_amount === null ? null : Number(o.cost_amount),
          coupon_discount: Number(o.coupon_discount ?? 0),
          platform_status: String(o.platform_status), fulfill_status: String(o.fulfill_status),
          refund_status: String(o.refund_status), fulfillment: String(o.fulfillment),
          buyer_id: Number(o.buyer_id), promoter_id: o.promoter_id === null ? null : Number(o.promoter_id),
          address: o.address_snapshot ?? {}, goods_snapshot: o.goods_snapshot ?? {},
          logistics: o.logistics_snapshot ?? null, payment_no: o.payment_no ?? '',
          created_at: o.created_at, paid_at: o.paid_at, settled_at: o.settled_at,
        },
        items: items.map((i) => ({
          item_id: Number(i.item_id), goods_id: i.goods_id === null ? null : Number(i.goods_id),
          sku_id: i.sku_id === null ? null : Number(i.sku_id),
          title: String(i.title), spec: String(i.spec), image: i.image ?? '',
          unit_price: Number(i.unit_price), unit_cost: i.unit_cost === null ? null : Number(i.unit_cost),
          num: Number(i.num), amount: Number(i.amount),
          refunded_num: Number(i.refunded_num), refund_amount: Number(i.refund_amount),
        })),
      },
    });
  } catch (e) { next(e); }
});

/** POST /api/admin/shop/orders/:id/ship {company, tracking_no} → 发货（写 logistics_snapshot） */
adminShopRouter.post('/orders/:id/ship', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const siteId = await adminSite(req.admin!, req);
    const id = Number(req.params.id);
    const company = String(req.body?.company ?? '').trim();
    const trackingNo = String(req.body?.tracking_no ?? '').trim();
    if (!company || !trackingNo) throw new HttpError(400, '快递公司与运单号必填', 'BAD_LOGISTICS');
    const { rows: cur } = await pool.query(
      `SELECT id, order_sn, fulfillment, platform_status, fulfill_status FROM "order"
        WHERE id = $1::bigint AND site_id = $2::uuid AND provider='self' LIMIT 1`,
      [id, siteId],
    );
    const o = cur[0];
    if (!o) throw new HttpError(404, '订单不存在', 'ORDER_NOT_FOUND');
    if (String(o.fulfillment) !== 'express') throw new HttpError(409, '该订单无需物流（到店核销/虚拟卡券）', 'NOT_EXPRESS');
    if (!['paid', 'settled'].includes(String(o.platform_status))) {
      throw new HttpError(409, '订单未支付，不能发货', 'BAD_ORDER_STATE');
    }
    if (String(o.fulfill_status) === 'shipped' || String(o.fulfill_status) === 'delivered') {
      throw new HttpError(409, '该订单已发货', 'ALREADY_SHIPPED');
    }
    const { rows } = await pool.query(
      `UPDATE "order"
          SET logistics_snapshot = $3::jsonb, fulfill_status = 'shipped', updated_at = now()
        WHERE id = $1::bigint AND site_id = $2::uuid RETURNING id, fulfill_status`,
      [id, siteId, JSON.stringify({ company, tracking_no: trackingNo, shipped_at: new Date().toISOString(), by: req.admin!.username })],
    );
    res.json({ ok: true, data: { order_id: Number(rows[0].id), fulfill_status: String(rows[0].fulfill_status), company, tracking_no: trackingNo } });
  } catch (e) { next(e); }
});
