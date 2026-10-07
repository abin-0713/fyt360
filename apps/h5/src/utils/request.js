// 请求封装（H5）：uni.request 走 XHR；token 用 window.localStorage 原生 API
// key 与旧 H5 空壳一致（fyt_token_site-a）——用户升级后无需重新授权
// 商城二开：默认同源（H5 与 API 同域部署），可用 VITE_API_BASE 覆盖为绝对地址
export const API_BASE = import.meta.env?.VITE_API_BASE ?? '';

export const SITE_CODE = 'site-a';
const TOKEN_KEY = 'fyt_token_' + SITE_CODE;

export function getToken() {
  try {
    return window.localStorage.getItem(TOKEN_KEY) || '';
  } catch (e) {
    return '';
  }
}

export function setToken(token) {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
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
      success: (res) => {
        if (res.statusCode >= 200 && res.statusCode < 300 && res.data?.ok) {
          resolve(res.data.data);
        } else {
          reject(new Error(res.data?.message ?? `HTTP ${res.statusCode}`));
        }
      },
      fail: (err) => reject(new Error(err.errMsg ?? '网络错误')),
    });
  });
}
