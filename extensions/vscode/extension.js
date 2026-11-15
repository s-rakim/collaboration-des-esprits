/**
 * The room, from inside the editor.
 *
 * The room is a web page and a server on your own machine; this is the part
 * of it that lives where the code is. It does five things and none of them is
 * a second copy of the room:
 *
 *  - links the folder you have open, so the agents work in it and what they
 *    write appears in the editor as they write it;
 *  - sends a selection to the room, with where it came from, so "what is
 *    wrong with this?" does not start with copying and pasting;
 *  - runs a command in the room's shared terminal, on the record;
 *  - shows what the agents are saying and running, in an output panel;
 *  - opens the room itself in a tab.
 *
 * It works in any editor that runs VS Code extensions — VS Code, Cursor,
 * Windsurf, VSCodium. For other editors the room's own "Open in editor" and
 * its link command do the same job from the other side.
 */

const vscode = require('vscode');
const { createRoom, quote } = require('./room.js');

let follower = null;
let channel = null;
let status = null;

function activate(context) {
  const settings = () => vscode.workspace.getConfiguration('esprits');
  const room = () => createRoom({ url: settings().get('url', 'http://127.0.0.1:4300'), token: settings().get('token', '') });

  channel = vscode.window.createOutputChannel('Esprits room');
  status = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  status.command = 'esprits.menu';
  status.text = '$(comment-discussion) Room';
  status.tooltip = 'Collaboration des Esprits';
  status.show();
  context.subscriptions.push(channel, status);

  const folder = () => vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? null;

  /** Problems are shown where the person is looking, in the room's own words. */
  const guard = (fn) => async (...args) => {
    try { return await fn(...args); }
    catch (err) {
      const choice = err.offline ? await vscode.window.showErrorMessage(err.message, 'Open settings') : await vscode.window.showErrorMessage(`Room: ${err.message}`);
      if (choice === 'Open settings') vscode.commands.executeCommand('workbench.action.openSettings', 'esprits');
      return undefined;
    }
  };

  /**
   * Who you are in the room. Asked once and kept, and joined each time it is
   * used: joining again under a name is the same person arriving, and it is
   * what makes a name the room has never seen one it will accept.
   */
  async function me() {
    let name = settings().get('name', '') || context.globalState.get('esprits.name', '');
    if (!name) {
      name = await vscode.window.showInputBox({
        title: 'Your name in the room',
        prompt: 'One word — it is how the agents address you.',
        validateInput: (v) => (/^[A-Za-z0-9][\w.-]*$/.test(String(v).trim()) ? null : 'Letters, numbers, dots, dashes and underscores; no spaces.'),
      });
      if (!name) return null;
      name = name.trim();
      await context.globalState.update('esprits.name', name);
    }
    const joined = await room().join(name);
    return joined.agent?.name ?? name;
  }

  // ------------------------------------------------------------- the commands

  const linkFolder = guard(async () => {
    const path = folder();
    if (!path) { vscode.window.showWarningMessage('Open a folder first — that is what gets linked.'); return undefined; }
    const as = await me();
    if (!as) return undefined;
    const linked = await room().link(path, as);
    refresh();
    vscode.window.showInformationMessage(linked.isolated
      ? `The room now works in ${linked.hostDir}, inside its sandbox — this folder is all the agents can see.`
      : `The room now works in ${linked.hostDir}. Commands run directly on this computer in this folder (no sandbox engine is running).`);
    return linked;
  });

  const openRoom = guard(async () => {
    const url = room().base;
    await room().health();
    // The editor's own browser tab, so the room sits beside the code. If this
    // editor has none, the system's browser is the same room.
    try { await vscode.commands.executeCommand('simpleBrowser.show', url); }
    catch { await vscode.env.openExternal(vscode.Uri.parse(url)); }
  });

  const askRoom = guard(async () => {
    const as = await me();
    if (!as) return undefined;
    const editor = vscode.window.activeTextEditor;
    const picked = editor && !editor.selection.isEmpty ? editor.document.getText(editor.selection) : '';

    const who = await room().rounds();
    const everyone = { label: 'Everyone', description: who.speaking.length ? `${who.speaking.join(', ')} — in turn` : 'nobody can answer yet', name: '' };
    const to = await vscode.window.showQuickPick(
      [everyone, ...who.speaking.map((name) => ({ label: `@${name}`, description: 'only this agent answers', name }))],
      { title: 'Ask the room', placeHolder: 'Who should answer?' },
    );
    if (!to) return undefined;

    const question = await vscode.window.showInputBox({
      title: picked ? 'Ask about the selection' : 'Ask the room',
      prompt: picked ? 'The selected code is sent with your question.' : 'What do you want to ask?',
      placeHolder: picked ? 'What is wrong with this?' : '',
    });
    if (!question) return undefined;

    const body = [
      to.name ? `@${to.name} ${question}` : question,
      ...(picked ? ['', quote({
        file: vscode.workspace.asRelativePath(editor.document.uri),
        from: editor.selection.start.line + 1,
        to: editor.selection.end.line + 1,
        language: editor.document.languageId,
        text: picked,
      })] : []),
    ].join('\n');
    const sent = await room().say({ body, as });
    if (settings().get('follow', true)) channel.show(true);
    vscode.window.setStatusBarMessage(`Asked ${to.name ? `@${to.name}` : 'the room'} — the answer appears in the "Esprits room" panel`, 6000);
    return sent;
  });

  const runCommand = guard(async () => {
    const as = await me();
    if (!as) return undefined;
    const where = await room().status();
    const command = await vscode.window.showInputBox({
      title: 'Run in the room\'s terminal',
      prompt: where.isolated ? `Runs in the sandbox, in ${where.dir}.`
        : where.ready ? `Runs on this computer, in ${where.dir}.`
        : `Nothing can run yet: ${where.why}. Link this folder first.`,
      placeHolder: 'npm test',
    });
    if (!command) return undefined;
    channel.show(true);
    channel.appendLine(`\n$ ${command}   (${as}, in ${where.dir})`);
    const run = await room().run(command, as);
    seen.command = Math.max(seen.command, run.id);
    if (run.output) channel.appendLine(run.output.replace(/\s+$/, ''));
    channel.appendLine(`exit ${run.exitCode}${run.timedOut ? ' — stopped, it ran too long' : ''}`);
    return run;
  });

  const dropIdea = guard(async () => {
    const as = await me();
    if (!as) return undefined;
    const title = await vscode.window.showInputBox({ title: 'Drop an idea', prompt: 'A line is enough; the room shapes it.' });
    if (!title) return undefined;
    const idea = await room().dropIdea({ title, as });
    vscode.window.showInformationMessage(`"${idea.title}" is in the room — the agents are answering it in turn.`);
    return idea;
  });

  const showActivity = () => channel.show(true);

  const menu = async () => {
    const pick = await vscode.window.showQuickPick([
      { label: '$(link) Link this folder to the room', run: 'esprits.linkFolder' },
      { label: '$(comment) Ask the room', run: 'esprits.askRoom' },
      { label: '$(terminal) Run in the room\'s terminal', run: 'esprits.runCommand' },
      { label: '$(lightbulb) Drop an idea', run: 'esprits.dropIdea' },
      { label: '$(output) Show what the room is doing', run: 'esprits.showActivity' },
      { label: '$(browser) Open the room', run: 'esprits.openRoom' },
    ], { title: 'Collaboration des Esprits' });
    if (pick) await vscode.commands.executeCommand(pick.run);
  };

  for (const [id, fn] of Object.entries({
    'esprits.linkFolder': linkFolder, 'esprits.openRoom': openRoom, 'esprits.askRoom': askRoom,
    'esprits.runCommand': runCommand, 'esprits.dropIdea': dropIdea, 'esprits.showActivity': showActivity, 'esprits.menu': menu,
  })) context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  // ------------------------------------------------- following what happens

  /** The newest command and message already shown, so each is written once. */
  const seen = { command: 0, message: 0, primed: false };
  let looking = null;

  /**
   * Look at the room again: is it there, is this folder the one it is working
   * in, and what has been said and run since last time.
   */
  function refresh() {
    // One look at a time; whoever asks while one is under way waits for that one.
    looking ??= look().finally(() => { looking = null; });
    return looking;
  }

  async function look() {
    try {
      const r = room();
      const [where, who] = await Promise.all([r.status(), r.rounds()]);
      const here = folder();
      // The same folder, however each side happens to have spelled it.
      const plain = (x) => String(x ?? '').replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
      const linked = Boolean(here) && plain(where.hostDir) === plain(here);
      status.text = `$(comment-discussion) Room: ${who.speaking.length} agent${who.speaking.length === 1 ? '' : 's'}${linked ? ' · linked' : ''}`;
      status.tooltip = linked
        ? `The room is working in this folder${where.isolated ? ', inside its sandbox' : ', directly on this computer'}.`
        : `The room is working in ${where.dir}. Click to link this folder instead.`;

      const [commands, said] = await Promise.all([r.commandsSince(seen.command), r.saidSince(seen.message)]);
      // The first look only finds out where things stand: a panel that opens
      // by replaying everything ever said is not showing what is happening.
      if (seen.primed && settings().get('follow', true)) {
        for (const m of said.messages) {
          if (m.authorKind === 'system' || m.kind === 'system') continue;
          channel.appendLine(`\n${m.author}${m.idea ? ` (${m.idea})` : ''}:\n${m.body}`);
        }
        for (const c of commands.runs) {
          if (c.running) continue;
          channel.appendLine(`\n$ ${c.command}   (${c.by}${c.thread ? `, thread ${c.thread}` : ''}, in ${c.cwd})`);
          if (c.output) channel.appendLine(c.output.replace(/\s+$/, ''));
          channel.appendLine(`exit ${c.exitCode}${c.timedOut ? ' — stopped, it ran too long' : ''}`);
        }
      }
      for (const m of said.messages) seen.message = Math.max(seen.message, m.id);
      // A command still running is looked at again next time, when it has an ending to show.
      for (const c of commands.runs) if (!c.running) seen.command = Math.max(seen.command, c.id);
      seen.primed = true;
    } catch (err) {
      status.text = '$(comment-discussion) Room: not running';
      status.tooltip = err.message;
    }
  }

  refresh();
  follower = setInterval(refresh, 3000);
  context.subscriptions.push({ dispose: () => clearInterval(follower) });
  context.subscriptions.push(vscode.workspace.onDidChangeConfiguration((e) => { if (e.affectsConfiguration('esprits')) refresh(); }));

  // For whoever drives this from outside the editor: a test, or another extension.
  return { refresh, seen };
}

function deactivate() {
  clearInterval(follower);
}

module.exports = { activate, deactivate };
