import * as vscode from 'vscode';
import * as path from 'path';
import * as PathUtils from 'utils/PathUtils';
import * as StringUtils from 'utils/StringUtils';
import { Uri, FileSystemWatcher, CompletionItem, QuickPickItem } from 'vscode';
import { CacheManager } from 'CacheManager';
import { FileMoveEvent, MoveFileWatcher } from 'MoveFileWatcher';
import { logInfo, logWarning, logError, throwError, assert, context } from 'utils/CommonUtils';
import { promises as fs } from 'fs';

export class Label {
    public readonly namepath: string;
    public readonly parent?: Label;
    public readonly childs: Label[] = [];

    public get isRoot() { return this.namepath === ''; }

    public constructor(name: string, parent?: Label) {
        if (name === '') {
            assert(parent === undefined, `only root label can has empty name: ${name}`);
        } else {
            assert(parent !== undefined, `child must has parent: ${name}`);
        }
        this.namepath = name;
        this.parent = parent;
    }

    public getChild(name: string) {
        for (const child of this.childs) {
            if (child.namepath === name) { return child; }
        }
        return undefined;
    }
    public isDescendantOf(label: Label, includeSelf = true): boolean {
        if (this === label) { return includeSelf; }
        if (this.parent === undefined) { return false; }
        if (this.parent === label) { return true; }
        return this.parent.isDescendantOf(label);
    }

    public toString(level: number = 0): string {
        const indent = '  '.repeat(level);
        if (this.childs.length === 0) {
            return `${indent}- ${this.namepath}`;
        } else {
            const lines = [];
            for (const child of this.childs) { lines.push(child.toString(level + 1)); }
            return this.isRoot ? `${lines.join('\n')}` : `${indent}- ${this.namepath}\n${lines.join('\n')}`;
        }
    }
}

export class LabelsManager {
    public static readonly defaultPath = 'labels.tree';
    private static _instance: LabelsManager | null = null;

    /* 用户标注 label 时，必须以 uniqueLabel 为起点 */
    private _names = new Set<string>();
    private _uniquelabels = new Map<string, Label>();
    private _root = new Label('');

