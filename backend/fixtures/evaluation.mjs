// 开发者编写的初始标签，不冒充已获用户或教师人工核对。
const entries = [
  ['核心线程数未满且线程工厂正常时提交任务，通常如何处理？','先尝试创建核心线程处理任务。','correct'],
  ['核心线程数已满、无界队列可接收任务时，是否必然扩到最大线程数？','必然继续创建线程直到最大线程数。','incorrect'],
  ['有界队列满且线程数未达最大值时可能如何处理？','会尝试创建非核心线程执行该任务，创建失败仍可能拒绝。','correct'],
  ['线程数与队列都达到限制时，任务是否一定被悄悄丢弃？','一定悄悄丢弃，没有其他可能。','incorrect'],
  ['解释 AbortPolicy 的行为。','它会抛出拒绝执行异常。','correct'],
  ['无界队列对最大线程数作用有何影响？','我不知道具体执行流程。','uncertain'],
  ['SynchronousQueue 是否储存排队任务？','它没有内部容量，用于直接移交。','correct'],
  ['CallerRunsPolicy 适用于任何场景且没有代价吗？','适用于任何场景，没有延迟或阻塞风险。','incorrect'],
  ['如何评估线程池参数是否合理？','需要结合任务耗时、吞吐量、资源与延迟目标测量验证。','correct'],
  ['核心线程能否超时回收？','可能可以，但我不记得需要什么配置。','uncertain'],
  ['默认情况下核心线程数已经达到且队列能成功入队，会必然新建非核心线程吗？','不会仅因最大线程数尚未达到就必然新建，需要看执行条件。','correct'],
  ['任务队列未指定类型和容量，能否唯一判断是否会扩容？','不能唯一判断，队列能否接收任务会影响后续行为。','correct'],
  ['最大线程数设置为100，当前10个线程，是否每次提交都必定扩容？','是，每次都会创建新线程直到100。','incorrect'],
  ['线程池已关闭，再提交任务是否仍保证被处理？','只要CPU空闲就保证被处理。','incorrect'],
  ['CallerRunsPolicy 会在哪个线程运行任务？','在符合其条件时由调用 execute 的线程运行。','correct'],
  ['增大队列容量必然降低请求延迟吗？','必然降低，不需要考虑排队等待。','incorrect'],
  ['给定任务耗时和队列情况，如何确认拒绝原因？','还需要实际状态、参数与执行日志来确认。','correct'],
  ['解释空闲非核心线程的回收条件。','取决于keepAliveTime等配置，核心线程还要看允许核心超时的设置。','correct'],
  ['SynchronousQueue 会保存无限数量的任务吗？','会，类似无限长度链表队列。','incorrect'],
  ['未给出队列与线程数，预测提交结果。','条件不足，需要先补充配置和运行状态。','uncertain']
];
export const evaluationCases = entries.map(([question, answer, expected], i) => ({ id: `case-${i + 1}`, split: i < 10 ? 'development' : 'validation', question, answer, expected, humanReviewed: false, source: 'https://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/ThreadPoolExecutor.html' }));
