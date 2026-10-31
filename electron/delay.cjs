const { latencyRequest, normalizeSettings } = require('./settings.cjs');

const canceled = () => Error('已取消延迟测试');
const isRecord = value => !!value && typeof value === 'object' && !Array.isArray(value);

// Keep the renderer contract stable even when a core/API implementation returns
// an empty body, a numeric value, or a non-numeric delay.  The UI can use the
// status field for colour without having to duplicate response-shape checks.
function delayStatus(value) {
  const delay = Number(value);
  if (!Number.isFinite(delay) || delay < 0) return 'timeout';
  if (delay === 0) return 'unknown';
  if (delay < 200) return 'good';
  if (delay < 500) return 'warning';
  return 'bad';
}

function normalizeDelayResult(value) {
  const result = isRecord(value) ? { ...value } : {};
  const raw = result.delay ?? result.latency ?? (typeof value === 'number' ? value : undefined);
  const numeric = Number(raw);
  const delay = Number.isFinite(numeric) && numeric >= 0 ? Math.round(numeric) : -1;
  result.delay = delay;
  result.latency = delay >= 0 ? delay : null;
  result.status = delayStatus(delay);
  return result;
}

function requestUrls(settings, payload, request) {
  // An explicit URL is a one-off probe. Saved alternatives are used for the
  // normal node test, preserving the selected URL as the first attempt.
  if (isRecord(payload) && payload.url !== undefined) return [request.url];
  const urls = [request.url];
  for (const value of normalizeSettings(settings).latency.urls) {
    try {
      const candidate = latencyRequest(settings, { name: request.name, url: value, timeout: request.timeout }).url;
      if (!urls.includes(candidate)) urls.push(candidate);
    } catch { /* Ignore a stale malformed alternative. */ }
  }
  return urls;
}

class DelayTasks {
  constructor({ engine, settings, concurrency = 4, limit = 128 }) { this.engine = engine; this.settings = settings; this.concurrency = concurrency; this.limit = limit; this.tasks = new Map(); this.queue = []; this.active = 0; this.sequence = 0; }
  run(payload) {
    if (!this.engine.ready) return Promise.reject(Error('请先连接'));
    let request, provider, id;
    try {
      const settings = this.settings();
      request = latencyRequest(settings, payload);
      request.urls = requestUrls(settings, payload, request);
      provider = typeof payload === 'object' ? payload.provider : undefined;
      if (provider !== undefined && provider !== null && (typeof provider !== 'string' || !provider || provider.length > 1024 || /[\x00-\x1f\x7f]/.test(provider))) throw Error('Provider 参数无效');
      id = typeof payload === 'object' ? payload.requestId : undefined;
      if (id !== undefined && (typeof id !== 'string' || !id || id.length > 2048)) throw Error('测速请求标识无效');
      id ??= `delay-${++this.sequence}`;
      if (this.tasks.has(id)) throw Error('此测速请求正在进行');
      if (this.tasks.size >= this.limit) throw Error('测速队列已满，请稍后重试');
    } catch (error) { return Promise.reject(error); }
    return new Promise((resolve, reject) => {
      const task = { id, ...request, provider, resolve, reject, controller: new AbortController(), finished: false };
      this.tasks.set(id, task); this.queue.push(task); this.pump();
    });
  }
  cancel(value) {
    if (value !== undefined && (!value || typeof value !== 'object' || typeof value.id !== 'string' || !value.id || value.id.length > 2048)) throw Error('测速请求标识无效');
    const tasks = value ? [this.tasks.get(value.id)].filter(Boolean) : [...this.tasks.values()];
    for (const task of tasks) { task.controller.abort(); this.finish(task, canceled()); }
    this.queue = this.queue.filter(task => !task.finished);
    return { canceled: tasks.length };
  }
  finish(task, error, value) {
    if (task.finished) return;
    task.finished = true; this.tasks.delete(task.id); error ? task.reject(error) : task.resolve(value);
  }
  pump() {
    while (this.active < this.concurrency && this.queue.length) {
      const task = this.queue.shift(); if (task.finished) continue;
      if (!this.engine.ready) { this.finish(task, canceled()); continue; }
      this.active++;
      Promise.resolve().then(async () => {
        const deadline = Date.now() + task.timeout + 2000;
        let lastError;
        for (const url of task.urls) {
          if (task.controller.signal.aborted) throw canceled();
          const remaining = deadline - Date.now();
          if (remaining <= 0) break;
          const timer = AbortSignal.timeout(Math.max(1, remaining));
          const signal = AbortSignal.any([task.controller.signal, timer]);
          const route = task.provider ? `/providers/proxies/${encodeURIComponent(task.provider)}/${encodeURIComponent(task.name)}/healthcheck` : `/proxies/${encodeURIComponent(task.name)}/delay`;
          const endpoint = `${route}?timeout=${Math.min(task.timeout, Math.max(1, remaining))}&url=${encodeURIComponent(url)}`;
          try {
            const value = await this.engine.api(endpoint, 'GET', undefined, { signal });
            return normalizeDelayResult(value);
          } catch (error) {
            if (task.controller.signal.aborted) throw canceled();
            lastError = error;
            if (timer.aborted || Date.now() >= deadline) break;
          }
        }
        const result = normalizeDelayResult(-1);
        if (lastError?.message) result.error = String(lastError.message).slice(0, 300);
        return result;
      }).then(value => this.finish(task, null, value), error => this.finish(task, error))
        .finally(() => { this.active--; this.pump(); });
    }
  }
}
module.exports = { DelayTasks, delayStatus, normalizeDelayResult };
