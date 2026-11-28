/*
 * Test helper: write a project as {Title: 'prose with {{Child}} references'}. Titles double as node ids, so they must be
 * plain words. The first entry is the root.
 */
import type {Project} from '../model';

export function book(nodes: Record<string, string>, extra: Partial<Project> = {}): Project {
  const titles = Object.keys(nodes);
  return {
    root: titles[0],
    nodes: titles.map(id => ({id, title: id, prose: nodes[id].replace(/\{\{([A-Za-z0-9-]+)\}\}/g, '{{node:$1}}')})),
    words: [],
    settings: {grammar: true, grammarOffRules: []},
    ...extra,
  };
}

/** A node's prose with references written back as {{Child}}. */
export function prose(p: Project, id: string) {
  const n = p.nodes.find(n => n.id === id);
  if (!n) throw Error(`No node ${id}`);
  return n.prose.replace(/\{\{node:([A-Za-z0-9-]+)\}\}/g, '{{$1}}');
}
