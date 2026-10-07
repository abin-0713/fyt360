<template>
  <div class="shop-orders">
    <div class="toolbar">
      <el-input v-model="q.keyword" placeholder="订单号" clearable style="width: 220px" @keyup.enter="load(1)" />
      <el-select v-model="q.status" placeholder="支付状态" clearable style="width: 140px" @change="load(1)">
        <el-option label="待支付" value="created" />
        <el-option label="已付款" value="paid" />
        <el-option label="已完成" value="settled" />
        <el-option label="已关闭" value="closed" />
      </el-select>
      <el-select v-model="q.fulfillment" placeholder="履约方式" clearable style="width: 140px" @change="load(1)">
        <el-option label="快递" value="express" />
        <el-option label="到店核销" value="group" />
        <el-option label="虚拟卡券" value="virtual" />
      </el-select>
      <el-button type="primary" @click="load(1)">查询</el-button>
      <el-button @click="load()">刷新</el-button>
    </div>

    <el-table :data="rows" v-loading="loading" stripe size="small" style="margin-top: 12px">
      <el-table-column label="订单号" min-width="190">
        <template #default="{ row }">
          <el-button link type="primary" @click="openDetail(row)">{{ row.order_sn }}</el-button>
        </template>
      </el-table-column>
      <el-table-column label="金额" width="100"><template #default="{ row }">¥{{ row.pay_price }}</template></el-table-column>
      <el-table-column label="商品" width="110"><template #default="{ row }">{{ row.item_count }} 种 / {{ row.total_qty }} 件</template></el-table-column>
      <el-table-column label="收件人" width="150">
        <template #default="{ row }">
          <span v-if="row.receiver && row.receiver.name">{{ row.receiver.name }} {{ row.receiver.phone }}</span>
          <span v-else class="muted">—</span>
        </template>
      </el-table-column>
      <el-table-column label="履约" width="100">
        <template #default="{ row }">{{ DELIVERY[row.fulfillment] || row.fulfillment }}</template>
      </el-table-column>
      <el-table-column label="状态" width="110">
        <template #default="{ row }">
          <el-tag size="small" :type="statusType(row)">{{ statusText(row) }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="下单时间" width="160">
        <template #default="{ row }">{{ fmt(row.created_at) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="170" fixed="right">
        <template #default="{ row }">
          <el-button v-if="canShip(row)" link type="primary" @click="openShip(row)">发货</el-button>
          <el-button v-if="row.platform_status === 'paid'" link @click="forceSettle(row)">结算</el-button>
          <el-button link @click="openDetail(row)">详情</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination style="margin-top: 12px" layout="total, prev, pager, next" :total="total" :page-size="q.size" :current-page="q.page" @current-change="load" />

    <!-- 详情抽屉 -->
    <el-drawer v-model="drawer" size="560px" :title="detail.order ? `订单 ${detail.order.order_sn}` : '订单详情'">
      <div v-if="detail.order" class="detail">
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="状态">{{ statusText(detail.order) }}</el-descriptions-item>
          <el-descriptions-item label="实付">¥{{ detail.order.pay_price }}</el-descriptions-item>
          <el-descriptions-item label="成本">{{ detail.order.cost_amount === null ? '商家未录成本' : '¥' + detail.order.cost_amount }}</el-descriptions-item>
          <el-descriptions-item label="优惠">¥{{ detail.order.coupon_discount || 0 }}</el-descriptions-item>
          <el-descriptions-item label="履约">{{ DELIVERY[detail.order.fulfillment] }}</el-descriptions-item>
          <el-descriptions-item v-if="detail.order.address && detail.order.address.name" label="收货">
            {{ detail.order.address.name }} {{ detail.order.address.phone }}<br />{{ detail.order.address.region }} {{ detail.order.address.detail }}
          </el-descriptions-item>
          <el-descriptions-item v-if="detail.order.logistics" label="物流">
            {{ detail.order.logistics.company }} · {{ detail.order.logistics.tracking_no }}
          </el-descriptions-item>
          <el-descriptions-item label="时间">
            下单 {{ fmt(detail.order.created_at) }}<br />
            支付 {{ fmt(detail.order.paid_at) }}<br />
            结算 {{ fmt(detail.order.settled_at) }}
          </el-descriptions-item>
        </el-descriptions>

        <el-divider content-position="left">商品</el-divider>
        <el-table :data="detail.items" size="small" border>
          <el-table-column label="商品" min-width="180">
            <template #default="{ row }">
              <div>{{ row.title }}</div>
              <div class="muted">{{ row.spec }}</div>
            </template>
          </el-table-column>
          <el-table-column label="单价" width="90"><template #default="{ row }">¥{{ row.unit_price }}</template></el-table-column>
          <el-table-column label="数量" width="70" prop="num" />
          <el-table-column label="小计" width="90"><template #default="{ row }">¥{{ row.amount }}</template></el-table-column>
          <el-table-column label="已退" width="90">
            <template #default="{ row }">
              <span :class="{ warn: row.refunded_num > 0 }">{{ row.refunded_num }} 件</span>
            </template>
          </el-table-column>
        </el-table>
      </div>
    </el-drawer>

    <!-- 发货 -->
    <el-dialog v-model="shipDlg" title="发货" width="420px">
      <el-form label-width="90px" size="small">
        <el-form-item label="订单"><el-input :model-value="shipRow.order_sn" disabled /></el-form-item>
        <el-form-item label="快递公司"><el-input v-model="ship.company" placeholder="如：顺丰速运" /></el-form-item>
        <el-form-item label="运单号"><el-input v-model="ship.tracking_no" placeholder="如：SF1234567890" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="shipDlg = false">取消</el-button>
        <el-button type="primary" :loading="shipping" @click="doShip">确认发货</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { reactive, ref, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { adminApi } from '../../lib/api';

const DELIVERY = { express: '快递', group: '到店核销', virtual: '虚拟卡券' };
const rows = ref([]);
const total = ref(0);
const loading = ref(false);
const drawer = ref(false);
const detail = ref({});
const shipDlg = ref(false);
const shipping = ref(false);
const shipRow = ref({});
const ship = reactive({ company: '', tracking_no: '' });
const q = reactive({ keyword: '', status: '', fulfillment: '', page: 1, size: 20 });

const fmt = (v) => (v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '—');
const statusText = (o) => {
  if (o.platform_status === 'created') return '待支付';
  if (o.refund_status === 'refunded') return '已退款';
  if (o.refund_status === 'applying') return '售后处理中';
  if (o.platform_status === 'settled') return '已完成';
  if (o.fulfillment === 'express' && o.fulfill_status === 'shipped') return '待收货';
  return '已付款';
};
const statusType = (o) => (o.platform_status === 'created' ? 'warning' : o.refund_status === 'refunded' ? 'danger' : o.platform_status === 'settled' ? 'success' : 'primary');
const canShip = (o) => o.fulfillment === 'express' && ['paid', 'settled'].includes(o.platform_status) && o.fulfill_status !== 'shipped' && o.fulfill_status !== 'delivered';

const load = async (page) => {
  if (page) q.page = page;
  loading.value = true;
  try {
    const d = await adminApi(`/admin/shop/orders?page=${q.page}&size=${q.size}` +
      `&keyword=${encodeURIComponent(q.keyword)}&status=${q.status}&fulfillment=${q.fulfillment}`);
    rows.value = d.items;
    total.value = d.total;
  } catch (e) { ElMessage.error(e.message); } finally { loading.value = false; }
};

const openDetail = async (row) => {
  try {
    detail.value = await adminApi(`/admin/shop/orders/${row.order_id}`);
    drawer.value = true;
  } catch (e) { ElMessage.error(e.message); }
};

const openShip = (row) => {
  shipRow.value = row;
  ship.company = '';
  ship.tracking_no = '';
  shipDlg.value = true;
};

const doShip = async () => {
  if (!ship.company.trim() || !ship.tracking_no.trim()) return ElMessage.warning('请填写快递公司与运单号');
  shipping.value = true;
  try {
    await adminApi(`/admin/shop/orders/${shipRow.value.order_id}/ship`, { method: 'POST', body: JSON.stringify({ ...ship }) });
    ElMessage.success('已发货');
    shipDlg.value = false;
    load();
  } catch (e) { ElMessage.error(e.message); } finally { shipping.value = false; }
};

const forceSettle = async (row) => {
  try {
    await ElMessageBox.confirm('强制结算该订单？将立即按站点毛利率发放元宝与佣金（不可撤销）。', '确认结算', { type: 'warning' });
  } catch { return; }
  try {
    await adminApi(`/admin/shop/orders/${row.order_id}/settle`, { method: 'POST' });
    ElMessage.success('已结算');
    load();
  } catch (e) { ElMessage.error(e.message); }
};

onMounted(() => load(1));
</script>

<style scoped>
.toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.detail { padding-bottom: 20px; }
.muted { color: #999; font-size: 12px; }
.warn { color: #e23a3a; }
</style>
