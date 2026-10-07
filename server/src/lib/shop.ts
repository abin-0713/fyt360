/**
 * 商城（二开）核心逻辑 —— 多商品下单 / 支付后扣减 / 取消释放 / 超时兜底
 *
 * 与上游的关系（重要）：
 *   · 上游 trade.ts 的"单商品立即购买"链路**完全不动**，本模块只服务 shop_* 表的多商品订单；
 *   · 支付复用上游 `POST /api/trade/orders/:id/pay`（预支付）与微信回调，回调里 settleSelfOrder
 *     末尾挂一行 `shopOnOrderPaid()` 钩子（上游文件仅此一处改动，冲突面最小）；
 *   · 关单复用上游 ordersweep / cancel 端点（它们只认 platform_status='created'），
 *     本模块的 sweepShopOrders 只负责"把已关单的库存占用释放掉"，不抢关单权。
 *
 * 库存三段语义（可售 = stock - locked_stock）：
 *   下单     → locked_stock += num，流水 reason='order_create'
 *   支付成功 → stock -= num、locked_stock -= num、sales += num，流水 reason='order_pay'
 *   关单释放 → locked_stock -= num，流水 reason='order_cancel'
 *   退款回补（阶段4）→ stock += num，流水 reason='refund'
 *
 * 幂等设计：所有"扣/放"动作以 shop_stock_log.ref 为幂等键
 *   （ref = 'create:<order_sn>' / 'pay:<order_sn>' / 'cancel:<order_sn>'），
 *   重复调用（微信回调重试、定时任务重复跑）不会二次扣减。
 */
import crypto from 'node:crypto';
import { pool } from '../db/client.js';
import { HttpError } from '../middleware/errors.js';

const round2 = (n: number): number => Math.round(n * 100) / 100;
const round4 = (n: number): number => Math.round(n * 10000) / 10000;

type Row = Record<string, unknown>;
export interface Queryable {
  query(sql: string, params?: unknown[]): Promise<{ rows: Row[]; rowCount: number }>;
}

/**
 * 事务包装：TCP 直连模式用真事务；CloudBase HTTP 网关模式（无会话事务）降级为顺序执行。
 * 宝塔自建部署是 TCP 模式 → 走真事务（并发下单不超卖的前提）。
 */
export async function withTx<T>(fn: (q: Queryable) => Promise<T>): Promise<T> {
  const maybePool = pool as unknown as { connect?: () => Promise<unknown> };
  if (typeof maybePool.connect !== 'function') {
    // 网关模式：无 BEGIN/COMMIT，靠条件 UPDATE + 幂等键兜底
    return fn(pool as unknown as Queryable);
  }
  const client = (await maybePool.connect()) as {
    query: Queryable['query'];
    release: () => void;
  };
  try {
    await client.query('BEGIN');
    const out = await fn(client);
    await client.query('COMMIT');
    return out;
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch { /* 回滚失败不掩盖原错误 */ }
    throw e;
  } finally {
    client.release();
  }
}

export interface SkuLockRow {
  sku_id: number;
  goods_id: number;
  price: number;
  cost_price: number | null;
  stock: number;
  locked_stock: number;
  status: string;
  spec: string;
  weight_gram: number;
  title: string;
  main_imgs: unknown;
  goods_status: string;
  shop_status: string;
  delivery_type: string;
  freight_tpl_id: number | null;
}

export interface CreateOrderResult {
  order_id: number;
  order_sn: string;
  goods_amount: number;
  freight: number;
  discount: number;
  pay_price: number;
  item_count: number;
  total_qty: number;
  delivery_type: string;
}

export interface CreateOrderInput {
  siteId: string;
  userId: number;
  platform: 'mini' | 'h5';
  items: Array<{ sku_id: number; num: number }>;
  userCouponId?: number;
  addressId?: number;
  /** 从购物车下单时，成功后清掉这些 SKU 的购物车行 */
  clearCart?: boolean;
  /** 试算模式：走完全相同的校验/算钱逻辑，但在写库前抛 DryRun 回滚（保证预览金额==真实金额） */
  dryRun?: boolean;
}

