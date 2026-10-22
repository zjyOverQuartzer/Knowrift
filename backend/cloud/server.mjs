import Fastify from 'fastify';
import rateLimit from '@fastify/rate-limit';
import nodemailer from 'nodemailer';
import crypto from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { DateTime } from 'luxon';
import { SchedulerStore, Scheduler, nextOccurrence } from './scheduler.mjs';
import { id, fault } from '../core/storage.mjs';

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const equal = (a, b) => { const x = Buffer.from(a); const y = Buffer.from(b); return x.length === y.length && crypto.timingSafeEqual(x, y); };
const emailSchema = z.string().email().max(254).transform(s => s.toLowerCase());
const taskSchema = z.object({ title: z.string().min(1).max(160), body: z.string().min(1).max(16000), frequency: z.enum(['once','daily','weekly']), localTime: z.string().min(10).max(40), timezone: z.string().min(1).max(80), enabled: z.boolean(), type: z.enum(['manual','digest']).default('manual'), items: z.array(z.object({ label: z.string().max(160), dueAt: z.string().datetime(), status: z.string().max(30) }).strict()).max(100).optional() }).strict();

export async function buildServer({ file = path.resolve(process.env.DATA_DIR || fileURLToPath(new URL('../../.data/cloud', import.meta.url)), 'cloud.json'), mailer, startWorker = false } = {}) {
  const server = Fastify({ logger: false, bodyLimit: 40000, trustProxy: false });
  await server.register(rateLimit, { max: 120, timeWindow: '1 minute' });
  const store = new SchedulerStore(file);
  const transport = mailer || (process.env.SMTP_HOST && process.env.MAIL_FROM ? nodemailer.createTransport({ host: process.env.SMTP_HOST, port: Number(process.env.SMTP_PORT || 587), secure: process.env.SMTP_SECURE === 'true', auth: process.env.SMTP_USER ? { user: process.env.SMTP_USER, pass: process.env.SMTP_PASSWORD } : undefined, connectionTimeout: 15000, socketTimeout: 20000, tls: { rejectUnauthorized: true } }) : null);
  const send = async mail => {
    if (!transport) throw fault('服务端尚未配置邮件渠道', 'SMTP_NOT_CONFIGURED');
    return transport.sendMail({ from: process.env.MAIL_FROM || 'test@zhixi.local', to: mail.to, subject: mail.subject, text: mail.text, ...(mail.messageId ? { messageId: mail.messageId } : {}) });
  };
  const scheduler = new Scheduler(store, send); scheduler.recover();
  server.setErrorHandler((e, req, reply) => { const status = e.statusCode || (e instanceof z.ZodError ? 400 : e.code === 'UNAUTHORIZED' ? 401 : 400); reply.code(status).send({ error: e instanceof z.ZodError ? '输入格式无效' : e.message }); });
  const auth = req => {
    const token = req.headers.authorization?.replace(/^Bearer /, '') || '';
    const user = store.state.users.find(u => u.tokenHash && equal(u.tokenHash, hash(token)));
    if (!user || !token) throw fault('请先验证邮箱并登录提醒服务', 'UNAUTHORIZED');
    return user;
  };
  server.get('/health', async () => ({ ok: true, service: 'zhixi-reminders', mailConfigured: Boolean(transport) }));
  server.post('/auth/code', { config: { rateLimit: { max: 5, timeWindow: '15 minutes' } } }, async req => {
    if (!transport) throw fault('云端邮件渠道尚未配置，不能发送验证码');
    const email = emailSchema.parse(req.body?.email); const now = Date.now();
    const allow = (process.env.ALLOWED_EMAILS || '').split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    if (allow.length && !allow.includes(email)) throw fault('当前邮箱不在课程试用名单中');
    if (store.state.codes.some(c => c.email === email && now - c.createdAt < 60000)) throw fault('请稍后再申请验证码');
    const code = String(crypto.randomInt(100000, 1000000));
    await send({ to: email, subject: '知隙邮箱验证码', text: `你的验证码为 ${code}，10分钟内有效。若非本人操作，请忽略。` });
    store.state.codes = store.state.codes.filter(c => c.email !== email && c.expiresAt > now);
    store.state.codes.push({ email, codeHash: hash(code), createdAt: now, expiresAt: now + 600000, attempts: 0 }); store.save();
    return { status: 'submitted', message: '验证码已提交邮件渠道，请查看收件箱' };
  });
  server.post('/auth/verify', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async req => {
    const email = emailSchema.parse(req.body?.email); const code = z.string().regex(/^\d{6}$/).parse(req.body?.code);
    const record = store.state.codes.find(c => c.email === email && c.expiresAt > Date.now());
    if (!record || record.attempts >= 5) throw fault('验证码已失效，请重新申请');
    record.attempts++; store.save();
    if (!equal(record.codeHash, hash(code))) throw fault('验证码错误');
    let user = store.state.users.find(u => u.email === email); if (!user) { user = { id: id(), email }; store.state.users.push(user); }
    const token = crypto.randomBytes(32).toString('hex'); user.tokenHash = hash(token);
    store.state.codes = store.state.codes.filter(c => c.email !== email); store.save(); return { token, email };
  });
  server.get('/tasks', async req => { const user = auth(req); return { tasks: store.state.tasks.filter(t => t.userId === user.id && !t.deleted).map(t => ({ ...t, runs: store.state.runs.filter(r => r.userId === user.id && (r.taskId === t.id || r.taskIds?.includes(t.id))).slice(-30).reverse() })) }; });
  server.put('/tasks/:id', async req => {
    const user = auth(req); const taskId = z.string().regex(/^[a-zA-Z0-9-]{1,100}$/).parse(req.params.id); const body = taskSchema.parse(req.body);
    const target = DateTime.fromISO(body.localTime, { zone: body.timezone });
    if (!target.isValid || (body.frequency === 'once' && body.enabled && target <= DateTime.utc())) throw fault('时间无效；一次性任务必须设置未来时间');
    let task = store.state.tasks.find(t => t.id === taskId && t.userId === user.id);
    if (!task && store.state.tasks.filter(t => t.userId === user.id && !t.deleted).length >= 100) throw fault('课程试用每位用户最多100个任务');
    const unchangedSchedule = task && task.localTime === body.localTime && task.timezone === body.timezone && task.frequency === body.frequency && task.enabled === body.enabled;
    const nextRunAt = body.enabled ? (unchangedSchedule ? task.nextRunAt : nextOccurrence(body)) : null;
    if (!task) { task = { id: taskId, userId: user.id }; store.state.tasks.push(task); }
    Object.assign(task, body, { deleted: false, nextRunAt, updatedAt: new Date().toISOString() });
    for (const run of store.state.runs) if (run.userId === user.id && run.taskId === taskId && !run.digest && ['queued','retrying'].includes(run.status)) run.status = 'cancelled';
    store.save(); return { task };
  });
  server.delete('/tasks/:id', async req => { const user = auth(req); const task = store.state.tasks.find(t => t.id === req.params.id && t.userId === user.id); if (task) { task.deleted = true; task.enabled = false; for (const run of store.state.runs) if (run.userId === user.id && run.taskId === task.id && !run.digest && ['queued','retrying'].includes(run.status)) run.status = 'cancelled'; store.save(); } return { deleted: true }; });
  let timer;
  if (startWorker) { timer = setInterval(() => scheduler.tick().catch(() => {}), 10000); timer.unref(); }
  server.addHook('onClose', async () => { if (timer) clearInterval(timer); if (transport?.close) transport.close(); });
  return { server, scheduler, store };
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { server } = await buildServer({ startWorker: true });
  await server.listen({ host: process.env.HOST || '127.0.0.1', port: Number(process.env.PORT || 4319) });
  console.log(`知隙提醒服务已启动，端口 ${process.env.PORT || 4319}。日志不记录邮箱验证码或访问令牌。`);
  for (const signal of ['SIGINT','SIGTERM']) process.on(signal, () => server.close().then(() => process.exit(0)));
}
