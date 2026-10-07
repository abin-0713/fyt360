-- ════════════════════════════════════════════════════════════════════════
-- 100_shop_core：商城二开 —— 数据层（分类 / SKU / 购物车 / 订单行 / 运费 / 退款 / 库存流水）
--
-- 编号约定：从 100 起，三位数排在作者 001–042 之后，永不与上游撞号
--           （上游 041 号目前空着，可能被补上）。
--
-- 设计原则（与上游既有铁律对齐）：
--   ① 不重复造表：商品主表复用 self_goods（只加列），SKU 从 self_goods.skus JSON 规范化下沉；
--   ② 多租户：所有新表带 site_id，索引以 (site_id, ...) 打头，代码层必须配 assertSiteAccess/oneSite 守卫；
--   ③ 金额一律 NUMERIC(元)，与 order.pay_price 口径一致；
--      ⚠️ 但**单价/单件成本**用 NUMERIC(12,4)：实测存量数据存在 cost=0.005 元（半分钱）的规格，
--         用 (12,2) 会被四舍五入成 0.01，等于迁移时静默改了商家的成本账。
--         订单**行金额/实付**仍用 (12,2)（真实收款精确到分）。
--   ④ 全部幂等：CREATE TABLE IF NOT EXISTS / ADD COLUMN IF NOT EXISTS / DO $$ 守卫约束；
--   ⑤ 迁移期不丢数据：shop_sku.raw 保留原始 JSON 元素，二阶段切换代码后再考虑清理。
--
-- 库存语义（与本文件配套的代码约定）：
--   下单  → shop_sku.locked_stock += num，写 shop_stock_log('order_create')
--   支付成功 → stock -= num, locked_stock -= num，写 log('order_pay')
--   超时关单/取消 → locked_stock -= num，写 log('order_cancel')
--   退款成功 → stock += num，写 log('refund')（虚拟商品不回补，见 goods 的 delivery_type='virtual'）
-- ════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────
-- ① self_goods 扩列（不动既有列，全部可空或有默认值）
-- ────────────────────────────────────────────────────────────────────────
ALTER TABLE self_goods ADD COLUMN IF NOT EXISTS category_id     BIGINT       NULL;
ALTER TABLE self_goods ADD COLUMN IF NOT EXISTS brand           VARCHAR(64)  NULL;
ALTER TABLE self_goods ADD COLUMN IF NOT EXISTS detail_html     TEXT         NULL;
ALTER TABLE self_goods ADD COLUMN IF NOT EXISTS spu_code        VARCHAR(64)  NULL;
ALTER TABLE self_goods ADD COLUMN IF NOT EXISTS sales_count     INT          NOT NULL DEFAULT 0;
ALTER TABLE self_goods ADD COLUMN IF NOT EXISTS sort            INT          NOT NULL DEFAULT 0;
ALTER TABLE self_goods ADD COLUMN IF NOT EXISTS freight_tpl_id  BIGINT       NULL;
ALTER TABLE self_goods ADD COLUMN IF NOT EXISTS shop_status     VARCHAR(16)  NOT NULL DEFAULT 'draft';

COMMENT ON COLUMN self_goods.category_id IS '商城分类 shop_category.category_id；NULL=未归类';
COMMENT ON COLUMN self_goods.detail_html IS '商品详情富文本（原 detail_imgs 仅图片，富文本另存，二者共存）';
COMMENT ON COLUMN self_goods.sales_count IS '累计销量（支付成功后累加，用于列表排序）';
COMMENT ON COLUMN self_goods.shop_status IS '商城上架状态：draft=草稿（未完成录入，C 端不可见）/ on=上架 / off=下架。与既有 status(on/off) 并存，status 保持兼容旧后台';

-- 履约方式扩展：虚拟卡券（下单即成，无需物流）
-- 001 的行内约束由 PG 自动命名为 self_goods_delivery_type_check
ALTER TABLE self_goods DROP CONSTRAINT IF EXISTS self_goods_delivery_type_check;
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'self_goods_delivery_type_chk') THEN
    ALTER TABLE self_goods ADD CONSTRAINT self_goods_delivery_type_chk
      CHECK (delivery_type IN ('express','group','virtual'));
  END IF;
END $$;
COMMENT ON COLUMN self_goods.delivery_type IS '履约方式：express=快递 / group=到店核销 / virtual=虚拟卡券(下单即成，无物流)';

