/*
 * Test mode only (vite --mode test): a stand-in for the desktop side, so the app runs in a plain browser for the
 * acceptance tests. Project "files" live in memory; dialogs and the clipboard answer from `fake`; spelling and grammar
 * use tiny fixed rules so results are predictable.
 */
import {mockIPC} from '@tauri-apps/api/mocks';
import type {Project} from '../model';
import type {SpellIssue} from '../checking/spelling';
import type {GrammarIssue} from '../checking/grammar';

export const fake = {
  files: new Map<string, Project>(),
  exported: new Map<string, string>(),
  clipboard: '',
  saves: 0,
  /** What the next file dialogs return (null = cancelled). */
  dialogs: {open: null as string | null, saveProject: 'book.strand' as string | null, exportMarkdown: 'book.md' as string | null},
};

/** Words the fake spell checker flags. */
const MISSPELT = new Set(['teh', 'cagthrs', 'wrord']);

function spellIssues(text: string): SpellIssue[] {
  return [...text.matchAll(/[A-Za-z]+/g)]
    .filter(m => MISSPELT.has(m[0].toLowerCase()))
    .map(m => ({start: m.index!, length: m[0].length, action: 'suggest', replacement: null}));
}

/** The fake grammar checker knows one rule: "a" before a vowel. */
function grammarIssues(text: string): GrammarIssue[] {
  return [...text.matchAll(/\b[Aa](?= [aeiou])/g)]
    .map(m => ({start: m.index!, length: 1, rule: 'AnA', kind: 'Miscellaneous', message: 'Incorrect indefinite article.', fixes: ['an']}));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Args = any;

export function installFakeTauri() {
  mockIPC((cmd, args: Args) => {
    switch (cmd) {
      case 'save_project':
        fake.files.set(args.path, structuredClone(args.project));
        fake.saves++;
        return null;
      case 'load_project': {
        const project = fake.files.get(args.path);
        if (!project) throw `No such file: ${args.path}`;
        return structuredClone(project);
      }
      case 'export_markdown':
        fake.exported.set(args.path, args.prose);
        return null;
      case 'spell_check': return {language: args.language, issues: (args.texts as string[]).map(spellIssues)};
      case 'spell_suggest': return ['the'];
      case 'grammar_check': return (args.texts as string[]).map(grammarIssues);
      case 'plugin:dialog|open': return fake.dialogs.open;
      case 'plugin:dialog|save': return args.options?.filters?.[0]?.extensions?.includes('md') ? fake.dialogs.exportMarkdown : fake.dialogs.saveProject;
      case 'plugin:clipboard-manager|read_text': return fake.clipboard;
      case 'plugin:clipboard-manager|write_text':
        fake.clipboard = args.text;
        return null;
    }
    throw `The fake backend doesn’t know the command ${cmd}`;
  });
}
