export interface ITxConfig {
    txColName: string;
    txFieldName: string;
    verFieldName: string;
    encodePrefix: string;
    lockWaitTimeout: number;
    appId: string | null;
}
