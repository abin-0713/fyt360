<template>
  <div class="shop-freight">
    <div class="toolbar">
      <el-button type="primary" @click="openCreate">新建运费模板</el-button>
      <el-button @click="load">刷新</el-button>
      <span class="hint">快递商品的运费 = 首件/首重费 + 续件/续重费；满额可包邮。虚拟卡券与到店核销不产生运费。</span>
    </div>

    <el-table :data="rows" v-loading="loading" style="margin-top: 12px" size="small">
      <el-table-column label="模板名" min-width="160" prop="name" />
      <el-table-column label="计费方式" width="110">
        <template #default="{ row }">{{ row.charge_mode === 'weight' ? '按重量(kg)' : '按件数' }}</template>
      </el-table-column>
      <el-table-column label="首件/首重" width="120">
        <template #default="{ row }">{{ row.first_unit }} → ¥{{ row.first_fee }}</template>
      </el-table-column>
      <el-table-column label="续件/续重" width="120">
        <template #default="{ row }">{{ row.add_unit }} → ¥{{ row.add_fee }}</template>
      </el-table-column>
      <el-table-column label="满额包邮" width="110">
        <template #default="{ row }">{{ row.free_over > 0 ? '¥' + row.free_over : '不启用' }}</template>
      </el-table-column>
      <el-table-column label="使用商品" width="90" prop="goods_count" />
      <el-table-column label="状态" width="90">
        <template #default="{ row }">
          <el-tag :type="row.status === 'on' ? 'success' : 'info'" size="small">{{ row.status === 'on' ? '启用' : '停用' }}</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="操作" width="150">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">编辑</el-button>
          <el-button link type="danger" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dlg" :title="form.tpl_id ? '编辑运费模板' : '新建运费模板'" width="520px">
      <el-form label-width="110px" size="small">
        <el-form-item label="模板名"><el-input v-model="form.name" placeholder="如：全国快递" /></el-form-item>
        <el-form-item label="计费方式">
          <el-radio-group v-model="form.charge_mode">
            <el-radio label="qty">按件数</el-radio>
            <el-radio label="weight">按重量(kg)</el-radio>
          </el-radio-group>
        </el-form-item>
        <el-form-item label="首件/首重"><el-input-number v-model="form.first_unit" :min="1" /></el-form-item>
        <el-form-item label="首件运费"><el-input-number v-model="form.first_fee" :min="0" :precision="2" /></el-form-item>
        <el-form-item label="续件/续重"><el-input-number v-model="form.add_unit" :min="1" /></el-form-item>
        <el-form-item label="续费"><el-input-number v-model="form.add_fee" :min="0" :precision="2" /></el-form-item>
        <el-form-item label="满额包邮"><el-input-number v-model="form.free_over" :min="0" :precision="2" /><span class="hint">元，0 = 不启用</span></el-form-item>
        <el-form-item label="状态">
          <el-switch v-model="form.status" active-value="on" inactive-value="off" />
        </el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dlg = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { reactive, ref, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { adminApi } from '../../lib/api';

const rows = ref([]);
const loading = ref(false);
const saving = ref(false);
const dlg = ref(false);
const empty = () => ({ tpl_id: 0, name: '', charge_mode: 'qty', first_unit: 1, first_fee: 0, add_unit: 1, add_fee: 0, free_over: 0, status: 'on' });
const form = reactive(empty());

const load = async () => {
  loading.value = true;
  try {
    const d = await adminApi('/admin/shop/freight-templates');
    rows.value = d.items;
  } catch (e) { ElMessage.error(e.message); } finally { loading.value = false; }
};

const openCreate = () => { Object.assign(form, empty()); dlg.value = true; };
const openEdit = (row) => { Object.assign(form, row); dlg.value = true; };

const save = async () => {
  if (!form.name.trim()) return ElMessage.warning('请填写模板名');
  saving.value = true;
  try {
    const body = JSON.stringify({
      name: form.name, charge_mode: form.charge_mode, first_unit: form.first_unit, first_fee: form.first_fee,
      add_unit: form.add_unit, add_fee: form.add_fee, free_over: form.free_over, status: form.status,
    });
    if (form.tpl_id) await adminApi(`/admin/shop/freight-templates/${form.tpl_id}`, { method: 'PATCH', body });
    else await adminApi('/admin/shop/freight-templates', { method: 'POST', body });
    ElMessage.success('已保存');
    dlg.value = false;
    load();
  } catch (e) { ElMessage.error(e.message); } finally { saving.value = false; }
};

const remove = async (row) => {
  try {
    await ElMessageBox.confirm(`删除模板「${row.name}」？被商品使用时会被拒绝。`, '确认', { type: 'warning' });
  } catch { return; }
  try {
    await adminApi(`/admin/shop/freight-templates/${row.tpl_id}`, { method: 'DELETE' });
    ElMessage.success('已删除');
    load();
  } catch (e) { ElMessage.error(e.message); }
};

onMounted(load);
</script>

<style scoped>
.toolbar { display: flex; gap: 8px; align-items: center; }
.hint { color: #999; font-size: 12px; margin-left: 6px; }
</style>
