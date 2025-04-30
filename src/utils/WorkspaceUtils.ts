import * as vscode from 'vscode';
import { Uri } from 'vscode';
import { logError } from './CommonUtils';

/**
 * 遍历项目所有文件（每批并发处理 15 个文件）
 * @param filter 用于过滤文件的 glob 模式（例如 '**\/*.md'）
 * @param handler 每个文件对应的处理函数，传入文件的 Uri
 */
export async function traverseWorkspaceFiles(
    filter: string,
    handler: (uri: vscode.Uri) => void | Promise<void>
): Promise<void> {
    const files = await vscode.workspace.findFiles(filter);
    const batchSize = 15;
    for (let i = 0; i < files.length; i += batchSize) {
        const batch = files.slice(i, i + batchSize);
        await Promise.allSettled(batch.map(file => handler(file)));
    }
}

export function isOpened(uri: vscode.Uri): boolean {
    return vscode.workspace.textDocuments.some(doc => doc.uri.fsPath === uri.fsPath);
}

export async function saveEdit(edit: vscode.WorkspaceEdit): Promise<boolean> {
    return await saveAll(Array.from(edit.entries()).map(([uri]) => uri));
}

export async function saveAll(uriList: Iterable<Uri>): Promise<boolean> {
    const promises: Promise<boolean>[] = [];
    async function dosave(uri: Uri): Promise<boolean> {
        try {
            const doc = await vscode.workspace.openTextDocument(uri);
            return await doc.save();
        } catch (error) {
            logError(`save file error: ${error}`);
            return false;
        }
    }
    for (const uri of uriList) {
        promises.push(dosave(uri));
    }
    const results = await Promise.all(promises);
    return results.every(result => result === true);
}

export async function saveAllDirty(filter?: (doc: vscode.TextDocument) => boolean): Promise<Uri[]> {
    const dirtyDocs = filter === undefined
        ? vscode.workspace.textDocuments.filter(doc => doc.isDirty)
        : vscode.workspace.textDocuments.filter(doc => { return doc.isDirty && filter(doc); });
    const savePromises = dirtyDocs.map(doc => doc.save());
    await Promise.all(savePromises);
    return dirtyDocs.map(doc => doc.uri);
}
