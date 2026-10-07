/**
 * 商城（二开）售后与退款 —— 申请 / 审核 / 微信 V3 退款 / 库存回补 / 返利冲销 / 确认收货
 *
 * 资金语义（与上游一致的设计意图）：
 *   · 返利（元宝 + 佣金）由上游 `settleRebateOnVerify()` 发放：**订单完成才结算**。
 *     快递单没有"核销"动作 → 商城补一个「确认收货」来触发结算；虚拟卡券支付即成，走同一入口。
 *   · 退款成功需要三件事同时发生（缺一即账不平）：
 *       ① 库存回补 + 流水（reason='refund'）
 *       ② 元宝扣回（type='REFUND_DEDUCT'，幂等唯一索引 uq_ingot_tx_order_ref）
 *       ③ 佣金作废（commission_flow.status='invalid'）+ 余额扣回（不足部分挂账）
 *   · 上游 `ingot_account.frozen` 的注释就是"退款待扣冻结（余额不足时挂账）"——
 *     本模块按该设计落地：余额不够扣的部分进 frozen，绝不把 balance 扣成负数（有 CHECK >= 0）。
 *   · 部分退款：元宝按比例扣回；**佣金不做自动冲销**（多跳按 level 各一行、比例扣会污染历史），
 *     改为在 `shop_refund.reversed` 台账里标 manual_review，交运营人工处理——宁可要人确认，也不要静默算错。
 *
 * 幂等：
 *   · 微信退款用 `out_refund_no = refund_sn` → 微信侧天然幂等（重复请求返回同一退款单）
 *   · 落账（finalize）以 `shop_refund.status='success'` 为闸；重复调用直接返回 already=true
 *   · 库存/流水以 `shop_stock_log.ref = 'refund:<refund_sn>'` 为幂等键
 */
import crypto from 'node:crypto';
import { pool } from '../db/client.js';
import { HttpError } from '../middleware/errors.js';
import { withTx, type Queryable } from './shop.js';
import { INGOT_PER_YUAN } from './constants.js';
import { resolvePayConfig, refund as wxRefund } from './wxpay.js';
import { settleRebateOnVerify } from '../routes/trade.js';

const round2 = (n: number): number => Math.round(n * 100) / 100;
type Row = Record<string, unknown>;

const newRefundSn = (): string =>
  `RF_${new Date().toISOString().slice(0, 10).replace(/-/g, '')}_${crypto.randomBytes(5).toString('hex').toUpperCase()}`;

// ════════════════════════════════════════════════════════════════════════
// C 端：申请 / 取消 / 查询
// ════════════════════════════════════════════════════════════════════════

export interface ApplyRefundInput {
  siteId: string;
  userId: number;
  orderId: number;
  itemId?: number;
  num?: number;
  type?: 'refund' | 'return';
  reason?: string;
  description?: string;
  images?: unknown;
}

