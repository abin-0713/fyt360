<template>
  <view class="confirm">
    <!-- 收货地址：快递单必填；到店核销/虚拟单不需要 -->
    <view v-if="needAddress" class="panel addr">
      <view class="sec-title">收货地址</view>
      <view v-if="addresses.length">
        <view
          v-for="a in addresses"
          :key="a.id"
          :class="['addr-row', addressId === a.id ? 'addr-on' : '']"
          @click="pickAddress(a)"
        >
          <view class="addr-main">
            <text class="addr-name">{{ a.name }}</text>
            <text class="addr-phone">{{ a.phone }}</text>
            <text v-if="a.is_default" class="addr-tag">默认</text>
          </view>
          <view class="addr-detail">{{ a.region }} {{ a.detail }}</view>
        </view>
      </view>
      <view v-else class="addr-form">
        <view class="form-hint">还没有收货地址，先填一个：</view>
        <input v-model="form.name" class="ipt" placeholder="收货人姓名" />
        <input v-model="form.phone" class="ipt" placeholder="手机号" type="number" />
        <input v-model="form.region" class="ipt" placeholder="省市区（如 江苏省南京市玄武区）" />
        <input v-model="form.detail" class="ipt" placeholder="详细地址" />
        <view class="save-addr" @click="saveAddress">保存并使用</view>
      </view>
    </view>

    <!-- 商品清单与试算结果 -->
    <view class="panel">
      <view class="sec-title">订单明细</view>
      <view v-for="(it, i) in items" :key="i" class="item">
        <text class="item-title">{{ it.title }}</text>
        <text class="item-spec">{{ it.spec }} × {{ it.num }}</text>
      </view>
      <view class="line coupon-row" @click="toggleCoupons">
        <text>优惠券</text>
        <text class="coupon-val">
          <text v-if="selectedCoupon" class="minus">-{{ yuan(selectedCoupon.discount) }}</text>
          <text v-else-if="coupons.length">{{ coupons.length }} 张可用 ›</text>
          <text v-else class="muted">暂无可用 ›</text>
        </text>
      </view>
      <view v-if="showCoupons" class="coupon-list">
        <view class="coupon-item" :class="{ on: !couponId }" @click="pickCoupon(null)">不使用优惠券</view>
        <view
          v-for="c in coupons"
          :key="c.user_coupon_id"
          class="coupon-item"
          :class="{ on: couponId === c.user_coupon_id }"
          @click="pickCoupon(c)"
        >
          <text>{{ c.name }}</text>
          <text class="coupon-discount">-{{ yuan(c.discount) }}</text>
        </view>
      </view>
      <view class="line"><text>商品金额</text><text>{{ yuan(quote.goods_amount) }}</text></view>
      <view class="line"><text>运费</text><text>{{ yuan(quote.freight) }}</text></view>
      <view v-if="quote.discount" class="line"><text>优惠</text><text class="minus">-{{ yuan(quote.discount) }}</text></view>
      <view class="line total"><text>应付</text><text class="pay">{{ yuan(quote.pay_price) }}</text></view>
      <view v-if="quoteError" class="quote-err">{{ quoteError }}</view>
    </view>

    <view class="footbar">
      <view class="sum">
        <text class="sum-label">应付</text>
        <text class="sum-price">{{ yuan(quote.pay_price) }}</text>
      </view>
      <view :class="['submit', submitting ? 'submit-disabled' : '']" @click="submit">
        {{ submitting ? '提交中…' : '提交订单' }}
      </view>
    </view>
  </view>
</template>

<script>
import { shopApi, yuan } from '../../utils/shop';

