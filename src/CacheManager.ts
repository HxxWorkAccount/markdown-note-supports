import * as vscode from 'vscode';
import * as path from 'path';
import * as CommonUtils from 'utils/CommonUtils';
import * as StringUtils from 'utils/StringUtils';
import * as SearchUtils from 'utils/SearchUtils';
import * as PathUtils from 'utils/PathUtils';
import * as WorkspaceUtils from 'utils/WorkspaceUtils';
import { LabelsManager, Label } from 'providers/LabelsManager';
import { logInfo, logWarning, logError, throwError, assert } from 'utils/CommonUtils';
import { SearchOptions, MatchResult } from 'utils/SearchUtils';
import { Uri, Range, Location, TextDocument, WorkspaceEdit } from 'vscode';
import { promises as fs } from 'fs';

export class LocalReference {
    public readonly uri: Uri; /* 引用的资源位置 */
    public readonly relpath: string;
    public readonly id?: string; /* 如果引用目标是 md 文件，那么可以附加 `#id` 来索引到标题 */

    public readonly source: Uri;
    public readonly startIndex: number;
    public readonly length: number;

    constructor(relpath: string, source: Uri, startIndex: number, length: number, id?: string) {
        this.relpath = decodeURIComponent(relpath);
        this.id = id;
        this.uri = PathUtils.resolveRelpath(path.dirname(source.fsPath), relpath);

        this.source = source;
        this.startIndex = startIndex;
        this.length = length;
    }

    public get isIdReference(): boolean {
        /* 判断 uri 是否指向 .md 文件，且 id 不为空 */
        return this.relpath.endsWith('.md') && this.id !== undefined;
    }

    public getRelpath(from?: Uri, uri?: Uri): string {
        from = from ?? this.source;
        uri = uri ?? this.uri;
        const relpath = PathUtils.getRelpath(from, uri);
        return StringUtils.encodePath(relpath) + (this.id ? ('#' + this.id) : '');
    }
    public getRelpathFromFile(fromFile?: Uri, uri?: Uri): string {
        fromFile = fromFile ?? this.source;
        uri = uri ?? this.uri;
        const relpath = PathUtils.getRelpathFromFile(fromFile, uri);
        return StringUtils.encodePath(relpath) + (this.id ? ('#' + this.id) : '');
    }

    public async getRange(): Promise<Range> {
        const refDoc = await vscode.workspace.openTextDocument(this.source);
        const start = refDoc.positionAt(this.startIndex);
        const end = refDoc.positionAt(this.startIndex + this.length);
        return new Range(start, end);
    }

    public sameTarget(other: LocalReference): boolean {
        /* 判断 uri 和 id 是否都相同 */
        return this.uri.toString() === other.uri.toString() && this.id === other.id;
    }
}

export class AttrReference {
    public readonly source: Uri;
    public readonly startIndex: number;
    public readonly header: string; /* 目前只支持 attr 用于 header */
    public readonly raw: string;

    public readonly labels: string[];

    public constructor(source: Uri, startIndex: number, header: string, raw: string) {
        this.source = source;
        this.startIndex = startIndex;
        this.header = header;
        this.raw = raw;
        this.labels = AttrReference.parseAttrLabels(raw);
        // logInfo(`    recognize labels: ${this.labels}`);
    }

    public get length(): number { return this.raw.length; }

    public generateReport(from: Uri): string {
        const relpath = StringUtils.encodePath(PathUtils.getRelpath(from, this.source));
        const id = StringUtils.slugify(this.header);
        const labels = this.labels.length > 0 ? this.labels.join(', ') : '';
        return `[${path.basename(this.source.fsPath)}#${this.header}](${relpath}#${id}): ${labels}`;
    }

    public static parseAttrLabels(raw: string): string[] {
        const match = raw.match(/labels="([^"]*)"/);
        if (!match) { return []; }
        return match[1]
            .split(';')
            .map(s => s.trim())
            .filter(s => s.length > 0);
    }
}

export class Cache {
    public static readonly sep = String.raw`[\/\\]`;
    public static readonly char = String.raw`\w%\-\u0080-\uFFFF`;
    public static readonly dotchar = String.raw`${Cache.char}\.`;
    public static readonly name = String.raw`(?:[${Cache.dotchar}]*[${Cache.char}]+|\.{1,2})`; /* 支持以纯 '.' 作为名字 */
    public static readonly relpathPattern = String.raw`(?:src=['"]|\[[^\[\]]*\]\()((?:(?:\.{1,2}|${Cache.name})${Cache.sep})*(?:${Cache.name}(?:\.\w+|${Cache.sep})?))(?:#([${Cache.dotchar}]+))?['"\)]`;

