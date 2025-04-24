import * as vscode from 'vscode';
import * as StringUtils from 'utils/StringUtils';
import { promises as fs } from 'fs';
import { Uri, Range, Location, TextDocument, Position, CancellationToken, WorkspaceEdit, ProviderResult } from 'vscode';
import { logWarning } from './CommonUtils';

export type MatchResult = { match: RegExpExecArray; range: Range; };

export const enum SearchOptions {
    None = 0,
    FullWord = 1 << 0,
    IgnoreCase = 1 << 1,
    Regex = 1 << 2,
}

export function searchInText(text: string, pattern: string | RegExp, options = SearchOptions.Regex): RegExpStringIterator<RegExpExecArray> {
    let regex: RegExp;
    if (pattern instanceof RegExp) {
        if (options !== SearchOptions.Regex) {
            logWarning(`searchInText will ignore options when pattern is RegExp: ${pattern}.`);
        }
        regex = pattern;
    } else {
        let flags = 'ug';
        if (SearchOptions.IgnoreCase & options) {
            flags += 'i';
        }
        if (!(SearchOptions.Regex & options)) { /* 非正则模式时，先转义搜索字符串 */
            pattern = StringUtils.escapeRegexExp(pattern);
        }
        if (SearchOptions.FullWord & options) { /* 全词匹配时，在模式前后加上单词边界 */
            pattern = `\\b${pattern}\\b`;
        }
        regex = new RegExp(pattern, flags);
    }
    return text.matchAll(regex);
}

export async function searchInDocument(document: TextDocument | Uri, pattern: string | RegExp, options = SearchOptions.Regex): Promise<RegExpStringIterator<RegExpExecArray>> {
    let text: string;
    if (document instanceof Uri) {
        text = await fs.readFile(document.fsPath, 'utf-8');
    } else {
        text = document.getText();
    }

    return searchInText(text, pattern, options);
}
