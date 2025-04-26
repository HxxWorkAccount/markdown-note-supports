import * as vscode from 'vscode';
import * as path from 'path';
import * as WorkspaceUtils from 'utils/WorkspaceUtils';
import * as PathUtils from 'utils/PathUtils';
import * as DocumentUtils from 'utils/DocumentUtils';
import * as StringUtils from 'utils/StringUtils';
import { Uri, Range, TextDocument, DiagnosticCollection, Diagnostic } from 'vscode';
import { CacheManager, AttrReference, LocalReference } from 'CacheManager';
import { FileMoveEvent, MoveFileWatcher } from 'MoveFileWatcher';
import { logInfo, logWarning, logError, throwError, assert, context } from 'utils/CommonUtils';
import { promises as fs } from 'fs';
import { LabelManager } from './LabelManager';

export class DiagnosticProvider {
    private static _instance: DiagnosticProvider | null = null;
    public static getInstance(): DiagnosticProvider {
        if (!this._instance) {
            this._instance = new DiagnosticProvider();
        }
        return this._instance;
    }

    /* ---------------- Members ---------------- */

    private _diagnosticCollection: DiagnosticCollection;

    private constructor() {
        this._diagnosticCollection = vscode.languages.createDiagnosticCollection('markdown');
        context!.subscriptions.push(this._diagnosticCollection);

        /* 监听文件 cache 变化 */
        CacheManager.getInstance().afterCacheUri((uri) => { this.updateDiagnostics(uri); });

        /* 监听文件的打开事件 */
        context!.subscriptions.push(
            vscode.workspace.onDidOpenTextDocument((document) => {
                this.updateDiagnostics(document.uri);
            })
        );
    }

    private async updateDiagnostics(uri: Uri) {
        const diagnostics: Diagnostic[] = [];
        if (!WorkspaceUtils.isOpened(uri)) { return; }
        const document = await vscode.workspace.openTextDocument(uri);
        const cache = CacheManager.getInstance().getCacheUnsafe(uri); /* 获得当前 cache 直接分析 */
        if (cache === undefined) { return; }

        async function diagnoseRef(ref: LocalReference) {
            try {
                if (await PathUtils.exists(ref.uri)) { return; } /* 处于性能考虑，这里就不解析标题合法性 */
                assert(ref.source.fsPath === uri.fsPath, `WTF?! ref.source !== cache key: ${ref.source}, ${uri}`);
                diagnostics.push(new Diagnostic(
                    await ref.getRange(),
                    `path not exists: ${ref.relpath}`,
                    vscode.DiagnosticSeverity.Warning
                ));
            } catch (error) {
                logError(`diagnose ref failed, msg: ${error}`);
            }
        }

        async function diagnoseLabels(attr: AttrReference) {
            try {
                assert(attr.source.fsPath === uri.fsPath, `WTF?! attr.source !== cache key: ${attr.source}, ${uri}`);
                for (const { labelpath, startIndex } of attr.labelpaths) {
                    if (LabelManager.getInstance().getLabel(labelpath)) { continue; }
                    const range = await DocumentUtils.getRange(uri, attr.startIndex+startIndex, labelpath.length);
                    diagnostics.push(new Diagnostic(
                        range,
                        `invalid label: ${labelpath}`,
                        vscode.DiagnosticSeverity.Warning
                    ));
                }
            } catch (error) {
                logError(`diagnose attr failed, msg: ${error}`);
            }
        }

        await Promise.all([
            ...cache.localReferences.map(async ref => { await diagnoseRef(ref); }),
            ...cache.attrReferences.map(async attr => { await diagnoseLabels(attr); }),
        ]);

        this._diagnosticCollection.set(document.uri, diagnostics);
        logInfo(`diagnose success: ${uri}`);
    }

}