    static {
        logInfo(`relpath pattern: ${Cache.relpathPattern}`);
    }

    /* ---------------- Members ---------------- */

    public readonly uri: Uri;
    public readonly localReferences: LocalReference[] = [];
    public readonly attrReferences: AttrReference[] = [];

    constructor(uri: Uri) {
        this.uri = uri;
    }

    /* ---------------- Methods ---------------- */

    public async traverseUri(targetUri: Uri, handler: (ref: LocalReference) => void | Promise<void>) {
        for (const ref of this.localReferences) {
            if (ref.uri.fsPath !== targetUri.fsPath) { continue; }
            try {
                await handler(ref);
            } catch (error) {
                logError(`traverseUri error: ${error}`);
            }
        }
    }
    public async traverseTarget(targetUri: Uri, targetId: string | undefined, handler: (ref: LocalReference) => void | Promise<void>) {
        /* targetId === undefined 时，表示匹配任意 id */
        for (const ref of this.localReferences) {
            const refpath = ref.uri.fsPath;
            const targetPath = targetUri.fsPath;
            if ((refpath !== targetPath && !PathUtils.inDir(refpath, targetPath)) || /* 支持按目录遍历 */
                (targetId !== undefined && ref.id !== targetId)) {
                continue;
            }
            try {
                await handler(ref); /* 这里也可以考虑并发处理，但正常应该也不会有辣么多引用吧 */
            } catch (error) {
                logError(`traverseTarget error: ${error}`);
            }
        }
    }
    public async updateTarget(edit: WorkspaceEdit, oldUri: Uri, oldId: string | undefined, newUri: Uri, newId: string | undefined) {
        await this.traverseTarget(oldUri, oldId, async (ref) => {
            // LogInfo(`update ${oldId}, ref id: ${ref.id}, newId: ${newId}`);
            const refDoc = await vscode.workspace.openTextDocument(ref.source);
            const start = refDoc.positionAt(ref.startIndex);
            const end = refDoc.positionAt(ref.startIndex + ref.length);
            const finalId = newId === undefined ? ref.id : newId;

            /* 计算新相对路径（带新 id） */
            let relPath;
            if (PathUtils.isDirectory(newUri)) {
                const uri = PathUtils.getNewUriAfterDirMove(ref.uri, oldUri.fsPath, newUri.fsPath);
                relPath = PathUtils.getRelpathFromFile(ref.source, uri);
            } else {
                relPath = PathUtils.getRelpathFromFile(ref.source, newUri);
            }
            const newRefText = finalId === undefined ? relPath.replace(/\\/g, '/') : relPath.replace(/\\/g, '/') + '#' + finalId;

            /* 替换整个引用区间 */
            edit.replace(ref.source, new Range(start, end), StringUtils.encodePath(newRefText));
        });
    }

    public static async fromUri(doc: TextDocument | Uri): Promise<Cache> {
        const uri = doc instanceof Uri ? doc : doc.uri;
        const cache = new Cache(uri);
        const text = await fs.readFile(uri.fsPath, 'utf-8');
        cache.cacheLocalReference(text);
        cache.cacheAttrReference(text);
        return cache;
    }
    public async cacheLocalReference(text?: string) {
        const matches = text === undefined
            ? await SearchUtils.searchInDocument(this.uri, Cache.relpathPattern)
            : SearchUtils.searchInText(text, Cache.relpathPattern);

        // const currDoc = doc instanceof Uri ? await vscode.workspace.openTextDocument(doc) : doc; /* 测试用途 */
        // LogInfo(`start cache: ${vscode.workspace.asRelativePath(uri)}`);

        for (const match of matches) {
            const relpath = match[1];
            let id: string | undefined = undefined;
            if (match.length > 2) {
                id = match[2];
            }
            const start = match.index + match[0].indexOf(match[1]);
            const length = match[1].length + (id === undefined ? 0 : id.length + 1); /* 这里 +1 是因为还有一个 '#' 符号 */
            try {
                this.localReferences.push(new LocalReference(relpath, this.uri, start, length, id));
                // const resourceUri = PathUtils.resolveRelpath(path.dirname(uri.fsPath), relpath);
                // const startAt = currDoc.positionAt(start); /* 测试用途 */
                // LogInfo(`    recognize ref: relpath: ${relpath}, id: ${id}, start: ${startAt}, len: ${length}, uri: ${uri}`);
                // LogInfo(`resolve success: ${path.basename(uri.fsPath)}, resource: ${resourceUri}, line: ${hehe.line+1}, col: ${hehe.character+1}, length: ${length}, id: ${id}`);
            } catch (error) {
                logError(`resolve uri failed: '${relpath}' in '${this.uri.fsPath}`);
            }
        }
    }
    public async cacheAttrReference(text?: string) {
        const regex = /^#+\s+(.+)\r?\n(?:\r?\n)*(<attr\b([^>]*)>.*?<\/attr>)/gim; /* 暂不支持 dotall 模式 */
        const matches = text === undefined
            ? await SearchUtils.searchInDocument(this.uri, regex)
            : SearchUtils.searchInText(text, regex);
        for (const match of matches) {
            this.attrReferences.push(new AttrReference(this.uri, match.index, match[1], match[2]));
            // logInfo(`    recognize attr for '${match[1]}', raw: '${match[2]}'.`);
        }
    }
}

