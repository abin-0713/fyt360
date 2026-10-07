/**
 * 商城（二开）路由 —— 公开商品接口 / 购物车 / 多商品下单
 *
 * 挂载：
 *   app.use('/api/shop', shopRouter)        —— 商品目录 + 下单 + 我的商城订单
 *   app.use('/api/me/shop', shopUserRouter) —— 购物车（需登录）
 *
 * 与上游的边界：
 *   · 只读 `self_goods`（加列不改造），只写 shop_* 表；
 *   · 支付走上游 `POST /api/trade/orders/:id/pay`，本文件不碰支付；
 *   · 所有查询带 site_id，写操作校验归属（对齐 §8.2 多租户铁律）。
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { pool } from '../db/client.js';
import { HttpError } from '../middleware/errors.js';
import { requireUser, optionalUser } from '../middleware/auth.js';
import { createShopOrder, quoteShopOrder, releaseShopOrderStock } from '../lib/shop.js';
import { applyRefund, cancelRefund, confirmReceive } from '../lib/shop-refund.js';

export const shopRouter = Router();
export const shopUserRouter = Router();

// token 解析前置（不挂则 requireUser 永远 401 —— 上游 trade.ts 注释里记过这个坑）
shopRouter.use(optionalUser);
shopUserRouter.use(optionalUser);

const clampInt = (v: unknown, min: number, max: number, dflt: number): number => {
  const n = Number(v);
  if (!Number.isFinite(n)) return dflt;
  return Math.min(max, Math.max(min, Math.floor(n)));
};

/** site code → site_id（公开接口用；登录态接口直接用 req.user.siteId） */
async function siteIdByCode(code: unknown): Promise<string> {
  const c = String(code ?? '').trim() || 'site-a';
  const { rows } = await pool.query(`SELECT site_id::text AS site_id, status FROM site WHERE code = $1 LIMIT 1`, [c]);
  if (!rows[0]) throw new HttpError(404, '站点不存在', 'SITE_NOT_FOUND');
  if (String(rows[0].status) !== 'active') throw new HttpError(403, '站点已停用', 'SITE_DISABLED');
  return String(rows[0].site_id);
}

// ────────────────────────────────────────────────────────────────────────
// 公开：分类 / 商品列表 / 商品详情
// ────────────────────────────────────────────────────────────────────────

/** GET /api/shop/categories?site=site-a → 分类树（只出 on 状态） */
shopRouter.get('/categories', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const siteId = await siteIdByCode(req.query.site);
    const { rows } = await pool.query(
      `SELECT category_id, parent_id, name, icon, sort
         FROM shop_category WHERE site_id = $1::uuid AND status = 'on'
        ORDER BY sort DESC, category_id`,
      [siteId],
    );
    const nodes = rows.map((r) => ({
      category_id: Number(r.category_id),
      parent_id: r.parent_id === null ? null : Number(r.parent_id),
      name: String(r.name),
      icon: r.icon ?? '',
      children: [] as unknown[],
    }));
    const byId = new Map(nodes.map((n) => [n.category_id, n]));
    const tree: unknown[] = [];
    for (const n of nodes) {
      const parent = n.parent_id ? byId.get(n.parent_id) : null;
      if (parent) (parent.children as unknown[]).push(n);
      else tree.push(n);
    }
    res.json({ ok: true, data: { tree, flat: nodes } });
  } catch (e) { next(e); }
});

/**
 * GET /api/shop/goods?site=&category_id=&keyword=&page=&size=
 * 只出已上架（shop_status='on' AND status='on'）且有可售 SKU 的商品。
 * 可售 = stock - locked_stock（下单占用也算占用，避免超卖）。
 */