/** 试算信号：不是错误，是"算完了，回滚吧" */
class DryRun extends Error {
  constructor(public payload: CreateOrderResult) { super('DRY_RUN'); }
}

/** 运费：按模板分组计算（按件/按重 + 满额包邮），同模板合并；虚拟/到店不产生运费 */
function freightOf(
  tpl: { charge_mode: string; free_over: number; first_unit: number; first_fee: number; add_unit: number; add_fee: number } | null,
  goodsAmount: number,
  qty: number,
  weightGram: number,
): number {
  if (!tpl) return 0;
  if (tpl.free_over > 0 && goodsAmount >= tpl.free_over) return 0;
  if (tpl.first_fee <= 0 && tpl.add_fee <= 0) return 0;
  const unit = tpl.charge_mode === 'weight' ? Math.ceil(weightGram / 1000) : qty; // 按重量的单位是 kg（向上取整）
  const first = Math.max(1, tpl.first_unit);
  if (unit <= first) return round2(tpl.first_fee);
  const extra = Math.ceil((unit - first) / Math.max(1, tpl.add_unit));
  return round2(tpl.first_fee + extra * tpl.add_fee);
}

/**
 * 多商品下单（单事务）：校验 → 算钱 → 建单 → 建订单行 → 锁库存 → 锁券 → 清购物车
 * 任何一步失败整单回滚，不会留下"扣了库存没订单"的脏数据。
 */