export default {
  data() {
    return {
      fromCart: false,
      skuId: 0,
      goodsId: 0,
      num: 1,
      items: [],
      addresses: [],
      addressId: 0,
      needAddress: true,
      quote: { goods_amount: 0, freight: 0, discount: 0, pay_price: 0 },
      coupons: [],
      couponId: 0,
      showCoupons: false,
      quoteError: '',
      submitting: false,
      buyNowCache: null,
      form: { name: '', phone: '', region: '', detail: '' },
    };
  },
  computed: {
    selectedCoupon() {
      return this.coupons.find((c) => c.user_coupon_id === this.couponId) || null;
    },
  },
  onLoad(query) {
    this.fromCart = String(query.from_cart || '') === '1';
    this.skuId = Number(query.sku_id || 0);
    this.goodsId = Number(query.goods_id || 0);
    this.num = Number(query.num || 1);
    if (!this.fromCart && this.skuId) this.loadBuyNowItem();
    this.init();
  },
  methods: {
    yuan,
    async init() {
      await this.loadAddresses();
      await this.requote();
    },
    async loadAddresses() {
      try {
        const d = await shopApi.addresses();
        this.addresses = Array.isArray(d) ? d : (d.items || []);
        const def = this.addresses.find((a) => a.is_default) || this.addresses[0];
        if (def) this.addressId = def.id;
      } catch (e) {
        this.addresses = [];
      }
    },
    /** 立即购买：拉商品详情取出该 SKU 的标题/规格，仅用于明细展示（下单仍以 sku_id 为准） */
    async loadBuyNowItem() {
      if (!this.goodsId) return;
      try {
        const g = await shopApi.goodsDetail(this.goodsId);
        const sku = (g.skus || []).find((s) => s.sku_id === this.skuId);
        this.buyNowCache = { title: g.title, spec: sku ? sku.spec : '', num: this.num };
      } catch (e) { /* 仅展示用 */ }
    },
    pickAddress(a) {
      this.addressId = a.id;
      this.requote();
    },
    async saveAddress() {
      const f = this.form;
      if (!f.name || !f.phone || !f.region || !f.detail) {
        uni.showToast({ title: '请填写完整地址', icon: 'none' });
        return;
      }
      try {
        const r = await shopApi.createAddress({ ...f, is_default: true });
        uni.showToast({ title: '地址已保存', icon: 'success' });
        await this.loadAddresses();
        if (r && r.id) this.addressId = r.id;
        await this.requote();
      } catch (e) {
        uni.showToast({ title: e.message || '保存失败', icon: 'none' });
      }
    },
    body() {
      const base = this.fromCart
        ? { from_cart: 1, address_id: this.addressId || undefined }
        : { items: [{ sku_id: this.skuId, num: this.num }], address_id: this.addressId || undefined };
      if (this.couponId) base.user_coupon_id = this.couponId;
      return base;
    },
    toggleCoupons() {
      this.showCoupons = !this.showCoupons;
    },
    async pickCoupon(c) {
      this.couponId = c ? c.user_coupon_id : 0;
      this.showCoupons = false;
      await this.requote();
    },
    /** 拉可用券（用当前商品额算门槛与可减额，与下单同口径） */
    async loadCoupons() {
      try {
        const d = await shopApi.coupons(this.quote.goods_amount || 0);
        this.coupons = d.items || [];
      } catch (e) {
        this.coupons = [];
      }
    },
    async requote() {
      this.quoteError = '';
      try {
        const q = await shopApi.checkout(this.body());
        this.quote = q;
        // 没选券时刷新可用券列表（商品额可能变化，门槛/可减额跟着变）
        if (!this.couponId) await this.loadCoupons();
      } catch (e) {
        const msg = e.message || '试算失败';
        // 快递单没选地址时后端会明确报错，这里给出可操作提示而不是甩英文
        this.quoteError = msg.includes('收货地址') ? '请先选择收货地址' : msg;
      }
      // 明细展示：购物车结算取勾选项；立即购买取该 SKU 的标题/规格
      try {
        if (this.fromCart) {
          const c = await shopApi.cart();
          this.items = (c.items || [])
            .filter((i) => i.selected && !i.invalid)
            .map((i) => ({ title: i.title, spec: i.spec, num: i.num }));
        } else if (this.buyNowCache) {
          this.items = [this.buyNowCache];
        }
      } catch (e) { /* 明细仅展示用，失败不影响下单 */ }
    },
    async submit() {
      if (this.submitting) return;
      this.submitting = true;
      try {
        const o = await shopApi.createOrder(this.body());
        uni.showToast({ title: '下单成功', icon: 'success' });
        setTimeout(() => {
          uni.redirectTo({ url: `/pages/shop/order-detail?id=${o.order_id}&pay=1` });
        }, 600);
      } catch (e) {
        uni.showToast({ title: e.message || '下单失败', icon: 'none' });
      } finally {
        this.submitting = false;
      }
    },
  },
};
</script>

