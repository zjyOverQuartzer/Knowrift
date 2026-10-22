import { DateTime } from 'luxon';
import { id, stamp, fault, readJson, saveJson } from '../core/storage.mjs';

export function nextOccurrence(task, after = DateTime.utc()) {
  const zone = task.timezone || 'Asia/Shanghai';
  let target = DateTime.fromISO(task.localTime, { zone });
  if (!target.isValid) throw fault('任务时间或时区无效');
  if (task.frequency === 'once') return target.toMillis() > after.toMillis() ? target.toUTC().toISO() : null;
  if (!['daily','weekly'].includes(task.frequency)) throw fault('任务规则无效');
  const increment = task.frequency === 'daily' ? { days: 1 } : { weeks: 1 };
  // 按本地日历递增，夏令时切换时仍保留用户指定的当地时间。
  if (target < after.minus({ years: 2 })) throw fault('循环任务的起始时间过早');
  while (target.toMillis() <= after.toMillis()) target = target.plus(increment);
  return target.toUTC().toISO();
}

export class SchedulerStore {
  constructor(file) { this.file = file; this.state = readJson(file, { users: [], codes: [], tasks: [], runs: [] }); }
  save() { saveJson(this.file, this.state); }
}

export class Scheduler {
  constructor(store, send, { now = () => DateTime.utc() } = {}) { this.store = store; this.send = send; this.now = now; this.running = false; }
  async tick() {
    if (this.running) return; this.running = true;
    try {
      const now = this.now(); const data = this.store.state;
      for (const task of data.tasks.filter(t => t.enabled && !t.deleted && t.nextRunAt && DateTime.fromISO(t.nextRunAt) <= now)) {
        const scheduledAt = task.nextRunAt;
        const digest = task.type === 'digest';
        const key = digest ? `${task.userId}:digest:${now.setZone(task.timezone).toISODate()}` : `${task.userId}:${task.id}:${scheduledAt}`;
        let run = data.runs.find(r => r.key === key);
        const hasDue = !digest || task.items?.some(item => DateTime.fromISO(item.dueAt) <= now);
        if (!run && hasDue) { run = { id: id(), key, userId: task.userId, taskId: task.id, taskIds: [task.id], digest, scheduledAt, status: 'queued', attempts: 0, nextAttemptAt: now.toISO(), createdAt: stamp(), title: digest ? '知隙｜今日待复习摘要' : task.title, body: task.body }; data.runs.push(run); }
        else if (run && digest && hasDue && run.status === 'queued' && !run.taskIds.includes(task.id)) run.taskIds.push(task.id);
        task.nextRunAt = task.frequency === 'once' ? null : nextOccurrence(task, now);
        if (task.frequency === 'once') task.enabled = false;
        this.store.save();
      }
      for (const run of data.runs.filter(r => ['queued','retrying'].includes(r.status) && DateTime.fromISO(r.nextAttemptAt) <= now)) {
        const task = data.tasks.find(t => t.id === run.taskId && t.userId === run.userId);
        const user = data.users.find(u => u.id === run.userId);
        if (run.digest) {
          const sources = data.tasks.filter(t => run.taskIds.includes(t.id) && t.userId === run.userId && t.enabled && !t.deleted);
          const sections = sources.map(t => { const due = (t.items || []).filter(item => DateTime.fromISO(item.dueAt) <= now); return due.length ? `${t.title}\n${due.map(i => `- ${i.label}（${i.status}）`).join('\n')}\n${t.body}` : ''; }).filter(Boolean);
          if (!user || !sections.length) { run.status = 'cancelled'; this.store.save(); continue; }
          run.body = sections.join('\n\n');
        } else if (!task || task.deleted || !user || (task.frequency !== 'once' && !task.enabled)) { run.status = 'cancelled'; this.store.save(); continue; }
        run.status = 'sending'; run.attempts++; this.store.save();
        try {
          const result = await this.send({ to: user.email, subject: run.title, text: run.body, messageId: `<${run.id}@zhixi.local>`, userId: user.id });
          run.status = 'submitted'; run.channelId = result.messageId || null; run.finishedAt = this.now().toISO();
        } catch (e) {
          run.error = '邮件渠道提交失败，请检查服务器发信配置或网络';
          if (run.attempts <= 3) { run.status = 'retrying'; run.nextAttemptAt = now.plus({ minutes: [1,5,15][run.attempts - 1] }).toISO(); }
          else run.status = 'failed';
        }
        this.store.save();
      }
    } finally { this.running = false; }
  }
  recover() {
    // 进程在 SMTP 交接时崩溃，不能确定是否已提交，避免盲目重发造成重复。
    for (const run of this.store.state.runs) if (run.status === 'sending') { run.status = 'uncertain'; run.error = '服务中断时正在提交，结果不确定，请人工核查'; }
    this.store.save();
  }
}
