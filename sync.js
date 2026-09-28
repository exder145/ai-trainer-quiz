(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.StudySync = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const CONFIG_KEY = 'ai-trainer-sync-config-v1';
  // 去掉了容易看错的 0/O/1/I，方便在两台设备上手动输入。
  const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const CODE_PATTERN = /^[A-Z0-9]{4,32}$/;

  function storageArea() {
    try {
      return typeof localStorage === 'undefined' ? null : localStorage;
    } catch {
      return null;
    }
  }

  // 用文件方式（file://）打开时没有同源接口，需要手动填部署后的地址。
  function defaultEndpoint() {
    if (typeof location === 'undefined' || !location.protocol || location.protocol === 'file:') return '';
    return location.origin + '/api/state';
  }

  function normalizeCode(value) {
    return String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 32);
  }

  function isValidCode(value) {
    return CODE_PATTERN.test(normalizeCode(value));
  }

  function makeCode(length = 8, random = Math.random) {
    let out = '';
    for (let i = 0; i < length; i += 1) out += CODE_ALPHABET[Math.floor(random() * CODE_ALPHABET.length)];
    return out;
  }

  function normalizeEndpoint(value) {
    return String(value || '').trim().replace(/\/+$/, '');
  }

  function readConfig() {
    const area = storageArea();
    const fallback = { code: '', endpoint: '', lastSyncAt: null };
    if (!area) return fallback;
    try {
      const raw = area.getItem(CONFIG_KEY);
      if (!raw) return fallback;
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return fallback;
      return {
        code: normalizeCode(data.code),
        endpoint: normalizeEndpoint(data.endpoint),
        lastSyncAt: typeof data.lastSyncAt === 'string' ? data.lastSyncAt : null,
      };
    } catch {
      return fallback;
    }
  }

  function saveConfig(config) {
    const area = storageArea();
    const clean = {
      code: normalizeCode(config && config.code),
      endpoint: normalizeEndpoint(config && config.endpoint),
      lastSyncAt: (config && typeof config.lastSyncAt === 'string') ? config.lastSyncAt : null,
    };
    if (area) {
      try {
        area.setItem(CONFIG_KEY, JSON.stringify(clean));
      } catch {
        /* 隐私模式下写入失败时忽略，同步仍可用一次。 */
      }
    }
    return clean;
  }

  function endpointFor(config) {
    return normalizeEndpoint(config && config.endpoint) || defaultEndpoint();
  }

  function isReady(config) {
    return isValidCode(config && config.code) && Boolean(endpointFor(config));
  }

  async function call(endpoint, code, init, fetchImpl) {
    const doFetch = fetchImpl || (typeof fetch !== 'undefined' ? fetch : null);
    if (!doFetch) throw new Error('当前环境不支持网络同步');
    const separator = endpoint.includes('?') ? '&' : '?';
    let response;
    try {
      response = await doFetch(endpoint + separator + 'code=' + encodeURIComponent(code), init);
    } catch {
      throw new Error('连不上同步服务，请检查网络');
    }
    if (!response.ok) {
      let detail = '';
      try {
        const body = await response.json();
        if (body && body.error) detail = '：' + body.error;
      } catch {
        /* 服务端没有返回 JSON 时用状态码说明。 */
      }
      throw new Error('同步服务返回 ' + response.status + detail);
    }
    try {
      return await response.json();
    } catch {
      throw new Error('同步服务返回的内容无法解析');
    }
  }

  function pickItems(payload) {
    const items = payload && payload.items;
    if (!items || typeof items !== 'object' || Array.isArray(items)) throw new Error('同步服务返回的数据格式不正确');
    return items;
  }

  // 把本机记录发给服务端，服务端合并后把结果还回来。
  async function push(endpoint, code, items, fetchImpl) {
    const payload = await call(endpoint, code, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items }),
    }, fetchImpl);
    return { items: pickItems(payload), updatedAt: payload.updatedAt || null };
  }

  async function pull(endpoint, code, fetchImpl) {
    const payload = await call(endpoint, code, { method: 'GET' }, fetchImpl);
    return { items: pickItems(payload), updatedAt: payload.updatedAt || null };
  }

  return {
    CONFIG_KEY,
    defaultEndpoint,
    endpointFor,
    isReady,
    isValidCode,
    makeCode,
    normalizeCode,
    normalizeEndpoint,
    pull,
    push,
    readConfig,
    saveConfig,
  };
});
