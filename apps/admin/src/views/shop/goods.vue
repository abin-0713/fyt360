<template>
  <div class="shop-goods">
    <div class="toolbar">
      <el-input v-model="q.keyword" placeholder="搜索商品标题" clearable style="width: 220px" @keyup.enter="load(1)" />
      <el-select v-model="q.status" placeholder="上架状态" clearable style="width: 140px" @change="load(1)">
        <el-option label="已上架" value="on" />
        <el-option label="草稿" value="draft" />
        <el-option label="已下架" value="off" />
      </el-select>
      <el-select v-model="q.category_id" placeholder="分类" clearable style="width: 160px" @change="load(1)">
        <el-option v-for="c in categories" :key="c.category_id" :label="c.name" :value="c.category_id" />
      </el-select>
      <el-button type="primary" @click="load(1)">查询</el-button>
      <div class="spacer" />
      <el-button @click="loadCats(true)">刷新分类</el-button>
      <el-button type="primary" @click="openCreate">新建商品</el-button>
    </div>

    <el-table :data="rows" v-loading="loading" stripe size="small" style="margin-top: 12px">
      <el-table-column label="商品" min-width="240">
        <template #default="{ row }">
          <div class="cell-goods">
            <el-image v-if="row.image" :src="row.image" class="thumb" fit="cover" />
            <div>
              <div class="t">{{ row.title }}</div>
              <div class="s">{{ row.brand || '—' }} · ID {{ row.goods_id }}</div>
            </div>
          </div>
        </template>
      </el-table-column>
      <el-table-column label="分类" width="120">
        <template #default="{ row }">{{ row.category_name || '未归类' }}</template>
      </el-table-column>
      <el-table-column label="履约" width="90">
        <template #default="{ row }">{{ DELIVERY[row.delivery_type] || row.delivery_type }}</template>
      </el-table-column>
      <el-table-column label="SKU" width="90">
        <template #default="{ row }">{{ row.sku_on }}/{{ row.sku_count }}</template>
      </el-table-column>
      <el-table-column label="价格" width="110">
        <template #default="{ row }">{{ row.min_price === null ? '—' : '¥' + row.min_price }}</template>
      </el-table-column>
      <el-table-column label="可售" width="80" prop="available" />
      <el-table-column label="销量" width="80" prop="sales_count" />
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag v-if="row.shop_status === 'on'" type="success" size="small">已上架</el-tag>
          <el-tag v-else-if="row.shop_status === 'draft'" type="info" size="small">草稿</el-tag>
          <el-tag v-else type="warning" size="small">已下架</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="210" fixed="right">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button v-if="row.shop_status !== 'on'" link type="success" @click="publish(row, true)">上架</el-button>
          <el-button v-else link type="warning" @click="publish(row, false)">下架</el-button>
          <el-button link type="danger" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-pagination
      style="margin-top: 12px"
      layout="total, prev, pager, next"
      :total="total"
      :page-size="q.size"
      :current-page="q.page"
      @current-change="load"
    />

    <!-- 新建 / 编辑 -->
    <el-dialog v-model="dlg" :title="form.goods_id ? `编辑商品 #${form.goods_id}` : '新建商品'" width="880px" top="6vh">
      <el-form label-width="92px" size="small">
        <el-form-item label="标题"><el-input v-model="form.title" placeholder="商品标题" /></el-form-item>
        <el-row :gutter="12">
          <el-col :span="8">
            <el-form-item label="分类">
              <el-select v-model="form.category_id" placeholder="选择分类" clearable style="width: 100%">
                <el-option v-for="c in categories" :key="c.category_id" :label="c.name" :value="c.category_id" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="履约方式">
              <el-select v-model="form.delivery_type" style="width: 100%">
                <el-option label="快递发货" value="express" />
                <el-option label="到店核销" value="group" />
                <el-option label="虚拟卡券" value="virtual" />
              </el-select>
            </el-form-item>
          </el-col>
          <el-col :span="8">
            <el-form-item label="运费模板">
              <el-select v-model="form.freight_tpl_id" placeholder="快递单必填" clearable :disabled="form.delivery_type !== 'express'" style="width: 100%">
                <el-option v-for="t in freights" :key="t.tpl_id" :label="t.name" :value="t.tpl_id" />
              </el-select>
            </el-form-item>
          </el-col>
        </el-row>
        <el-row :gutter="12">
          <el-col :span="8"><el-form-item label="品牌"><el-input v-model="form.brand" /></el-form-item></el-col>
          <el-col :span="8"><el-form-item label="排序"><el-input-number v-model="form.sort" :min="-9999" :max="9999" /></el-form-item></el-col>
          <el-col :span="8">
            <el-form-item label="主图">
              <div class="imgs">
                <div v-for="(u, i) in form.main_imgs" :key="i" class="img-item">
                  <el-image :src="u" class="thumb" fit="cover" />
                  <el-button link type="danger" size="small" @click="form.main_imgs.splice(i, 1)">移除</el-button>
                </div>
                <el-upload :show-file-list="false" :http-request="(o) => doUpload(o, form.main_imgs)" accept="image/*">
                  <el-button size="small">上传图片</el-button>
                </el-upload>
              </div>
            </el-form-item>
          </el-col>
        </el-row>
        <el-form-item label="详情">
          <el-input v-model="form.detail_html" type="textarea" :rows="3" placeholder="支持 HTML（富文本），也可留空只放详情图" />
        </el-form-item>

        <el-divider content-position="left">SKU（价格必须大于 0；改库存请用「库存」列，会留流水）</el-divider>
        <el-table :data="form.skus" size="small" border>
          <el-table-column label="规格" width="120"><template #default="{ row }"><el-input v-model="row.spec" size="small" /></template></el-table-column>
          <el-table-column label="编码" width="110"><template #default="{ row }"><el-input v-model="row.sku_code" size="small" /></template></el-table-column>
          <el-table-column label="售价" width="110"><template #default="{ row }"><el-input-number v-model="row.price" :min="0.01" :precision="2" size="small" controls-position="right" style="width: 100%" /></template></el-table-column>
          <el-table-column label="成本" width="110"><template #default="{ row }"><el-input-number v-model="row.cost_price" :min="0" :precision="2" size="small" controls-position="right" style="width: 100%" /></template></el-table-column>
          <el-table-column label="库存" width="110">
            <template #default="{ row }">
              <el-input-number v-model="row.stock" :min="0" size="small" controls-position="right" style="width: 100%" @change="(v) => onStockChange(row, v)" />
            </template>
          </el-table-column>
          <el-table-column label="重量(g)" width="110"><template #default="{ row }"><el-input-number v-model="row.weight_gram" :min="0" size="small" controls-position="right" style="width: 100%" /></template></el-table-column>
          <el-table-column label="状态" width="90">
            <template #default="{ row }">
              <el-select v-model="row.status" size="small">
                <el-option label="在售" value="on" />
                <el-option label="停用" value="off" />
              </el-select>
            </template>
          </el-table-column>
          <el-table-column label="" width="70">
            <template #default="{ $index }"><el-button link type="danger" @click="removeSku($index)">删除</el-button></template>
          </el-table-column>
        </el-table>
        <el-button size="small" style="margin-top: 8px" @click="addSku">+ 添加规格</el-button>
      </el-form>
      <template #footer>
        <el-button @click="dlg = false">取消</el-button>
        <el-button :loading="saving" @click="save(false)">保存为草稿</el-button>
        <el-button type="primary" :loading="saving" @click="save(true)">保存并上架</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { reactive, ref, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { adminApi } from '../../lib/api';
import { uploadImage } from '../../upload';

const DELIVERY = { express: '快递', group: '到店核销', virtual: '虚拟卡券' };

const rows = ref([]);
const total = ref(0);
const loading = ref(false);
const saving = ref(false);
const dlg = ref(false);
const categories = ref([]);
const freights = ref([]);
const q = reactive({ keyword: '', status: '', category_id: '', page: 1, size: 20 });

const emptyForm = () => ({
  goods_id: 0, title: '', category_id: '', delivery_type: 'express', freight_tpl_id: '',
  brand: '', sort: 0, main_imgs: [], detail_html: '', skus: [],
});
const form = reactive(emptyForm());

const load = async (page) => {
  if (page) q.page = page;
  loading.value = true;
  try {
    const d = await adminApi(`/admin/shop/goods?page=${q.page}&size=${q.size}` +
      `&keyword=${encodeURIComponent(q.keyword)}&status=${q.status}&category_id=${q.category_id || ''}`);
    rows.value = d.items;
    total.value = d.total;
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    loading.value = false;
  }
};

const loadCats = async (notify) => {
  try {
    const d = await adminApi('/admin/shop/categories');
    categories.value = d.items.filter((c) => c.status === 'on');
    if (notify) ElMessage.success(`分类 ${categories.value.length} 个`);
  } catch (e) { ElMessage.error(e.message); }
};

const loadFreights = async () => {
  try {
    const d = await adminApi('/admin/shop/freight-templates');
    freights.value = d.items.filter((t) => t.status === 'on');
  } catch (e) { /* 无模板也能建虚拟/核销商品 */ }
};

const openCreate = () => {
  Object.assign(form, emptyForm());
  form.skus = [blankSku()];
  dlg.value = true;
};

const openEdit = async (row) => {
  try {
    const d = await adminApi(`/admin/shop/goods/${row.goods_id}`);
    Object.assign(form, {
      goods_id: d.goods.goods_id,
      title: d.goods.title,
      category_id: d.goods.category_id || '',
      delivery_type: d.goods.delivery_type,
      freight_tpl_id: d.goods.freight_tpl_id || '',
      brand: d.goods.brand || '',
      sort: d.goods.sort || 0,
      main_imgs: [...(d.goods.main_imgs || [])],
      detail_html: d.goods.detail_html || '',
      skus: d.skus.map((s) => ({ ...s, _dirty: false })),
    });
    dlg.value = true;
  } catch (e) { ElMessage.error(e.message); }
};

const blankSku = () => ({ sku_id: 0, sku_code: '', spec: '默认', price: 1, cost_price: null, stock: 0, weight_gram: 0, status: 'on', _dirty: true });

const addSku = () => form.skus.push(blankSku());

const removeSku = async (idx) => {
  const s = form.skus[idx];
  if (!s.sku_id) { form.skus.splice(idx, 1); return; }
  try {
    await ElMessageBox.confirm('删除该规格？已被订单引用时会自动改为下架保留历史。', '确认', { type: 'warning' });
  } catch { return; }
  try {
    const r = await adminApi(`/admin/shop/skus/${s.sku_id}`, { method: 'DELETE' });
    ElMessage.success(r.deleted ? '已删除' : r.reason || '已下架');
    form.skus.splice(idx, 1);
  } catch (e) { ElMessage.error(e.message); }
};

/** 库存改动单独走 stock 接口（留流水、且不允许低于未支付订单占用量） */
const onStockChange = async (row, val) => {
  if (!row.sku_id) return;
  try {
    await adminApi(`/admin/shop/skus/${row.sku_id}/stock`, {
      method: 'POST', body: JSON.stringify({ mode: 'set', value: val, reason: 'admin_adjust' }),
    });
    ElMessage.success('库存已调整并记录流水');
    row._stockTouched = true;
  } catch (e) {
    ElMessage.error(e.message);
    row.stock = null;
    setTimeout(() => { row.stock = val; }, 0);
  }
};

const doUpload = async (opt, list) => {
  try {
    const url = await uploadImage(opt.file);
    list.push(url);
    ElMessage.success('上传成功');
  } catch (e) { ElMessage.error(e.message); }
};

const save = async (publish) => {
  if (!form.title.trim()) return ElMessage.warning('请填写商品标题');
  if (!form.skus.length) return ElMessage.warning('至少需要一个 SKU');
  if (form.delivery_type === 'express' && !form.freight_tpl_id) return ElMessage.warning('快递商品请选择运费模板');
  saving.value = true;
  try {
    const payload = {
      title: form.title, category_id: form.category_id || null, delivery_type: form.delivery_type,
      freight_tpl_id: form.freight_tpl_id || null, brand: form.brand, sort: form.sort,
      main_imgs: form.main_imgs, detail_html: form.detail_html,
    };
    if (!form.goods_id) {
      const d = await adminApi('/admin/shop/goods', {
        method: 'POST',
        body: JSON.stringify({ ...payload, publish, skus: form.skus.map(cleanSku) }),
      });
      ElMessage.success(publish ? '已创建并上架' : '已保存为草稿');
      form.goods_id = d.goods_id;
    } else {
      await adminApi(`/admin/shop/goods/${form.goods_id}`, { method: 'PATCH', body: JSON.stringify(payload) });
      for (const s of form.skus) {
        if (!s.sku_id) {
          await adminApi(`/admin/shop/goods/${form.goods_id}/skus`, { method: 'POST', body: JSON.stringify(cleanSku(s)) });
        } else if (s._dirty) {
          await adminApi(`/admin/shop/skus/${s.sku_id}`, {
            method: 'PATCH',
            body: JSON.stringify({ sku_code: s.sku_code, spec: s.spec, price: s.price, cost_price: s.cost_price, weight_gram: s.weight_gram, status: s.status }),
          });
        }
      }
      if (publish) await adminApi(`/admin/shop/goods/${form.goods_id}/publish`, { method: 'POST', body: JSON.stringify({ publish: true }) });
      ElMessage.success('已保存');
    }
    dlg.value = false;
    load(1);
  } catch (e) {
    ElMessage.error(e.message);
  } finally {
    saving.value = false;
  }
};

const cleanSku = (s) => ({
  sku_code: s.sku_code || null, spec: s.spec, price: s.price,
  cost_price: s.cost_price, market_price: s.market_price ?? null,
  stock: s.stock ?? 0, weight_gram: s.weight_gram ?? 0, status: s.status || 'on',
});

const publish = async (row, on) => {
  try {
    await adminApi(`/admin/shop/goods/${row.goods_id}/publish`, { method: 'POST', body: JSON.stringify({ publish: on }) });
    ElMessage.success(on ? '已上架' : '已下架');
    load();
  } catch (e) { ElMessage.error(e.message); }
};

const remove = async (row) => {
  try {
    await ElMessageBox.confirm(`下架并停用「${row.title}」？有未支付订单时会被拒绝。`, '确认删除', { type: 'warning' });
  } catch { return; }
  try {
    await adminApi(`/admin/shop/goods/${row.goods_id}`, { method: 'DELETE' });
    ElMessage.success('已下架');
    load();
  } catch (e) { ElMessage.error(e.message); }
};

onMounted(() => { loadCats(); loadFreights(); load(1); });
</script>

<style scoped>
.toolbar { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.spacer { flex: 1; }
.cell-goods { display: flex; gap: 10px; align-items: center; }
.thumb { width: 44px; height: 44px; border-radius: 6px; background: #f5f5f5; }
.t { font-weight: 600; color: #3d2530; }
.s { font-size: 12px; color: #999; }
.imgs { display: flex; gap: 8px; align-items: center; flex-wrap: wrap; }
.img-item { display: flex; flex-direction: column; align-items: center; }
</style>