/** 提交售后申请（一次只允许一笔进行中的售后，避免超额退款） */
export async function applyRefund(input: ApplyRefundInput): Promise<{ refund_id: number; refund_sn: string; amount: number; num: number }> {
  const orderRows = (await pool.query(
    `SELECT id, order_sn, site_id::text AS site_id, buyer_id, pay_price::float AS pay_price,
            platform_status, refund_status, fulfillment
       FROM "order"
      WHERE id = $1::bigint AND provider = 'self' AND site_id = $2::uuid AND buyer_id = $3::bigint LIMIT 1`,
    [input.orderId, input.siteId, input.userId],
  )).rows as Row[];
  const order = orderRows[0];
  if (!order) throw new HttpError(404, '订单不存在', 'ORDER_NOT_FOUND');
  if (!['paid', 'settled'].includes(String(order.platform_status))) {
    throw new HttpError(409, '订单未支付或已关闭，不能申请售后', 'BAD_ORDER_STATE');
  }
  if (String(order.refund_status) === 'refunded') throw new HttpError(409, '该订单已全额退款', 'ALREADY_REFUNDED');

  const active = (await pool.query(
    `SELECT refund_sn, status FROM shop_refund
      WHERE order_id = $1::bigint AND status IN ('applied','approved','refunding') LIMIT 1`,
    [input.orderId],
  )).rows as Row[];
  if (active[0]) throw new HttpError(409, `该订单已有进行中的售后单（${active[0].refund_sn}）`, 'EXISTING_REFUND');

  // ⛔ 只给 num 不给 item_id 是歧义请求：整单退款路径会忽略 num，
  //    调用方以为"只退 1 件"、实际退了整单 —— 钱的方向上不允许靠猜。
  if (!input.itemId && input.num !== undefined && Number(input.num) > 0) {
    throw new HttpError(400, '按件数退款必须指定 item_id（整单退款无需传 num）', 'ITEM_ID_REQUIRED');
  }

  const items = (await pool.query(
    `SELECT item_id, sku_id, title, unit_price::float AS unit_price, num, amount::float AS amount,
            refunded_num, refund_amount::float AS refund_amount
       FROM shop_order_item WHERE order_id = $1::bigint ORDER BY item_id`,
    [input.orderId],
  )).rows as Row[];

  let targets: Array<{ item: Row; num: number; amount: number }> = [];
  let totalAmount = 0;
  let totalNum = 0;

  if (input.itemId) {
    const item = items.find((i) => Number(i.item_id) === Number(input.itemId));
    if (!item) throw new HttpError(404, '订单中无此商品', 'ITEM_NOT_FOUND');
    const remainingNum = Number(item.num) - Number(item.refunded_num);
    if (remainingNum <= 0) throw new HttpError(409, '该商品已全部退款', 'ITEM_REFUNDED');
    const num = input.num ? Number(input.num) : remainingNum;
    if (!Number.isInteger(num) || num <= 0) throw new HttpError(400, '退款件数不合法', 'BAD_NUM');
    if (num > remainingNum) throw new HttpError(409, `最多可退 ${remainingNum} 件`, 'NUM_TOO_MANY');
    const remainingAmount = round2(Number(item.amount) - Number(item.refund_amount));
    const amount = Math.min(round2(Number(item.unit_price) * num), remainingAmount);
    if (amount <= 0) throw new HttpError(409, '可退金额为 0', 'NO_AMOUNT');
    targets = [{ item, num, amount }];
    totalAmount = amount;
    totalNum = num;
  } else {
    // 整单退款：按各行剩余可退金额之和（含未退完的行；运费/券差额体现在 last 行吸收）
    let paid = Number(order.pay_price);
    const prevRefunded = (await pool.query(
      `SELECT COALESCE(SUM(amount),0)::float AS s FROM shop_refund WHERE order_id = $1::bigint AND status = 'success'`,
      [input.orderId],
    )).rows as Row[];
    const already = Number(prevRefunded[0]?.s ?? 0);
    const refundable = round2(paid - already);
    if (refundable <= 0) throw new HttpError(409, '该订单无可退金额', 'NO_AMOUNT');
    for (const item of items) {
      const remainingNum = Number(item.num) - Number(item.refunded_num);
      if (remainingNum <= 0) continue;
      const remainingAmount = round2(Number(item.amount) - Number(item.refund_amount));
      if (remainingAmount <= 0) continue;
      targets.push({ item, num: remainingNum, amount: remainingAmount });
      totalNum += remainingNum;
    }
    if (!targets.length) throw new HttpError(409, '该订单无可退商品', 'NO_ITEM');
    totalAmount = refundable;
  }

  const refundSn = newRefundSn();
  const refundId = await withTx(async (q) => {
    const { rows } = await q.query(
      `INSERT INTO shop_refund (site_id, refund_sn, order_id, item_id, user_id, type, reason, description, images, amount, num, status)
       VALUES ($1::uuid,$2::varchar,$3::bigint,$4::bigint,$5::bigint,$6::varchar,$7::varchar,$8::text,$9::jsonb,$10::numeric,$11::int,'applied')
       RETURNING refund_id`,
      [
        input.siteId, refundSn, input.orderId, input.itemId ?? null, input.userId,
        input.type === 'return' ? 'return' : 'refund',
        String(input.reason ?? '').slice(0, 255), String(input.description ?? '').slice(0, 2000),
        JSON.stringify(Array.isArray(input.images) ? input.images : []),
        totalAmount, totalNum,
      ],
    );
    await q.query(
      `UPDATE "order" SET refund_status = 'applying', updated_at = now()
        WHERE id = $1::bigint AND refund_status <> 'refunded'`,
      [input.orderId],
    );
    return Number((rows[0] as Row).refund_id);
  });

  return { refund_id: refundId, refund_sn: refundSn, amount: totalAmount, num: totalNum };
}