shopRouter.get('/goods', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const siteId = await siteIdByCode(req.query.site);
    const page = clampInt(req.query.page, 1, 10_000, 1);
    const size = clampInt(req.query.size, 1, 50, 10);
    const categoryId = req.query.category_id ? Number(req.query.category_id) : null;
    const keyword = String(req.query.keyword ?? '').trim();
    const params: unknown[] = [siteId];
    let where = `g.site_id = $1::uuid AND g.shop_status = 'on' AND g.status = 'on'`;
    if (categoryId && Number.isInteger(categoryId)) {
      params.push(categoryId);
      // 命中子分类也算（一级分类下能看到二级分类的商品）
      where += ` AND (g.category_id = $${params.length}::bigint
                      OR g.category_id IN (SELECT category_id FROM shop_category
                                            WHERE parent_id = $${params.length}::bigint AND site_id = $1::uuid))`;
    }
    if (keyword) {
      params.push(`%${keyword}%`);
      where += ` AND g.title ILIKE $${params.length}`;
    }
    const total = Number((await pool.query(
      `SELECT COUNT(*)::int AS n FROM self_goods g
        WHERE ${where}
          AND EXISTS (SELECT 1 FROM shop_sku s WHERE s.goods_id = g.goods_id AND s.status = 'on')`,
      params,
    )).rows[0]?.n ?? 0);

    params.push(size, (page - 1) * size);
    const { rows } = await pool.query(
      `SELECT g.goods_id, g.title, g.main_imgs, g.brand, g.delivery_type, g.sales_count, g.category_id,
              MIN(s.price)::float AS min_price,
              MAX(s.price)::float AS max_price,
              COALESCE(SUM(s.stock - s.locked_stock), 0)::int AS available,
              COUNT(s.sku_id)::int AS sku_count
         FROM self_goods g
         JOIN shop_sku s ON s.goods_id = g.goods_id AND s.status = 'on'
        WHERE ${where}
        GROUP BY g.goods_id
       HAVING COALESCE(SUM(s.stock - s.locked_stock), 0) > 0
        ORDER BY g.sort DESC, g.sales_count DESC, g.goods_id DESC
        LIMIT $${params.length - 1}::int OFFSET $${params.length}::int`,
      params,
    );
    res.json({
      ok: true,
      data: {
        page, size, total,
        items: rows.map((r) => ({
          goods_id: Number(r.goods_id),
          title: String(r.title),
          image: Array.isArray(r.main_imgs) ? String(r.main_imgs[0] ?? '') : '',
          brand: r.brand ?? '',
          delivery_type: String(r.delivery_type),
          category_id: r.category_id === null ? null : Number(r.category_id),
          sales_count: Number(r.sales_count ?? 0),
          min_price: Number(r.min_price ?? 0),
          max_price: Number(r.max_price ?? 0),
          available: Number(r.available ?? 0),
          sku_count: Number(r.sku_count ?? 0),
        })),
      },
    });
  } catch (e) { next(e); }
});

/** GET /api/shop/goods/:id?site= → 商品详情 + 可售 SKU 列表 */
shopRouter.get('/goods/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const siteId = await siteIdByCode(req.query.site);
    const goodsId = Number(req.params.id);
    if (!Number.isInteger(goodsId) || goodsId <= 0) throw new HttpError(400, '商品 ID 不合法', 'BAD_PARAM');
    const { rows } = await pool.query(
      `SELECT goods_id, title, main_imgs, detail_imgs, detail_html, video_url, brand,
              delivery_type, sales_count, category_id, freight_tpl_id
         FROM self_goods
        WHERE goods_id = $1::bigint AND site_id = $2::uuid AND shop_status = 'on' AND status = 'on' LIMIT 1`,
      [goodsId, siteId],
    );
    if (!rows[0]) throw new HttpError(404, '商品不存在或已下架', 'GOODS_NOT_FOUND');
    const g = rows[0];
    const { rows: skus } = await pool.query(
      `SELECT sku_id, sku_code, spec, spec_values, price::float AS price, market_price::float AS market_price,
              stock - locked_stock AS available, image, weight_gram
         FROM shop_sku
        WHERE goods_id = $1::bigint AND site_id = $2::uuid AND status = 'on'
        ORDER BY sku_id`,
      [goodsId, siteId],
    );
    res.json({
      ok: true,
      data: {
        goods_id: Number(g.goods_id),
        title: String(g.title),
        main_imgs: g.main_imgs ?? [],
        detail_imgs: g.detail_imgs ?? [],
        detail_html: g.detail_html ?? '',
        video_url: g.video_url ?? '',
        brand: g.brand ?? '',
        delivery_type: String(g.delivery_type),
        sales_count: Number(g.sales_count ?? 0),
        category_id: g.category_id === null ? null : Number(g.category_id),
        freight_tpl_id: g.freight_tpl_id === null ? null : Number(g.freight_tpl_id),
        skus: skus.map((s) => ({
          sku_id: Number(s.sku_id),
          sku_code: s.sku_code ?? '',
          spec: String(s.spec),
          spec_values: s.spec_values ?? {},
          price: Number(s.price),
          market_price: s.market_price === null ? null : Number(s.market_price),
          available: Math.max(0, Number(s.available ?? 0)),
          image: s.image ?? '',
          weight_gram: Number(s.weight_gram ?? 0),
        })),
      },
    });
  } catch (e) { next(e); }
});

