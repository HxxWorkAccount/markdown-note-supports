import * as vscode from 'vscode';
import { Uri, Range } from 'vscode';

export async function getRange(uri: Uri, startIndex: number, length: number): Promise <Range> {
    const doc = await vscode.workspace.openTextDocument(uri);
    const start = doc.positionAt(startIndex);
    const end = doc.positionAt(startIndex + length);
    return new Range(start, end);
}
