import { S as SessionView } from '../../../../types-BxyAidGf.js';

type ZcodeReaderErrorCode = "engine_session_read_failed";
declare class ZcodeReaderError extends Error {
    readonly code: ZcodeReaderErrorCode;
    /** 原始失败细节（缺文件/表漂移/运行时不支持）。 */
    readonly detail: string;
    constructor(detail: string, hint?: string);
}
/**
 * 读取 zcode session 的引擎中立视图（read 第①级）。
 *
 * @param dbPath    db.sqlite 绝对路径（引擎 read() 由 handle 解析后传入）
 * @param sessionId 目标 session；缺省取池内最新（time_created DESC 首行）
 * @throws ZcodeReaderError db 缺失/表漂移/node:sqlite 不可用/session 不存在——
 *         结构化错误供调用方走降级链②③级
 */
declare function readZcodeSessionView(dbPath: string, sessionId?: string): Promise<SessionView>;

export { ZcodeReaderError, type ZcodeReaderErrorCode, readZcodeSessionView };