    private _watcher?: FileSystemWatcher;
    private _listeningUri?: Uri;

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
        this.registerSummaryCommand();
    }

    public get root() { return this._root; }

    public static getInstance(): LabelsManager {
        if (!this._instance) {
            this._instance = new LabelsManager();
        }
        return this._instance;
    }

    public async updateConfig() {
        /* 读取配置 */
        const configPath: string = vscode.workspace.getConfiguration('markdown-note-supports').get('labelTreePath', '');
        let labelTreePath: Uri | undefined;
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (configPath === '' || !path.isAbsolute(configPath)) {
            const relpath = configPath === '' ? LabelsManager.defaultPath : configPath;
            labelTreePath = workspaceFolder
                ? Uri.file(path.join(workspaceFolder.uri.fsPath, relpath))
                : undefined;
        } else {
            labelTreePath = Uri.file(configPath);
        }

        /* 更新监听器，并加载配置 */
        if (labelTreePath === undefined) { /* 读取配置失败，清除数据 */
            this.clearCache();
            this.clearWatcher();
            return;
        } else {
            this.updateWatcher(labelTreePath);
            await this.loadLabelsConfig(labelTreePath);
            logInfo(`update label config success!\n${this._root.toString()}`);
        }
    }
    private async loadLabelsConfig(uri: Uri) {
        const text = await fs.readFile(uri.fsPath, 'utf-8');
        await this.parseLabelsConfig(text).catch(error => {
            this.clearCache();
            throw error;
        });
    }
    private async parseLabelsConfig(config: string) {
        const lines = config.split(/\r?\n/);

        let indentToken: string | undefined;
        const stack: Label[] = [this._root];

        this.clearCache();
        for (let i = 0; i < lines.length; i++) {
            const raw = lines[i];
            if (raw.trim() === '') { continue; }

            /* 求当前缩进 */
            const firstNonSpace = raw.search(/[^ \t]/);
            const indent = firstNonSpace > 0 ? raw.slice(0, firstNonSpace) : '';
            const rest = raw.slice(firstNonSpace);

            /* 获取 label name 并做部分检测 */
            assert(rest.startsWith('- '), `Tree parse error at line ${i + 1}: missing "- "`); /* 必须以 "- " 开头 */
            const name = rest.slice(2).trimEnd();
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
            assert(!parent.childs.some(c => c.namepath === name), `Duplicate label "${name}" at line ${i + 1}`); /* 同层不允许重名 */
            parent.childs.push(newlabel);

            /* 维护 uniquelabels */
            if (this._names.has(name)) {
                this._uniquelabels.delete(name);
            } else {
                this._uniquelabels.set(name, newlabel);
            }
            this._names.add(name);
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
        this._names.clear();
        this._uniquelabels.clear();
        this._root.childs.length = 0;
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

    /* ---------------- label data ---------------- */

    public getLabel(namepath: string | string[]): Label | undefined {
        const names = namepath instanceof Array ? namepath : namepath.split('.');
        if (names.length <= 0 || !this._uniquelabels.has(names[0])) { return; }
        let label = this._uniquelabels.get(names[0]);
        for (let i = 1; i < names.length; i++) {
            const name = names[i];
            const child = label!.getChild(name);
            if (child === undefined) { return; }
            label = child;
        }
        return label;
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

            const completions: CompletionItem[] = [];
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
                const label = this.getLabel(namePath);
                if (label === undefined) { return []; }
                /* 提供当前路径允许的 name */
                for (const child of label.childs) {
                    const item = new vscode.CompletionItem(child.namepath, vscode.CompletionItemKind.Value);
                    item.sortText = '0' + child.namepath;
                    completions.push(item);
                }
            } else {
                for (const label of this._uniquelabels.values()) {
                    const item = new vscode.CompletionItem(label.namepath, vscode.CompletionItemKind.Constant);
                    item.sortText = '0' + label.namepath;
                    completions.push(item);
                }
            }
            logInfo(`provide complete, count: ${completions.length}, pos: ${position.line + 1},${position.character + 1} in (${start + 1},${end + 1}), trigger: ${context.triggerCharacter}`);
            return completions;
        } catch (error) {
            logError(`completion error: ${error}`);
            return [];
        }
    }

    /* ---------------- commands ---------------- */

    private registerSummaryCommand() { /* 提供根据标签生成报告 */
        context!.subscriptions.push(vscode.commands.registerCommand('markdown-note-supports.SelectByLabels', async () => {
            await this.summaryCommand().catch(error => {
                logError(`summary failed. msg: ${error}`);
            });
        }));
    }
    private async summaryCommand() {
        type LabelItem = QuickPickItem & { labelObj: Label };
        const indent = '    ';
        const items: LabelItem[] = [];
        /* 先生成一个可多选的分组结构，让用户选择 */
        const stack = [{ mylabel: this._root, level: -1, last: true }];
        while (stack.length > 0) { /* 通过循环实现前序遍历 */
            const { mylabel, level, last } = stack.pop()!;
            if (level >= 0) { /* 跳过根节点 */
                items.push({ label: `${indent.repeat(level)}${last ? '└─' : '├─'} ${mylabel.namepath}`, labelObj: mylabel });
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

        /* 生成目标 label 集合 */
        const targetLabels = new Set<Label>();
        for (const item of picked) {
            const labelItem = item as LabelItem;
            targetLabels.add(labelItem.labelObj);
        }

        /* 从 cache 中获取相关的引用 */
        const attrs = CacheManager.getInstance().findLabels(...targetLabels);
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
        const contentList: string[] = ['# Select by labels results\n\n'];
        for (const attr of attrs) {
            contentList.push(`- ${attr.generateReport(reportDir)}\n`);
        }
        contentList.push('\n');
        const content = contentList.join('');

        /* 输出报告内容 */
        const reportPath = path.join(reportDir.fsPath, `select_label_result.md`);
        await fs.writeFile(reportPath, content, 'utf-8').catch(error => {
            vscode.window.showErrorMessage(`Failed to create report. msg: ${error}`);
        });

        /* 打开 md 预览 */
        const doc = await vscode.workspace.openTextDocument(reportPath);
        await vscode.window.showTextDocument(doc, { preview: false });
        await vscode.commands.executeCommand('markdown.showPreview', doc.uri);
    }
}
