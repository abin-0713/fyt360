// 请求封装：M1 空壳直连 API_BASE；多站点构建期由 sites/<site>/config.json 注入
// 商城二开：改为构建期可配置（VITE_API_BASE），默认指向自建域名
// 小程序必须用 https 且在微信公众平台配置 request 合法域名
export const API_BASE = import.meta.env?.VITE_API_BASE ?? 'https://xc.fishingbank.cn';

// 站点 code（与 h5 的 request.js 保持对称导出，便于共享 shop.js API 封装）
export const SITE_CODE = 'site-a';

const TOKEN_KEY = 'fyt_token';

/** 默认请求超时（ms）。uni.request 平台默认 60s，实测上游偶发挂死会让 loading 遮罩永驻（D先生 2026-10-03）。
 *  取 20s：足够覆盖蚂蚁/京东 CPS 实测 0.5~4s 的正常波动，又能保证异常时快速降级而非假死。
 *  单次可传 options.timeout 覆盖。 */
const DEFAULT_TIMEOUT = 20000;

export function getToken() {
  try {
    return uni.getStorageSync(TOKEN_KEY) || '';
  } catch (e) {
    return '';
  }
}

export function setToken(token) {
  try {
    if (token) uni.setStorageSync(TOKEN_KEY, token);
    else uni.removeStorageSync(TOKEN_KEY);
  } catch (e) {
    // storage 异常不阻塞主流程
  }
}

export function request(path, options = {}) {
  const token = getToken();
  const header = options.header ?? {};
  if (token) header.Authorization = 'Bearer ' + token;
  return new Promise((resolve, reject) => {
    uni.request({
      url: API_BASE + path,
      method: options.method ?? 'GET',
      data: options.data ?? {},
      header,
      timeout: options.timeout ?? DEFAULT_TIMEOUT,
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300 && res.data?.ok) {
          resolve(res.data.data);
        } else {
          reject(new Error(res.data?.message ?? `HTTP ${res.statusCode}`));
        }
      },
      fail: (err) => {
        const msg = String(err?.errMsg ?? '');
        // 平台超时 errMsg 形如 "request:fail timeout" —— 给出可读文案，便于排查「卡死」
        reject(new Error(/timeout/i.test(msg) ? '请求超时，请重试' : msg || '网络错误'));
      },
    });
  });
}
