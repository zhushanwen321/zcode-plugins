/** 路径段进入文件系统前的安全编码：路径穿越、分隔符、空白、超长全部归一。 */
declare function sanitizeSeg(input: string): string;
declare function resolveEnginesRoot(dataDir: string): string;
declare function resolveEngineDir(dataDir: string, engineId: string): string;
declare function resolvePoolDir(dataDir: string, engineId: string, poolKey: string): string;
declare function resolveJournalPath(dataDir: string, engineId: string, poolKey: string, taskId: string): string;

export { resolveEngineDir, resolveEnginesRoot, resolveJournalPath, resolvePoolDir, sanitizeSeg };
