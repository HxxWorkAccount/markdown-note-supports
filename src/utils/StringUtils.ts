import * as vscode from 'vscode';
import { Uri, Range, Location, TextDocument, Position, CancellationToken, WorkspaceEdit, ProviderResult } from 'vscode';

export function encodePath(path: string): string {
    /* 下面这个实现有 BUG，会把中文也给 encode */
    // const encode = encodeURIComponent(path.replace(/\\/g, '/'));
    // return encode.replace(/%2F/g, '/').replace(/%23/g, '#');
    return path.replace(/ /g, '%20'); /* 先做简单处理吧 */
}

export function escapeRegexExp(text: string): string {
    /* 转义字符串中正则表达式的特殊字符 */
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function slugify(text?: string): string { /* 该函数是幂等的 */
    if (text === undefined) {
        return "";
    }
    return text
        .trim()
        .toLowerCase()
        .replace(/\s/g, '-') /* 先将空格转为 - */
        // .replace(/-+/g, '-') /* 合并多个 - */
        .replace(/[\\`*+~.()'"!?:@\[\]{}<>^$|#%&=]/g, '') /* 移除特殊字符 */
        .replace(/[\u0080-\uFFFF]/gu, c => /\p{L}/u.test(c) ? c : '');
}