<style scoped>
.confirm { min-height: 100vh; background: #fff6e9; padding: 16rpx 0 160rpx; }
.panel { background: #fff; margin: 16rpx; border-radius: 20rpx; padding: 24rpx; }
.sec-title { font-size: 28rpx; font-weight: 700; color: #a31245; margin-bottom: 16rpx; }
.addr-row { border: 2rpx solid #f0dfc8; border-radius: 14rpx; padding: 18rpx; margin-bottom: 14rpx; }
.addr-on { border-color: #e8336d; background: #ffeaf1; }
.addr-main { display: flex; align-items: center; gap: 16rpx; }
.addr-name { font-size: 28rpx; font-weight: 700; color: #3d2530; }
.addr-phone { font-size: 26rpx; color: #8a6b75; }
.addr-tag { font-size: 20rpx; background: #ffaa1d; color: #5c3200; border-radius: 6rpx; padding: 0 8rpx; }
.addr-detail { margin-top: 8rpx; font-size: 26rpx; color: #8a6b75; }
.addr-form .form-hint { font-size: 26rpx; color: #8a6b75; margin-bottom: 12rpx; }
.ipt { border: 2rpx solid #f0dfc8; border-radius: 12rpx; padding: 16rpx 20rpx; margin-bottom: 12rpx; font-size: 26rpx; }
.save-addr { background: #ffaa1d; color: #5c3200; font-weight: 800; text-align: center; padding: 18rpx 0; border-radius: 999rpx; margin-top: 8rpx; }
.item { display: flex; justify-content: space-between; padding: 10rpx 0; font-size: 26rpx; color: #3d2530; }
.item-spec { color: #b59aa1; }
.line { display: flex; justify-content: space-between; padding: 12rpx 0; font-size: 26rpx; color: #8a6b75; border-top: 2rpx solid #fbefdd; }
.line.total { color: #3d2530; font-weight: 700; }
.pay { color: #e8336d; font-size: 34rpx; font-weight: 900; }
.minus { color: #2fbf71; }
.quote-err { margin-top: 12rpx; color: #e23a3a; font-size: 24rpx; }
.coupon-row { align-items: center; }
.coupon-val { color: #e8336d; font-size: 26rpx; }
.coupon-val .muted { color: #b59aa1; }
.coupon-list { border: 2rpx solid #fbefdd; border-radius: 12rpx; margin: 8rpx 0; max-height: 420rpx; overflow-y: auto; }
.coupon-item { display: flex; justify-content: space-between; padding: 18rpx 20rpx; font-size: 26rpx; color: #3d2530; border-bottom: 2rpx solid #fbefdd; }
.coupon-item:last-child { border-bottom: none; }
.coupon-item.on { background: #ffeaf1; color: #e8336d; font-weight: 700; }
.coupon-discount { color: #e8336d; font-weight: 800; }
.footbar { position: fixed; left: 0; right: 0; bottom: 0; display: flex; align-items: center; background: #fff; border-top: 2rpx solid #f0dfc8; padding: 12rpx 20rpx; }
.sum { flex: 1; }
.sum-label { font-size: 24rpx; color: #8a6b75; }
.sum-price { color: #e8336d; font-weight: 900; font-size: 34rpx; margin-left: 8rpx; }
.submit { background: #e8336d; color: #fff; font-weight: 800; padding: 20rpx 44rpx; border-radius: 999rpx; font-size: 28rpx; }
.submit-disabled { opacity: .6; }
</style>
