import {Connection, Model, Mongoose, Schema} from "mongoose";
import {DelayDocLockingEngine} from "../doc-locking/DelayDocLockingEngine";
import {IDocLockingEngine} from "../doc-locking/IDocLockingEngine";
import {TransactionManagerBase} from "../TransactionManagerBase";
import {Transaction} from "./Transaction";
import {ITransactionInstance, TransactionEngine} from "./TransactionEngine";

export interface ITransactionManagerOptions {
    mongoose?: Mongoose;
    mongooseConn?: Connection;
    txColName?: string;
    docLockEngine?: IDocLockingEngine;
    appId?: string;
    lockWaitTimeout?: number;
    txFieldName?: string;
}

export interface IMongoosePluginOptions {
    optimisticLocking?: boolean;
    pessimisticLocking?: boolean;
}

export class TransactionManager extends TransactionManagerBase<Schema.Types.ObjectId, Transaction, TransactionEngine> {
    public protect: (schema: Schema, options?: IMongoosePluginOptions) => void;
    private txModel: Model<ITransactionInstance>;

    constructor(opts: ITransactionManagerOptions) {
        super();
        const {
            docLockEngine = new DelayDocLockingEngine(),
            mongooseConn = null,
            mongoose,
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
                this.txModel = mongooseConn.model<ITransactionInstance>(txColName);
            }
            catch (err) {
                if (err.name !== "MissingSchemaError") { throw err; }
                this.txModel = mongooseConn.model<ITransactionInstance>(txColName, txSchema);
            }
        }
        else {
            try {
                this.txModel = mongoose.model<ITransactionInstance>(txColName);
            }
            catch (err) {
                if (err.name !== "MissingSchemaError") { throw err; }
                this.txModel = mongoose.model<ITransactionInstance>(txColName, txSchema);
            }
        }
        this.engine = new TransactionEngine(this.txModel, docLockEngine, this.config, this);
        this.protect = this._protect.bind(this);
    }
    public getTxModel() { return this.txModel; }
    public addModels(models: Array<Model<any>>) {
        this.engine.addModels(models);
    }
    private _protect(schema: Schema) {
        schema.add({[this.config.txFieldName]: Object.getPrototypeOf(schema).constructor.Types.ObjectId});
    }
}
