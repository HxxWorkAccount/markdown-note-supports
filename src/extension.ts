import * as vscode from 'vscode';
import * as CommonUtils from 'utils/CommonUtils';
import * as RenameProvider from './providers/RenameProvider';
import { DiagnosticProvider } from './providers/DiagnosticProvider';
import { LabelManager } from './providers/LabelsManager';
import { MdReferenceUpdater } from 'providers/MdReferenceUpdater';
import { CacheManager } from 'CacheManager';
import { logInfo, logWarning, logError, throwError, assert } from 'utils/CommonUtils';

export async function activate(context: vscode.ExtensionContext) {
    CommonUtils._setContext(context);

    /* 注册 diagnostic 功能 */
    DiagnosticProvider.getInstance();

    /* 读取 label 配置 */
    await LabelManager.getInstance().updateConfig()
        .catch((error) => {
            logError(`load label failed, msg: ${error}`);
        });

    /* 读取文件缓存 */
    await CacheManager.getInstance().cacheWorkspace()
        .then(() => { logInfo(`CACHE DONE! total: ${CacheManager.getInstance().cacheCount}`); })
        .catch((error) => {
            throwError(`update cache failed, msg: ${error}`);
        });;

    /* 依赖 cache 的功能放后面 */
    RenameProvider.register();
    MdReferenceUpdater.getInstance(); /* 初始化 updater */
}

export function deactivate() { }
