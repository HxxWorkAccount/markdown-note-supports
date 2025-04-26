/* Todo 该部分仍待实现 */

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

/* 之后实现 TextFormat 单独起一个类吧，这个类只是功能汇总的单例 */
export class FormatProvider {
    private static _instance: FormatProvider | null = null;
    public static getInstance(): FormatProvider {
        if (!this._instance) {
            this._instance = new FormatProvider();
        }
        return this._instance;
    }

    /* ---------------- Members ---------------- */

    private constructor() {
        /* 注册命令 */
        context!.subscriptions.push(vscode.commands.registerCommand(
            'markdown-note-supports.WrapSymbolWithEquationMark',
            async () => { await this.wrapSymbolWithEquationMark(); }
        ));
    }

    /* ---------------- Wrap Symbol With Equation ---------------- */

    /* 对连续的 ascii 字符标上 '$$'，首尾空格会被剔除；如果 $$ 内有非 ascii 字符，则会拆成多份 */
    private async wrapSymbolWithEquationMark() {
        const editor = vscode.window.activeTextEditor;
        if (!editor || editor.selections.length === 0) { return; }
        const buffer: string[] = [];
        await editor.edit(editBuilder => {
            for (const selection of editor.selections) {
                const selectedText = editor.document.getText(selection);
                editBuilder.replace(selection, this.wrapText(buffer, selectedText));
            }
        });
    }
    private wrapText(buffer: string[], text: string): string {
        const lines = text.split('\n');
        const lineBuffer: string[] = [];
        buffer.length = 0;
        for (const line of lines) {
            buffer.push(this.wrapLine(lineBuffer, line));
        }
        return buffer.join('\n');
    }
    private wrapLine(buffer: string[], line: string): string { /* 该方法尽可能保留全部空格（只处理生成 $ 的边界情况） */
        line = line.replace(/^(\s*&)+/, '').replace(/^\s*\$(\s*&)+/,'$'); /* 剔除开头的 '&' */
        line = line.replace(/(\\\\\s*)+$/, '').replace(/(\\\\\s*)+\$\s*$/,'$'); /* 剔除尾部的 '\\' */
        const ascii = /[\x00-\x7F]/;
        const largeChar = /\p{L}/u;
        buffer.length = 0;
        const subbuffer: string[] = [];

        function IsUPunc(c: string | undefined): boolean { /* 是否为非 ascii 的标点符号（如：，、；。“”‘’） */
            if (c === undefined) { return false; }
            return !ascii.test(c[0]) && !largeChar.test(c[0]);
        }
        function getNext(part: string, i: number): string { /* 首尾空格都会纳入 */
            const j = i;
            if (ascii.test(part[i])) {
                while (i < part.length && ascii.test(part[i])) { i++; }
            } else {
                while (i < part.length && (part[i] === ' ' || !ascii.test(part[i]))) { i++; }
            }
            return part.substring(j, i);
        }
        function handleNonEquationPart(part: string) {
            for (let i = 0; i < part.length;) {
                const j = i;
                if (ascii.test(part[i])) {
                    subbuffer.push(j === 0 || IsUPunc(part[j-1]) ? '$' : ' $'); /* 如果前面是标点符号，则不需要空格 */
                    const str = getNext(part, i);
                    i += str.length;
                    subbuffer.push(str.trim());
                    subbuffer.push(i === part.length || IsUPunc(part[i]) ? '$' : '$ '); /* 如果后面是标点符号，则不需要空格 */
                } else {
                    const str = getNext(part, i);
                    i += str.length;
                    subbuffer.push(str.trim());
                }
            }
        }
        function handleEquationPart(part: string) {
            let i = 0;
            if (!ascii.test(part[0])) { /* 第一个是非 ascii，先录入一波（要处理 '$纯中文公式$' 这种情况） */
                const str = getNext(part, i);
                i += str.length;
                subbuffer.push(str.trimEnd());
                if (i === part.length) { return; }
            }
            let atBegin = true;
            subbuffer.push('$');
            while (i < part.length) {
                const str = getNext(part, i);
                const j = i;
                i += str.length;
                if (i === part.length && (str.length === 0 || !ascii.test(str[0]))) { /* 处理最后一个非 ascii part */
                    subbuffer.push(str.length > 0 && IsUPunc(str[0]) ? '$' : '$ '); /* 如果第一个符号是标点，则不需要空格m */
                    subbuffer.push(str.trimEnd());
                    return;
                } else if (atBegin) {
                    subbuffer.push(str.trimEnd());
                } else {
                    if (ascii.test(str[0])) {
                        subbuffer.push(j > 0 && IsUPunc(part[j-1]) ? '$': ' $'); /* 如果前面是标点符号，则不需要空格 */
                    } else {
                        subbuffer.push(j > 0 && IsUPunc(part[j]) ? '$': '$ '); /* 如果后面是标点符号，则不需要空格 */
                    }
                    subbuffer.push(str.trimEnd());
                }
                atBegin = false;
            }
            subbuffer.push('$'); /* 如果不是非 ascii 结尾，则需要补上结束符 */
        }

        const parts = line.split('$').map(p => p.trim());
        let inEquation = false;
        for (let i = 0; i < parts.length; i++, inEquation = !inEquation) {
            const part = parts[i];
            if (part === '') { continue; } /* 空的部分直接跳过 */

            subbuffer.length = 0;
            if (inEquation) { handleEquationPart(part); }
            else { handleNonEquationPart(part); }

            /* 尝试与上个公式合并 */
            if (buffer.length > 1 && buffer[buffer.length - 2].endsWith('$') && subbuffer[0].startsWith('$')) {
                buffer.pop(); /* 弹出分隔的空格 */
                const last = buffer.pop();
                if (last!.length > 1) { buffer.push(last!.substring(0, last!.length - 1)); }
                const first = subbuffer.shift();
                if (first!.length > 1) { subbuffer.unshift(first!.substring(1, last!.length)); }
                buffer.push(' ');
            }
            buffer.push(...subbuffer);

            /* 检测是否已经到最后一个了 */
            let j = i + 1;
            for (;j < parts.length && parts[j] === ''; j++) { }
            if (j === parts.length) { return buffer.join(''); }

            /* 公式与非公式之间插入空格，但要排除特定情况 */
            if (i < parts.length - 1 &&
                !(parts[i].length > 0 && IsUPunc(parts[i].at(-1))) && /* 如果当前符号是标点符号，则不需要加空格 */
                !(parts[i + 1] !== '' && IsUPunc(parts[i + 1])) /* 如果下个符号是标点符号，就不加空格 */
            ) {
                buffer.push(' ');
            }
        }
        return buffer.join('');
    }
}