/** 用户撤销申请（仅 applied 可撤） */
export async function cancelRefund(refundId: number, userId: number): Promise<boolean> {
  return withTx(async (q) => {
    const { rows } = await q.query(
      `UPDATE shop_refund SET status = 'canceled', updated_at = now()
        WHERE refund_id = $1::bigint AND user_id = $2::bigint AND status = 'applied'
        RETURNING order_id`,
      [refundId, userId],
    );
    if (!rows[0]) return false;
    await refreshOrderRefundStatus(q, Number((rows[0] as Row).order_id));
    return true;
  });
}

// ════════════════════════════════════════════════════════════════════════
// 后台：审核 / 退款 / 落账
// ════════════════════════════════════════════════════════════════════════

/**
 * 通过售后单并发起退款。
 * 有真实支付凭据 → 调微信 V3 退款（out_refund_no = refund_sn，微信侧幂等）；
 * 无凭据 → 走 mock 通道直接落账（与上游 mock-pay 同款安全边界：配了真商户号即自动失效）。
 */
export async function approveRefund(
  refundId: number, admin: { adminId: string; username: string }, siteId: string,
): Promise<{ status: string; mock: boolean; amount: number; wx_refund_id: string | null; already?: boolean }> {
  const rows = (await pool.query(
    `SELECT r.refund_id, r.refund_sn, r.order_id, r.amount::float AS amount, r.status, r.wx_refund_id,
            o.order_sn, o.pay_price::float AS pay_price
       FROM shop_refund r JOIN "order" o ON o.id = r.order_id
      WHERE r.refund_id = $1::bigint AND r.site_id = $2::uuid LIMIT 1`,
    [refundId, siteId],
  )).rows as Row[];
  const r = rows[0];
  if (!r) throw new HttpError(404, '售后单不存在', 'REFUND_NOT_FOUND');
  if (String(r.status) === 'success') return { status: 'success', mock: false, amount: Number(r.amount), wx_refund_id: r.wx_refund_id ? String(r.wx_refund_id) : null, already: true };
  if (String(r.status) !== 'applied') throw new HttpError(409, '售后单状态不可审核', 'BAD_REFUND_STATE');

  await pool.query(
    `UPDATE shop_refund SET status='approved', admin_id=$2::bigint, admin_remark=COALESCE(admin_remark,''), audited_at=now(), updated_at=now()
      WHERE refund_id = $1::bigint`,
    [refundId, admin.adminId],
  );

  const orderSn = String(r.order_sn);
  const totalFen = Math.round(Number(r.pay_price) * 100);
  const refundFen = Math.round(Number(r.amount) * 100);

  let cfg: Awaited<ReturnType<typeof resolvePayConfig>> | null = null;
  try { cfg = await resolvePayConfig(siteId); } catch { cfg = null; }

  if (!cfg) {
    // mock 通道：未配置真实商户号时允许本地/联调环境跑通全流程
    const mockId = `MOCKRF${Date.now()}`;
    await pool.query(
      `UPDATE shop_refund SET wx_refund_id=$2::varchar, wx_refund_state='SUCCESS', updated_at=now() WHERE refund_id=$1::bigint`,
      [refundId, mockId],
    );
    await finalizeRefund(refundId, 'SUCCESS');
    return { status: 'success', mock: true, amount: Number(r.amount), wx_refund_id: mockId };
  }

  try {
    const out = await wxRefund({
      cfg, outTradeNo: orderSn, outRefundNo: String(r.refund_sn),
      totalFen, refundFen, reason: '商城订单退款',
    });
    await pool.query(
      `UPDATE shop_refund SET wx_refund_id=$2::varchar, wx_refund_state=$3::varchar, updated_at=now() WHERE refund_id=$1::bigint`,
      [refundId, out.refundId, out.refundStatus],
    );
    if (out.refundStatus === 'SUCCESS') {
      await finalizeRefund(refundId, 'SUCCESS', admin);
      return { status: 'success', mock: false, amount: Number(r.amount), wx_refund_id: out.refundId };
    }
    await pool.query(`UPDATE shop_refund SET status='refunding', updated_at=now() WHERE refund_id=$1::bigint`, [refundId]);
    return { status: 'refunding', mock: false, amount: Number(r.amount), wx_refund_id: out.refundId };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    // 保留 applied：微信退款单号幂等，运营可以稍后重试
    await pool.query(
      `UPDATE shop_refund SET status='applied', fail_reason=$2::text, updated_at=now() WHERE refund_id=$1::bigint`,
      [refundId, msg.slice(0, 500)],
    );
    throw e;
  }
}