-- ────────────────────────────────────────────────────────────────────────
-- ② shop_category：商品分类（多级，站点隔离）
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shop_category (
  category_id BIGSERIAL PRIMARY KEY,
  site_id     UUID        NOT NULL REFERENCES site(site_id),
  parent_id   BIGINT      NULL,                        -- 树形；NULL=一级分类（不建外键，避免删父级被阻塞）
  name        VARCHAR(64) NOT NULL,
  icon        TEXT        NULL,
  sort        INT         NOT NULL DEFAULT 0,
  status      VARCHAR(16) NOT NULL DEFAULT 'on',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT shop_category_status_chk CHECK (status IN ('on','off'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_shop_category_name ON shop_category (site_id, COALESCE(parent_id, 0), name);
CREATE INDEX IF NOT EXISTS idx_shop_category_tree ON shop_category (site_id, status, parent_id, sort);
COMMENT ON TABLE shop_category IS '商城商品分类（与 CPS 的 brand_category 无关，勿混用）';

-- ────────────────────────────────────────────────────────────────────────
-- ③ shop_sku：SKU 规范化表（self_goods.skus 迁入；二阶段起为库存/价格的唯一真相源）
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shop_sku (
  sku_id       BIGSERIAL PRIMARY KEY,
  site_id      UUID          NOT NULL REFERENCES site(site_id),
  goods_id     BIGINT        NOT NULL REFERENCES self_goods(goods_id) ON DELETE CASCADE,
  sku_code     VARCHAR(64)   NULL,                     -- 业务编号（沿用原 JSON 的 sku_id，如 's1'）
  spec         VARCHAR(128)  NOT NULL DEFAULT '默认',   -- 规格描述（沿用原 JSON 的 spec 字符串，保持兼容）
  spec_values  JSONB         NOT NULL DEFAULT '{}'::jsonb, -- 结构化规格 {"颜色":"红","尺码":"XL"}，二期填
  price        NUMERIC(12,4) NOT NULL CHECK (price >= 0),   -- 4 位小数：迁移不损失精度
  market_price NUMERIC(12,4) NULL,
  cost_price   NUMERIC(12,4) NULL,                     -- 商家结算成本（原 JSON 的 cost）
  stock        INT           NOT NULL DEFAULT 0 CHECK (stock >= 0),
  locked_stock INT           NOT NULL DEFAULT 0 CHECK (locked_stock >= 0),
  sales        INT           NOT NULL DEFAULT 0,
  weight_gram  INT           NOT NULL DEFAULT 0,
  image        TEXT          NULL,
  status       VARCHAR(16)   NOT NULL DEFAULT 'on',
  raw          JSONB         NULL,                     -- 迁移期保留原始 JSON 元素（零信息丢失）
  created_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at   TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT shop_sku_status_chk CHECK (status IN ('on','off'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_shop_sku_code ON shop_sku (site_id, goods_id, sku_code) WHERE sku_code IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_shop_sku_goods ON shop_sku (site_id, goods_id, status, sku_id);
COMMENT ON COLUMN shop_sku.locked_stock IS '已下单未支付占用量；可售 = stock - locked_stock';
COMMENT ON COLUMN shop_sku.raw IS '迁移期原始 skus[] 元素快照；代码切到本表读写后可删除';

-- ────────────────────────────────────────────────────────────────────────
-- ④ shop_cart：购物车
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shop_cart (
  cart_id    BIGSERIAL PRIMARY KEY,
  site_id    UUID        NOT NULL REFERENCES site(site_id),
  user_id    BIGINT      NOT NULL REFERENCES "user"(user_id) ON DELETE CASCADE,
  goods_id   BIGINT      NOT NULL REFERENCES self_goods(goods_id) ON DELETE CASCADE,
  sku_id     BIGINT      NOT NULL REFERENCES shop_sku(sku_id) ON DELETE CASCADE,
  num        INT         NOT NULL CHECK (num > 0 AND num <= 999),
  selected   BOOLEAN     NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_shop_cart_sku ON shop_cart (user_id, sku_id);
CREATE INDEX IF NOT EXISTS idx_shop_cart_user ON shop_cart (site_id, user_id, selected);
COMMENT ON TABLE shop_cart IS '购物车（同 SKU 合并为一行，num 叠加）';

-- ────────────────────────────────────────────────────────────────────────
-- ⑤ shop_order_item：订单行（一单多商品；仅 provider=''self'' 的订单写本表）
--    ⛔ CPS/直充订单保持"一单一行"语义，不写本表，避免污染上游订单同步逻辑
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shop_order_item (
  item_id       BIGSERIAL PRIMARY KEY,
  site_id       UUID          NOT NULL REFERENCES site(site_id),
  order_id      BIGINT        NOT NULL REFERENCES "order"(id) ON DELETE CASCADE,
  goods_id      BIGINT        NULL,
  sku_id        BIGINT        NULL,
  title         VARCHAR(255)  NOT NULL,                -- 下单快照（商品改名/下架不影响历史单）
  spec          VARCHAR(128)  NOT NULL DEFAULT '默认',
  image         TEXT          NULL,
  unit_price    NUMERIC(12,4) NOT NULL CHECK (unit_price >= 0),  -- 与 shop_sku 同精度，迁移不丢尾数
  unit_cost     NUMERIC(12,4) NULL,
  num           INT           NOT NULL CHECK (num > 0),
  amount        NUMERIC(12,2) NOT NULL CHECK (amount >= 0),
  refunded_num  INT           NOT NULL DEFAULT 0,
  refund_amount NUMERIC(12,2) NOT NULL DEFAULT 0,
  created_at    TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT shop_order_item_refund_chk CHECK (refunded_num <= num AND refund_amount <= amount)
);
CREATE INDEX IF NOT EXISTS idx_shop_order_item_order ON shop_order_item (order_id);
CREATE INDEX IF NOT EXISTS idx_shop_order_item_goods ON shop_order_item (site_id, goods_id);
COMMENT ON TABLE shop_order_item IS '订单行快照。金额/成本在下单瞬间固化，禁止 JOIN 商品表回算（与 order.cost_amount 同口径）';

-- ────────────────────────────────────────────────────────────────────────
-- ⑥ shop_freight_template：运费模板（self_goods.freight_tpl JSON 的实体化，两者并存）
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shop_freight_template (
  tpl_id         BIGSERIAL PRIMARY KEY,
  site_id        UUID          NOT NULL REFERENCES site(site_id),
  name           VARCHAR(64)   NOT NULL,
  charge_mode    VARCHAR(16)   NOT NULL DEFAULT 'qty',   -- qty=按件 / weight=按重量(kg)
  free_over      NUMERIC(12,2) NOT NULL DEFAULT 0,       -- 满额包邮（0=不启用）
  first_unit     INT           NOT NULL DEFAULT 1,       -- 首件/首重
  first_fee      NUMERIC(12,2) NOT NULL DEFAULT 0,
  add_unit       INT           NOT NULL DEFAULT 1,       -- 续件/续重
  add_fee        NUMERIC(12,2) NOT NULL DEFAULT 0,
  exclude_regions JSONB        NOT NULL DEFAULT '[]'::jsonb, -- 不发货地区（预留，如 ["新疆","西藏"]）
  status         VARCHAR(16)   NOT NULL DEFAULT 'on',
  created_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT shop_freight_tpl_mode_chk CHECK (charge_mode IN ('qty','weight')),
  CONSTRAINT shop_freight_tpl_status_chk CHECK (status IN ('on','off'))
);
CREATE UNIQUE INDEX IF NOT EXISTS uniq_shop_freight_name ON shop_freight_template (site_id, name);
COMMENT ON COLUMN shop_freight_template.free_over IS '满此金额包邮（元），0 = 不包邮';

-- ────────────────────────────────────────────────────────────────────────
-- ⑦ shop_refund：售后/退款单
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shop_refund (
  refund_id       BIGSERIAL PRIMARY KEY,
  site_id         UUID          NOT NULL REFERENCES site(site_id),
  refund_sn       VARCHAR(64)   NOT NULL UNIQUE,
  order_id        BIGINT        NOT NULL REFERENCES "order"(id),
  item_id         BIGINT        NULL REFERENCES shop_order_item(item_id),
  user_id         BIGINT        NOT NULL,
  type            VARCHAR(24)   NOT NULL DEFAULT 'refund',   -- refund=仅退款 / return=退货退款
  reason          VARCHAR(255)  NULL,
  description     TEXT          NULL,
  images          JSONB         NOT NULL DEFAULT '[]'::jsonb,
  amount          NUMERIC(12,2) NOT NULL CHECK (amount > 0),
  num             INT           NOT NULL DEFAULT 1,
  status          VARCHAR(24)   NOT NULL DEFAULT 'applied',
  wx_refund_id    VARCHAR(64)   NULL,
  wx_refund_state VARCHAR(32)   NULL,
  fail_reason     TEXT          NULL,
  admin_id        BIGINT        NULL,
  admin_remark    TEXT          NULL,
  applied_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  audited_at      TIMESTAMPTZ   NULL,
  finished_at     TIMESTAMPTZ   NULL,
  updated_at      TIMESTAMPTZ   NOT NULL DEFAULT now(),
  CONSTRAINT shop_refund_status_chk CHECK (status IN ('applied','approved','rejected','refunding','success','failed','canceled')),
  CONSTRAINT shop_refund_type_chk   CHECK (type IN ('refund','return'))
);
CREATE INDEX IF NOT EXISTS idx_shop_refund_status ON shop_refund (site_id, status, applied_at);
CREATE INDEX IF NOT EXISTS idx_shop_refund_order  ON shop_refund (order_id);
COMMENT ON COLUMN shop_refund.wx_refund_state IS '微信退款单状态：SUCCESS/PROCESSING/ABNORMAL/CLOSED（V3 退款查询接口回填）';

-- ────────────────────────────────────────────────────────────────────────
-- ⑧ shop_stock_log：库存流水（排查超卖/对账用，只增不改）
-- ────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS shop_stock_log (
  log_id      BIGSERIAL PRIMARY KEY,
  site_id     UUID        NOT NULL REFERENCES site(site_id),
  sku_id      BIGINT      NOT NULL,
  change_num  INT         NOT NULL,                     -- 正=增加 负=减少（对 stock 的净变化）
  after_stock INT         NOT NULL,
  reason      VARCHAR(32) NOT NULL,                     -- order_create/order_pay/order_cancel/refund/admin_adjust
  ref         VARCHAR(64) NULL,                         -- 关联单号（order_sn / refund_sn）
  operator    VARCHAR(64) NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_shop_stock_log_sku ON shop_stock_log (sku_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_shop_stock_log_ref ON shop_stock_log (site_id, ref);

-- ────────────────────────────────────────────────────────────────────────
-- ⑨ 存量数据迁移：self_goods.skus JSON → shop_sku
--    幂等：某商品已有 SKU 行则整商品跳过；raw 保留原始元素
-- ────────────────────────────────────────────────────────────────────────
INSERT INTO shop_sku (site_id, goods_id, sku_code, spec, price, cost_price, stock, status, raw)
SELECT
  g.site_id,
  g.goods_id,
  NULLIF(e.item->>'sku_id', ''),
  COALESCE(NULLIF(e.item->>'spec', ''), '默认'),
  COALESCE(NULLIF(e.item->>'price', '')::numeric, 0),
  COALESCE(NULLIF(e.item->>'cost', '')::numeric, g.cost_price),
  GREATEST(COALESCE(NULLIF(e.item->>'stock', '')::int, 0), 0),
  'on',
  e.item
FROM self_goods g
CROSS JOIN LATERAL jsonb_array_elements(g.skus) WITH ORDINALITY AS e(item, ord)
WHERE jsonb_typeof(g.skus) = 'array'
  AND jsonb_array_length(g.skus) > 0
  AND NOT EXISTS (SELECT 1 FROM shop_sku s WHERE s.goods_id = g.goods_id);

-- ────────────────────────────────────────────────────────────────────────
-- ⑩ 存量数据迁移：自营历史订单 goods_snapshot → shop_order_item
--    只处理 provider='self'（CPS 单不写订单行），幂等：该单已有行则跳过
-- ────────────────────────────────────────────────────────────────────────
INSERT INTO shop_order_item (site_id, order_id, goods_id, sku_id, title, spec, image, unit_price, unit_cost, num, amount, created_at)
SELECT
  o.site_id,
  o.id,
  NULLIF(o.goods_snapshot->>'goods_id', '')::bigint,
  NULL,
  COALESCE(NULLIF(o.goods_snapshot->>'title', ''), '历史自营订单'),
  COALESCE(NULLIF(o.goods_snapshot->>'spec', ''), '默认'),
  NULLIF(o.goods_snapshot->'main_imgs'->>0, ''),
  COALESCE(NULLIF(o.goods_snapshot->>'price', '')::numeric, o.pay_price),
  o.cost_amount,
  GREATEST(COALESCE(NULLIF(o.goods_snapshot->>'num', '')::int, 1), 1),
  o.pay_price,
  o.created_at
FROM "order" o
WHERE o.provider = 'self'
  AND NOT EXISTS (SELECT 1 FROM shop_order_item i WHERE i.order_id = o.id);

-- ────────────────────────────────────────────────────────────────────────
-- ⑪ 幂等收尾：shop_status 与旧 status 对齐（只处理默认值 draft 且 status='on' 的存量商品）
--     存量商品在旧后台已上架 → 商城侧不应显示为草稿，否则 C 端会"整店消失"
-- ────────────────────────────────────────────────────────────────────────
UPDATE self_goods
   SET shop_status = 'on'
 WHERE shop_status = 'draft' AND status = 'on';
