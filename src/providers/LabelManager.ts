import * as vscode from 'vscode';
import * as path from 'path';
import * as PathUtils from 'utils/PathUtils';
import * as StringUtils from 'utils/StringUtils';
import * as WorkspaceUtils from 'utils/WorkspaceUtils';
import * as DocumentUtils from 'utils/DocumentUtils';
import { Uri, Range, WorkspaceEdit, TextDocument, Position, FileSystemWatcher, CancellationToken, CompletionItem, QuickPickItem, EventEmitter } from 'vscode';
import { CacheManager } from 'CacheManager';
import { FileMoveEvent, MoveFileWatcher } from 'MoveFileWatcher';
import { logInfo, logWarning, logError, throwError, assert, context } from 'utils/CommonUtils';
import { promises as fs } from 'fs';
import { UnderlyingSinkWriteCallback } from 'stream/web';

export class Label {
    private _name: string = '';
    public readonly parent?: Label;
    public readonly childs: Label[] = [];

    public get isRoot() { return this.name === ''; }
    public get name() { return this._name; }
    public validStart(labelTree: LabelTree) { return labelTree.checkStart(this.name); }
    public get fullPath(): string {
        const names: string[] = [];
        let label: Label | undefined = this;
        while (label !== undefined && !label.isRoot) {
            names.unshift(label.name);
            label = label.parent;
        }
        return names.join('.');
    }
    public bestPath(labelTree: LabelTree): string { /* 最短路径 */
        const names: string[] = [this.name];
        let label: Label = this;
        while (!label.validStart(labelTree) && label.parent !== undefined && !label.parent.isRoot) {
            names.unshift(label.parent.name);
            label = label.parent;
        }
        return names.join('.');
    }

    public constructor(name: string, parent?: Label) {
        if (name === '') {
            assert(parent === undefined, `only root label can has empty name: ${name}`);
        } else {
            assert(parent !== undefined, `child must has parent: ${name}`);
        }
        this._name = name;
        this.parent = parent;
    }
    public _rename(newName: string) {
        this._name = newName;
    }

    public getChild(name: string) {
        for (const child of this.childs) {
            if (child.name === name) { return child; }
        }
        return undefined;
    }
    public isDescendantOf(label: Label, includeSelf = true): boolean {
        if (this === label) { return includeSelf; }
        if (this.parent === undefined) { return false; }
        if (this.parent === label) { return true; }
        return this.parent.isDescendantOf(label);
    }
    public isAncestorOf(label: Label, includeSelf = true): boolean {
        if (this === label) { return includeSelf; }
        if (label.parent === undefined) { return false; }
        if (label.parent === this) { return true; }
        return this.isAncestorOf(label.parent);
    }

    public toString(level: number = 0): string {
        const indent = '  '.repeat(level);
        if (this.childs.length === 0) {
            return `${indent}- ${this.name}`;
        } else {
            const lines = [];
            for (const child of this.childs) { lines.push(child.toString(level + 1)); }
            return this.isRoot ? `${lines.join('\n')}` : `${indent}- ${this.name}\n${lines.join('\n')}`;
        }
    }
}

export class LabelTree {
    public readonly names = new Set<string>();
    private readonly _uniquelabels = new Map<string, Label>();
    public readonly root = new Label('');

    public get empty() { return this.root.childs.length === 0; }

    public checkStart(name: string): Label | undefined {
        for (const [uniqueName, label] of this._uniquelabels) {
            if (uniqueName === name) { return label; }
        }
        for (const child of this.root.childs) {
            if (child.name === name) { return child; }
        }
        return undefined;
    }
    public checkIntermediateStart(name: string): Label | undefined { /* 中间起点（非根节点的子节点） */
        let temp: Label | undefined;
        for (const [uniqueName, label] of this._uniquelabels) {
            if (uniqueName === name) {
                temp = label;
                break;
            }
        }
        if (temp === undefined) { return temp; }
        for (const child of this.root.childs) {
            if (child.name === name) { return undefined; }
        }
        return temp;
    }
    public *startLabels(): Generator<Label> {
        for (const label of this._uniquelabels.values()) {
            yield label;
        }
        for (const child of this.root.childs) {
            if (!this._uniquelabels.has(child.name)) { yield child; }
        }
    }