// ────────────────────────────────────────────────────────────────────────
// 购物车（需登录）
// ────────────────────────────────────────────────────────────────────────

/** GET /api/me/shop/cart → 购物车（含可售校验；失效商品标记 invalid 不静默删除） */
shopUserRouter.get('/cart', requireUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { rows } = await pool.query(
      `SELECT c.cart_id, c.num, c.selected, c.goods_id, c.sku_id,
              g.title, g.main_imgs, g.delivery_type, g.status AS goods_status, g.shop_status,
              s.spec, s.price::float AS price, s.status AS sku_status,
              s.stock - s.locked_stock AS available
         FROM shop_cart c
         JOIN self_goods g ON g.goods_id = c.goods_id
         JOIN shop_sku s ON s.sku_id = c.sku_id
        WHERE c.user_id = $1::bigint AND c.site_id = $2::uuid
        ORDER BY c.updated_at DESC, c.cart_id DESC`,
      [req.user!.userId, req.user!.siteId],
    );
    const items = rows.map((r) => {
      const available = Math.max(0, Number(r.available ?? 0));
      const onSale = String(r.goods_status) === 'on' && String(r.shop_status) === 'on' && String(r.sku_status) === 'on';
      const invalid = !onSale || available <= 0;
      return {
        cart_id: Number(r.cart_id),
        goods_id: Number(r.goods_id),
        sku_id: Number(r.sku_id),
        title: String(r.title),
        spec: String(r.spec),
        image: Array.isArray(r.main_imgs) ? String(r.main_imgs[0] ?? '') : '',
        delivery_type: String(r.delivery_type),
        price: Number(r.price),
        num: Number(r.num),
        selected: Boolean(r.selected),
        available,
        invalid,
        invalid_reason: !onSale ? '已下架' : available <= 0 ? '已售罄' : '',
        amount: Math.round(Number(r.price) * Number(r.num) * 100) / 100,
      };
    });
    const valid = items.filter((i) => !i.invalid);
    const selected = valid.filter((i) => i.selected);
    res.json({
      ok: true,
      data: {
        items,
        summary: {
          total: items.length,
          selected_count: selected.length,
          selected_qty: selected.reduce((n, i) => n + i.num, 0),
          goods_amount: Math.round(selected.reduce((n, i) => n + i.amount, 0) * 100) / 100,
        },
      },
    });
  } catch (e) { next(e); }
});

/** POST /api/me/shop/cart {goods_id, sku_id, num} → 加入购物车（同 SKU 累加，上限 999 且不超过可售） */
shopUserRouter.post('/cart', requireUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const siteId = req.user!.siteId;
    const userId = req.user!.userId;
    const skuId = Number(req.body?.sku_id);
    const num = clampInt(req.body?.num ?? 1, 1, 999, 1);
    if (!Number.isInteger(skuId) || skuId <= 0) throw new HttpError(400, 'SKU 参数不合法', 'BAD_PARAM');

    const { rows } = await pool.query(
      `SELECT s.sku_id, s.goods_id, s.status AS sku_status, s.stock - s.locked_stock AS available,
              g.status AS goods_status, g.shop_status, g.title, s.spec
         FROM shop_sku s JOIN self_goods g ON g.goods_id = s.goods_id
        WHERE s.sku_id = $1::bigint AND s.site_id = $2::uuid LIMIT 1`,
      [skuId, siteId],
    );
    const r = rows[0];
    if (!r) throw new HttpError(404, '商品不存在', 'SKU_NOT_FOUND');
    if (String(r.sku_status) !== 'on' || String(r.goods_status) !== 'on' || String(r.shop_status) !== 'on') {
      throw new HttpError(409, '商品已下架', 'GOODS_OFF');
    }
    const available = Math.max(0, Number(r.available ?? 0));
    if (available <= 0) throw new HttpError(409, '商品已售罄', 'OUT_OF_STOCK');

    const { rows: up } = await pool.query(
      `INSERT INTO shop_cart (site_id, user_id, goods_id, sku_id, num)
       VALUES ($1::uuid, $2::bigint, $3::bigint, $4::bigint, $5::int)
       ON CONFLICT (user_id, sku_id) DO UPDATE
         SET num = LEAST(shop_cart.num + EXCLUDED.num, 999), updated_at = now()
       RETURNING cart_id, num`,
      [siteId, userId, Number(r.goods_id), skuId, Math.min(num, available)],
    );
    res.json({ ok: true, data: { cart_id: Number(up[0].cart_id), num: Number(up[0].num), available } });
  } catch (e) { next(e); }
});