/** 驳回售后（钱不动；若该单没有其它进行中售后，退款状态回滚到 none） */
export async function rejectRefund(refundId: number, admin: { adminId: string }, reason: string): Promise<boolean> {
  const why = String(reason ?? '').trim();
  if (!why) throw new HttpError(400, '请填写驳回原因', 'BAD_REASON');
  return withTx(async (q) => {
    const { rows } = await q.query(
      `UPDATE shop_refund SET status='rejected', admin_id=$2::bigint, admin_remark=$3::varchar, audited_at=now(), finished_at=now(), updated_at=now()
        WHERE refund_id = $1::bigint AND status IN ('applied','approved') RETURNING order_id`,
      [refundId, admin.adminId, why.slice(0, 500)],
    );
    if (!rows[0]) return false;
    await refreshOrderRefundStatus(q, Number((rows[0] as Row).order_id));
    return true;
  });
}

/** 人工标记退款结果（微信返回 PROCESSING/ABNORMAL，或线下退款后补录） */
export async function finishRefundManually(
  refundId: number, admin: { adminId: string }, success: boolean, note?: string,
): Promise<boolean> {
  const rows = (await pool.query(
    `SELECT refund_id, status FROM shop_refund WHERE refund_id = $1::bigint LIMIT 1`, [refundId],
  )).rows as Row[];
  if (!rows[0]) throw new HttpError(404, '售后单不存在', 'REFUND_NOT_FOUND');
  if (String(rows[0].status) === 'success') return true;
  if (success) {
    await finalizeRefund(refundId, 'SUCCESS_MANUAL', admin);
    return true;
  }
  const { rows: upd } = await pool.query(
    `UPDATE shop_refund SET status='failed', fail_reason=$2::text, admin_id=$3::bigint, finished_at=now(), updated_at=now()
      WHERE refund_id = $1::bigint AND status IN ('applied','approved','refunding') RETURNING order_id`,
    [refundId, String(note ?? '人工判定失败').slice(0, 500), admin.adminId],
  );
  if (upd[0]) {
    await refreshOrderRefundStatus(pool as unknown as Queryable, Number((upd[0] as Row).order_id));
  }
  return !!upd[0];
}

/**
 * 落账（幂等核心）：库存回补 + 订单行退款量 + 订单退款状态 + 返利冲销。
 * 重复调用（微信回调重试 / 运营重复点）直接返回 already。
 */
