import * as _ from "lodash";

import {Connection, Model, Mongoose, Schema} from "mongoose";
import {DelayRowLockingEngine} from "./DelayRowLockingEngine";
import {IRowLockingEngine} from "./IRowLockingEngine";
import {LocalRowLockingEngine} from "./LocalRowLockingEngine";
import {Transaction} from "./Transaction";
import {ITransactionInstance, ITxConfig, TransactionEngine} from "./TransactionEngine";

export type TransactionBody<TRes> = (t: Transaction) => Promise<TRes>;

export interface ITransactionManagerOptions {
    rowLockEngine?: IRowLockingEngine;
    mongoose: Mongoose;
    mongooseConn?: Connection;
    appId?: string;
    lockWaitTimeout?: number;
}

export interface IMongoosePluginOptions {
    optimisticLocking?: boolean;
    pessimisticLocking?: boolean;
}

export class TransactionManager {
    public protect: (schema: Schema, options?: IMongoosePluginOptions) => void;

    private mgr: TransactionEngine;
    private txModel: Model<ITransactionInstance>;
    private config: ITxConfig;

    constructor(opts: ITransactionManagerOptions) {
        const {
            rowLockEngine = new DelayRowLockingEngine(),
            mongooseConn = null,
            mongoose,
            lockWaitTimeout = 20 * 1000,
        } = opts;

        this.config = {
            txFieldName: "__m__t",
            verFieldName: "__m__v",
            encodePrefix: "__tx",
            lockWaitTimeout,
            appId: opts.appId || null,
        };
        // _.defaults()
        // _.assign(this, {txFieldName, verFieldName, encodePrefix, lockWaitTimeout});

        const txModelName = "MongoTxs";
        const txSchema = new mongoose.Schema({
            state: String,
            sq: [mongoose.Schema.Types.Mixed],
            date: Date,
            locks: [mongoose.Schema.Types.Mixed],
            appId: String,
            xaId: String,
            createdAt: Date,
            updatedAt: Date,
            recoveryAt: Date,
        });

        if (mongooseConn) {
            try {
                this.txModel = mongooseConn.model<ITransactionInstance>(txModelName);
            }
            catch (err) {
                if (err.name !== "MissingSchemaError") { throw err; }
                this.txModel = mongooseConn.model<ITransactionInstance>(txModelName, txSchema);
            }
        }
        else {
            try {
                this.txModel = mongoose.model<ITransactionInstance>(txModelName);
            }
            catch (err) {
                if (err.name !== "MissingSchemaError") { throw err; }
                this.txModel = mongoose.model<ITransactionInstance>(txModelName, txSchema);
            }
        }
        this.mgr = new TransactionEngine(rowLockEngine, this.txModel, this.config);
        this.protect = this._protect.bind(this);
    }
    public getTxModel() { return this.txModel; }
    public getConfig() { return _.cloneDeep(this.config); }
    public transaction<TRes>(body: TransactionBody<TRes>) {
        return this.mgr.transaction(body);
    }
    public transactionPrepare<TRes>(xaId: string, body: TransactionBody<TRes>) {
        return this.mgr.transaction(body, xaId);
    }
    public commitPrepared(xaId: string) {
        return this.mgr.commitPrepared(xaId);
    }
    public rollbackPrepared(xaId: string) {
        return this.mgr.rollbackPrepared(xaId);
    }
    public addModels(models: Array<Model<any>>) {
        this.mgr.addModels(models);
    }
    public recovery(considerTimeThreshold: boolean = true) {
        return this.mgr.recovery(considerTimeThreshold);
    }
    private _protect(schema: Schema, options?: IMongoosePluginOptions) {
        const {optimisticLocking = true, pessimisticLocking = true} = options || {};
        if (optimisticLocking) {
            schema.add({[this.config.verFieldName]: Number});
        }
        if (pessimisticLocking) {
            schema.add({[this.config.txFieldName]: Object.getPrototypeOf(schema).constructor.Types.ObjectId});
        }
    }
}

export {DelayRowLockingEngine, LocalRowLockingEngine};