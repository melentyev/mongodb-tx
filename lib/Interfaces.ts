export class TxUnknownModelError extends Error {
    constructor() { super("TX_UNKNOWN_MODEL_ERROR"); }
}

export class TxPreparedNotFound extends Error {
    constructor() { super("TX_PREPARED_NOT_FOUND"); }
}

export class TxLockTimeoutError extends Error {
    constructor() { super("TX_LOCK_TIMEOUT_ERROR"); }
}

export enum TransactionState {
    CREATED  = "CREATED",
    PREPARED = "PREPARED",
    COMMITED = "COMMITED",
    FAILED   = "FAILED",
}

export enum TransactionStepType {
    INSERT = "INSERT",
    UPDATE = "UPDATE",
    REMOVE = "REMOVE",
}

export interface ITxConfig {
    txColName: string;
    txFieldName: string;
    verFieldName: string;
    encodePrefix: string;
    lockWaitTimeout: number;
    appId: string | null;
}

export interface IStepDescription {
    m: string;
    c: any;
    e: any;
    t: TransactionStepType;
    upd: any;
}

export interface ILockDefinition {
    m: string;
    c: any;
}

export interface ITransactionDoc<TId> {
    _id: TId;
    state: TransactionState;
    sq: IStepDescription[];
    locks: ILockDefinition[];
    appId: string;
    xaId: string;
    createdAt: Date;
    updatedAt: Date;
    recoveryAt: Date;
}

export interface ITransaction<TId> {
    tx: ITransactionDoc<TId>;
    persistQueue(): Promise<any>;
}

export interface IUpdateRemoveOptions {
    throwIfMissing?: string;
}
