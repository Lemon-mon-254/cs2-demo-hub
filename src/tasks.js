'use strict';

class TaskManager {
  constructor(options = {}) {
    this.tasks = new Map();
    this.counter = 0;
    this.maxTasks = options.maxTasks || 80;
  }

  _prune() {
    if (this.tasks.size <= this.maxTasks) {
      return;
    }
    const finished = [...this.tasks.values()]
      .filter((task) => task.state !== 'running')
      .sort((a, b) => Date.parse(a.updatedAt) - Date.parse(b.updatedAt));
    while (this.tasks.size > this.maxTasks && finished.length > 0) {
      const task = finished.shift();
      this.tasks.delete(task.id);
    }
  }

  start(type, options, runner) {
    this.counter += 1;
    const now = new Date().toISOString();
    const task = {
      id: `task-${Date.now().toString(36)}-${this.counter}`,
      type,
      label: options.label || type,
      matchId: options.matchId || null,
      state: 'running',
      progress: 0,
      phase: null,
      message: options.message || '任务已开始',
      error: null,
      result: null,
      createdAt: now,
      updatedAt: now,
      finishedAt: null,
    };
    this.tasks.set(task.id, task);
    this._prune();

    const update = (patch = {}) => {
      const current = this.tasks.get(task.id);
      if (!current) {
        return;
      }
      Object.assign(current, patch, {updatedAt: new Date().toISOString()});
      if (typeof patch.progress === 'number') {
        current.progress = Math.max(0, Math.min(100, Math.round(patch.progress)));
      }
    };

    Promise.resolve()
      .then(() => runner(update))
      .then((result) => {
        const resultMessage = result && typeof result.message === 'string' && result.message.trim()
          ? result.message
          : null;
        update({
          state: 'success',
          progress: 100,
          phase: 'done',
          message: resultMessage || options.successMessage || '任务完成',
          result: result ?? null,
          finishedAt: new Date().toISOString(),
        });
      })
      .catch((err) => {
        update({
          state: 'error',
          phase: 'error',
          message: err.message || '任务失败',
          error: err.code || 'TASK_FAILED',
          finishedAt: new Date().toISOString(),
        });
      })
      .finally(() => this._prune());

    return this.get(task.id);
  }

  get(id) {
    const task = this.tasks.get(id);
    return task ? {...task} : null;
  }

  list() {
    return [...this.tasks.values()]
      .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
      .map((task) => ({...task}));
  }

  activeForMatch(matchId) {
    return [...this.tasks.values()].filter((task) => (
      task.state === 'running' && String(task.matchId) === String(matchId)
    ));
  }

  active() {
    return [...this.tasks.values()].filter((task) => task.state === 'running');
  }

  /**
   * 清除所有已结束的任务，正在运行的任务会被保留。
   * @returns {number} 被清除的任务数量
   */
  clearFinished() {
    let removed = 0;
    for (const [id, task] of this.tasks) {
      if (task.state !== 'running') {
        this.tasks.delete(id);
        removed += 1;
      }
    }
    return removed;
  }
}

module.exports = {TaskManager};
