const { latencyRequest } = require('./settings.cjs');

const canceled = () => Error('已取消延迟测试');
class DelayTasks {
  constructor({ engine, settings, concurrency = 4, limit = 128 }) { this.engine = engine; this.settings = settings; this.concurrency = concurrency; this.limit = limit; this.tasks = new Map(); this.queue = []; this.active = 0; this.sequence = 0; }
  run(payload) {
    if (!this.engine.ready) return Promise.reject(Error('请先连接'));
    let request, provider, id;
    try {
      request = latencyRequest(this.settings(), payload);
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
      const route = task.provider ? `/providers/proxies/${encodeURIComponent(task.provider)}/${encodeURIComponent(task.name)}/healthcheck` : `/proxies/${encodeURIComponent(task.name)}/delay`;
      const endpoint = `${route}?timeout=${task.timeout}&url=${encodeURIComponent(task.url)}`;
      const signal = AbortSignal.any([task.controller.signal, AbortSignal.timeout(task.timeout + 2000)]);
      let abort;
      const stopped = new Promise((_, reject) => { abort = () => reject(task.controller.signal.aborted ? canceled() : Error('延迟测试超时')); if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true }); });
      Promise.race([Promise.resolve().then(() => this.engine.api(endpoint, 'GET', undefined, { signal })), stopped])
        .then(value => this.finish(task, null, value), error => this.finish(task, error))
        .finally(() => { signal.removeEventListener('abort', abort); this.active--; this.pump(); });
    }
  }
}
module.exports = { DelayTasks };
