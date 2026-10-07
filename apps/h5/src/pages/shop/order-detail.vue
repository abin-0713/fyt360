<template>
  <view class="od">
    <view v-if="loading" class="state"><text>加载中…</text></view>
    <view v-else-if="error" class="state">
      <text>{{ error }}</text>
      <view class="retry" @click="load">重试</view>
    </view>

    <template v-else>
      <view class="panel status-panel">
        <text class="big-status">{{ statusText(order) }}</text>
        <text class="sn">{{ order.order_sn }}</text>
      </view>

      <view v-if="order.logistics" class="panel">
        <view class="sec-title">物流信息</view>
        <view class="line"><text>{{ order.logistics.company }}</text><text>{{ order.logistics.tracking_no }}</text></view>
        <view v-if="order.logistics.shipped_at" class="sub">发货时间：{{ order.logistics.shipped_at }}</view>
      </view>

      <view v-if="hasAddress" class="panel">
        <view class="sec-title">收货信息</view>
        <view class="line"><text>{{ order.address.name }}</text><text>{{ order.address.phone }}</text></view>
        <view class="sub">{{ order.address.region }} {{ order.address.detail }}</view>
      </view>

      <view class="panel">
        <view class="sec-title">商品</view>
        <view v-for="it in items" :key="it.item_id" class="item">
          <image class="item-img" :src="it.image" mode="aspectFill" />
          <view class="item-main">
            <view class="item-title">{{ it.title }}</view>
            <view class="sub">{{ it.spec }}</view>
            <view v-if="it.refunded_num > 0" class="sub refunded">已退 {{ it.refunded_num }} 件 / {{ yuan(it.refund_amount) }}</view>
          </view>
          <view class="item-right">
            <text class="item-price">{{ yuan(it.unit_price) }}</text>
            <text class="sub">× {{ it.num }}</text>
          </view>
        </view>
        <view class="line"><text>商品金额</text><text>{{ yuan(order.pay_price) }}</text></view>
        <view v-if="order.coupon_discount" class="line"><text>优惠</text><text class="minus">-{{ yuan(order.coupon_discount) }}</text></view>
        <view class="line total"><text>实付</text><text class="pay">{{ yuan(order.pay_price) }}</text></view>
      </view>

      <!-- 申请售后（paid / settled 且未全额退款时可用） -->
      <view v-if="canRefund" class="panel">
        <view class="sec-title">申请售后</view>
        <picker :range="itemLabels" :value="refundItemIdx" @change="onPickItem">
          <view class="picker">{{ itemLabels[refundItemIdx] }}</view>
        </picker>
        <input v-model="refundForm.reason" class="ipt" placeholder="退款原因（如：不想要了 / 质量问题）" />
        <input v-model="refundForm.num" class="ipt" type="number" placeholder="退款件数（默认全部）" />
        <view class="btn-row">
          <view class="btn ghost" @click="refundForm.type = refundForm.type === 'return' ? 'refund' : 'return'">
            {{ refundForm.type === 'return' ? '退货退款' : '仅退款' }}
          </view>
          <view class="btn primary" @click="submitRefund">提交申请</view>
        </view>
        <view class="sub">提交后由商家审核；审核通过自动原路退回。</view>
      </view>

      <view v-if="order.refund_status !== 'none'" class="panel">
        <view class="sec-title">售后状态</view>
        <view class="line"><text>{{ refundStatusText(order.refund_status) }}</text><text v-if="myRefund"> {{ applyStatusText(myRefund.status) }}</text></view>
        <view v-if="myRefund" class="sub">售后单号：{{ myRefund.refund_sn }} · 金额 {{ yuan(myRefund.amount) }}</view>
        <view v-if="myRefund && myRefund.status === 'applied'" class="btn-row">
          <view class="btn ghost" @click="cancelRefund">撤销申请</view>
        </view>
      </view>

      <view class="footbar">
        <view v-if="order.platform_status === 'created'" class="btn ghost" @click="cancelOrder">取消订单</view>
        <view v-if="order.platform_status === 'created'" class="btn primary" @click="pay">立即支付</view>
        <view v-if="canReceive" class="btn primary" @click="receive">确认收货</view>
        <view v-if="order.platform_status !== 'created' && !canReceive" class="btn ghost" @click="goOrders">返回列表</view>
      </view>
    </template>
  </view>
