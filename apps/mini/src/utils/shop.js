// 商城（二开）前端 API 封装 —— mini / h5 共用同一份（两个 app 的 request.js 导出对称）
import { request, SITE_CODE } from './request';

const qs = (params = {}) => Object.entries(params)
  .filter(([, v]) => v !== undefined && v !== null && v !== '')
  .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
  .join('&');

export const shopApi = {
  // 公开目录
  categories: () => request(`/api/shop/categories?site=${SITE_CODE}`),
  goodsList: (params) => request(`/api/shop/goods?site=${SITE_CODE}&${qs(params)}`),
  goodsDetail: (id) => request(`/api/shop/goods/${id}?site=${SITE_CODE}`),

  // 购物车
  cart: () => request('/api/me/shop/cart'),
  cartAdd: (body) => request('/api/me/shop/cart', { method: 'POST', data: body }),
  cartPatch: (id, body) => request(`/api/me/shop/cart/${id}`, { method: 'PATCH', data: body }),
  cartDel: (id) => request(`/api/me/shop/cart/${id}`, { method: 'DELETE' }),
  cartSelectAll: (selected) => request('/api/me/shop/cart/select-all', { method: 'POST', data: { selected } }),

  // 我的可用券（商城口径）
  coupons: (goodsAmount) => request(`/api/me/shop/coupons?goods_amount=${Number(goodsAmount) || 0}`),

  // 下单与支付
  checkout: (body) => request('/api/shop/checkout', { method: 'POST', data: body }),
  createOrder: (body) => request('/api/shop/orders', { method: 'POST', data: body }),
  pay: (orderId) => request(`/api/trade/orders/${orderId}/pay`, { method: 'POST' }),
  // 开发/联调：站点未配置真实商户号时可模拟支付（配了真凭据后后端自动返回 403）
  mockPay: (orderId) => request(`/api/trade/orders/${orderId}/mock-pay`, { method: 'POST' }),

  // 订单
  orders: (params) => request(`/api/shop/orders?${qs(params)}`),
  orderDetail: (id) => request(`/api/shop/orders/${id}`),
  cancelOrder: (id) => request(`/api/shop/orders/${id}/cancel`, { method: 'POST' }),
  receiveOrder: (id) => request(`/api/shop/orders/${id}/receive`, { method: 'POST' }),

  // 售后
  applyRefund: (orderId, body) => request(`/api/shop/orders/${orderId}/refund`, { method: 'POST', data: body }),
  refunds: () => request('/api/shop/refunds'),
  refundDetail: (id) => request(`/api/shop/refunds/${id}`),
  cancelRefund: (id) => request(`/api/shop/refunds/${id}/cancel`, { method: 'POST' }),

  // 地址簿（复用上游 profile 接口；注意 GET 返回的是**数组**，且手机号已脱敏）
  addresses: () => request('/api/profile/addresses'),
  createAddress: (body) => request('/api/profile/addresses', { method: 'POST', data: body }),
};

/** 统一的金额展示（后端一律返回元，两位小数） */
export const yuan = (n) => `¥${Number(n || 0).toFixed(2)}`;

/** 订单/售后状态文案 */
export const ORDER_STATUS_TEXT = {
  created: '待支付', paid: '已付款', settled: '已完成', closed: '已关闭',
};
export const FULFILL_TEXT = {
  none: '', pending: '待发货', shipped: '已发货', delivered: '已收货', verified: '已核销',
};
export const REFUND_STATUS_TEXT = {
  none: '', applying: '售后处理中', partial: '部分退款', refunded: '已退款',
};
export const REFUND_APPLY_STATUS_TEXT = {
  applied: '待商家审核', approved: '已通过', rejected: '已驳回', refunding: '退款中',
  success: '退款成功', failed: '退款失败', canceled: '已撤销',
};

/** 订单列表用的组合状态文案 */
export function orderStatusText(o) {
  if (o.platform_status === 'created') return '待支付';
  if (o.refund_status === 'refunded') return '已退款';
  if (o.refund_status === 'applying') return '售后处理中';
  if (o.platform_status === 'settled') return '已完成';
  if (o.fulfillment === 'express' && o.fulfill_status === 'shipped') return '待收货';
  if (o.fulfillment === 'virtual') return '已完成';
  return '已付款';
}
