<template>
  <div class="shop-refunds">
    <div class="toolbar">
      <el-select v-model="q.status" placeholder="审核状态" clearable style="width: 150px" @change="load(1)">
        <el-option label="待审核" value="applied" />
        <el-option label="退款中" value="refunding" />
        <el-option label="已退款" value="success" />
        <el-option label="已驳回" value="rejected" />
        <el-option label="已撤销" value="canceled" />
        <el-option label="退款失败" value="failed" />
      </el-select>
      <el-button type="primary" @click="load(1)">查询</el-button>
      <el-button @click="load()">刷新</el-button>
      <span class="hint">通过后自动原路退款（微信 V3）；未配置商户号时走模拟通道，便于先跑通流程。</span>
    </div>

    <el-table :data="rows" v-loading="loading" stripe size="small" style="margin-top: 12px">
      <el-table-column label="售后单号" min-width="180">
        <template #default="{ row }">
          <el-button link type="primary" @click="openDetail(row)">{{ row.refund_sn }}</el-button>
        </template>
      </el-table-column>
      <el-table-column label="订单号" min-width="170">
        <template #default="{ row }">{{ row.order_sn }}</template>
      </el-table-column>
      <el-table-column label="退款金额" width="100"><template #default="{ row }">¥{{ row.amount }}</template></el-table-column>
      <el-table-column label="订单金额" width="100"><template #default="{ row }">¥{{ row.pay_price }}</template></el-table-column>
      <el-table-column label="件数" width="70" prop="num" />
      <el-table-column label="类型" width="90">
        <template #default="{ row }">{{ row.type === 'return' ? '退货退款' : '仅退款' }}</template>
      </el-table-column>
      <el-table-column label="原因" min-width="140" prop="reason" />
      <el-table-column label="状态" width="100">
        <template #default="{ row }">
          <el-tag size="small" :type="tagType(row.status)">{{ STATUS[row.status] || row.status }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="申请时间" width="150">
        <template #default="{ row }">{{ fmt(row.applied_at) }}</template>
      </el-table-column>
      <el-table-column label="操作" width="220" fixed="right">
        <template #default="{ row }">
          <template v-if="row.status === 'applied'">
            <el-button link type="primary" @click="approve(row)">通过并退款</el-button>
            <el-button link type="danger" @click="reject(row)">驳回</el-button>
          </template>
          <el-button v-if="['approved', 'refunding'].includes(row.status)" link type="primary" @click="finish(row, true)">标记成功</el-button>
          <el-button v-if="['approved', 'refunding'].includes(row.status)" link @click="finish(row, false)">标记失败</el-button>
          <el-button link @click="openDetail(row)">详情</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination style="margin-top: 12px" layout="total, prev, pager, next" :total="total" :page-size="q.size" :current-page="q.page" @current-change="load" />

    <el-drawer v-model="drawer" size="560px" :title="detail.refund ? `售后 ${detail.refund.refund_sn}` : '售后详情'">
      <div v-if="detail.refund">
        <el-descriptions :column="1" border size="small">
          <el-descriptions-item label="状态">{{ STATUS[detail.refund.status] || detail.refund.status }}</el-descriptions-item>
          <el-descriptions-item label="订单">{{ detail.refund.order_sn }}</el-descriptions-item>
          <el-descriptions-item label="退款金额">¥{{ detail.refund.amount }}（{{ detail.refund.num }} 件）</el-descriptions-item>
          <el-descriptions-item label="原因">{{ detail.refund.reason }}</el-descriptions-item>
          <el-descriptions-item v-if="detail.refund.description" label="说明">{{ detail.refund.description }}</el-descriptions-item>
          <el-descriptions-item v-if="detail.refund.wx_refund_id" label="微信退款单号">{{ detail.refund.wx_refund_id }}</el-descriptions-item>
          <el-descriptions-item v-if="detail.refund.fail_reason" label="失败原因">{{ detail.refund.fail_reason }}</el-descriptions-item>
          <el-descriptions-item label="申请时间">{{ fmt(detail.refund.applied_at) }}</el-descriptions-item>
          <el-descriptions-item v-if="detail.refund.finished_at" label="完成时间">{{ fmt(detail.refund.finished_at) }}</el-descriptions-item>
        </el-descriptions>

        <el-divider content-position="left">返利冲销台账</el-divider>
        <el-table :data="detail.refund.reversed || []" size="small" border>
          <el-table-column label="类型" width="100">
            <template #default="{ row }">{{ row.kind === 'ingot' ? '元宝' : row.kind === 'commission' ? '佣金' : row.kind === 'none' ? '无' : row.kind }}</template>
          </el-table-column>
          <el-table-column label="用户" width="80"><template #default="{ row }">{{ row.user_id || '—' }}</template></el-table-column>
          <el-table-column label="金额" width="100"><template #default="{ row }">{{ row.amount ?? '—' }}</template></el-table-column>
          <el-table-column label="实际扣回" width="100"><template #default="{ row }">{{ row.applied ?? '—' }}</template></el-table-column>
          <el-table-column label="说明" min-width="200" prop="note" />
        </el-table>
        <p class="hint" style="margin-top: 8px">
          台账说明：全额退款会自动作废佣金并扣回余额；部分退款只标记待人工处理（避免按比例改历史账导致对不上）。
        </p>
      </div>
    </el-drawer>
  </div>
</template>

<script setup>
import { reactive, ref, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { adminApi } from '../../lib/api';

const STATUS = { applied: '待审核', approved: '已通过', rejected: '已驳回', refunding: '退款中', success: '已退款', failed: '退款失败', canceled: '已撤销' };
const rows = ref([]);
const total = ref(0);
const loading = ref(false);
const drawer = ref(false);
const detail = ref({});
const q = reactive({ status: '', page: 1, size: 20 });

const fmt = (v) => (v ? new Date(v).toLocaleString('zh-CN', { hour12: false }) : '—');
const tagType = (s) => (s === 'success' ? 'success' : s === 'applied' ? 'warning' : s === 'rejected' || s === 'failed' ? 'danger' : 'primary');

const load = async (page) => {
  if (page) q.page = page;
  loading.value = true;
  try {
    const d = await adminApi(`/admin/shop/refunds?page=${q.page}&size=${q.size}&status=${q.status}`);
    rows.value = d.items;
    total.value = d.total;
  } catch (e) { ElMessage.error(e.message); } finally { loading.value = false; }
};

const openDetail = async (row) => {
  try {
    detail.value = await adminApi(`/admin/shop/refunds/${row.refund_id}`);
    drawer.value = true;
  } catch (e) { ElMessage.error(e.message); }
};

const approve = async (row) => {
  try {
    await ElMessageBox.confirm(
      `通过售后 ${row.refund_sn}？将退款 ¥${row.amount}，并回补库存、按规则冲销返利。`,
      '确认通过', { type: 'warning' },
    );
  } catch { return; }
  try {
    const r = await adminApi(`/admin/shop/refunds/${row.refund_id}/approve`, { method: 'POST' });
    ElMessage.success(r.status === 'success' ? (r.mock ? '已退款（模拟通道）' : '已退款') : '微信退款处理中，请稍后核对');
    load();
  } catch (e) { ElMessage.error(e.message); }
};

const reject = async (row) => {
  let reason = '';
  try {
    const r = await ElMessageBox.prompt('请填写驳回原因（用户可见）', '驳回售后', { inputPlaceholder: '如：商品无质量问题', inputValidator: (v) => (v && v.trim() ? true : '必须填写原因') });
    reason = r.value;
  } catch { return; }
  try {
    await adminApi(`/admin/shop/refunds/${row.refund_id}/reject`, { method: 'POST', body: JSON.stringify({ reason }) });
    ElMessage.success('已驳回');
    load();
  } catch (e) { ElMessage.error(e.message); }
};

const finish = async (row, success) => {
  try {
    await ElMessageBox.confirm(success ? '标记为退款成功（会立即回补库存并冲销返利）？' : '标记为退款失败？', '确认', { type: 'warning' });
  } catch { return; }
  try {
    await adminApi(`/admin/shop/refunds/${row.refund_id}/finish`, { method: 'POST', body: JSON.stringify({ success }) });
    ElMessage.success(success ? '已标记成功' : '已标记失败');
    load();
  } catch (e) { ElMessage.error(e.message); }
};

onMounted(() => load(1));
</script>

<style scoped>
.toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.hint { color: #999; font-size: 12px; }
</style>