export async function finalizeRefund(
  refundId: number, wxState: string, admin?: { adminId: string },
): Promise<{ already: boolean; restored: number; reversed: unknown[] }> {
  return withTx(async (q) => {
    const refundRows = (await q.query(
      `SELECT r.refund_id, r.refund_sn, r.order_id, r.item_id, r.amount::float AS amount, r.num, r.status,
              o.order_sn, o.site_id::text AS site_id, o.buyer_id, o.pay_price::float AS pay_price,
              o.settled_at, o.platform_status
         FROM shop_refund r JOIN "order" o ON o.id = r.order_id
        WHERE r.refund_id = $1::bigint FOR UPDATE OF r`,
      [refundId],
    )).rows as Row[];
    const r = refundRows[0];
    if (!r) throw new HttpError(404, '售后单不存在', 'REFUND_NOT_FOUND');
    if (String(r.status) === 'success') {
      const prev = (await q.query(`SELECT reversed FROM shop_refund WHERE refund_id=$1::bigint`, [refundId])).rows as Row[];
      return { already: true, restored: 0, reversed: (prev[0]?.reversed as unknown[]) ?? [] };
    }

    const orderId = Number(r.order_id);
    const siteId = String(r.site_id);
    const refundSn = String(r.refund_sn);
    const amount = Number(r.amount);

    // ① 库存回补 + 流水
    const items = (await q.query(
      `SELECT item_id, sku_id, num, refunded_num, amount::float AS amount, refund_amount::float AS refund_amount
         FROM shop_order_item WHERE order_id = $1::bigint ORDER BY item_id`,
      [orderId],
    )).rows as Row[];
    const plan = r.item_id
      ? [{ item: items.find((i) => Number(i.item_id) === Number(r.item_id)), num: Number(r.num), amount }]
      : distributeFullRefund(items, amount);

    let restored = 0;
    for (const p of plan) {
      if (!p.item) continue;
      await q.query(
        `UPDATE shop_order_item SET refunded_num = refunded_num + $2::int, refund_amount = refund_amount + $3::numeric
          WHERE item_id = $1::bigint`,
        [Number(p.item.item_id), p.num, p.amount],
      );
      const skuId = p.item.sku_id;
      if (skuId) {
        const dup = await q.query(
          `SELECT 1 FROM shop_stock_log WHERE ref = $1::varchar AND reason = 'refund' LIMIT 1`,
          [`refund:${refundSn}`],
        );
        if (!dup.rows.length) {
          const { rows: upd } = await q.query(
            `UPDATE shop_sku SET stock = stock + $2::int, updated_at = now()
              WHERE sku_id = $1::bigint AND site_id = $3::uuid
              RETURNING stock`,
            [Number(skuId), p.num, siteId],
          );
          if (upd[0]) {
            await q.query(
              `INSERT INTO shop_stock_log (site_id, sku_id, change_num, after_stock, reason, ref, operator)
               VALUES ($1::uuid,$2::bigint,$3::int,$4::int,'refund',$5::varchar,$6::varchar)`,
              [siteId, Number(skuId), p.num, Number((upd[0] as Row).stock), `refund:${refundSn}`, admin ? `admin:${admin.adminId}` : 'system'],
            );
            restored++;
          }
        }
      }
    }

    // ② 返利冲销（只有已结算的单才有返利可冲）
    const ledger: unknown[] = [];
    if (r.settled_at) {
      const ratio = Math.max(0, Math.min(1, amount / Math.max(0.01, Number(r.pay_price))));
      // 2.1 元宝扣回（幂等：uq_ingot_tx_order_ref）
      const awarded = Math.floor(Number(r.pay_price) * INGOT_PER_YUAN);
      const deduct = Math.floor(awarded * ratio);
      if (deduct > 0) {
        const { rows: tx } = await q.query(
          `WITH tx AS (
             INSERT INTO ingot_tx (user_id, type, ref_id, amount, balance_after, remark)
             VALUES ($1::bigint, 'REFUND_DEDUCT', $2::varchar, $3::int, 0, $4::varchar)
             ON CONFLICT (user_id, type, ref_id) WHERE type IN ('ORDER_REBATE','REFUND_DEDUCT') DO NOTHING
             RETURNING tx_id
           ), acc AS (
             UPDATE ingot_account
                SET balance = GREATEST(balance - $5::int, 0),
                    frozen  = frozen + GREATEST($5::int - balance, 0),
                    updated_at = now()
              WHERE user_id = $1::bigint AND EXISTS (SELECT 1 FROM tx)
              RETURNING balance, frozen
           )
           SELECT (SELECT count(*)::int FROM tx) AS inserted,
                  (SELECT balance FROM acc) AS balance, (SELECT frozen FROM acc) AS frozen`,
          [Number(r.buyer_id), String(orderId), -deduct, `退款扣回元宝（${refundSn}）`, deduct],
        );
        const inserted = Number((tx[0] as Row)?.inserted ?? 0);
        if (inserted > 0) {
          await q.query(
            `UPDATE ingot_tx SET balance_after = COALESCE((SELECT balance FROM ingot_account WHERE user_id = $1::bigint), 0)
              WHERE user_id = $1::bigint AND type = 'REFUND_DEDUCT' AND ref_id = $2::varchar AND balance_after = 0`,
            [Number(r.buyer_id), String(orderId)],
          );
          ledger.push({
            kind: 'ingot', user_id: Number(r.buyer_id), amount: -deduct,
            balance_after: (tx[0] as Row)?.balance ?? null, note: ratio < 0.999 ? '部分退款按比例扣回' : '全额退款扣回',
          });
        }
      }
      // 2.2 佣金：仅全额退款自动作废；部分退款挂人工（多跳比例扣会污染历史，宁可要人确认）
      if (ratio >= 0.999) {
        const { rows: flows } = await q.query(
          `UPDATE commission_flow SET status = 'invalid', updated_at = now()
            WHERE order_id = $1::bigint AND status IN ('estimated','available')
            RETURNING user_id, level, amount::float AS amount`,
          [orderId],
        );
        for (const f of flows as Row[]) {
          const uid = Number(f.user_id);
          const amt = Number(f.amount);
          const { rows: before } = await q.query(`SELECT commission_balance::float AS b FROM promoter WHERE user_id = $1::bigint`, [uid]);
          if (!before[0]) {
            ledger.push({ kind: 'commission', user_id: uid, amount: -amt, applied: 0, shortfall: amt, note: 'promoter 记录不存在' });
            continue;
          }
          const { rows: after } = await q.query(
            `UPDATE promoter SET commission_balance = GREATEST(commission_balance - $2::numeric, 0)
              WHERE user_id = $1::bigint RETURNING commission_balance::float AS b`,
            [uid, amt],
          );
          const deducted = round2(Number(before[0].b) - Number(after[0]?.b ?? 0));
          ledger.push({
            kind: 'commission', user_id: uid, level: Number(f.level), amount: -amt,
            applied: -deducted, shortfall: round2(amt - deducted),
            note: deducted < amt ? '余额不足以扣回，差额记挂账待人工追缴' : '全额退款作废佣金并扣回余额',
          });
        }
      } else {
        const { rows: flows } = await q.query(
          `SELECT user_id, level, amount::float AS amount FROM commission_flow
            WHERE order_id = $1::bigint AND status IN ('estimated','available')`,
          [orderId],
        );
        for (const f of flows as Row[]) {
          ledger.push({
            kind: 'commission', user_id: Number(f.user_id), level: Number(f.level),
            amount: -round2(Number(f.amount) * ratio), applied: 0,
            note: 'manual_review：部分退款不自动冲销佣金，请运营按政策人工处理',
          });
        }
      }
    } else {
      ledger.push({ kind: 'none', note: '订单尚未结算（未确认收货），无返利可冲销' });
    }

    // ③ 更新订单退款状态
    await refreshOrderRefundStatus(q, orderId);

    // ④ 收口：写台账 + 状态置 success
    await q.query(
      `UPDATE shop_refund
          SET status = 'success', wx_refund_state = $2::varchar, reversed = $3::jsonb,
              admin_id = COALESCE($4::bigint, admin_id), finished_at = now(), updated_at = now()
        WHERE refund_id = $1::bigint`,
      [refundId, wxState, JSON.stringify(ledger), admin?.adminId ?? null],
    );
    return { already: false, restored, reversed: ledger };
  });
}

