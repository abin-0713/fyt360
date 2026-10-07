<template>
  <view class="cart">
    <view v-if="loading" class="state"><text>加载中…</text></view>
    <view v-else-if="!items.length" class="state">
      <text>购物车还是空的</text>
      <view class="retry" @click="goShop">去逛逛</view>
    </view>

    <template v-else>
      <view v-for="it in items" :key="it.cart_id" :class="['row', it.invalid ? 'row-invalid' : '']">
        <view class="check" @click="toggle(it)">
          <text>{{ it.selected && !it.invalid ? '☑' : '☐' }}</text>
        </view>
        <image class="row-img" :src="it.image" mode="aspectFill" />
        <view class="row-main">
          <view class="row-title">{{ it.title }}</view>
          <view class="row-spec">{{ it.spec }}</view>
          <view v-if="it.invalid" class="row-bad">{{ it.invalid_reason }}</view>
          <view class="row-bottom">
            <text class="row-price">{{ yuan(it.price) }}</text>
            <view v-if="!it.invalid" class="qty">
              <view class="qty-btn" @click="changeNum(it, it.num - 1)">-</view>
              <text class="qty-num">{{ it.num }}</text>
              <view class="qty-btn" @click="changeNum(it, it.num + 1)">+</view>
            </view>
          </view>
        </view>
        <view class="del" @click="remove(it)">删除</view>
      </view>

      <view class="footbar">
        <view class="all" @click="toggleAll">
          <text>{{ allSelected ? '☑' : '☐' }} 全选</text>
        </view>
        <view class="sum">
          <text class="sum-label">合计</text>
          <text class="sum-price">{{ yuan(summary.goods_amount) }}</text>
        </view>
        <view class="submit" @click="checkout">去结算({{ summary.selected_count }})</view>
      </view>
    </template>
  </view>
</template>

<script>
import { shopApi, yuan } from '../../utils/shop';

export default {
  data() {
    return {
      items: [],
      summary: { total: 0, selected_count: 0, selected_qty: 0, goods_amount: 0 },
      loading: true,
    };
  },
  computed: {
    allSelected() {
      const valid = this.items.filter((i) => !i.invalid);
      return valid.length > 0 && valid.every((i) => i.selected);
    },
  },
  onShow() {
    this.load();
  },
  methods: {
    yuan,
    async load() {
      this.loading = true;
      try {
        const d = await shopApi.cart();
        this.items = d.items || [];
        this.summary = d.summary || this.summary;
      } catch (e) {
        uni.showToast({ title: e.message || '加载失败', icon: 'none' });
      } finally {
        this.loading = false;
      }
    },
    async toggle(it) {
      if (it.invalid) return;
      try {
        await shopApi.cartPatch(it.cart_id, { selected: !it.selected });
        await this.load();
      } catch (e) {
        uni.showToast({ title: e.message || '操作失败', icon: 'none' });
      }
    },
    async toggleAll() {
      try {
        await shopApi.cartSelectAll(!this.allSelected);
        await this.load();
      } catch (e) {
        uni.showToast({ title: e.message || '操作失败', icon: 'none' });
      }
    },
    async changeNum(it, num) {
      if (num < 1) return this.remove(it);
      if (num > it.available) {
        uni.showToast({ title: `最多可购 ${it.available} 件`, icon: 'none' });
        return;
      }
      try {
        await shopApi.cartPatch(it.cart_id, { num });
        await this.load();
      } catch (e) {
        uni.showToast({ title: e.message || '操作失败', icon: 'none' });
      }
    },
    remove(it) {
      uni.showModal({
        title: '删除商品',
        content: `确定从购物车移除「${it.title}」？`,
        success: async (r) => {
          if (!r.confirm) return;
          try {
            await shopApi.cartDel(it.cart_id);
            await this.load();
          } catch (e) {
            uni.showToast({ title: e.message || '删除失败', icon: 'none' });
          }
        },
      });
    },
    checkout() {
      const valid = this.items.filter((i) => !i.invalid && i.selected);
      if (!valid.length) {
        uni.showToast({ title: '请先勾选商品', icon: 'none' });
        return;
      }
      uni.navigateTo({ url: '/pages/shop/confirm?from_cart=1' });
    },
    goShop() {
      uni.navigateTo({ url: '/pages/shop/index' });
    },
  },
};
</script>

<style scoped>
.cart { min-height: 100vh; background: #fff6e9; padding: 16rpx 0 140rpx; }
.state { padding: 160rpx 40rpx; text-align: center; color: #8a6b75; }
.retry { margin: 24rpx auto 0; width: 200rpx; padding: 14rpx 0; background: #e8336d; color: #fff; border-radius: 999rpx; }
.row { display: flex; align-items: center; background: #fff; margin: 12rpx 16rpx; border-radius: 18rpx; padding: 20rpx; }
.row-invalid { opacity: .6; }
.check { width: 60rpx; font-size: 34rpx; color: #e8336d; text-align: center; }
.row-img { width: 140rpx; height: 140rpx; border-radius: 12rpx; background: #f7ece1; }
.row-main { flex: 1; padding: 0 16rpx; min-width: 0; }
.row-title { font-size: 28rpx; color: #3d2530; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.row-spec { font-size: 24rpx; color: #b59aa1; margin-top: 6rpx; }
.row-bad { font-size: 24rpx; color: #e23a3a; margin-top: 6rpx; }
.row-bottom { display: flex; align-items: center; justify-content: space-between; margin-top: 12rpx; }
.row-price { color: #e8336d; font-weight: 800; font-size: 30rpx; }
.qty { display: flex; align-items: center; }
.qty-btn { width: 48rpx; height: 48rpx; line-height: 44rpx; text-align: center; border: 2rpx solid #f0dfc8; border-radius: 10rpx; color: #a31245; }
.qty-num { width: 64rpx; text-align: center; font-size: 26rpx; }
.del { font-size: 24rpx; color: #b59aa1; padding: 8rpx; }
.footbar { position: fixed; left: 0; right: 0; bottom: 0; display: flex; align-items: center; background: #fff; border-top: 2rpx solid #f0dfc8; padding: 12rpx 20rpx; }
.all { font-size: 26rpx; color: #a31245; }
.sum { flex: 1; text-align: right; padding-right: 20rpx; }
.sum-label { font-size: 24rpx; color: #8a6b75; }
.sum-price { color: #e8336d; font-weight: 900; font-size: 34rpx; margin-left: 8rpx; }
.submit { background: #e8336d; color: #fff; font-weight: 800; padding: 20rpx 36rpx; border-radius: 999rpx; font-size: 28rpx; }
</style>
