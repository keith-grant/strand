export interface NarrativeNode { id: string; title: string; prose: string }
export interface Project { root: string; nodes: NarrativeNode[] }
export const reference = (id: string) => `{{node:${id}}}`;
export const parts = (prose: string) => prose.split(/(\{\{node:[a-zA-Z0-9-]+\}\})/g).map((text,i) => i%2 ? {kind:'child' as const,id:text.slice(7,-2)} : {kind:'text' as const,text});
export function newNode(title='Untitled',prose=''): NarrativeNode { return {id:crypto.randomUUID(),title,prose}; }
export function newProject(): Project { const root=newNode('Manuscript'); return {root:root.id,nodes:[root]}; }
export function node(p:Project,id:string): NarrativeNode { const n=p.nodes.find(n=>n.id===id); if(!n) throw Error(`Missing node ${id}`); return n; }
export function children(n:NarrativeNode):string[] { return parts(n.prose).flatMap(p=>p.kind==='child'?[p.id]:[]); }
export function validate(p:Project) { const seen=new Set<string>(); function visit(id:string){ if(seen.has(id)) throw Error('Repeated node or cycle'); seen.add(id); children(node(p,id)).forEach(visit); } visit(p.root); if(seen.size!==p.nodes.length) throw Error('Unreachable or duplicate nodes'); }
export function compose(p:Project,id=p.root):string { return parts(node(p,id).prose).map(v=>v.kind==='text'?v.text:compose(p,v.id)).join(''); }
export function wordCount(s:string):number { return s.trim().split(/\s+/).filter(Boolean).length; }
export function subtree(p:Project,id:string):string[] { const out:string[]=[]; (function visit(i:string){ out.push(i); children(node(p,i)).forEach(visit); })(id); return out; }
/** Words belonging directly to each node, and to it plus all its descendants. */
export function wordTotals(p:Project):Map<string,{own:number,total:number}> { const out=new Map<string,{own:number,total:number}>(); function visit(id:string):number { const n=node(p,id), own=wordCount(parts(n.prose).map(v=>v.kind==='text'?v.text:' ').join('')); let total=own; for(const c of children(n)) total+=visit(c); out.set(id,{own,total}); return total; } visit(p.root); return out; }
export function move(p:Project,id:string,target:string) { if(id===p.root) throw Error('Cannot move root'); const old=p.nodes.find(n=>children(n).includes(id)); if(!old) throw Error('Missing parent'); const before=structuredClone(p); try { old.prose=old.prose.replace(reference(id),''); node(p,target).prose+='\n\n'+reference(id); validate(p); } catch(e){p.nodes=before.nodes;throw e;} }