export async function createShopOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
  // 入参规整：同 SKU 合并数量
  const merged = new Map<number, number>();
  for (const it of input.items ?? []) {
    const skuId = Number(it?.sku_id);
    const num = Number(it?.num);
    if (!Number.isInteger(skuId) || skuId <= 0) throw new HttpError(400, 'SKU 参数不合法', 'BAD_ITEMS');
    if (!Number.isInteger(num) || num <= 0 || num > 999) throw new HttpError(400, '购买数量须为 1–999', 'BAD_NUM');
    merged.set(skuId, (merged.get(skuId) ?? 0) + num);
  }
  if (merged.size === 0) throw new HttpError(400, '请先选择商品', 'BAD_ITEMS');
  if (merged.size > 50) throw new HttpError(400, '单笔订单最多 50 种商品', 'TOO_MANY_ITEMS');
  const skuIds = [...merged.keys()];

  return withTx(async (q) => {
    // ① 锁定 SKU 行（FOR UPDATE：并发下单在此串行化，这是不超卖的第一道闸）
    const { rows } = await q.query(
      `SELECT s.sku_id, s.goods_id, s.price::float AS price, s.cost_price::float AS cost_price,
              s.stock, s.locked_stock, s.status, s.spec, s.weight_gram,
              g.title, g.main_imgs, g.status AS goods_status, g.shop_status,
              g.delivery_type, g.freight_tpl_id
         FROM shop_sku s
         JOIN self_goods g ON g.goods_id = s.goods_id
        WHERE s.sku_id = ANY($1::bigint[]) AND s.site_id = $2::uuid
        FOR UPDATE OF s`,
      [skuIds, input.siteId],
    );
    if (rows.length !== skuIds.length) {
      throw new HttpError(404, '部分商品不存在或不属于当前站点', 'SKU_NOT_FOUND');
    }
    // ⛔ pg 对 BIGINT/NUMERIC 一律返回**字符串**：不归一化就会 merged.get(字符串) 落空 →
    //    数量 undefined → 金额算出 NaN → 而 PG 的 numeric 接受 NaN 字面量，会静默落一张 NaN 订单。
    //    钱路径上这类"静默脏数据"比报错危险得多，故在进入计算前统一 Number()。
    const skus: SkuLockRow[] = rows.map((r) => ({
      sku_id: Number(r.sku_id),
      goods_id: Number(r.goods_id),
      price: Number(r.price),
      cost_price: r.cost_price === null || r.cost_price === undefined ? null : Number(r.cost_price),
      stock: Number(r.stock),
      locked_stock: Number(r.locked_stock),
      status: String(r.status),
      spec: String(r.spec ?? '默认'),
      weight_gram: Number(r.weight_gram ?? 0),
      title: String(r.title),
      main_imgs: r.main_imgs,
      goods_status: String(r.goods_status),
      shop_status: String(r.shop_status),
      delivery_type: String(r.delivery_type),
      freight_tpl_id: r.freight_tpl_id === null || r.freight_tpl_id === undefined ? null : Number(r.freight_tpl_id),
    }));

    let goodsAmount = 0;
    let totalQty = 0;
    let totalWeight = 0;
    let costSum = 0;
    let costComplete = true;
    const deliveryTypes = new Set<string>();
    const tplGroups = new Map<number, { qty: number; weight: number; amount: number }>();

    for (const s of skus) {
      const num = merged.get(s.sku_id)!;
      if (s.status !== 'on' || s.goods_status !== 'on' || s.shop_status !== 'on') {
        throw new HttpError(409, `「${s.title} ${s.spec}」已下架`, 'GOODS_OFF');
      }
      const available = s.stock - s.locked_stock;
      if (available < num) {
        throw new HttpError(409, `「${s.title} ${s.spec}」库存不足（可售 ${Math.max(0, available)} 件）`, 'OUT_OF_STOCK');
      }
      if (!(s.price > 0)) throw new HttpError(500, `SKU 价格异常：${s.title}`, 'BAD_SKU_PRICE');
      deliveryTypes.add(s.delivery_type);
      const line = round4(s.price * num);
      goodsAmount += line;
      totalQty += num;
      totalWeight += s.weight_gram * num;
      if (s.cost_price === null || s.cost_price === undefined) costComplete = false;
      else costSum += s.cost_price * num;
      if (s.freight_tpl_id) {
        const g = tplGroups.get(s.freight_tpl_id) ?? { qty: 0, weight: 0, amount: 0 };
        g.qty += num; g.weight += s.weight_gram * num; g.amount += line;
        tplGroups.set(s.freight_tpl_id, g);
      }
    }
    goodsAmount = round2(goodsAmount);
    if (deliveryTypes.size > 1) {
      throw new HttpError(400, '实物、到店、虚拟商品不能合并下单，请分开结算', 'MIXED_DELIVERY');
    }
    const deliveryType = [...deliveryTypes][0];

    // ② 运费（虚拟/到店为 0；同一模板合并计算）
    let freight = 0;
    if (deliveryType === 'express' && tplGroups.size > 0) {
      const tplIds = [...tplGroups.keys()];
      const { rows: tpls } = await q.query(
        `SELECT tpl_id, charge_mode, free_over::float AS free_over, first_unit, first_fee::float AS first_fee,
                add_unit, add_fee::float AS add_fee
           FROM shop_freight_template WHERE tpl_id = ANY($1::bigint[]) AND site_id = $2::uuid AND status = 'on'`,
        [tplIds, input.siteId],
      );
      const byId = new Map((tpls as Row[]).map((t) => [Number(t.tpl_id), t]));  // tpl_id 由 SQL 端 ::bigint 返回字符串，这里统一 Number
      for (const [tplId, g] of tplGroups) {
        const t = byId.get(tplId);
        if (!t) continue;
        freight += freightOf(
          {
            charge_mode: String(t.charge_mode), free_over: Number(t.free_over),
            first_unit: Number(t.first_unit), first_fee: Number(t.first_fee),
            add_unit: Number(t.add_unit), add_fee: Number(t.add_fee),
          },
          round2(g.amount), g.qty, g.weight,
        );
      }
      freight = round2(freight);
    }

    // ③ 收货地址（快递单必需；快照进订单，商品改地址簿不影响历史单）
    let addressSnapshot: Row = {};
    if (deliveryType === 'express') {
      const addrId = Number(input.addressId);
      if (!Number.isInteger(addrId) || addrId <= 0) {
        throw new HttpError(400, '快递商品需要选择收货地址', 'ADDRESS_REQUIRED');
      }
      const { rows: addr } = await q.query(
        `SELECT id, name, phone, region, detail, tag FROM user_address
          WHERE id = $1::bigint AND user_id = $2::bigint LIMIT 1`,
        [addrId, input.userId],
      );
      if (!addr[0]) throw new HttpError(404, '收货地址不存在', 'ADDRESS_NOT_FOUND');
      addressSnapshot = addr[0];
    }

    // ④ 优惠券（只抵商品金额，不抵运费；门槛/有效期/归属三重校验）
    let discount = 0;
    let couponId: number | null = null;
    let couponName = '';
    if (Number(input.userCouponId) > 0) {
      const { rows: ucs } = await q.query(
        `SELECT uc.id, c.name, c.type, c.amount::float AS amount, c.threshold::float AS threshold, uc.expire_at
           FROM user_coupon uc JOIN coupon c ON c.id = uc.coupon_id
          WHERE uc.id = $1::bigint AND uc.user_id = $2::bigint AND uc.status = 'unused' LIMIT 1`,
        [Number(input.userCouponId), input.userId],
      );
      const uc = ucs[0];
      if (!uc) throw new HttpError(409, '优惠券状态已变化，请重新选择', 'COUPON_TAKEN');
      if (uc.expire_at && new Date(String(uc.expire_at)).getTime() < Date.now()) {
        throw new HttpError(409, '优惠券已过期', 'COUPON_EXPIRED');
      }
      const threshold = Number(uc.threshold ?? 0);
      if (threshold > 0 && goodsAmount < threshold) {
        throw new HttpError(409, `该券满 ¥${threshold} 可用`, 'COUPON_THRESHOLD');
      }
      const type = String(uc.type);
      const amount = Number(uc.amount ?? 0);
      if (type === 'cash_off') discount = Math.min(amount, goodsAmount);
      else if (type === 'discount') discount = goodsAmount * (1 - amount / 10);
      else discount = goodsAmount; // exchange = 免费兑换
      discount = Math.max(0, Math.min(round2(discount), goodsAmount));
      couponId = Number(uc.id);
      couponName = String(uc.name ?? '');
    }

    // ⑤ 实付（微信不接受 0 元单 → 下限 0.01）
    let payPrice = round2(goodsAmount + freight - discount);
    if (payPrice < 0.01) payPrice = 0.01;
    discount = round2(goodsAmount + freight - payPrice);
    if (discount <= 0) { discount = 0; couponId = null; couponName = ''; }

    // 钱路径兜底：任何非有限数（NaN/Infinity）都必须当场失败，而不是静默写库
    if (![goodsAmount, freight, discount, payPrice, totalQty].every((n) => Number.isFinite(n))) {
      throw new HttpError(500, '订单金额计算异常，已中止', 'BAD_AMOUNT');
    }
    const costAmount = costComplete && costSum > 0 ? round2(costSum) : null;
    const orderSn = `SHOP_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}_${crypto.randomBytes(6).toString('hex').toUpperCase()}`;
    const first = skus[0];
    const firstImg = Array.isArray(first.main_imgs) ? String((first.main_imgs as string[])[0] ?? '') : '';

    // 试算：金额已在上面算完，这里直接回滚返回（不写任何行）
    const preview: CreateOrderResult = {
      order_id: 0, order_sn: orderSn, goods_amount: goodsAmount, freight, discount,
      pay_price: payPrice, item_count: skus.length, total_qty: totalQty, delivery_type: deliveryType,
    };
    if (input.dryRun) throw new DryRun(preview);

    // ⑥ 建单（goods_snapshot/sku_snapshot 保持上游字段形状，兼容取消/回调/后台展示）
    const { rows: ins } = await q.query(
      `INSERT INTO "order" (order_sn, site_id, provider, platform, pay_price, commission, cost_amount,
                            buyer_id, promoter_id, goods_snapshot, address_snapshot, sku_snapshot,
                            fulfillment, platform_status, fulfill_status, refund_status, coupon_discount)
       VALUES ($1::varchar, $2::uuid, 'self', $3::varchar, $4::numeric, 0, $5::numeric,
               $6::bigint, $6::bigint, $7::jsonb, $8::jsonb, $9::jsonb,
               $10::varchar, 'created', 'pending', 'none', $11::numeric)
       RETURNING id`,
      [
        orderSn, input.siteId, input.platform, payPrice, costAmount, input.userId,
        JSON.stringify({
          mall: true,
          title: skus.length > 1 ? `${first.title} 等 ${skus.length} 件商品` : first.title,
          pic: firstImg,
          num: totalQty,
          goods_id: first.goods_id,
          delivery_type: deliveryType,
          goods_amount: goodsAmount,
          freight,
          item_count: skus.length,
          ...(costAmount === null ? {} : { cost_amount: costAmount }),
          ...(couponId ? { coupon_id: couponId, coupon_name: couponName } : {}),
        }),
        JSON.stringify(addressSnapshot),
        // ⛔ sku_id 刻意留空：上游 cancel/ordersweep 见到 sku_id 会用 self_goods.skus 回补库存，
        //    而商城单扣的是 shop_sku.locked_stock —— 两者同时回补会双记。商城的释放走 sweepShopOrders。
        JSON.stringify({ mall: true, num: totalQty, sku_ids: skuIds }),
        deliveryType,
        discount,
      ],
    );
    const orderId = Number((ins[0] as Row).id);

    // ⑦ 订单行快照
    for (const s of skus) {
      const num = merged.get(s.sku_id)!;
      const unitPrice = round4(s.price);
      await q.query(
        `INSERT INTO shop_order_item (site_id, order_id, goods_id, sku_id, title, spec, image,
                                      unit_price, unit_cost, num, amount)
         VALUES ($1::uuid, $2::bigint, $3::bigint, $4::bigint, $5::varchar, $6::varchar, $7::text,
                 $8::numeric, $9::numeric, $10::int, $11::numeric)`,
        [
          input.siteId, orderId, s.goods_id, s.sku_id, s.title, s.spec, firstImg,
          unitPrice, s.cost_price === null || s.cost_price === undefined ? null : round4(s.cost_price),
          num, round4(unitPrice * num),
        ],
      );
    }

    // ⑧ 锁库存（第二道闸：条件 UPDATE，并发下拿不到就直接失败回滚）
    for (const s of skus) {
      const num = merged.get(s.sku_id)!;
      const { rows: locked } = await q.query(
        `UPDATE shop_sku SET locked_stock = locked_stock + $2::int, updated_at = now()
          WHERE sku_id = $1::bigint AND site_id = $3::uuid AND stock - locked_stock >= $2::int
          RETURNING stock - locked_stock AS available`,
        [s.sku_id, num, input.siteId],
      );
      if (!locked.length) {
        throw new HttpError(409, `「${s.title} ${s.spec}」库存不足`, 'OUT_OF_STOCK');
      }
      await q.query(
        `INSERT INTO shop_stock_log (site_id, sku_id, change_num, after_stock, reason, ref, operator)
         VALUES ($1::uuid, $2::bigint, $3::int, $4::int, 'order_create', $5::varchar, $6::varchar)`,
        [input.siteId, s.sku_id, -num, Number((locked[0] as Row).available), `create:${orderSn}`, `user:${input.userId}`],
      );
    }

    // ⑨ 锁券（条件 UPDATE；并发被抢则整单回滚）
    if (couponId) {
      const { rows: lockedCoupon } = await q.query(
        `UPDATE user_coupon SET status = 'used', used_order_id = $3::bigint, used_at = now()
          WHERE id = $1::bigint AND user_id = $2::bigint AND status = 'unused'
          RETURNING id`,
        [couponId, input.userId, orderId],
      );
      if (!lockedCoupon.length) throw new HttpError(409, '优惠券已被占用，请重新选择', 'COUPON_TAKEN');
    }

    // ⑩ 清购物车
    if (input.clearCart !== false) {
      await q.query(
        `DELETE FROM shop_cart WHERE user_id = $1::bigint AND site_id = $2::uuid AND sku_id = ANY($3::bigint[])`,
        [input.userId, input.siteId, skuIds],
      );
    }

    return { ...preview, order_id: orderId };
  });
}

