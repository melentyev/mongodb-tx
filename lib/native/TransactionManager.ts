import {Db, ObjectId} from "mongodb";

import {DelayDocLockingEngine} from "../doc-locking/DelayDocLockingEngine";
import {IDocLockingEngine} from "../doc-locking/IDocLockingEngine";
import {TransactionManagerBase} from "../TransactionManagerBase";
import {Transaction} from "./Transaction";
import {TransactionEngine} from "./TransactionEngine";

export interface ITransactionManagerOptions {
    db: Db;
    txColName?: string;
    docLockEngine?: IDocLockingEngine;
    appId?: string;
    lockWaitTimeout?: number;
    txFieldName?: string;
}

export class TransactionManager extends TransactionManagerBase<ObjectId, Transaction, TransactionEngine> {
    constructor(opts: ITransactionManagerOptions) {
        super();
        const {
            db,
            docLockEngine = new DelayDocLockingEngine(),
            lockWaitTimeout = 20 * 1000,
            txColName = "mongotxs",
        } = opts;

        this.config = {
            txFieldName: opts.txFieldName || "__m__t",
            verFieldName: "__m__v",
            encodePrefix: "__tx",
            lockWaitTimeout,
            appId: opts.appId || null,
            txColName,
        };

        this.engine = new TransactionEngine(db, docLockEngine, this.config, this);
    }
}
