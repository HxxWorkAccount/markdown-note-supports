import * as vscode from 'vscode';
import * as path from 'path';
import * as PathUtils from 'utils/PathUtils';
import * as StringUtils from 'utils/StringUtils';
import { Uri, WorkspaceEdit } from 'vscode';
import { CacheManager } from 'CacheManager';
import { FileMoveEvent, MoveFileWatcher } from 'MoveFileWatcher';
import { logInfo, logWarning, logError, throwError, assert } from 'utils/CommonUtils';

export class MdReferenceUpdater {
    private static _instance: MdReferenceUpdater | null = null;

    private constructor() {
        MoveFileWatcher.getInstance().onDidMove(this._onFileMoved, this);
    }

    public static getInstance(): MdReferenceUpdater {
        if (!this._instance) {
            this._instance = new MdReferenceUpdater();
        }
        return this._instance;
    }

    private async _onFileMoved(event: FileMoveEvent) {
        try {
            let edit: WorkspaceEdit | undefined;
            logInfo(`Updating references from ${event.oldUri.fsPath} to ${event.newUri.fsPath}`);

            await CacheManager.getInstance().saveAndCacheAllDirty(); /* 插件只希望在必要时执行自动保存 */

            const movingDir = await PathUtils.isDirectoryAsync(event.newUri.fsPath);
            const dirMdFiles = await vscode.workspace.findFiles(`${vscode.workspace.asRelativePath(event.newUri.fsPath)}/**/*.md`);

            if (movingDir) { /* 如果是移动目录，那要把该目录下的 .md 全部再刷一遍（文件监控不会触发。。。非常离谱） */
                CacheManager.getInstance()._removeCacheInDir(event.oldUri);
                await CacheManager.getInstance().cacheWorkspace(`${vscode.workspace.asRelativePath(event.newUri.fsPath)}/**/*.md`);
            }

            /* 更新被移动文件内的引用 */
            edit = new vscode.WorkspaceEdit();
            if (event.newUri.fsPath.endsWith('.md')) {
                await this._editInnerReference(edit, event.oldUri, event.newUri).catch((error) => {
                    logError(`can't edit inner reference, msg: ${error}`);
                });;
            } else if (movingDir) {
                const promises = dirMdFiles.map((uri) => {
                    const oldUri = PathUtils.getOldUriAfterDirMove(uri, event.oldUri.fsPath, event.newUri.fsPath);
                    return this._editInnerReference(edit!, oldUri, uri, event.oldUri);
                });
                await Promise.allSettled(promises);
            }
            if (edit) {
                await vscode.workspace.applyEdit(edit);
                // await Promise.allSettled(Array.from(edit.entries()).map(([uri]) => vscode.workspace.save(uri)));
            }

            /* 更新指向被移动文件的引用 */
            edit = new vscode.WorkspaceEdit();
            await this._editOuterReference(edit, event.oldUri, event.newUri);
            await vscode.workspace.applyEdit(edit);
            // await Promise.allSettled(Array.from(edit.entries()).map(([uri]) => vscode.workspace.save(uri)));
        } catch (err) {
            logError(`Failed to update references for file move: ${err instanceof Error ? err.stack : String(err)}`);
        }
    }

    private async _editInnerReference(edit: WorkspaceEdit, oldUri: Uri, newUri: Uri, oldDir?: Uri) {
        const cache = await CacheManager.getInstance().getCache(newUri);
        if (!cache) {
            throw Error(`Can't get cache, won't update reference: ${newUri}`);
        }
        /* 更新局部引用信息，替换相对路径 */
        for (const ref of cache.localReferences) {
            const oldRelpath = ref.relpath; /* 这个是相对于旧路径的地址 */
            const refOldAbspath = path.resolve(path.dirname(oldUri.fsPath), oldRelpath); /* 旧资源绝对路径 */
            let newRelpath;
            if (oldDir && PathUtils.inDir(refOldAbspath, oldDir.fsPath)) { /* 如果是移动目录，那么目录内的引用只需要格式化一下就行了 */
                newRelpath = oldRelpath + (ref.id !== undefined ? `#${ref.id}` : ''); /* 相对于旧目录的路径 */
            } else {
                newRelpath = ref.getRelpathFromFile(cache.uri, Uri.file(refOldAbspath)); /* 相对于新文件的路径 */
            }
            const range = await ref.getRange();
            // LogInfo(`    oldrel: ${oldRelpath}, abspath: ${abspath}, newrel: ${newRelpath}`);
            edit.replace(cache.uri, range, StringUtils.encodePath(newRelpath));
        }
    }

    private async _editOuterReference(edit: WorkspaceEdit, oldUri: Uri, newUri: Uri) {
        await CacheManager.getInstance().editUri(edit, oldUri, newUri);
    }
}
