import * as _ from "lodash";
import * as mongoose from "mongoose";
import {
    ILockDefinition, IStepDescription, ITransactionInstance, TransactionEngine, TransactionState,
    TransactionStepType,
} from "./TransactionEngine";

export class TxPrepareFailedError extends Error {
    constructor() { super("TX_PREPARE_FAILED_ERROR"); }
}

export class TxLockTimeoutError extends Error {
    constructor() { super("TX_LOCK_TIMEOUT_ERROR"); }
}

// export let LOCK_COLLISIONS = 0;

export class TransactionLocks {
    constructor(private manager: TransactionEngine,
                private t: Transaction,
                private declaredLocks: ILockDefinition[]) {}

    public declare(modelOrName: string|mongoose.Model<any>, cond) {
        const model = this.manager.getModel(modelOrName);
        const modelName = model.modelName;
        if (!this._isSet(modelName, cond)) {
            this.declaredLocks.push({m: modelName, c: cond});
        }
        return this;
    }
    public isSet(modelOrName: string|mongoose.Model<any>, cond) {
        const model = this.manager.getModel(modelOrName);
        return this._isSet(model.modelName, cond);
    }
    public async save() {
        const tx = await this.manager.txModel.findOneAndUpdate(
            {_id: this.t.getId(), state: TransactionState.CREATED},
            {locks: this.manager.encode(this.declaredLocks)}, {new: true});
        this.declaredLocks = this.manager.decode(tx.locks); // fails when tx === null
        this.t.tx = tx;
    }

    private _isSet(modelName: string, cond) {
        return !!this.declaredLocks.find((x) => _.isEqual(x, {m: modelName, c: cond}));
    }
}

export interface IUpdateRemoveOptions {
    throwIfMissing?: string;
}

export class Transaction {
    public locks: TransactionLocks;
    private txFieldName: string;
    private fetchedDocModels = [];
    private queue: IStepDescription[] = [];

    constructor(private manager: TransactionEngine, public tx: ITransactionInstance) {
        this.txFieldName = this.manager.txFieldName;
        this.locks = new TransactionLocks(this.manager, this,
            this.tx.locks.map((x) => _.assign({}, x)));
    }

    public getId(): mongoose.Schema.Types.ObjectId { return this.tx._id; }

    /**
     * We have to wait for all promises completion, because we can't start rollback too early
     * @param {Array<Promise<any>>} promises
     * @returns {Promise<void>}
     */
    public async all(promises: Array<Promise<any> >) {
        const results = await Promise.all(promises.map((p) =>
            p.then((res) => ({res})).catch((err) => ({err}))));
        const errWrap = results.find((x) => x["err"]);
        if (errWrap) {
            throw errWrap["err"];
        }
        return results.map((res) => res["res"]);
    }
    public async mapSeries<T>(arr: T[], cb: any) {
        const results = [];
        for (const x of arr) {
            try { results.push(await cb(x)); }
            catch (err) { throw err; }
        }
        return results;
    }

    public update(modelOrName: string|mongoose.Model<any>, cond, upd, opts?: IUpdateRemoveOptions): void;
    public update(doc: mongoose.Document, upd, opts?: IUpdateRemoveOptions): void;
    public update(modelOrNameOrDoc: string|mongoose.Model<any>|mongoose.Document, condOrUpd, updOrOpts?, opts?): void {
        if (typeof modelOrNameOrDoc === "string" || modelOrNameOrDoc["modelName"]) {
            const model = this.manager.getModel(modelOrNameOrDoc as string|mongoose.Model<any>);
            this._stepLocal(condOrUpd, TransactionStepType.UPDATE, model.modelName, updOrOpts, opts);
        }
        else {
            const found = this.fetchedDocModels.find((x) => x.doc === modelOrNameOrDoc);
            // TODO consider if not found
            this._stepLocal(found.cond, TransactionStepType.UPDATE, found.modelName, condOrUpd, updOrOpts);
        }
    }

    public create<T extends mongoose.Document>(modelOrName: string|mongoose.Model<any>, vals): T {
        const model = this.manager.getModel<T>(modelOrName);
        const entity = new model({...vals, [this.txFieldName]: this.getId()});

        this._stepLocal({_id: `${entity._id}`}, TransactionStepType.INSERT, model.modelName, vals);
        return entity;
    }

    public remove(modelOrName: string|mongoose.Model<any>, cond, opts?: IUpdateRemoveOptions);
    public remove(doc: mongoose.Document, opts?: IUpdateRemoveOptions);
    public remove(modelOrNameOrDoc: string|mongoose.Model<any>|mongoose.Document, condOrOpts?, opts?) {
        if (typeof modelOrNameOrDoc === "string" || modelOrNameOrDoc["modelName"]) {
            const model = this.manager.getModel(modelOrNameOrDoc as string|mongoose.Model<any>);
            this._stepLocal(condOrOpts, TransactionStepType.REMOVE, model.modelName, undefined, opts);
        }
        else {
            const found = this.fetchedDocModels.find((x) => x.doc === modelOrNameOrDoc);
            // TODO consider if not found
            this._stepLocal(found.cond, TransactionStepType.REMOVE, found.modelName, undefined, condOrOpts);
        }
    }

    public async findOneForUpdate<T extends mongoose.Document>(
        modelOrName: string|mongoose.Model<T>, cond): Promise<T>
    {
        const model = this.manager.getModel(modelOrName);
        const modelName = model.modelName;

        if (!this.locks.isSet(modelName, cond)) {
            await this._stepLock(modelName, cond);
        }

        const doc = await this.manager.findOneForUpdate(this.tx, model, modelName, cond);
        this.fetchedDocModels.push({doc, modelName, cond});
        return doc;
    }

    public async persistQueue() {
        this.tx = await this.manager.txModel.findOneAndUpdate({_id: this.getId()},
            {$push: {sq: {$each: this.queue}}, updatedAt: new Date()},
            {new: true});
        this.queue = null;
    }

    private _stepLock(collection: string, cond: any) {
        // TODO update locks object
        return this.manager.txModel.findOneAndUpdate({_id: this.getId()},
            {$push: {locks: {m: collection, c: this.manager.encode(cond)}}, updatedAt: new Date()},
            {new: true});
    }
    private _stepLocal(cond: any, t: TransactionStepType, collection: string, upd?: any, opts?: IUpdateRemoveOptions) {
        return this.queue.push({
            t,
            m: collection,
            c: this.manager.encode(cond),
            upd: this.manager.encode(upd),
            e: opts,
        });
    }
}
