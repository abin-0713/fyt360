<template>
  <view class="detail">
    <view v-if="loading" class="state"><text>加载中…</text></view>
    <view v-else-if="error" class="state">
      <text>{{ error }}</text>
      <view class="retry" @click="load">重试</view>
    </view>

    <template v-else>
      <swiper v-if="imgs.length" class="gallery" indicator-dots circular>
        <swiper-item v-for="(img, i) in imgs" :key="i">
          <image class="gallery-img" :src="img" mode="aspectFill" />
        </swiper-item>
      </swiper>
      <view v-else class="gallery gallery-empty"><text>暂无图片</text></view>

      <view class="panel">
        <view class="price-row">
          <text class="price">{{ yuan(current ? current.price : goods.min_price) }}</text>
          <text v-if="goods.market_price" class="market">{{ yuan(goods.market_price) }}</text>
        </view>
        <view class="title">{{ goods.title }}</view>
        <view class="meta">
          <text v-if="goods.brand">{{ goods.brand }}</text>
          <text>已售 {{ goods.sales_count }}</text>
          <text>{{ deliveryText }}</text>
        </view>
      </view>

      <view class="panel">
        <view class="sec-title">选择规格</view>
        <view class="skus">
          <view
            v-for="s in goods.skus"
            :key="s.sku_id"
            :class="['sku', skuId === s.sku_id ? 'sku-on' : '', s.available <= 0 ? 'sku-disabled' : '']"
            @click="pickSku(s)"
          >
            <text class="sku-spec">{{ s.spec }}</text>
            <text class="sku-price">{{ yuan(s.price) }}<text v-if="s.available <= 0" class="sku-sold"> 已售罄</text></text>
          </view>
        </view>

        <view class="qty-row">
          <text class="sec-title">数量</text>
          <view class="qty">
            <view class="qty-btn" @click="num > 1 && num--">-</view>
            <text class="qty-num">{{ num }}</text>
            <view class="qty-btn" @click="inc">+</view>
          </view>
        </view>
      </view>

      <view v-if="goods.detail_html" class="panel">
        <view class="sec-title">商品详情</view>
        <rich-text :nodes="goods.detail_html" />
      </view>
      <view v-else-if="detailImgs.length" class="panel">
        <view class="sec-title">商品详情</view>
        <image v-for="(img, i) in detailImgs" :key="i" class="detail-img" :src="img" mode="widthFix" />
      </view>

      <view class="footbar">
        <view class="foot-btn ghost" @click="go('/pages/shop/cart')">购物车</view>
        <view class="foot-btn ghost" @click="addCart">加入购物车</view>
        <view class="foot-btn primary" @click="buyNow">立即购买</view>
      </view>
    </template>
  </view>
</template>

<script>
import { shopApi, yuan } from '../../utils/shop';

const DELIVERY_TEXT = { express: '快递发货', group: '到店核销', virtual: '虚拟卡券·自动发放' };

export default {
  data() {
    return {
      goodsId: 0,
      goods: { skus: [] },
      imgs: [],
      detailImgs: [],
      skuId: 0,
      num: 1,
      loading: true,
      error: '',
    };
  },
  computed: {
    current() {
      return (this.goods.skus || []).find((s) => s.sku_id === this.skuId) || null;
    },
    deliveryText() {
      return DELIVERY_TEXT[this.goods.delivery_type] || '';
    },
  },
  onLoad(query) {
    this.goodsId = Number(query.id || 0);
    this.load();
  },
  methods: {
    yuan,
    async load() {
      this.loading = true;
      this.error = '';
      try {
        const d = await shopApi.goodsDetail(this.goodsId);
        this.goods = d;
        this.imgs = Array.isArray(d.main_imgs) ? d.main_imgs.filter(Boolean) : [];
        this.detailImgs = Array.isArray(d.detail_imgs) ? d.detail_imgs.filter(Boolean) : [];
        const first = (d.skus || []).find((s) => s.available > 0) || (d.skus || [])[0];
        this.skuId = first ? first.sku_id : 0;
      } catch (e) {
        this.error = e.message || '加载失败';
      } finally {
        this.loading = false;
      }
    },
    pickSku(s) {
      if (s.available <= 0) {
        uni.showToast({ title: '该规格已售罄', icon: 'none' });
        return;
      }
      this.skuId = s.sku_id;
      if (this.num > s.available) this.num = s.available;
    },
    inc() {
      const max = this.current ? this.current.available : 999;
      if (this.num >= Math.min(max, 999)) {
        uni.showToast({ title: '已达可购上限', icon: 'none' });
        return;
      }
      this.num += 1;
    },
    guard() {
      if (!this.skuId) {
        uni.showToast({ title: '请选择规格', icon: 'none' });
        return false;
      }
      if (this.current && this.current.available <= 0) {
        uni.showToast({ title: '该规格已售罄', icon: 'none' });
        return false;
      }
      return true;
    },
    async addCart() {
      if (!this.guard()) return;
      try {
        await shopApi.cartAdd({ sku_id: this.skuId, num: this.num });
        uni.showToast({ title: '已加入购物车', icon: 'success' });
      } catch (e) {
        uni.showToast({ title: e.message || '加入失败', icon: 'none' });
      }
    },
    buyNow() {
      if (!this.guard()) return;
      uni.navigateTo({
        url: `/pages/shop/confirm?sku_id=${this.skuId}&num=${this.num}&goods_id=${this.goodsId}`,
      });
    },
    go(url) {
      uni.navigateTo({ url });
    },
  },
};
</script>