    public getLabel(namepath: string | string[]): Label | undefined {
        const names = namepath instanceof Array ? namepath : namepath.split('.');
        let label = this.checkStart(names[0]);
        if (label === undefined || names.length <= 0) { return; }
        for (let i = 1; i < names.length; i++) {
            const name = names[i];
            const child: Label | undefined = label!.getChild(name);
            if (child === undefined) { return; }
            label = child;
        }
        return label;
    }
    public renameLabel(namepath: string | string[], newName: string) {
        const label = this.getLabel(namepath);
        if (label === undefined) {
            throwError(`renameLabel: can't find namepath: ${namepath}`);
        }
        if (this._uniquelabels.has(label.name)) {
            this.names.delete(label.name);
            this._uniquelabels.delete(label.name);
        }
        if (this._uniquelabels.has(newName)) {
            this._uniquelabels.delete(newName);
        } else {
            this._uniquelabels.set(newName, label);
        }
        this.names.add(newName);
        label._rename(newName);
    }

    public async parseLabelsConfig(config: string) {
        const lines = config.split(/\r?\n/);

        let indentToken: string | undefined;
        const stack: Label[] = [this.root];

        this.clear();
        for (let i = 0; i < lines.length; i++) {
            const raw = lines[i];
            if (raw.trim() === '') { continue; }

            /* 求当前缩进 */
            const firstNonSpace = raw.search(/[^ \t]/);
            const indent = firstNonSpace > 0 ? raw.slice(0, firstNonSpace) : '';
            const rest = raw.slice(firstNonSpace);

            /* 获取 label name 并做部分检测 */
            assert(rest.startsWith('- '), `Tree parse error at line ${i + 1}: missing "- "`); /* 必须以 "- " 开头 */
            const name = rest.slice(2).split(';')[0].trimEnd(); /* 支持注释 */
            assert(!/[\.&"'<>]/.test(name), `Invalid character in label "${name}" at line ${i + 1}`); /* 检查非法字符 */

            /* 获取层级 */
            let level: number;
            if (indent === '') {
                level = 0;
            } else if (!indentToken) {
                indentToken = indent;
                level = 1;
            } else {
                const unitLen = indentToken.length;
                if (indent.length % unitLen !== 0 || indent !== indentToken.repeat(indent.length / unitLen)) {
                    throwError(`Inconsistent indent at line ${i + 1}`);
                }
                level = indent.length / unitLen;
            }

            let parent = stack[stack.length - 1];

            /* 层级校验，并设置正确的 parent */
            if (stack.length === level + 1) { /* 继续插入节点 */
                ; /* nothing to do */
            } else if (stack.length === level) { /* 插入子节点 */
                assert(parent.childs.length > 0, `Could not indent at the beginning. line: ${i + 1}`);
                parent = parent.childs[parent.childs.length - 1];
                stack.push(parent);
            } else if (stack.length > level + 1) { /* 回到上层 */
                stack.length = level + 1;
                parent = stack[stack.length - 1];
            } else {
                throwError(`Unexpected indent increase at line ${i + 1}`);
            }

            /* 执行插入节点操作，并做必要检查 */
            const newlabel = new Label(name, parent);
            assert(!parent.childs.some(c => c.name === name), `Duplicate label "${name}" at line ${i + 1}`); /* 同层不允许重名 */
            parent.childs.push(newlabel);

            /* 维护 uniquelabels */
            if (this.names.has(name)) {
                this._uniquelabels.delete(name);
            } else {
                this._uniquelabels.set(name, newlabel);
            }
            this.names.add(name);
        }
    }

    public clear() {
        this.names.clear();
        this._uniquelabels.clear();
        this.root.childs.length = 0;
    }
    public clone(): LabelTree {
        const newTree = new LabelTree();
        const stack = [this.root];
        const newTreeStack = [newTree.root];
        while (stack.length > 0) { /* 层序遍历 */
            const label = stack.pop()!;
            const parent = newTreeStack.pop()!;
            for (const child of label.childs) {
                stack.push(child);
                const newChild = new Label(child.name, parent);
                parent.childs.push(newChild);
                newTreeStack.push(newChild);
                newTree.names.add(child.name);
                if (this._uniquelabels.has(child.name)) {
                    newTree._uniquelabels.set(child.name, newChild);
                }
            }
        }
        return newTree;
    }
}

export class LabelManager {
    private static _instance: LabelManager | null = null;
    public static getInstance(): LabelManager {
        if (!this._instance) {
            this._instance = new LabelManager();
        }
        return this._instance;
    }
    public static readonly defaultPath = 'labels.tree';

    /* 用户标注 label 时，必须以 uniqueLabel 为起点 */
    private _labelTree: LabelTree = new LabelTree();
    private _labelTreePath: Uri | undefined;

    private _watcher?: FileSystemWatcher;
    private _listeningUri?: Uri;

    private _completionCache?: CompletionItem[];

    private _afterConfigUpdate = new EventEmitter<void>();
    public readonly afterConfigUpdate = this._afterConfigUpdate.event;

    private constructor() {
        /* 监听配置变化 */
        vscode.workspace.onDidChangeConfiguration(event => {
            if (event.affectsConfiguration('markdown-note-supports.labelTreePath')) {
                this.updateConfig();
            }
        });

        /* 释放监听器 */
        context!.subscriptions.push(this);

        /* 注册功能 */
        this.registerCompletion();
        this.registerCommand();
        vscode.languages.registerRenameProvider({ scheme: 'file' }, new LabelTreeRenameProvider);
    }

    public get labelTree() { return this._labelTree; }
    public get labelTreePath() { return this._labelTreePath; }

    public async updateConfig() {
        const cacheManager = CacheManager.getInstance();

        /* 读取配置 */
        const labelTreePath = this.getLabelTreePath();
        if (labelTreePath === undefined) { /* 读取配置失败，清除数据 */
            this.clearCache();
            this.clearWatcher();
            return;
        }

        /* 获得新配置前 */
        const newLabelTree = new LabelTree();
        await this.loadLabelsConfig(labelTreePath, newLabelTree);

        /* 处理重命名的路径重构 */
        let edit = new vscode.WorkspaceEdit();
        if (!newLabelTree.empty && !this._labelTree.empty) {
            await CacheManager.getInstance().saveAndCacheAllDirty();

            /* 尝试修复因修改 label tree 导致的的非法 label path */
            edit = new vscode.WorkspaceEdit();
            await this.fixInvalidOldPath(edit, newLabelTree);
        }

        /* 更新 label tree 和监听器，并加载配置 */
        this._completionCache = undefined; /* 更新配置后移除缓存 */
        this._labelTree = newLabelTree;
        this._labelTreePath = labelTreePath;
        this.updateWatcher(labelTreePath);
        // logInfo(`update label config success!\n${this._labelTree.root.toString()}`);
        logInfo(`update label config success!`);

        /* 执行对现有路径的安全性重构 */
        await vscode.workspace.applyEdit(edit);
        // await WorkspaceUtils.saveEdit(edit); /* 没必要替用户保存 */

        this._afterConfigUpdate.fire();
    }
    private getLabelTreePath() {
        const configPath: string = vscode.workspace.getConfiguration('markdown-note-supports').get('labelTreePath', '');
        let labelTreePath: Uri | undefined;
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (configPath === '' || !path.isAbsolute(configPath)) {
            const relpath = configPath === '' ? LabelManager.defaultPath : configPath;
            labelTreePath = workspaceFolder
                ? Uri.file(path.join(workspaceFolder.uri.fsPath, relpath))
                : undefined;
        } else {
            labelTreePath = Uri.file(configPath);
        }
        return labelTreePath;
    }
    private async loadLabelsConfig(uri: Uri, labelTree: LabelTree) {
        const text = await fs.readFile(uri.fsPath, 'utf-8');
        await labelTree.parseLabelsConfig(text).catch(error => {
            labelTree.clear();
            throw error;
        });
    }
    private async fixInvalidOldPath(edit: WorkspaceEdit, newLabelTree: LabelTree) {
        if (!newLabelTree.empty && !this._labelTree.empty) {
            const invalidUniqueLabels = new Map<string, Label>(); /* 在文件更新后会变为非法路径的 label 开头 */
            for (const label of this._labelTree.startLabels()) {
                const name = label.name;
                if (newLabelTree.checkStart(name)) { continue; }
                invalidUniqueLabels.set(name, label);
            }
            const fixlabel: string[] = [];
            for (const [name, label] of invalidUniqueLabels) {
                const newLabel = newLabelTree.getLabel(label.fullPath);
                if (newLabel === undefined) { continue; } /* 如果用户自己删除了已有标签，那怎么也救不了了 */
                await CacheManager.getInstance().editLabel(edit, label, (label) => label.bestPath(newLabelTree));
                fixlabel.push(label.name);
            }
            if (fixlabel.length > 0) {
                logInfo(`fix invalid path for: ${fixlabel.join(', ')}`);
            }
        }
    }

    private updateWatcher(uri: Uri) {
        if (!PathUtils.inWorkspace(uri)) {
            this.clearWatcher();
            return;
        }
        // const relpath = vscode.workspace.asRelativePath(uri);
        if (this._watcher === undefined || this._listeningUri?.fsPath !== uri.fsPath) {
            this.clearWatcher();
            this._watcher = vscode.workspace.createFileSystemWatcher(uri.fsPath);
            this._listeningUri = uri;
            this._watcher.onDidCreate(() => {
                logInfo(`label config created: ${uri}`);
                this.updateConfig();
            });
            this._watcher.onDidChange(() => {
                logInfo(`label config changed: ${uri}`);
                this.updateConfig();
            });
            this._watcher.onDidDelete(() => {
                logInfo(`label config deleted: ${uri}`);
                this.clearCache();
            });
        }
    }

    private clearCache() {
        this._labelTree.clear();
        this._labelTreePath = undefined;
    }
    private clearWatcher() {
        this._watcher?.dispose();
        this._watcher = undefined;
        this._listeningUri = undefined;
    }
    public dispose() {
        this.clearCache();
        this.clearWatcher();
    }

    /* ---------------- completion ---------------- */

    private registerCompletion() { /* 提供补全功能 */
        const self = this;
        const func = {
            provideCompletionItems(document: vscode.TextDocument, position: vscode.Position, token: vscode.CancellationToken, context: vscode.CompletionContext) {
                return self.completeLabel(document, position, context);
            }
        };
        const provider = vscode.languages.registerCompletionItemProvider('markdown', func, '"', ';', '.');
        context!.subscriptions.push(provider);
    }
    private completeLabel(document: vscode.TextDocument, position: vscode.Position, context: vscode.CompletionContext) {
        try {
            const line = document.lineAt(position.line);
            if (!line.text.startsWith('<attr ')) { return []; }
            const match = line.text.match(/labels="([^"]*)[ ">]/);
            if (!match || match.index === undefined) { return []; }
            const start = match.index + 8;
            const end = start + match[1].length;
            if (!(start <= position.character && position.character <= end)) { return []; }

            let completions: CompletionItem[] = [];
            if (context.triggerCharacter === '.') {
                /* 查找路径当前 */
                let namePath = '';
                for (let i = position.character; i >= start; i--) {
                    if (line.text[i] !== '.') { continue; }
                    const last = i--;
                    while (i >= start && line.text[i] !== ';') { i--; }
                    if (last - i <= 1) { return []; } /* 相邻的分隔符，是非法的 */
                    namePath = line.text.substring(i + 1, last);
                    break;
                }
                /* 检查是否为合法路径，并找到最后一个 name 所指的 label */
                const label = this._labelTree.getLabel(namePath);
                if (label === undefined) { return []; }
                /* 提供当前路径允许的 name */
                for (const child of label.childs) {
                    const item = new vscode.CompletionItem(child.name, vscode.CompletionItemKind.Value);
                    item.sortText = '0' + child.name;
                    completions.push(item);
                }
            } else if (this._completionCache !== undefined) {
                completions = this._completionCache; /* 可以直接用缓存 */
            } else {
                const stack = [this._labelTree.root];
                while (stack.length > 0) {
                    const label = stack.pop()!;
                    const itemName = label.bestPath(this._labelTree);
                    const item = new vscode.CompletionItem(itemName, vscode.CompletionItemKind.Constant);
                    item.sortText = '0' + itemName;
                    completions.push(item);
                    for (const child of label.childs) {
                        stack.push(child);
                    }
                }
                this._completionCache = completions;
            }
            logInfo(`provide complete, count: ${completions.length}, pos: ${position.line + 1},${position.character + 1} in (${start + 1},${end + 1}), trigger: ${context.triggerCharacter}`);
            return completions;
        } catch (error) {
            logError(`completion error: ${error}`);
            return [];
        }
    }

    /* ---------------- commands ---------------- */

    private registerCommand() { /* 提供根据标签生成报告 */
        context!.subscriptions.push(vscode.commands.registerCommand('markdown-note-supports.SelectByLabelsUnion', async () => {
            await this.summaryLabel(false).catch(error => {
                logError(`summary failed. msg: ${error}`);
            });
        }));
        context!.subscriptions.push(vscode.commands.registerCommand('markdown-note-supports.SelectByLabelsIntersection', async () => {
            await this.summaryLabel(true).catch(error => {
                logError(`summary failed. msg: ${error}`);
            });
        }));
        context!.subscriptions.push(vscode.commands.registerCommand('markdown-note-supports.MinimizeLabelPathInFile', async () => {
            await this.minimizeLabelPathInFile().catch(error => {
                logError(`minimizeLabelPathInFile failed. msg: ${error}`);
            });
        }));
    }

    private async summaryLabel(isIntersection: boolean) {
        type LabelItem = QuickPickItem & { labelObj: Label };
        const indent = '    ';
        const items: LabelItem[] = [];
        /* 先生成一个可多选的分组结构，让用户选择 */
        const stack = [{ mylabel: this._labelTree.root, level: -1, last: true }];
        while (stack.length > 0) { /* 通过循环实现前序遍历 */
            const { mylabel, level, last } = stack.pop()!;
            if (level >= 0) { /* 跳过根节点 */
                items.push({ label: `${indent.repeat(level)}${last ? '└─' : '├─'} ${mylabel.name}`, labelObj: mylabel });
            }
            for (let i = mylabel.childs.length - 1; i >= 0; i--) {
                stack.push({ mylabel: mylabel.childs[i], level: level + 1, last: i === mylabel.childs.length - 1 });
            }
        }

        /* 生成标签路径枚举 */
        const picked = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select Labels',
            canPickMany: true
        });

        /* 从缓存中读取对应的标签，并生成报告 */
        if (!picked) { return; }
        if (picked.length === 0) {
            vscode.window.showInformationMessage('At least select one label.');
            return;
        }

        /* 生成目标 label 集合，剔除掉无用的 label */
        const targetLabels = new Set<Label>();
        for (const item of picked) {
            const labelItem = item as LabelItem;
            const removeList: Label[] = [];
            let add = true;
            for (const target of targetLabels) { /* 判断是否需要添加，以及移除无效的节点 */
                if ((isIntersection && labelItem.labelObj.isAncestorOf(target)) || /* 如果是交集，则剔除先祖节点 */
                    (!isIntersection && labelItem.labelObj.isDescendantOf(target))) { /* 如果是并集，则剔除后代节点 */
                    add = false;
                    break;
                } else if ((isIntersection && target.isAncestorOf(labelItem.labelObj)) || /* 剔除先祖 */
                    (!isIntersection && target.isDescendantOf(labelItem.labelObj))) { /* 剔除后代 */
                    removeList.push(target);
                }
            }
            for (const target of removeList) {
                targetLabels.delete(target);
            }
            if (add) {
                targetLabels.add(labelItem.labelObj);
            }
        }

        /* 从 cache 中获取相关的引用 */
        const attrs = CacheManager.getInstance().findLabels(isIntersection, ...targetLabels);
        if (attrs.length === 0) {
            vscode.window.showInformationMessage('No labels found.');
            return;
        }

        /* 尝试创建输出目录 */
        const reportDir = PathUtils.getAbsPath('.report');
        if (reportDir === undefined) {
            vscode.window.showErrorMessage('Failed to get report directory.');
            return;
        }
        await fs.mkdir(reportDir.fsPath, { recursive: true }).catch(error => {
            vscode.window.showErrorMessage('Failed to create output directory \'.report\'');
            return;
        });

        /* 生成报告内容 */
        const contentList: string[] = [`# Select By Labels (${isIntersection ? 'Intersection' : 'Union'})\n\n`];

        contentList.push(`Labels:\n`); /* 生成标签列表 */
        for (const label of targetLabels) {
            contentList.push(`- ${label.fullPath}\n`);
        }

        contentList.push('\n---\n\nRelated Sections:\n'); /* 生成引用列表 */
        for (const attr of attrs) {
            contentList.push(`- ${attr.generateReport(reportDir)}\n`);
        }
        contentList.push('\n');
        const content = contentList.join('');

        /* 输出报告内容 */
        const reportPath = path.join(reportDir.fsPath, `select_by_labels_results.md`);
        await fs.writeFile(reportPath, content, 'utf-8').catch(error => {
            vscode.window.showErrorMessage(`Failed to create report. msg: ${error}`);
        });

        /* 打开 md 预览 */
        const doc = await vscode.workspace.openTextDocument(reportPath);
        await vscode.window.showTextDocument(doc, { preview: true });
        // await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
        const mpeExt = vscode.extensions.getExtension('shd101wyy.markdown-preview-enhanced');
        if (mpeExt) { /* 用 Markdown Preview Enhanced 插件打开预览 */
            await vscode.commands.executeCommand('markdown-preview-enhanced.openPreview', doc.uri);
        }
    }

