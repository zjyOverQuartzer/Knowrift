import fs from 'node:fs';
import path from 'node:path';
import { LearningService } from '@knowrift/backend';
const directory=path.resolve('examples/Java线程池');
if(fs.existsSync(path.join(directory,'.zhixi/state.json'))){console.log('示例已存在，保留已有内容。');process.exit(0);}
const service=new LearningService(path.resolve('.data/example-builder'),{environmentKey:''});const p=service.createProject({name:'Java线程池示例',directory});
service.writeFile({projectId:p.id,file:'references/阅读说明.md',content:'# 示例阅读说明\n\n本项目使用明确标识的示例回答演示功能，不是经过真实模型验证的学习结论。\n\n可结合官方资料阅读：\n\nhttps://docs.oracle.com/en/java/javase/21/docs/api/java.base/java/util/concurrent/ThreadPoolExecutor.html\n\n在应用内通过“新建项目 → 导入已有项目”选择这个目录。',expectedRevision:null});
const session=await service.startSession({projectId:p.id,topic:'Java线程池',demo:true});
await service.answer({projectId:p.id,sessionId:session.id,content:'我希望先根据任务数量推演线程和队列的变化，再归纳规则。'});
await service.endSession({projectId:p.id,sessionId:session.id});console.log(`示例项目已生成：${directory}`);