/**
 * 下单试算（购物车勾选后看金额）。
 * 复用 createShopOrder 的完整校验与算钱逻辑，在写库前回滚 —— 预览金额与真实下单**必然一致**。
 * 仅 TCP 直连模式可用（网关模式没有会话事务，无法安全回滚）。
 */
export async function quoteShopOrder(input: CreateOrderInput): Promise<CreateOrderResult> {
  if (typeof (pool as unknown as { connect?: unknown }).connect !== 'function') {
    throw new HttpError(503, '当前数据层模式不支持下单试算', 'PREVIEW_UNSUPPORTED');
  }
  try {
    return await createShopOrder({ ...input, dryRun: true, clearCart: false });
  } catch (e) {
    if (e instanceof DryRun) return e.payload;
    throw e;
  }
}

/** 支付成功后的商城处理（由 trade.ts 的 settleSelfOrder 末尾钩子调用，幂等） */
export async function shopOnOrderPaid(orderId: number): Promise<void> {
  const { rows: orders } = await pool.query(
    `SELECT o.id, o.order_sn, o.site_id::text AS site_id, o.platform_status, o.fulfillment
       FROM "order" o WHERE o.id = $1::bigint AND o.provider = 'self' LIMIT 1`,
    [orderId],
  );
  const order = orders[0];
  if (!order) return;
  const items = ((await pool.query(
    `SELECT item_id, goods_id, sku_id, num FROM shop_order_item WHERE order_id = $1::bigint ORDER BY item_id`,
    [orderId],
  )).rows as Row[]).map((r) => ({ goods_id: Number(r.goods_id), sku_id: Number(r.sku_id), num: Number(r.num) }));
  if (!items.length) return; // 非商城单（上游单商品链路）：不干预

  const orderSn = String(order.order_sn);
  await withTx(async (q) => {
    const dup = await q.query(
      `SELECT 1 FROM shop_stock_log WHERE ref = $1::varchar AND reason = 'order_pay' LIMIT 1`,
      [`pay:${orderSn}`],
    );
    if (dup.rows.length) return; // 回调重试：已扣过

    for (const it of items) {
      const skuId = Number(it.sku_id);
      const num = Number(it.num);
      if (!skuId) continue;
      const { rows: upd } = await q.query(
        `UPDATE shop_sku
            SET stock = stock - $2::int,
                locked_stock = GREATEST(locked_stock - $2::int, 0),
                sales = sales + $2::int,
                updated_at = now()
          WHERE sku_id = $1::bigint AND site_id = $3::uuid AND stock >= $2::int
          RETURNING stock`,
        [skuId, num, String(order.site_id)],
      );
      if (!upd.length) {
        // 占用库存凭空消失（人为改库）：不阻断已支付订单，留痕给运营排查
        console.error(`[shop] 支付后扣减异常：sku=${skuId} order=${orderSn}，stock 不足以扣 ${num}`);
        await q.query(
          `INSERT INTO shop_stock_log (site_id, sku_id, change_num, after_stock, reason, ref, operator)
           VALUES ($1::uuid, $2::bigint, 0, COALESCE((SELECT stock FROM shop_sku WHERE sku_id=$2::bigint),0), 'order_pay', $3::varchar, 'anomaly')`,
          [String(order.site_id), skuId, `pay:${orderSn}`],
        );
        continue;
      }
      await q.query(
        `INSERT INTO shop_stock_log (site_id, sku_id, change_num, after_stock, reason, ref, operator)
         VALUES ($1::uuid, $2::bigint, $3::int, $4::int, 'order_pay', $5::varchar, 'system')`,
        [String(order.site_id), skuId, -num, Number((upd[0] as Row).stock), `pay:${orderSn}`],
      );
    }

    // 商品累计销量
    const goodsQty = new Map<number, number>();
    for (const it of items) {
      const gid = Number(it.goods_id);
      if (gid) goodsQty.set(gid, (goodsQty.get(gid) ?? 0) + Number(it.num));
    }
    for (const [gid, qty] of goodsQty) {
      await q.query(`UPDATE self_goods SET sales_count = sales_count + $2::int WHERE goods_id = $1::bigint`, [gid, qty]);
    }

    // 虚拟卡券：支付即成，直接标记已履约（上游默认置 pending，会永远卡在"待发货"）
    if (String(order.fulfillment) === 'virtual') {
      await q.query(`UPDATE "order" SET fulfill_status = 'delivered' WHERE id = $1::bigint`, [orderId]);
    }
  });
}