export class CacheManager {
    private static instance?: CacheManager;

    private readonly _caches: Map<string, Cache>; /* fspath -> Cache 的表 */
    private _cacheChangeCounter: Map<string, number>;
    private _pendingCache: Map<string, Promise<void>>;

    private constructor() {
        this._caches = new Map<string, Cache>();
        this._cacheChangeCounter = new Map<string, number>();
        this._pendingCache = new Map<string, Promise<void>>();
        const watcher = vscode.workspace.createFileSystemWatcher('**/*.md');
        watcher.onDidChange((uri) => { this._onDidChange(uri); });
        watcher.onDidCreate((uri) => { this._onDidCreate(uri); });
        watcher.onDidDelete((uri) => { this._onDidDelete(uri); });
        CommonUtils.context!.subscriptions.push(watcher);
    }

    public static getInstance(): CacheManager {
        if (!CacheManager.instance) {
            CacheManager.instance = new CacheManager();
        }
        return CacheManager.instance;
    }

    public get cacheCount() { return this._caches.size; }

    /* ---------------- Cache ---------------- */

    public async cacheUri(uri: Uri) {
        const self = this;
        const empty = Promise.resolve();
        const placeholder = Promise.resolve();
        async function doCache() {
            if (self._pendingCache.has(uri.fsPath)) { return empty; }; /* 有空可以优化下这里的代码... 感觉很乱 */
            self._pendingCache.set(uri.fsPath, placeholder); /* 用 resolve 占位 */
            // LogInfo(`    cache remove: ${path.basename(uri.fsPath)}`);
            self._caches.delete(uri.fsPath); /* 要先移除旧 cache */
            const maxTryCount = 10;
            let tryCount = 0;
            if (!self._cacheChangeCounter.get(uri.fsPath)) {
                self._cacheChangeCounter.set(uri.fsPath, 0);
            }
            while (++tryCount < maxTryCount) {
                const count = self._cacheChangeCounter.get(uri.fsPath) ?? 0;
                try {
                    await self._doCacheUri(uri);
                } catch (error) {
                    self._removeCache(uri.fsPath);
                    throwError(`cache failed, msg: ${error}`);
                } finally {
                    if (self._cacheChangeCounter.has(uri.fsPath) && count !== self._cacheChangeCounter.get(uri.fsPath)) {
                        continue; // 继续下一轮
                    } else if (!self._cacheChangeCounter.has(uri.fsPath)) {
                        self._removeCache(uri.fsPath);
                    }
                    self._pendingCache.delete(uri.fsPath);
                    break;
                }
            }
            if (tryCount > maxTryCount) {
                self._removeCache(uri.fsPath);
                throwError(`try too much: ${uri.fsPath}`);
            }
            logInfo(`cache success: ${path.basename(uri.fsPath)}`);
        }
        const promise = doCache();
        if (promise !== empty) {
            this._pendingCache.set(uri.fsPath, promise);
        }
        await promise;
    }
    public async cacheWorkspace(pattern?: string) {
        pattern = pattern ?? '**/*.md';
        await WorkspaceUtils.traverseWorkspaceFiles(pattern, (uri) => { return this.cacheUri(uri); });
    }
    public _removeCacheInDir(dir: string | Uri) {
        const dirpath = dir instanceof Uri ? dir.fsPath : dir;
        const removeSet: Set<string> = new Set<string>();
        for (const fspath of this._caches.keys()) {
            if (PathUtils.inDir(fspath, dirpath)) {
                removeSet.add(fspath);
            }
        }
        for (const fspath of this._pendingCache.keys()) {
            if (PathUtils.inDir(fspath, dirpath)) {
                removeSet.add(fspath);
            }
        }
        for (const fspath of removeSet) {
            this._removeCache(fspath);
        }
    }
    private _removeCache(fspath: string) {
        // LogInfo(`    cache remove: ${path.basename(fspath)}`);
        this._caches.delete(fspath);
        this._cacheChangeCounter.delete(fspath);
        this._pendingCache.delete(fspath);
    }
    private async _doCacheUri(markdownUri: Uri) {
        if (!markdownUri.fsPath.endsWith('.md')) {
            logError(`invalid uri: only markdown file can be cached: ${markdownUri}`);
            return;
        }
        const cache = await Cache.fromUri(markdownUri);
        // LogInfo(`    set caches: ${path.basename(markdownUri.fsPath)}`);
        this._caches.set(markdownUri.fsPath, cache);
    }