/** 整单退款时把金额按行摊到各订单行（最后一行吸收尾差，保证合计等于退款额） */
function distributeFullRefund(items: Row[], amount: number): Array<{ item: Row; num: number; amount: number }> {
  const out: Array<{ item: Row; num: number; amount: number }> = [];
  let left = amount;
  const pending = items.filter((i) => Number(i.num) - Number(i.refunded_num) > 0);
  pending.forEach((item, idx) => {
    const num = Number(item.num) - Number(item.refunded_num);
    const remaining = round2(Number(item.amount) - Number(item.refund_amount));
    const isLast = idx === pending.length - 1;
    const amt = isLast ? round2(left) : Math.min(remaining, round2(left));
    left = round2(left - amt);
    out.push({ item, num, amount: amt });
  });
  return out;
}

/** 重算订单退款状态（refunded/partial/none，忽略 applying 由申请接口单独置位） */
async function refreshOrderRefundStatus(q: Queryable, orderId: number): Promise<void> {
  const { rows } = await q.query(
    `SELECT o.pay_price::float AS pay_price,
            COALESCE((SELECT SUM(i.refund_amount)::float FROM shop_order_item i WHERE i.order_id = o.id), 0) AS refunded,
            (SELECT COUNT(*)::int FROM shop_refund r WHERE r.order_id = o.id AND r.status IN ('applied','approved','refunding')) AS active
       FROM "order" o WHERE o.id = $1::bigint`,
    [orderId],
  );
  const row = rows[0];
  if (!row) return;
  const pay = Number(row.pay_price);
  const refunded = Number(row.refunded);
  const active = Number(row.active);
  const status = refunded >= round2(pay) - 0.01 ? 'refunded' : refunded > 0 ? 'partial' : active > 0 ? 'applying' : 'none';
  await q.query(`UPDATE "order" SET refund_status = $2::varchar, updated_at = now() WHERE id = $1::bigint`, [orderId, status]);
}

