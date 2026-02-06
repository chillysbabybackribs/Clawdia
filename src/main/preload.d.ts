declare const api: {
    sendMessage: (conversationId: string, content: string) => Promise<any>;
    stopGeneration: () => Promise<any>;
    newConversation: () => Promise<any>;
    listConversations: () => Promise<any>;
    loadConversation: (id: string) => Promise<any>;
    deleteConversation: (id: string) => Promise<any>;
    onStreamText: (callback: (text: string) => void) => () => Electron.IpcRenderer;
    onStreamEnd: (callback: (fullText: string) => void) => () => Electron.IpcRenderer;
    onToolStart: (callback: (data: {
        id: string;
        name: string;
        input: unknown;
    }) => void) => () => Electron.IpcRenderer;
    onToolResult: (callback: (data: {
        id: string;
        result: string;
        isError: boolean;
    }) => void) => () => Electron.IpcRenderer;
    onChatError: (callback: (error: {
        error: string;
    }) => void) => () => Electron.IpcRenderer;
    onResearchProgress: (callback: (progress: any) => void) => () => Electron.IpcRenderer;
    browserNavigate: (url: string) => Promise<any>;
    browserBack: () => Promise<any>;
    browserForward: () => Promise<any>;
    browserRefresh: () => Promise<any>;
    browserSetBounds: (bounds: {
        x: number;
        y: number;
        width: number;
        height: number;
    }) => Promise<any>;
    onBrowserNavigated: (callback: (url: string) => void) => () => Electron.IpcRenderer;
    onBrowserTitle: (callback: (title: string) => void) => () => Electron.IpcRenderer;
    onBrowserLoading: (callback: (loading: boolean) => void) => () => Electron.IpcRenderer;
    onBrowserError: (callback: (error: string) => void) => () => Electron.IpcRenderer;
    getSettings: () => Promise<any>;
    setSetting: (key: string, value: string) => Promise<any>;
    windowMinimize: () => Promise<any>;
    windowMaximize: () => Promise<any>;
    windowClose: () => Promise<any>;
};
export type API = typeof api;
export {};
//# sourceMappingURL=preload.d.ts.map