    public async getCache(uri: Uri): Promise<Cache | void> {
        const fspath = uri.fsPath;
        if (this._pendingCache.has(fspath)) {
            await this._pendingCache.get(fspath);
            return this._caches.get(fspath);
        } else if (this._caches.has(fspath)) {
            return this._caches.get(fspath);
        } else {
            await this.cacheUri(uri);
            return this._caches.get(fspath);
        }
    }

    public findLabels(...labels: Label[]): AttrReference[] {
        function inLabels(target: Label) {
            for (const label of labels) {
                if (target.isDescendantOf(label)) {
                    return true;
                }
            }
            return false;
        }
        const attrs: AttrReference[] = [];
        for (const cache of this._caches.values()) {
            for (const attrReference of cache.attrReferences) {
                if (attrReference.labels.length === 0) { continue; }
                const labelSet = new Set<string>(attrReference.labels);
                for (const namepath of labelSet) {
                    const label = LabelsManager.getInstance().getLabel(namepath);
                    if (label === undefined) { continue; }
                    if (inLabels(label)) {
                        attrs.push(attrReference);
                        break;
                    }
                }
            }
        }
        return attrs;
    }

    /* ---------------- Iteration ---------------- */

    public async traverseUri(targetUri: Uri, handler: (ref: LocalReference) => void | Promise<void>) {
        for (const cache of this._caches.values()) {
            await cache.traverseUri(targetUri, handler);
        }
    }
    public async traverseTarget(targetUri: Uri, targetId: string | undefined, handler: (ref: LocalReference) => void | Promise<void>) {
        /* targetId === undefined 时，表示匹配任意 id */
        for (const cache of this._caches.values()) {
            await cache.traverseTarget(targetUri, targetId, handler);
        }
    }
    public async updateUri(edit: WorkspaceEdit, oldUri: Uri, newUri: Uri) {
        await this.updateTarget(edit, oldUri, undefined, newUri, undefined);
    }
    public async updateTarget(edit: WorkspaceEdit, oldUri: Uri, oldId: string | undefined, newUri: Uri, newId: string | undefined) {
        /* oldId === undefined 表示匹配任意 id，newId === undefined 表示使用 oldId */
        for (const cache of this._caches.values()) {
            await cache.updateTarget(edit, oldUri, oldId, newUri, newId).catch((error) => {
                logError(`    update target failed. target: ${path.basename(cache.uri.fsPath)}, msg: ${error}`);
            });
        }
    }

    /* ---------------- File Changes ---------------- */

    private _onDidChange(uri: Uri) {
        logInfo(`file changed: ${vscode.workspace.asRelativePath(uri)}`);
        const oldCount = this._cacheChangeCounter.get(uri.fsPath);
        this._cacheChangeCounter.set(uri.fsPath, oldCount !== undefined ? oldCount + 1 : 1);
        this.cacheUri(uri);
    }
    private _onDidCreate(uri: Uri) {
        logInfo(`file create: ${vscode.workspace.asRelativePath(uri)}`);
        const oldCount = this._cacheChangeCounter.get(uri.fsPath);
        this._cacheChangeCounter.set(uri.fsPath, oldCount !== undefined ? oldCount + 1 : 1);
        this.cacheUri(uri);
    }
    private _onDidDelete(uri: Uri) {
        logInfo(`file delete: ${vscode.workspace.asRelativePath(uri)}`);
        this._removeCache(uri.fsPath);
    }
}