/** PATCH /api/me/shop/cart/:id {num?, selected?} */
shopUserRouter.patch('/cart/:id', requireUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const cartId = Number(req.params.id);
    if (!Number.isInteger(cartId) || cartId <= 0) throw new HttpError(400, '参数不合法', 'BAD_PARAM');
    const sets: string[] = [];
    const params: unknown[] = [cartId, req.user!.userId];
    if (req.body?.num !== undefined) {
      params.push(clampInt(req.body.num, 1, 999, 1));
      sets.push(`num = $${params.length}::int`);
    }
    if (req.body?.selected !== undefined) {
      params.push(Boolean(req.body.selected));
      sets.push(`selected = $${params.length}::boolean`);
    }
    if (!sets.length) throw new HttpError(400, '无可更新字段', 'BAD_REQUEST');
    const { rows } = await pool.query(
      `UPDATE shop_cart SET ${sets.join(', ')}, updated_at = now()
        WHERE cart_id = $1::bigint AND user_id = $2::bigint RETURNING cart_id, num, selected`,
      params,
    );
    if (!rows[0]) throw new HttpError(404, '购物车项不存在', 'CART_NOT_FOUND');
    res.json({ ok: true, data: { cart_id: Number(rows[0].cart_id), num: Number(rows[0].num), selected: Boolean(rows[0].selected) } });
  } catch (e) { next(e); }
});

/** DELETE /api/me/shop/cart/:id → 删除单项；DELETE /api/me/shop/cart?selected=1 → 清空选中（不带参数=清空全部） */
shopUserRouter.delete('/cart/:id', requireUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const cartId = Number(req.params.id);
    const { rowCount } = await pool.query(
      `DELETE FROM shop_cart WHERE cart_id = $1::bigint AND user_id = $2::bigint`,
      [cartId, req.user!.userId],
    );
    res.json({ ok: true, data: { deleted: rowCount } });
  } catch (e) { next(e); }
});

shopUserRouter.delete('/cart', requireUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const onlySelected = String(req.query.selected ?? '') === '1';
    const sql = onlySelected
      ? `DELETE FROM shop_cart WHERE user_id = $1::bigint AND site_id = $2::uuid AND selected = TRUE`
      : `DELETE FROM shop_cart WHERE user_id = $1::bigint AND site_id = $2::uuid`;
    const { rowCount } = await pool.query(sql, [req.user!.userId, req.user!.siteId]);
    res.json({ ok: true, data: { deleted: rowCount } });
  } catch (e) { next(e); }
});

/** POST /api/me/shop/cart/select-all {selected} → 全选/全不选（失效项跳过） */
shopUserRouter.post('/cart/select-all', requireUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const selected = Boolean(req.body?.selected ?? true);
    const { rowCount } = await pool.query(
      `UPDATE shop_cart SET selected = $3::boolean, updated_at = now()
        WHERE user_id = $1::bigint AND site_id = $2::uuid`,
      [req.user!.userId, req.user!.siteId, selected],
    );
    res.json({ ok: true, data: { updated: rowCount, selected } });
  } catch (e) { next(e); }
});

// ────────────────────────────────────────────────────────────────────────
// 下单
// ────────────────────────────────────────────────────────────────────────

/** 从请求里取下单条目：直接给 items，或 from_cart=1 取购物车选中项 */
async function resolveItems(req: Request): Promise<Array<{ sku_id: number; num: number }>> {
  if (String(req.body?.from_cart ?? '') === '1' || req.body?.from_cart === true) {
    const { rows } = await pool.query(
      `SELECT sku_id, num FROM shop_cart
        WHERE user_id = $1::bigint AND site_id = $2::uuid AND selected = TRUE ORDER BY cart_id`,
      [req.user!.userId, req.user!.siteId],
    );
    if (!rows.length) throw new HttpError(400, '购物车没有选中商品', 'CART_EMPTY');
    return rows.map((r) => ({ sku_id: Number(r.sku_id), num: Number(r.num) }));
  }
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!items.length) throw new HttpError(400, '请选择要购买的商品', 'BAD_ITEMS');
  return items.map((i: Record<string, unknown>) => ({ sku_id: Number(i.sku_id), num: Number(i.num ?? 1) }));
}

