/**
 * 商城（二开）定时任务端点
 *
 *   POST /api/jobs/shop-sweep/cron?token=<HMAC(JWT_SECRET,'shop-sweep') 前 32 hex>
 *
 * 为什么单独一个任务而不是改上游 ordersweep：
 *   · 关单权仍在 ordersweep / C 端 cancel（它们只认 platform_status='created'）；
 *   · 本任务只做"已关单但库存占用没释放"的兜底释放（幂等键 = shop_stock_log.ref='cancel:<order_sn>'），
 *     这样上游关单逻辑怎么改都不会造成商城库存被永久占住。
 * token 复用上游 cronToken 的派生方式，无需新增环境变量。
 */
import { Router, type Request, type Response, type NextFunction } from 'express';
import { HttpError } from '../middleware/errors.js';
import { cronToken } from './jobs.js';
import { sweepShopOrders } from '../lib/shop.js';

export const shopJobsRouter = Router();

shopJobsRouter.post('/shop-sweep/cron', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const token = String(req.query.token ?? req.headers['x-cron-token'] ?? '');
    if (!process.env.JWT_SECRET || token !== cronToken('shop-sweep')) {
      throw new HttpError(401, 'BAD_CRON_TOKEN', '定时触发 token 无效');
    }
    const result = await sweepShopOrders();
    res.json({ ok: true, data: result });
  } catch (e) { next(e); }
});