<style scoped>
.detail { min-height: 100vh; background: #fff6e9; padding-bottom: 130rpx; }
.state { padding: 160rpx 40rpx; text-align: center; color: #8a6b75; }
.retry { margin: 24rpx auto 0; width: 200rpx; padding: 14rpx 0; background: #e8336d; color: #fff; border-radius: 999rpx; }
.gallery { width: 100%; height: 640rpx; background: #f7ece1; }
.gallery-img { width: 100%; height: 640rpx; }
.gallery-empty { display: flex; align-items: center; justify-content: center; color: #b59aa1; }
.panel { background: #fff; margin: 16rpx; border-radius: 20rpx; padding: 24rpx; box-shadow: 0 3rpx 0 0 rgba(163,18,69,.12); }
.price-row { display: flex; align-items: baseline; }
.price { color: #e8336d; font-size: 48rpx; font-weight: 900; }
.market { margin-left: 16rpx; color: #b59aa1; font-size: 26rpx; text-decoration: line-through; }
.title { margin-top: 12rpx; font-size: 32rpx; font-weight: 700; color: #3d2530; line-height: 1.5; }
.meta { margin-top: 12rpx; display: flex; gap: 24rpx; color: #b59aa1; font-size: 24rpx; }
.sec-title { font-size: 28rpx; font-weight: 700; color: #a31245; margin-bottom: 16rpx; }
.skus { display: flex; flex-wrap: wrap; }
.sku {
  border: 2rpx solid #f0dfc8; border-radius: 14rpx; padding: 12rpx 20rpx; margin: 0 16rpx 16rpx 0;
  display: flex; flex-direction: column; min-width: 160rpx;
}
.sku-on { border-color: #e8336d; background: #ffeaf1; }
.sku-disabled { opacity: .45; }
.sku-spec { font-size: 26rpx; color: #3d2530; }
.sku-price { font-size: 24rpx; color: #e8336d; margin-top: 4rpx; }
.sku-sold { color: #b59aa1; }
.qty-row { display: flex; align-items: center; justify-content: space-between; }
.qty-row .sec-title { margin-bottom: 0; }
.qty { display: flex; align-items: center; }
.qty-btn { width: 56rpx; height: 56rpx; line-height: 52rpx; text-align: center; border: 2rpx solid #f0dfc8; border-radius: 12rpx; color: #a31245; font-size: 32rpx; }
.qty-num { width: 80rpx; text-align: center; font-size: 28rpx; }
.detail-img { width: 100%; margin-top: 12rpx; border-radius: 12rpx; }
.footbar { position: fixed; left: 0; right: 0; bottom: 0; display: flex; background: #fff; border-top: 2rpx solid #f0dfc8; }
.foot-btn { flex: 1; text-align: center; padding: 26rpx 0; font-size: 28rpx; }
.foot-btn.ghost { color: #a31245; font-weight: 700; }
.foot-btn.primary { background: #e8336d; color: #fff; font-weight: 800; }
</style>