/** 释放未支付订单的库存占用（幂等；已支付单不走这里，退款回补在阶段 4） */
export async function releaseShopOrderStock(orderId: number, reason = 'order_cancel'): Promise<number> {
  const { rows: orders } = await pool.query(
    `SELECT id, order_sn, site_id::text AS site_id, platform_status FROM "order" WHERE id = $1::bigint AND provider = 'self' LIMIT 1`,
    [orderId],
  );
  const order = orders[0];
  if (!order) return 0;
  const orderSn = String(order.order_sn);
  const items = ((await pool.query(
    `SELECT sku_id, num FROM shop_order_item WHERE order_id = $1::bigint`,
    [orderId],
  )).rows as Row[]).map((r) => ({ sku_id: Number(r.sku_id), num: Number(r.num) }));
  if (!items.length) return 0;

  return withTx(async (q) => {
    const dup = await q.query(
      `SELECT 1 FROM shop_stock_log WHERE ref = $1::varchar AND reason = $2::varchar LIMIT 1`,
      [`cancel:${orderSn}`, reason],
    );
    if (dup.rows.length) return 0;
    let released = 0;
    for (const it of items) {
      const skuId = Number(it.sku_id);
      const num = Number(it.num);
      if (!skuId) continue;
      const { rows: upd } = await q.query(
        `UPDATE shop_sku SET locked_stock = GREATEST(locked_stock - $2::int, 0), updated_at = now()
          WHERE sku_id = $1::bigint AND site_id = $3::uuid
          RETURNING stock - locked_stock AS available`,
        [skuId, num, String(order.site_id)],
      );
      if (!upd.length) continue;
      await q.query(
        `INSERT INTO shop_stock_log (site_id, sku_id, change_num, after_stock, reason, ref, operator)
         VALUES ($1::uuid, $2::bigint, $3::int, $4::int, $5::varchar, $6::varchar, 'system')`,
        [String(order.site_id), skuId, num, Number((upd[0] as Row).available), reason, `cancel:${orderSn}`],
      );
      released++;
    }
    return released;
  });
}

/**
 * 兜底扫描：已关单但占用未释放的商城订单。
 * 不抢关单权（关单仍由上游 ordersweep / cancel 端点负责），只做释放，避免库存被永久占住。
 */
export async function sweepShopOrders(limit = 200): Promise<{ scanned: number; released: number; orders: string[] }> {
  const { rows } = await pool.query(
    `SELECT o.id, o.order_sn
       FROM "order" o
      WHERE o.provider = 'self'
        AND o.platform_status = 'closed'
        AND EXISTS (SELECT 1 FROM shop_order_item i WHERE i.order_id = o.id)
        AND NOT EXISTS (SELECT 1 FROM shop_stock_log l WHERE l.ref = 'cancel:' || o.order_sn)
      ORDER BY o.id
      LIMIT $1::int`,
    [limit],
  );
  const orders: string[] = [];
  let released = 0;
  for (const r of (rows as Row[]).map((x) => ({ id: Number(x.id), order_sn: String(x.order_sn) }))) {
    const n = await releaseShopOrderStock(r.id, 'order_cancel');
    if (n > 0) { released += n; orders.push(String(r.order_sn)); }
  }
  return { scanned: rows.length, released, orders };
}
