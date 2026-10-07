<template>
  <view class="shop">
    <view class="hero">
      <text class="hero-title">商城</text>
      <input
        v-model="keyword"
        class="search"
        placeholder="搜索商品"
        confirm-type="search"
        @confirm="reload"
      />
    </view>

    <scroll-view class="cats" scroll-x>
      <view :class="['cat', categoryId === null ? 'cat-on' : '']" @click="pickCat(null)">全部</view>
      <view
        v-for="c in cats"
        :key="c.category_id"
        :class="['cat', categoryId === c.category_id ? 'cat-on' : '']"
        @click="pickCat(c.category_id)"
      >{{ c.name }}</view>
    </scroll-view>

    <view v-if="loading" class="state"><text>加载中…</text></view>
    <view v-else-if="error" class="state">
      <text>{{ error }}</text>
      <view class="retry" @click="reload">重试</view>
    </view>
    <view v-else-if="!items.length" class="state"><text>该分类下暂无商品</text></view>

    <view v-else class="grid">
      <view v-for="g in items" :key="g.goods_id" class="card" @click="openGoods(g.goods_id)">
        <image class="thumb" :src="g.image" mode="aspectFill" />
        <view class="card-title">{{ g.title }}</view>
        <view class="card-price">
          <text class="price">{{ yuan(g.min_price) }}</text>
          <text v-if="g.max_price > g.min_price" class="price-from">起</text>
        </view>
        <view class="card-meta">
          <text>已售 {{ g.sales_count }}</text>
          <text v-if="g.available <= 5" class="warn">仅剩 {{ g.available }}</text>
        </view>
      </view>
    </view>

    <view v-if="hasMore && items.length" class="more" @click="loadMore">
      <text>{{ loadingMore ? '加载中…' : '加载更多' }}</text>
    </view>

    <view class="footbar">
      <view class="foot-btn" @click="go('/pages/shop/cart')">购物车</view>
      <view class="foot-btn" @click="go('/pages/shop/orders')">我的订单</view>
    </view>
  </view>
</template>

<script>
import { shopApi, yuan } from '../../utils/shop';

export default {
  data() {
    return {
      cats: [],
      categoryId: null,
      keyword: '',
      items: [],
      page: 1,
      size: 10,
      total: 0,
      hasMore: false,
      loading: true,
      loadingMore: false,
      error: '',
    };
  },
  onLoad() {
    this.loadCats();
    this.reload();
  },
  // 页面级上拉加载（H5/小程序均支持）
  onReachBottom() {
    this.loadMore();
  },
  methods: {
    yuan,
    async loadCats() {
      try {
        const d = await shopApi.categories();
        // 只把一级分类平铺出来（二级通过点进一级分类命中，见后端 /goods 的子分类命中逻辑）
        this.cats = (d.flat || []).filter((c) => !c.parent_id);
      } catch (e) {
        // 分类失败不阻塞商品列表
        this.cats = [];
      }
    },
    async fetch(page) {
      const d = await shopApi.goodsList({
        page,
        size: this.size,
        category_id: this.categoryId,
        keyword: this.keyword,
      });
      this.total = d.total;
      if (page === 1) this.items = d.items;
      else this.items = this.items.concat(d.items);
      this.hasMore = this.items.length < d.total;
      this.page = page;
    },
    async reload() {
      this.loading = true;
      this.error = '';
      try {
        await this.fetch(1);
      } catch (e) {
        this.error = e.message || '加载失败';
      } finally {
        this.loading = false;
      }
    },
    async loadMore() {
      if (!this.hasMore || this.loadingMore || this.loading) return;
      this.loadingMore = true;
      try {
        await this.fetch(this.page + 1);
      } catch (e) {
        uni.showToast({ title: e.message || '加载失败', icon: 'none' });
      } finally {
        this.loadingMore = false;
      }
    },
    pickCat(id) {
      this.categoryId = id;
      this.reload();
    },
    openGoods(id) {
      uni.navigateTo({ url: `/pages/shop/detail?id=${id}` });
    },
    go(url) {
      uni.navigateTo({ url });
    },
  },
};
</script>

<style scoped>
.shop { min-height: 100vh; background: #fff6e9; padding-bottom: 120rpx; }
.hero { padding: 32rpx 24rpx 16rpx; }
.hero-title { font-size: 44rpx; font-weight: 900; color: #a31245; }
.search {
  margin-top: 20rpx; background: #fff; border-radius: 999rpx;
  padding: 18rpx 28rpx; font-size: 26rpx; color: #a31245;
  border: 2rpx solid #f0dfc8;
}
.cats { white-space: nowrap; padding: 8rpx 16rpx 0; }
.cat {
  display: inline-block; margin: 8rpx; padding: 10rpx 28rpx;
  background: #fff; border-radius: 999rpx; font-size: 26rpx; color: #8a6b75;
  border: 2rpx solid #f0dfc8;
}
.cat-on { background: #e8336d; color: #fff; border-color: #e8336d; font-weight: 700; }
.state { padding: 120rpx 40rpx; text-align: center; color: #8a6b75; font-size: 28rpx; }
.retry { margin: 24rpx auto 0; width: 200rpx; padding: 14rpx 0; background: #e8336d; color: #fff; border-radius: 999rpx; }
.grid { display: flex; flex-wrap: wrap; padding: 8rpx 16rpx; }
.card {
  width: calc(50% - 16rpx); margin: 8rpx; background: #fff; border-radius: 20rpx;
  overflow: hidden; box-shadow: 0 3rpx 0 0 #a31245, 0 8rpx 24rpx rgba(163,18,69,.08);
}
.thumb { width: 100%; height: 320rpx; background: #f7ece1; }
.card-title { font-size: 28rpx; color: #3d2530; padding: 14rpx 16rpx 0; font-weight: 600;
  overflow: hidden; text-overflow: ellipsis; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; }
.card-price { padding: 8rpx 16rpx 0; }
.price { color: #e8336d; font-size: 34rpx; font-weight: 900; }
.price-from { color: #b59aa1; font-size: 22rpx; margin-left: 6rpx; }
.card-meta { display: flex; justify-content: space-between; padding: 6rpx 16rpx 16rpx; color: #b59aa1; font-size: 22rpx; }
.warn { color: #e23a3a; }
.more { text-align: center; padding: 24rpx; color: #8a6b75; font-size: 26rpx; }
.footbar {
  position: fixed; left: 0; right: 0; bottom: 0; display: flex;
  background: #fff; border-top: 2rpx solid #f0dfc8;
}
.foot-btn { flex: 1; text-align: center; padding: 26rpx 0; color: #a31245; font-weight: 700; font-size: 28rpx; }
</style>
