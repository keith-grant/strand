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

/** Where a moved node goes relative to the target: as its sibling before or after it, or at the end of its content. */
export type Place='before'|'after'|'inside';
type Slice=(from:number,to:number)=>string;
/** Line breaks to put either side of a block inserted at `at` (inside [start,end)) so it sits in its own paragraph. */
export function separators(slice:Slice,at:number,start:number,end:number):[string,string] {
  const before=slice(Math.max(start,at-2),at), after=slice(at,Math.min(end,at+2));
  return [at<=start||before==='\n\n'?'':before.endsWith('\n')?'\n':'\n\n', at>=end||after==='\n\n'?'':after.startsWith('\n')?'\n':'\n\n'];
}
/** What to remove when taking [from,to) out of [start,end): it plus the blank lines after it (or else before it), so gaps don't pile up. */
export function cutWithGap(slice:Slice,from:number,to:number,start:number,end:number):[number,number] {
  const space=(i:number)=>/\s/.test(slice(i,i+1));
  let b=to; while(b<end&&space(b)) b++;
  if(slice(to,b).includes('\n')) return [from,b];
  let a=from; while(a>start&&space(a-1)) a--;
  return slice(a,from).includes('\n')?[a,to]:[from,to];
}
/** Move a node in the stored model (used for moves that reach outside the open editor). */
export function place(p:Project,id:string,target:string,where:Place) {
  if(id===p.root) throw Error('The top node can’t be moved.');
  if(subtree(p,id).includes(target)) throw Error('A node can’t be moved inside itself.');
  const parentOf=(i:string)=>{ const n=p.nodes.find(n=>children(n).includes(i)); if(!n) throw Error('Only “inside” works for the top node.'); return n; };
  const before=structuredClone(p.nodes);
  try {
    const old=parentOf(id), ref=reference(id), i=old.prose.indexOf(ref);
    const [a,b]=cutWithGap((x,y)=>old.prose.slice(x,y),i,i+ref.length,0,old.prose.length);
    old.prose=old.prose.slice(0,a)+old.prose.slice(b);
    const host=where==='inside'?node(p,target):parentOf(target), j=host.prose.indexOf(reference(target));
    const at=where==='inside'?host.prose.length:where==='before'?j:j+reference(target).length;
    const [lead,trail]=separators((x,y)=>host.prose.slice(x,y),at,0,host.prose.length);
    host.prose=host.prose.slice(0,at)+lead+ref+trail+host.prose.slice(at);
    validate(p);
  } catch(e) { p.nodes=before; throw e; }
}
