/*
 * Everything Strand asks of the desktop side (the Rust commands in src-tauri, file dialogs, the clipboard), in one
 * typed place. Tests swap in a fake at this seam (or at Tauri's IPC layer underneath it).
 */
import {invoke} from '@tauri-apps/api/core';
import {open, save} from '@tauri-apps/plugin-dialog';
import {readText, writeText} from '@tauri-apps/plugin-clipboard-manager';
import type {Project} from './model';
import type {SpellIssue} from './checking/spelling';
import type {GrammarIssue} from './checking/grammar';

const STRAND = {name: 'Strand project', extensions: ['strand']};

export const backend = {
  saveProject: (path: string, project: Project) => invoke<void>('save_project', {path, project}),
  loadProject: (path: string) => invoke<Project>('load_project', {path}),
  exportMarkdown: (path: string, prose: string) => invoke<void>('export_markdown', {path, prose}),

  spellCheck: (language: string, texts: string[]) => invoke<{language: string; issues: SpellIssue[][]}>('spell_check', {language, texts}),
  spellSuggest: (language: string, word: string) => invoke<string[]>('spell_suggest', {language, word}),
  grammarCheck: (texts: string[]) => invoke<GrammarIssue[][]>('grammar_check', {texts}),

  /** Ask where to open a project from; null if cancelled. */
  chooseProjectToOpen: async () => {
    const path = await open({multiple: false, filters: [STRAND]});
    return typeof path === 'string' ? path : null;
  },
  /** Ask where to save a project; null if cancelled. */
  chooseProjectSaveAs: () => save({filters: [STRAND]}),
  /** Ask where to export Markdown; null if cancelled. */
  chooseMarkdownExport: () => save({filters: [{name: 'Markdown', extensions: ['md']}]}),

  readClipboard: () => readText(),
  writeClipboard: (text: string) => writeText(text),
};

export type Backend = typeof backend;
