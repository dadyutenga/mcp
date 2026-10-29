export interface AgentRuntimeAdapter {
 capabilities():{start:boolean;pause:boolean;resume:boolean;cancel:boolean;isolatedWorktrees:boolean};
 health():Promise<{available:boolean;reason?:string}>;
 start(task:unknown,repo:unknown,workingDirectory:string,config:unknown):Promise<unknown>;
 pause(jobId:string):Promise<void>;resume(jobId:string):Promise<void>;cancel(jobId:string):Promise<void>;status(jobId:string):Promise<unknown>;
}
