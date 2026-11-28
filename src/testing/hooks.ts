/*
 * Test mode only: a read-only window into the running app for the acceptance tests (window.__strand), plus loading
 * a fixture project, the one set-up step the feature files allow to bypass the UI.
 */
import type {App} from '../app';
import {stripMarkers} from '../editor/markers';
import {sceneById} from '../editor/scenes';
import type {Project} from '../model';
import {fake} from './fake-tauri';

function makeHooks(app: App) {
  const {session} = app, view = app.editor.view;
  return {
    fake,
    /** Start afresh with this project, as if opened from `path` (stored there first), or new if path is null. */
    load(project: Project, path: string | null) {
      if (path) fake.files.set(path, structuredClone(project));
      app.load(structuredClone(project), path);
    },
    /** The project as it stands, including what's in the editor. */
    project(): Project {
      session.sync();
      return structuredClone(session.project);
    },
    totals: () => Object.fromEntries(session.totals),
    openId: () => session.openId,
    saved: () => session.saved,
    /** The editor's text, scene markers included. */
    text: () => view.state.doc.toString(),
    scene(id: string) {
      const s = sceneById(view.state, id);
      return s ? {from: s.from, innerFrom: s.innerFrom, innerTo: s.innerTo, to: s.to} : null;
    },
    selection: () => ({from: view.state.selection.main.from, to: view.state.selection.main.to}),
    /** Where an editor position falls in the composed manuscript (the text without scene markers). */
    composedOffset: (pos: number) => stripMarkers(view.state.sliceDoc(0, pos)).length,
  };
}

export type StrandHooks = ReturnType<typeof makeHooks>;

export function installHooks(app: App) {
  (window as unknown as {__strand: StrandHooks}).__strand = makeHooks(app);
}