    private async minimizeLabelPathInFile() {
        /* 遍历该文件 cache 的所有 attr reference，edit 为最短路径 */
        const activeDoc = vscode.window.activeTextEditor?.document;
        if (activeDoc === undefined) {
            vscode.window.showErrorMessage('No active document.');
            return;
        }
        const cacheManager = CacheManager.getInstance();
        if (activeDoc.isDirty) {
            activeDoc.save();
            await cacheManager.cacheUri(activeDoc.uri);
        }
        const cache = cacheManager.getCacheUnsafe(activeDoc.uri);
        if (cache === undefined) {
            throwError(`cache not found ?! uri: ${activeDoc.uri}`);
        }
        const edit = new WorkspaceEdit();
        const labelManager = LabelManager.getInstance();
        for (const attr of cache.attrReferences) {
            for (const { labelpath, startIndex } of attr.labelpaths) {
                const label = labelManager.labelTree.getLabel(labelpath);
                if (label === undefined) { continue; }
                const bestPath = label.bestPath(labelManager.labelTree);
                if (bestPath === labelpath) { continue; }
                const range = await DocumentUtils.getRange(activeDoc.uri, attr.startIndex+startIndex, labelpath.length);
                edit.replace(activeDoc.uri, range, bestPath);
            }
        }
        await vscode.workspace.applyEdit(edit);
    }
}

