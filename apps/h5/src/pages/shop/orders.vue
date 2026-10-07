<template>
  <view class="orders">
    <view class="tabs">
      <view
        v-for="t in tabs"
        :key="t.value"
        :class="['tab', status === t.value ? 'tab-on' : '']"
        @click="pick(t.value)"
      >{{ t.label }}</view>
    </view>

    <view v-if="loading" class="state"><text>加载中…</text></view>
    <view v-else-if="!items.length" class="state">
      <text>还没有商城订单</text>
      <view class="retry" @click="goShop">去逛逛</view>
    </view>

    <view v-else>
      <view v-for="o in items" :key="o.order_id" class="card" @click="open(o.order_id)">
        <view class="card-top">
          <text class="sn">{{ o.order_sn }}</text>
          <text :class="['status', o.platform_status === 'created' ? 'status-warn' : '']">{{ statusText(o) }}</text>
        </view>
        <view class="card-mid">
          <text class="meta">{{ o.item_count }} 种商品 · 共 {{ o.total_qty }} 件</text>
          <text class="amount">{{ yuan(o.pay_price) }}</text>
        </view>
        <view class="card-bottom">
          <text class="meta">{{ o.created_at }}</text>
          <text v-if="o.fulfillment === 'express' && o.fulfill_status === 'shipped'" class="hint">已发货</text>
          <text v-else-if="o.fulfillment === 'virtual'" class="hint">虚拟卡券</text>
        </view>
      </view>
      <view v-if="hasMore" class="more" @click="loadMore">加载更多</view>
    </view>
  </view>
</template>

<script>
import { shopApi, yuan, orderStatusText } from '../../utils/shop';

export default {
  data() {
    return {
      tabs: [
        { label: '全部', value: '' },
        { label: '待支付', value: 'created' },
        { label: '已付款', value: 'paid' },
        { label: '已完成', value: 'settled' },
        { label: '已关闭', value: 'closed' },
      ],
      status: '',
      items: [],
      page: 1,
      size: 10,
      total: 0,
      loading: true,
    };
  },
  computed: {
    hasMore() {
      return this.items.length < this.total;
    },
  },
  onShow() {
    this.reload();
  },
  onReachBottom() {
    this.loadMore();
  },
  methods: {
    yuan,
    statusText: orderStatusText,
    pick(v) {
      this.status = v;
      this.reload();
    },
    async fetch(page) {
      const d = await shopApi.orders({ page, size: this.size, status: this.status });
      this.total = d.total;
      this.items = page === 1 ? d.items : this.items.concat(d.items);
      this.page = page;
    },
    async reload() {
      this.loading = true;
      try {
        await this.fetch(1);
      } catch (e) {
        uni.showToast({ title: e.message || '加载失败', icon: 'none' });
      } finally {
        this.loading = false;
      }
    },
    async loadMore() {
      if (!this.hasMore) return;
      try {
        await this.fetch(this.page + 1);
      } catch (e) { /* 忽略 */ }
    },
    open(id) {
      uni.navigateTo({ url: `/pages/shop/order-detail?id=${id}` });
    },
    goShop() {
      uni.navigateTo({ url: '/pages/shop/index' });
    },
  },
};
</script>

<style scoped>
.orders { min-height: 100vh; background: #fff6e9; padding-bottom: 40rpx; }
.tabs { display: flex; background: #fff; border-bottom: 2rpx solid #f0dfc8; }
.tab { flex: 1; text-align: center; padding: 22rpx 0; font-size: 26rpx; color: #8a6b75; }
.tab-on { color: #e8336d; font-weight: 800; border-bottom: 4rpx solid #e8336d; }
.state { padding: 160rpx 40rpx; text-align: center; color: #8a6b75; }
.retry { margin: 24rpx auto 0; width: 200rpx; padding: 14rpx 0; background: #e8336d; color: #fff; border-radius: 999rpx; }
.card { background: #fff; margin: 16rpx; border-radius: 20rpx; padding: 24rpx; }
.card-top { display: flex; justify-content: space-between; align-items: center; }
.sn { font-size: 24rpx; color: #b59aa1; }
.status { font-size: 26rpx; color: #e8336d; font-weight: 800; }
.status-warn { color: #ff9f1c; }
.card-mid { display: flex; justify-content: space-between; align-items: baseline; margin-top: 16rpx; }
.meta { font-size: 24rpx; color: #8a6b75; }
.amount { font-size: 34rpx; font-weight: 900; color: #3d2530; }
.card-bottom { display: flex; justify-content: space-between; margin-top: 12rpx; }
.hint { font-size: 24rpx; color: #2fbf71; }
.more { text-align: center; padding: 24rpx; color: #8a6b75; font-size: 26rpx; }
</style>
