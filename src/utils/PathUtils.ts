import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { Uri, Range, Location, TextDocument, Position, CancellationToken, WorkspaceEdit, ProviderResult, commands } from 'vscode';

/* 给定一个目录 Uri 和一个相对路径（可以包含 URL 转义），返回最终的文件 Uri */
export function resolveRelpath(dir: Uri | string, relpath: string): Uri {
    /* 逆 URL 转义，如果 relpath 本身已经逆转义过也没事，重复调用不会改变什么（除非你提供了非法路径） */
    const decoded = decodeURIComponent(relpath);
    if (path.isAbsolute(relpath)) {
        throw new Error('Relative path expected');
    }

    if (dir instanceof Uri) {
        return Uri.file(path.resolve(dir.fsPath, decoded));
    } else {
        return Uri.file(path.resolve(dir, decoded));
    }
}

export function getRelpath(from: Uri | string, target: Uri | string): string {
    const fromFspath = from instanceof Uri ? from.fsPath : from;
    const toFspath = target instanceof Uri ? target.fsPath : target;
    const relpath = path.relative(fromFspath, toFspath).replace(/\\/g, '/');
    return relpath === '' ? '.' : relpath;
}
export function getRelpathFromFile(fromFile: Uri | string, target: Uri | string): string {
    const fromFspath = fromFile instanceof Uri ? fromFile.fsPath : fromFile;
    const toFspath = target instanceof Uri ? target.fsPath : target;
    const relpath = path.relative(path.dirname(fromFspath), toFspath).replace(/\\/g, '/');
    return relpath === '' ? '.' : relpath;
}
export function getAbsPath(relpath: Uri | string): Uri | undefined {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
        const workspacePath = workspaceFolders[0].uri.fsPath;
        return Uri.file(path.resolve(workspacePath, relpath instanceof Uri ? relpath.fsPath : relpath));
    }
    return;
}

export function isDirectory(uri: Uri): boolean {
    try {
        return fs.statSync(uri.fsPath).isDirectory();
    } catch {
        return false;
    }
}

export function inWorkspace(uri: Uri): boolean {
    return vscode.workspace.getWorkspaceFolder(uri) !== undefined;
}

export async function isDirectoryAsync(path: string): Promise<boolean> {
    try {
        const stat = await fs.promises.stat(path);
        return stat.isDirectory();
    } catch {
        return false;
    }
}

export function inDir(abspath: string, dir: string): boolean {
    const relative = path.relative(dir, abspath);
    return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
}

export async function exists(uri: Uri): Promise<boolean> {
    try {
        await vscode.workspace.fs.stat(uri);
        return true;
    } catch (e) {
        return false;
    }
}

export function getOldUriAfterDirMove(newUri: Uri, oldDir: string, newDir: string): Uri {
    /* 假设 oldDir 和 newDir 都是绝对路径 */
    oldDir = oldDir.endsWith('/') || oldDir.endsWith('\\') ? oldDir : oldDir + '/';
    newDir = newDir.endsWith('/') || newDir.endsWith('\\') ? newDir : newDir + '/';
    const newPath = newUri.fsPath;
    const oldPath = newPath.replace(newDir, oldDir);
    return Uri.file(oldPath);
}
export function getNewUriAfterDirMove(oldUri: Uri, oldDir: string, newDir: string): Uri {
    oldDir = oldDir.endsWith('/') || oldDir.endsWith('\\') ? oldDir : oldDir + '/';
    newDir = newDir.endsWith('/') || newDir.endsWith('\\') ? newDir : newDir + '/';
    const oldPath = oldUri.fsPath;
    const newPath = oldPath.replace(oldDir, newDir);
    return Uri.file(newPath);
}
