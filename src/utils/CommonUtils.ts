import * as vscode from 'vscode';
import { extensionName } from 'const/CommonConst';
import { ExtensionContext } from 'vscode';

export let context: ExtensionContext | undefined;
export function _setContext(ctx: ExtensionContext) {
    context = ctx;
}

export const output = vscode.window.createOutputChannel(extensionName);

export function logInfo(msg:string) {
    output.appendLine('[Info] ' + msg);
}
export function logWarning(msg:string) {
    output.appendLine('[Warning] ' + msg);
}
export function logError(msg:string) {
    output.appendLine('[Error] ' + msg);
}
export function throwError(msg:string): never {
    logError(msg);
    throw Error(msg);
}

export function assert(cond: boolean, msg?: string)  {
    if (!cond) {
        throw Error(msg === undefined ? 'assert failed.' : msg);
    }
}
