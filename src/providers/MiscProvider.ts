/* 提供杂项功能 */

import * as vscode from 'vscode';
import * as path from 'path';
import * as WorkspaceUtils from 'utils/WorkspaceUtils';
import * as PathUtils from 'utils/PathUtils';
import * as DocumentUtils from 'utils/DocumentUtils';
import * as CommonUtils from 'utils/CommonUtils';
import * as StringUtils from 'utils/StringUtils';
import { Uri, Range, TextDocument, DiagnosticCollection, Diagnostic } from 'vscode';
import { CacheManager, AttrReference, LocalReference } from 'CacheManager';
import { FileMoveEvent, MoveFileWatcher } from 'MoveFileWatcher';
import { logInfo, logWarning, logError, throwError, assert, context } from 'utils/CommonUtils';
import { promises as fs } from 'fs';

export function registerMiscFeatures() {
    registerInsertCurrentTime();
}

function registerInsertCurrentTime() {
    async function insertCurrentTime() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) { return; }
        const formattedTime = CommonUtils.formattedLocalTime();
        await editor.edit(editBuilder => {
            for (const selection of editor.selections) {
                editBuilder.insert(selection.active, formattedTime);
            }
        });
    }
    context!.subscriptions.push(vscode.commands.registerCommand(
        'markdown-note-supports.InsertCurrentTime',
        insertCurrentTime,
    ));
}