/** POST /api/shop/checkout → 试算（不落库；与真实下单同一段代码，保证金额一致） */
shopRouter.post('/checkout', requireUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const items = await resolveItems(req);
    const quote = await quoteShopOrder({
      siteId: req.user!.siteId,
      userId: req.user!.userId,
      platform: 'mini',
      items,
      userCouponId: Number(req.body?.user_coupon_id) > 0 ? Number(req.body.user_coupon_id) : undefined,
      addressId: Number(req.body?.address_id) > 0 ? Number(req.body.address_id) : undefined,
    });
    res.json({ ok: true, data: quote });
  } catch (e) { next(e); }
});

/** POST /api/shop/orders → 多商品下单（单事务；成功后可调上游 /api/trade/orders/:id/pay 支付） */
shopRouter.post('/orders', requireUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const items = await resolveItems(req);
    const platform = String(req.body?.platform ?? 'mini') === 'h5' ? 'h5' : 'mini';
    const result = await createShopOrder({
      siteId: req.user!.siteId,
      userId: req.user!.userId,
      platform,
      items,
      userCouponId: Number(req.body?.user_coupon_id) > 0 ? Number(req.body.user_coupon_id) : undefined,
      addressId: Number(req.body?.address_id) > 0 ? Number(req.body.address_id) : undefined,
    });
    res.json({ ok: true, data: result });
  } catch (e) { next(e); }
});

/** POST /api/shop/orders/:id/cancel → 取消（复用上游关单语义 + 释放商城库存占用） */
shopRouter.post('/orders/:id/cancel', requireUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, '订单 ID 不合法', 'BAD_PARAM');
    const { rows } = await pool.query(
      `SELECT id, platform_status FROM "order"
        WHERE id = $1::bigint AND buyer_id = $2::bigint AND site_id = $3::uuid AND provider = 'self' LIMIT 1`,
      [id, req.user!.userId, req.user!.siteId],
    );
    if (!rows[0]) throw new HttpError(404, '订单不存在', 'ORDER_NOT_FOUND');
    if (String(rows[0].platform_status) !== 'created') throw new HttpError(409, '订单状态不可取消', 'BAD_ORDER_STATE');
    const { rows: closed } = await pool.query(
      `UPDATE "order" SET platform_status = 'closed' WHERE id = $1::bigint AND platform_status = 'created' RETURNING id`,
      [id],
    );
    if (!closed.length) throw new HttpError(409, '订单状态不可取消', 'BAD_ORDER_STATE');
    // 退券（与上游 cancel 同语义）
    await pool.query(
      `UPDATE user_coupon SET status = 'unused', used_order_id = NULL
        WHERE used_order_id = $1::bigint AND status = 'used'`,
      [id],
    );
    const released = await releaseShopOrderStock(id, 'order_cancel');
    res.json({ ok: true, data: { order_id: id, released_skus: released } });
  } catch (e) { next(e); }
});