export class LabelTreeRenameProvider implements vscode.RenameProvider {
    public async provideRenameEdits(document: TextDocument, position: Position, newName: string, token: CancellationToken): Promise<WorkspaceEdit> {
        const { success, start, end, range } = LabelTreeRenameProvider.getLabelRange(document, position);
        if (!success || range === undefined) {
            return Promise.reject();
        }
        await CacheManager.getInstance().saveAndCacheAllDirty();
        const edit = new WorkspaceEdit();

        /* 获得完整路径，并填入 LabelManager */
        const line = document.lineAt(position.line);
        const fullpath: string[] = [line.text.substring(start, end)];
        let indent = start - 2;
        for (let lineIndex = position.line - 1; lineIndex >= 0; lineIndex--) {
            const currLine = document.lineAt(lineIndex).text;
            const currIndent = currLine.indexOf('- ');
            if (currIndent >= indent) { continue; }
            const start = currIndent + 2;
            const end = currLine.split(';')[0].trimEnd().length;
            indent = currIndent;
            fullpath.unshift(currLine.substring(start, end));
        }
        const oldNamepath = fullpath.join('.');
        await this.editRename(edit, oldNamepath, newName);
        logInfo(`oldNamepath: ${oldNamepath}`);

        edit.replace(document.uri, range, newName);
        return edit;
    }

