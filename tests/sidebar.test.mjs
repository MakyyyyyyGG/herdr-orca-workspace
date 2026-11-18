import { locations, normalize } from '../mods/orca-projects/projects.js';
import { endpoints } from '../mods/orca-projects/activity.js';
import { openProject } from '../mods/orca-add-project/open-project.js';
import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
test('opening a drive root preserves its absolute path', () => assert.equal(normalize('D:\\'), 'D:/'));
test('a space that has not supplied tabs yet remains visible', () => {
  assert.equal(locations([{id:'pending',folder:'D:/work'}], [], [], [])[0].space.id, 'pending');
});
test('a stale port record cannot hide the remaining listeners', () => {
  const port = {bind:'127.0.0.1',port:4100,pid:100,process:'node'};
  assert.deepEqual(endpoints([{ports:[null,port]}, {ports:{}}]), [port]);
});
test('creation controls have a layout block independent of project rendering', () => {
  const layout = JSON.parse(fs.readFileSync(new URL('../layouts/orca.json',import.meta.url)));
  const sidebar = layout.children[0].children.find(child => child.id === 'sidebar');
  assert.ok(sidebar.children.find(child => child.content?.mod === 'orca-project-actions'));
});

const space = { id: 'work', folder: 'C:/work', tabs: [{ id: 'tab' }] };
const pane = { tab: 'tab', pane: 'one', terminal: 't1', cwd: 'C:/work/src' };
const command = (name, args) => ({ name, args });
const missingGit = async () => { throw new Error('Git is unavailable'); };

test('a local folder with spaces opens when Git cannot start', async () => {
  const folder = 'D:/My projects';
  assert.deepEqual(await openProject(folder, [space], [pane], missingGit, command),
    command('space.new', { folder, machine: '' }));
});
test('an existing folder selects its space while tabs are loading', async () => {
  const loading = { id: 'work', folder: 'C:/My projects' };
  assert.deepEqual(await openProject('c:/my projects/', [loading], [], missingGit, command),
    command('space.select', { id: 'work' }));
});
test('an open local pane takes focus without looking up Git', async () => {
  assert.deepEqual(await openProject('C:/work/src', [space], [pane], missingGit, command),
    command('pane.focus', { pane: 'one' }));
});
test('another folder in the same checkout reuses its pane', async () => {
  const git = async () => ({ code: 0, stdout: 'C:/work\n' });
  assert.deepEqual(await openProject('C:/work/docs', [space], [pane], git, command),
    command('pane.focus', { pane: 'one' }));
});
test('a remote folder with the same path cannot capture a local request', async () => {
  const remote = { ...space, machine: 'server' };
  assert.deepEqual(await openProject(space.folder, [remote], [pane], missingGit, command),
    command('space.new', { folder: space.folder, machine: '' }));
});
