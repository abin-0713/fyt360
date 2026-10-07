<template>
  <div class="shop-cats">
    <div class="toolbar">
      <el-button type="primary" @click="openCreate(null)">新建一级分类</el-button>
      <el-button @click="load">刷新</el-button>
      <span class="hint">分类支持两级：一级分类下可建子分类；商品挂在子分类上时，一级分类页也能搜到。</span>
    </div>

    <el-table :data="tree" v-loading="loading" row-key="category_id" default-expand-all style="margin-top: 12px" size="small">
      <el-table-column label="分类名" min-width="200">
        <template #default="{ row }">
          <span :style="{ paddingLeft: (row.parent_id ? 18 : 0) + 'px' }">
            {{ row.parent_id ? '└ ' : '' }}{{ row.name }}
          </span>
          <el-tag v-if="row.status === 'off'" size="small" type="info" style="margin-left: 8px">已停用</el-tag>
        </template>
      </el-table-column>
      <el-table-column label="商品数" width="90" prop="goods_count" />
      <el-table-column label="排序" width="90" prop="sort" />
      <el-table-column label="操作" width="240">
        <template #default="{ row }">
          <el-button link type="primary" @click="openEdit(row)">重命名</el-button>
          <el-button v-if="!row.parent_id" link type="primary" @click="openCreate(row)">加子分类</el-button>
          <el-button link :type="row.status === 'on' ? 'warning' : 'success'" @click="toggle(row)">
            {{ row.status === 'on' ? '停用' : '启用' }}
          </el-button>
          <el-button link type="danger" @click="remove(row)">删除</el-button>
        </template>
      </el-table-column>
    </el-table>

    <el-dialog v-model="dlg" :title="editing.category_id ? '重命名分类' : '新建分类'" width="420px">
      <el-form label-width="80px" size="small">
        <el-form-item v-if="parent" label="上级"><el-input :model-value="parent.name" disabled /></el-form-item>
        <el-form-item label="名称"><el-input v-model="editing.name" placeholder="如：数码配件" /></el-form-item>
        <el-form-item label="排序"><el-input-number v-model="editing.sort" :min="-9999" :max="9999" /></el-form-item>
      </el-form>
      <template #footer>
        <el-button @click="dlg = false">取消</el-button>
        <el-button type="primary" :loading="saving" @click="save">保存</el-button>
      </template>
    </el-dialog>
  </div>
</template>

<script setup>
import { computed, reactive, ref, onMounted } from 'vue';
import { ElMessage, ElMessageBox } from 'element-plus';
import { adminApi } from '../../lib/api';

const list = ref([]);
const loading = ref(false);
const saving = ref(false);
const dlg = ref(false);
const parent = ref(null);
const editing = reactive({ category_id: 0, name: '', sort: 0 });

/** 平铺数据组装成两级树（Element Plus 需要 children） */
const tree = computed(() => {
  const byId = new Map(list.value.map((c) => [c.category_id, { ...c, children: [] }]));
  const roots = [];
  for (const c of byId.values()) {
    if (c.parent_id && byId.has(c.parent_id)) byId.get(c.parent_id).children.push(c);
    else roots.push(c);
  }
  return roots;
});

const load = async () => {
  loading.value = true;
  try {
    const d = await adminApi('/admin/shop/categories');
    list.value = d.items;
  } catch (e) { ElMessage.error(e.message); } finally { loading.value = false; }
};

const openCreate = (p) => {
  parent.value = p || null;
  Object.assign(editing, { category_id: 0, name: '', sort: 0 });
  dlg.value = true;
};

const openEdit = (row) => {
  parent.value = null;
  Object.assign(editing, { category_id: row.category_id, name: row.name, sort: row.sort });
  dlg.value = true;
};

const save = async () => {
  if (!editing.name.trim()) return ElMessage.warning('请填写分类名');
  saving.value = true;
  try {
    if (editing.category_id) {
      await adminApi(`/admin/shop/categories/${editing.category_id}`, {
        method: 'PATCH', body: JSON.stringify({ name: editing.name, sort: editing.sort }),
      });
    } else {
      await adminApi('/admin/shop/categories', {
        method: 'POST',
        body: JSON.stringify({ name: editing.name, sort: editing.sort, parent_id: parent.value ? parent.value.category_id : null }),
      });
    }
    ElMessage.success('已保存');
    dlg.value = false;
    load();
  } catch (e) { ElMessage.error(e.message); } finally { saving.value = false; }
};

const toggle = async (row) => {
  try {
    await adminApi(`/admin/shop/categories/${row.category_id}`, {
      method: 'PATCH', body: JSON.stringify({ status: row.status === 'on' ? 'off' : 'on' }),
    });
    load();
  } catch (e) { ElMessage.error(e.message); }
};

const remove = async (row) => {
  try {
    await ElMessageBox.confirm(`删除分类「${row.name}」？有子分类或商品时会被拒绝。`, '确认', { type: 'warning' });
  } catch { return; }
  try {
    await adminApi(`/admin/shop/categories/${row.category_id}`, { method: 'DELETE' });
    ElMessage.success('已删除');
    load();
  } catch (e) { ElMessage.error(e.message); }
};

onMounted(load);
</script>

<style scoped>
.toolbar { display: flex; gap: 8px; align-items: center; }
.hint { color: #999; font-size: 12px; }
</style>