</template>

<script>
import {
  shopApi, yuan, orderStatusText, REFUND_STATUS_TEXT, REFUND_APPLY_STATUS_TEXT,
} from '../../utils/shop';

export default {
  data() {
    return {
      orderId: 0,
      order: {},
      items: [],
      myRefund: null,
      refundItemIdx: 0,
      refundForm: { reason: '', num: '', type: 'refund' },
      loading: true,
      error: '',
    };
  },
  computed: {
    hasAddress() {
      return !!(this.order.address && this.order.address.name);
    },
    canReceive() {
      return this.order.platform_status === 'paid'
        && this.order.fulfillment === 'express'
        && this.order.fulfill_status === 'shipped';
    },
    canRefund() {
      const st = this.order.platform_status;
      return (st === 'paid' || st === 'settled')
        && this.order.refund_status !== 'refunded'
        && !(this.myRefund && ['applied', 'approved', 'refunding'].includes(this.myRefund.status));
    },
    itemLabels() {
      return this.items.map((i) => `${i.title}（${i.spec}）可退 ${i.num - i.refunded_num} 件`);
    },
  },
  onLoad(query) {
    this.orderId = Number(query.id || 0);
    this.load();
  },
  methods: {
    yuan,
    statusText: orderStatusText,
    refundStatusText: (s) => REFUND_STATUS_TEXT[s] || s,
    applyStatusText: (s) => REFUND_APPLY_STATUS_TEXT[s] || s,
    async load() {
      this.loading = true;
      this.error = '';
      try {
        const d = await shopApi.orderDetail(this.orderId);
        this.order = d.order || {};
        this.items = d.items || [];
        await this.loadMyRefund();
      } catch (e) {
        this.error = e.message || '加载失败';
      } finally {
        this.loading = false;
      }
    },
    async loadMyRefund() {
      try {
        const d = await shopApi.refunds();
        const hit = (d.items || []).find((r) => Number(r.order_id) === this.orderId);
        this.myRefund = hit || null;
      } catch (e) {
        this.myRefund = null;
      }
    },
    onPickItem(e) {
      this.refundItemIdx = Number(e.detail.value || 0);
    },
    async submitRefund() {
      const item = this.items[this.refundItemIdx];
      if (!item) return;
      const num = Number(this.refundForm.num || 0) || (item.num - item.refunded_num);
      if (!this.refundForm.reason) {
        uni.showToast({ title: '请填写退款原因', icon: 'none' });
        return;
      }
      try {
        await shopApi.applyRefund(this.orderId, {
          item_id: item.item_id, num, type: this.refundForm.type, reason: this.refundForm.reason,
        });
        uni.showToast({ title: '已提交，等待商家审核', icon: 'success' });
        this.refundForm.reason = '';
        this.refundForm.num = '';
        await this.load();
      } catch (e) {
        uni.showToast({ title: e.message || '提交失败', icon: 'none' });
      }
    },
    async cancelRefund() {
      if (!this.myRefund) return;
      try {
        await shopApi.cancelRefund(this.myRefund.refund_id);
        uni.showToast({ title: '已撤销', icon: 'success' });
        await this.load();
      } catch (e) {
        uni.showToast({ title: e.message || '撤销失败', icon: 'none' });
      }
    },
    async pay() {
      try {
        await shopApi.pay(this.orderId);
        // H5 在微信外无法调起支付参数；小程序端可拿返回参数直接 uni.requestPayment
        uni.showToast({ title: '请在微信内完成支付', icon: 'none' });
      } catch (e) {
        const msg = e.message || '支付失败';
        uni.showModal({
          title: '无法调起支付',
          content: `${msg}\n\n若商户号尚未配置，可用「模拟支付」先把发货/收货/售后流程跑通。`,
          confirmText: '模拟支付',
          success: async (r) => {
            if (!r.confirm) return;
            try {
              await shopApi.mockPay(this.orderId);
              uni.showToast({ title: '模拟支付成功', icon: 'success' });
              await this.load();
            } catch (err) {
              uni.showToast({ title: err.message || '模拟支付失败', icon: 'none' });
            }
          },
        });
      }
    },
    async cancelOrder() {
      try {
        await shopApi.cancelOrder(this.orderId);
        uni.showToast({ title: '订单已取消', icon: 'success' });
        await this.load();
      } catch (e) {
        uni.showToast({ title: e.message || '取消失败', icon: 'none' });
      }
    },
    async receive() {
      try {
        const r = await shopApi.receiveOrder(this.orderId);
        uni.showToast({ title: r.settled ? '已确认收货' : '已确认收货（结算待处理）', icon: 'success' });
        await this.load();
      } catch (e) {
        uni.showToast({ title: e.message || '确认收货失败', icon: 'none' });
      }
    },
    goOrders() {
      uni.navigateTo({ url: '/pages/shop/orders' });
    },
  },
};
</script>

