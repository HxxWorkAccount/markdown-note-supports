import * as vscode from 'vscode';
import * as path from 'path';
import * as StringUtils from 'utils/StringUtils';
import * as PathUtils from 'utils/PathUtils';
import { Range, TextDocument, Position, CancellationToken, WorkspaceEdit, ProviderResult } from 'vscode';
import { CacheManager } from 'CacheManager';
import { logInfo, logWarning, logError, throwError, assert } from 'utils/CommonUtils';

export class RenameProvider implements vscode.RenameProvider {
    public async provideRenameEdits(document: TextDocument, position: Position, newName: string, token: CancellationToken): Promise<WorkspaceEdit> {
        /* 检测是否符合标题格式 */
        const line = document.lineAt(position.line);
        const headerRegex = /^(#+\s+)(.+)$/;
        const match = headerRegex.exec(line.text);
        if (!match) {
            return Promise.reject(new Error(`not title: ${line.text}`));
        }

        /* 保留标题前缀（例如 "## "），只替换标题的文本部分 */
        const prefix = match[1];
        const oldHeader = match[2];
        const edit = new vscode.WorkspaceEdit();

        /* 计算标题文本在行中的范围（不包括前缀） */
        const headerBodyStart = line.range.start.translate(0, prefix.length);
        const headerBodyRange = new vscode.Range(headerBodyStart, line.range.end);
        edit.replace(document.uri, headerBodyRange, newName);

        /* 获取当前 header 的旧 id 和新 id */
        const oldId = StringUtils.slugify(oldHeader);
        const newId = StringUtils.slugify(newName);
        const thisUri = document.uri;
        logInfo(`oldHeader: ${oldHeader}, old id: ${oldId}, new id: ${newId}`);

        /* 遍历所有缓存，查找引用当前 header 的 LocalReference */
        await CacheManager.getInstance().editTarget(edit, thisUri, oldId, thisUri, newId);

        /* 处理当前文件内的本地 id 引用（如 [xxx](#oldId)） */
        const docText = document.getText();
        const localRegex = String.raw`\[[^\[\]]*\]\((#${StringUtils.escapeRegexExp(oldId)})\)`;
        const localRefRegex = new RegExp(localRegex, 'g');
        logInfo(`match local regex: ${localRegex}`);
        const localMatches = docText.matchAll(localRefRegex);
        for (const match of localMatches) {
            const matchStart = match.index + match[0].indexOf(match[1]);
            const startPos = document.positionAt(matchStart);
            const endPos = document.positionAt(matchStart + match[1].length);
            logInfo(`match[1]: ${match[1]}, modify local: ${startPos.line + 1}:${startPos.character + 1}, length: ${match[1].length}`);
            edit.replace(document.uri, new vscode.Range(startPos, endPos), '#' + newId);
        }
        return edit;
    }

    public async prepareRename(
        document: TextDocument,
        position: Position,
        token: CancellationToken
    ): Promise<Range | { range: Range; placeholder: string }> {
        const line = document.lineAt(position.line);
        const headerRegex = /^(#+\s+)(.+)$/;
        const match = headerRegex.exec(line.text);
        if (!match) {
            return Promise.reject(new Error(`not title: ${line.text}`));
        }
        const prefix = match[1];
        const headerText = match[2];
        const headerStart = line.range.start.translate(0, prefix.length);
        const headerEnd = headerStart.translate(0, headerText.length);
        const range = new vscode.Range(headerStart, headerEnd);

        // 可选：返回 placeholder
        return { range, placeholder: headerText };
    }
}

export function register(): vscode.Disposable {
    return vscode.languages.registerRenameProvider('markdown', new RenameProvider);
}