/** GET /api/shop/orders?page=&size= → 我的商城订单 */
shopRouter.get('/orders', requireUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = clampInt(req.query.page, 1, 10_000, 1);
    const size = clampInt(req.query.size, 1, 50, 10);
    const status = String(req.query.status ?? '').trim();
    const params: unknown[] = [req.user!.userId, req.user!.siteId];
    let where = `o.buyer_id = $1::bigint AND o.site_id = $2::uuid AND o.provider = 'self'
                   AND EXISTS (SELECT 1 FROM shop_order_item i WHERE i.order_id = o.id)`;
    if (['created', 'paid', 'settled', 'closed'].includes(status)) {
      params.push(status);
      where += ` AND o.platform_status = $${params.length}::varchar`;
    }
    const total = Number((await pool.query(`SELECT COUNT(*)::int AS n FROM "order" o WHERE ${where}`, params)).rows[0]?.n ?? 0);
    params.push(size, (page - 1) * size);
    const { rows } = await pool.query(
      `SELECT o.id, o.order_sn, o.pay_price::float AS pay_price, o.platform_status, o.fulfill_status,
              o.refund_status, o.fulfillment, o.created_at, o.paid_at,
              (SELECT COUNT(*)::int FROM shop_order_item i WHERE i.order_id = o.id) AS item_count,
              (SELECT COALESCE(SUM(i.num),0)::int FROM shop_order_item i WHERE i.order_id = o.id) AS total_qty
         FROM "order" o WHERE ${where}
        ORDER BY o.id DESC LIMIT $${params.length - 1}::int OFFSET $${params.length}::int`,
      params,
    );
    res.json({
      ok: true,
      data: {
        page, size, total,
        items: rows.map((r) => ({
          order_id: Number(r.id),
          order_sn: String(r.order_sn),
          pay_price: Number(r.pay_price),
          platform_status: String(r.platform_status),
          fulfill_status: String(r.fulfill_status),
          refund_status: String(r.refund_status),
          fulfillment: String(r.fulfillment),
          item_count: Number(r.item_count),
          total_qty: Number(r.total_qty),
          created_at: r.created_at,
          paid_at: r.paid_at,
        })),
      },
    });
  } catch (e) { next(e); }
});

/** GET /api/shop/orders/:id → 订单详情（含订单行） */
shopRouter.get('/orders/:id', requireUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await pool.query(
      `SELECT o.id, o.order_sn, o.pay_price::float AS pay_price, o.commission::float AS commission,
              o.cost_amount::float AS cost_amount, o.coupon_discount::float AS coupon_discount,
              o.platform_status, o.fulfill_status, o.refund_status, o.fulfillment,
              o.address_snapshot, o.goods_snapshot, o.created_at, o.paid_at
         FROM "order" o
        WHERE o.id = $1::bigint AND o.buyer_id = $2::bigint AND o.site_id = $3::uuid AND o.provider = 'self' LIMIT 1`,
      [id, req.user!.userId, req.user!.siteId],
    );
    if (!rows[0]) throw new HttpError(404, '订单不存在', 'ORDER_NOT_FOUND');
    const { rows: items } = await pool.query(
      `SELECT item_id, goods_id, sku_id, title, spec, image, unit_price::float AS unit_price,
              num, amount::float AS amount, refunded_num, refund_amount::float AS refund_amount
         FROM shop_order_item WHERE order_id = $1::bigint ORDER BY item_id`,
      [id],
    );
    res.json({
      ok: true,
      data: {
        order: {
          order_id: Number(rows[0].id),
          order_sn: String(rows[0].order_sn),
          pay_price: Number(rows[0].pay_price),
          commission: Number(rows[0].commission),
          cost_amount: rows[0].cost_amount === null ? null : Number(rows[0].cost_amount),
          coupon_discount: Number(rows[0].coupon_discount ?? 0),
          platform_status: String(rows[0].platform_status),
          fulfill_status: String(rows[0].fulfill_status),
          refund_status: String(rows[0].refund_status),
          fulfillment: String(rows[0].fulfillment),
          address: rows[0].address_snapshot ?? {},
          goods_snapshot: rows[0].goods_snapshot ?? {},
          created_at: rows[0].created_at,
          paid_at: rows[0].paid_at,
        },
        items: items.map((i) => ({
          item_id: Number(i.item_id),
          goods_id: i.goods_id === null ? null : Number(i.goods_id),
          sku_id: i.sku_id === null ? null : Number(i.sku_id),
          title: String(i.title),
          spec: String(i.spec),
          image: i.image ?? '',
          unit_price: Number(i.unit_price),
          num: Number(i.num),
          amount: Number(i.amount),
          refunded_num: Number(i.refunded_num),
          refund_amount: Number(i.refund_amount),
        })),
      },
    });
  } catch (e) { next(e); }
});

// ────────────────────────────────────────────────────────────────────────
// 确认收货 + 售后（阶段 4）
// ────────────────────────────────────────────────────────────────────────

/** POST /api/shop/orders/:id/receive → 确认收货（快递单；触发返利结算，幂等） */
shopRouter.post('/orders/:id/receive', requireUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, '订单 ID 不合法', 'BAD_PARAM');
    const out = await confirmReceive(id, req.user!.userId, req.user!.siteId);
    res.json({ ok: true, data: { order_id: id, ...out } });
  } catch (e) { next(e); }
});