<style scoped>
.od { min-height: 100vh; background: #fff6e9; padding-bottom: 160rpx; }
.state { padding: 160rpx 40rpx; text-align: center; color: #8a6b75; }
.retry { margin: 24rpx auto 0; width: 200rpx; padding: 14rpx 0; background: #e8336d; color: #fff; border-radius: 999rpx; }
.panel { background: #fff; margin: 16rpx; border-radius: 20rpx; padding: 24rpx; }
.status-panel { display: flex; flex-direction: column; }
.big-status { font-size: 36rpx; font-weight: 900; color: #e8336d; }
.sn { font-size: 24rpx; color: #b59aa1; margin-top: 8rpx; }
.sec-title { font-size: 28rpx; font-weight: 700; color: #a31245; margin-bottom: 16rpx; }
.line { display: flex; justify-content: space-between; padding: 10rpx 0; font-size: 26rpx; color: #3d2530; }
.line.total { border-top: 2rpx solid #fbefdd; margin-top: 8rpx; padding-top: 16rpx; font-weight: 700; }
.pay { color: #e8336d; font-size: 34rpx; font-weight: 900; }
.minus { color: #2fbf71; }
.sub { font-size: 24rpx; color: #8a6b75; }
.refunded { color: #e23a3a; }
.item { display: flex; padding: 16rpx 0; border-bottom: 2rpx solid #fbefdd; }
.item-img { width: 120rpx; height: 120rpx; border-radius: 12rpx; background: #f7ece1; }
.item-main { flex: 1; padding: 0 16rpx; min-width: 0; }
.item-title { font-size: 28rpx; color: #3d2530; font-weight: 600; }
.item-right { text-align: right; }
.item-price { display: block; color: #e8336d; font-weight: 800; font-size: 28rpx; }
.picker { border: 2rpx solid #f0dfc8; border-radius: 12rpx; padding: 16rpx 20rpx; font-size: 26rpx; color: #3d2530; margin-bottom: 12rpx; }
.ipt { border: 2rpx solid #f0dfc8; border-radius: 12rpx; padding: 16rpx 20rpx; margin-bottom: 12rpx; font-size: 26rpx; }
.btn-row { display: flex; gap: 16rpx; margin-top: 12rpx; }
.btn { flex: 1; text-align: center; padding: 20rpx 0; border-radius: 999rpx; font-size: 28rpx; font-weight: 800; }
.btn.ghost { background: #fff; color: #a31245; border: 2rpx solid #f0dfc8; }
.btn.primary { background: #e8336d; color: #fff; }
.footbar { position: fixed; left: 0; right: 0; bottom: 0; display: flex; gap: 16rpx; background: #fff; border-top: 2rpx solid #f0dfc8; padding: 16rpx 24rpx; }
</style>