    private async editRename(edit: WorkspaceEdit, oldNamepath: string, newName: string) {
        const oldLabelTree = LabelManager.getInstance().labelTree;
        const newLabelTree = oldLabelTree.clone();
        newLabelTree.renameLabel(oldNamepath, newName);

        /* 检查 newName 是否为老 unique label，若是则替换为 newpath */
        const conflictLabel = oldLabelTree.checkIntermediateStart(newName);
        if (conflictLabel !== undefined) {
            await CacheManager.getInstance().editLabel(edit, conflictLabel, label => label.bestPath(newLabelTree));
        }

        /* 执行 rename */
        const oldLabel = oldLabelTree.getLabel(oldNamepath);
        assert(oldLabel !== undefined, `old label not found: ${oldNamepath}`);

        const paths = oldNamepath.split('.');
        paths.pop();
        paths.push(newName);
        const newLabelPath = paths.join('.');

        function getNewPath(label: Label): string {
            const newpath = label.fullPath.replace(oldNamepath, newLabelPath); /* replace 只替换开头第一个 */
            const newlabel = newLabelTree.getLabel(newpath);
            return newlabel === undefined ? newpath : newlabel.bestPath(newLabelTree);
        }
        await CacheManager.getInstance().editLabel(edit, oldLabel!, getNewPath);
    }

    public async prepareRename(
        document: TextDocument,
        position: Position,
        token: CancellationToken
    ): Promise<Range | { range: Range; placeholder: string }> {
        const manager = LabelManager.getInstance();
        if (manager.labelTree.empty || manager.labelTreePath === undefined) {
            return Promise.reject(new Error('no valid label tree'));
        }
        if (document.uri.fsPath !== manager.labelTreePath.fsPath) {
            return Promise.reject(new Error('not label tree config'));
        }
        const line = document.lineAt(position.line);
        const { success, start, end, range } = LabelTreeRenameProvider.getLabelRange(document, position);
        if (!success || range === undefined) {
            return Promise.reject();
        }
        return { range, placeholder: line.text.substring(start, end) };
    }

    private static getLabelRange(document: TextDocument, position: Position)
        : { success: boolean, start: number, end: number, range: Range | undefined } {
        const line = document.lineAt(position.line);
        const start = line.text.indexOf('- ') + 2;
        const end = line.text.split(';')[0].trimEnd().length;
        if (position.character < start || position.character >= end) {
            return { success: false, start, end, range: undefined };
        }
        const range = new Range(line.range.start.translate(0, start), line.range.start.translate(0, end));
        return { success: true, start, end, range };
    }
}

