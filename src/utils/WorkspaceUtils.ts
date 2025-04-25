import * as vscode from 'vscode';

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