// ════════════════════════════════════════════════════════════════════════
// 确认收货 → 触发返利结算
// ════════════════════════════════════════════════════════════════════════

/**
 * 确认收货（快递单唯一可确认；虚拟卡券支付即成，此接口幂等兜底）。
 * 到店核销单必须走核销流程（核销即代表消费完成，钱不能提前放）。
 */
export async function confirmReceive(
  orderId: number, userId: number, siteId: string,
): Promise<{ fulfill_status: string; settled: boolean; already: boolean; settle_error?: string }> {
  const rows = (await pool.query(
    `SELECT id, order_sn, fulfillment, platform_status, fulfill_status
       FROM "order" WHERE id = $1::bigint AND buyer_id = $2::bigint AND site_id = $3::uuid AND provider = 'self' LIMIT 1`,
    [orderId, userId, siteId],
  )).rows as Row[];
  const o = rows[0];
  if (!o) throw new HttpError(404, '订单不存在', 'ORDER_NOT_FOUND');
  if (!['paid', 'settled'].includes(String(o.platform_status))) {
    throw new HttpError(409, '订单未支付，不能确认收货', 'BAD_ORDER_STATE');
  }
  if (String(o.fulfillment) === 'group') {
    throw new HttpError(409, '到店核销订单请到店核销，不能线上确认收货', 'GROUP_ORDER');
  }
  if (String(o.fulfillment) === 'express' && String(o.fulfill_status) !== 'shipped' && String(o.fulfill_status) !== 'delivered') {
    throw new HttpError(409, '商家还未发货', 'NOT_SHIPPED');
  }
  const already = String(o.fulfill_status) === 'delivered';
  if (!already) {
    await pool.query(
      `UPDATE "order" SET fulfill_status = 'delivered', updated_at = now()
        WHERE id = $1::bigint AND fulfill_status IN ('shipped','pending')`,
      [orderId],
    );
  }
  // 结算幂等：上游 settleRebateOnVerify 内部以 settled_at IS NULL 原子抢占。
  // ⛔ 结算失败**不允许**阻断确认收货：货已经交付给买家了，返利是后台账务问题，
  //    卡住收货只会让买家无法完成订单。失败留痕，运营可用后台 /orders/:id/settle 补结算。
  let settleError = '';
  try {
    await settleRebateOnVerify(orderId);
  } catch (e) {
    settleError = e instanceof Error ? e.message : String(e);
    console.error('[shop] 结算失败（不影响收货）', orderId, settleError);
  }
  const after = (await pool.query(`SELECT platform_status, fulfill_status FROM "order" WHERE id = $1::bigint`, [orderId])).rows as Row[];
  return {
    fulfill_status: String(after[0]?.fulfill_status ?? 'delivered'),
    settled: String(after[0]?.platform_status) === 'settled',
    already,
    ...(settleError ? { settle_error: settleError } : {}),
  };
}