/** POST /api/shop/orders/:id/refund {item_id?, num?, type?, reason?, description?, images?} → 申请售后 */
shopRouter.post('/orders/:id/refund', requireUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    if (!Number.isInteger(id) || id <= 0) throw new HttpError(400, '订单 ID 不合法', 'BAD_PARAM');
    const out = await applyRefund({
      siteId: req.user!.siteId,
      userId: req.user!.userId,
      orderId: id,
      itemId: Number(req.body?.item_id) > 0 ? Number(req.body.item_id) : undefined,
      num: Number(req.body?.num) > 0 ? Number(req.body.num) : undefined,
      type: String(req.body?.type ?? 'refund') === 'return' ? 'return' : 'refund',
      reason: req.body?.reason,
      description: req.body?.description,
      images: req.body?.images,
    });
    res.json({ ok: true, data: out });
  } catch (e) { next(e); }
});

/** GET /api/shop/refunds?page=&size= → 我的售后单 */
shopRouter.get('/refunds', requireUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const page = clampInt(req.query.page, 1, 10_000, 1);
    const size = clampInt(req.query.size, 1, 50, 10);
    const total = Number((await pool.query(
      `SELECT COUNT(*)::int AS n FROM shop_refund WHERE user_id = $1::bigint AND site_id = $2::uuid`,
      [req.user!.userId, req.user!.siteId],
    )).rows[0]?.n ?? 0);
    const { rows } = await pool.query(
      `SELECT r.refund_id, r.refund_sn, r.order_id, r.type, r.amount::float AS amount, r.num, r.status,
              r.reason, r.fail_reason, r.applied_at, r.finished_at, o.order_sn
         FROM shop_refund r JOIN "order" o ON o.id = r.order_id
        WHERE r.user_id = $1::bigint AND r.site_id = $2::uuid
        ORDER BY r.refund_id DESC LIMIT $3::int OFFSET $4::int`,
      [req.user!.userId, req.user!.siteId, size, (page - 1) * size],
    );
    res.json({
      ok: true,
      data: {
        page, size, total,
        items: rows.map((r) => ({
          refund_id: Number(r.refund_id), refund_sn: String(r.refund_sn), order_id: Number(r.order_id),
          order_sn: String(r.order_sn), type: String(r.type), amount: Number(r.amount), num: Number(r.num),
          status: String(r.status), reason: r.reason ?? '', fail_reason: r.fail_reason ?? '',
          applied_at: r.applied_at, finished_at: r.finished_at,
        })),
      },
    });
  } catch (e) { next(e); }
});

/** GET /api/shop/refunds/:id → 售后详情 */
shopRouter.get('/refunds/:id', requireUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    const { rows } = await pool.query(
      `SELECT r.*, o.order_sn FROM shop_refund r JOIN "order" o ON o.id = r.order_id
        WHERE r.refund_id = $1::bigint AND r.user_id = $2::bigint AND r.site_id = $3::uuid LIMIT 1`,
      [id, req.user!.userId, req.user!.siteId],
    );
    if (!rows[0]) throw new HttpError(404, '售后单不存在', 'REFUND_NOT_FOUND');
    const r = rows[0];
    res.json({
      ok: true,
      data: {
        refund_id: Number(r.refund_id), refund_sn: String(r.refund_sn), order_id: Number(r.order_id),
        order_sn: String(r.order_sn), item_id: r.item_id === null ? null : Number(r.item_id),
        type: String(r.type), reason: r.reason ?? '', description: r.description ?? '', images: r.images ?? [],
        amount: Number(r.amount), num: Number(r.num), status: String(r.status),
        wx_refund_state: r.wx_refund_state ?? '', fail_reason: r.fail_reason ?? '',
        admin_remark: r.admin_remark ?? '',
        applied_at: r.applied_at, audited_at: r.audited_at, finished_at: r.finished_at,
      },
    });
  } catch (e) { next(e); }
});

/** POST /api/shop/refunds/:id/cancel → 撤销申请（仅 applied） */
shopRouter.post('/refunds/:id/cancel', requireUser, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const id = Number(req.params.id);
    const ok = await cancelRefund(id, req.user!.userId);
    if (!ok) throw new HttpError(409, '售后单状态不可撤销', 'BAD_REFUND_STATE');
    res.json({ ok: true, data: { refund_id: id, status: 'canceled' } });
  } catch (e) { next(e); }
});
