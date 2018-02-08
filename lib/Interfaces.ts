import {TransactionState} from "./TransactionState";
import {TransactionStepType} from "./TransactionStepType";

export interface IStepDescription {
    m: string;
    c: any;
    e: IUpdateRemoveOptions | null;
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
