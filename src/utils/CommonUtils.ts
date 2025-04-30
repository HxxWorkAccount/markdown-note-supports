import * as vscode from 'vscode';
import { extensionName } from 'const/CommonConst';
import { ExtensionContext } from 'vscode';

export let context: ExtensionContext | undefined;
export function _setContext(ctx: ExtensionContext) {
    context = ctx;
}

export const output = vscode.window.createOutputChannel(extensionName);

export function logInfo(msg: string) {
    output.appendLine('[Info] ' + msg);
}
export function logWarning(msg: string) {
    output.appendLine('[Warning] ' + msg);
}
export function logError(msg: string) {
    output.appendLine('[Error] ' + msg);
}
export function throwError(msg: string): never {
    logError(msg);
    throw Error(msg);
}

export function assert(cond: boolean, msg?: string) {
    if (!cond) {
        throw Error(msg === undefined ? 'assert failed.' : msg);
    }
}

export function getIteratorElement<T>(iter: Iterator<T>, i: number): T | undefined {
    let result: IteratorResult<T>;
    let count = 0;
    while (!(result = iter.next()).done) {
        if (count === i) { return result.value; }
        count++;
    }
    return undefined;
}

export function formattedLocalTime() {
    const now = new Date();
    const pad = (n: number) => n.toString().padStart(2, '0');
    const year = now.getFullYear() % 100; // 取后两位
    const month = pad(now.getMonth() + 1);
    const day = pad(now.getDate());
    const hour = pad(now.getHours());
    const minute = pad(now.getMinutes());
    const second = pad(now.getSeconds());
    return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
}
