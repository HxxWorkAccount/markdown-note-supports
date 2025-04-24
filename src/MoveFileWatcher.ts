import * as vscode from 'vscode';
import { context } from 'utils/CommonUtils';

export interface FileMoveEvent {
    oldUri: vscode.Uri;
    newUri: vscode.Uri;
}

export class MoveFileWatcher {
    private static _instance: MoveFileWatcher | null = null;

    private _onDidMove = new vscode.EventEmitter<FileMoveEvent>();
    public readonly onDidMove = this._onDidMove.event;
    private _disposable: vscode.Disposable;

    private constructor() {
        this._disposable = vscode.workspace.onDidRenameFiles(event => {
            for (const file of event.files) {
                this._onDidMove.fire({ oldUri: file.oldUri, newUri: file.newUri });
            }
        });
        context!.subscriptions.push(this);
    }
    public static getInstance(): MoveFileWatcher {
        if (!this._instance) {
            this._instance = new MoveFileWatcher();
        }
        return this._instance;
    }

    dispose() {
        this._disposable.dispose();
        this._onDidMove.dispose();
    }
}
