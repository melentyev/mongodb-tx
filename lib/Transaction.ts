import * as _ from "lodash";
import * as mongoose from "mongoose";
import {
    ILockDefinition, ITransactionInstance, TransactionEngine, TransactionState,
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

export class Transaction {
    public locks: TransactionLocks;

    private txFieldName: string;
    private fetchedDocModels = [];

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

    public update(modelOrName: string|mongoose.Model<any>, cond, upd);
    public update(doc: mongoose.Document, upd);
    public async update(modelOrNameOrDoc: string|mongoose.Model<any>|mongoose.Document, condOrUpd, upd?) {
        if (typeof modelOrNameOrDoc === "string" || modelOrNameOrDoc["modelName"]) {
            const model = this.manager.getModel(modelOrNameOrDoc as string|mongoose.Model<any>);
            const modelName = model.modelName;
            const cond = condOrUpd;
            await this._step(cond, TransactionStepType.UPDATE, modelName, upd);
            if (!this.locks.isSet(modelName, cond)) {
                await this.findOneForUpdate(modelName, cond);
            }
        }
        else {
            const found = this.fetchedDocModels.find((x) => x.doc === modelOrNameOrDoc);
            // TODO consider if not found
            await this._step(found.cond, TransactionStepType.UPDATE, found.modelName, condOrUpd);
        }
    }

    public async create(modelOrName: string|mongoose.Model<any>, vals) {
        const model = this.manager.getModel(modelOrName);
        const entity = new model({...vals, [this.txFieldName]: this.getId()});

        await this._step({_id: `${entity._id}`}, TransactionStepType.INSERT, model.modelName);
        await entity.save();
        return entity;
    }

    public remove(modelOrName: string|mongoose.Model<any>, cond);
    public remove(doc: mongoose.Document);
    public async remove(modelOrNameOrDoc: string|mongoose.Model<any>|mongoose.Document, cond?) {
        if (typeof modelOrNameOrDoc === "string" || modelOrNameOrDoc["modelName"]) {
            const model = this.manager.getModel(modelOrNameOrDoc as string|mongoose.Model<any>);
            const modelName = model.modelName;
            await this._step(cond, TransactionStepType.REMOVE, modelName);
            if (!this.locks.isSet(modelName, cond)) {
                await this.findOneForUpdate(modelName, cond);
            }
        }
        else {
            const found = this.fetchedDocModels.find((x) => x.doc === modelOrNameOrDoc);
            // TODO consider if not found
            await this._step(found.cond, TransactionStepType.REMOVE, found.modelName);
        }
    }

    public async findOneForUpdate<T extends mongoose.Document>(
        modelOrName: string|mongoose.Model<T>, cond): Promise<T>
    {
        const model = this.manager.getModel(modelOrName);
        const modelName = model.modelName;

        if (!this.locks.isSet(model.modelName, cond)) {
            await this._stepLock(model.modelName, cond);
        }

        const startAt = new Date().getTime();

        while (!this._timeoutReached() && !this._timeoutReached(startAt)) {
            const updDoc = await model.findOneAndUpdate(
                {...cond, $or: [{[this.txFieldName]: null}, {[this.txFieldName]: this.getId()}]},
                {[this.txFieldName]: this.getId()}, {new: true});

            if (updDoc) {
                this.fetchedDocModels.push({doc: updDoc, modelName, cond});
                return updDoc;
            }
            else {
                // Failed to acquire lock? Let's check if locked document exists
                const doc: any[] = await model.find(cond).select("_id").limit(1).lean(true) as any;
                if (!doc.length) {
                    return null;
                }
                // LOCK_COLLISIONS++;
                await this.manager.rle.acquire(`${modelName}:${doc[0]._id}`,
                    Math.ceil(this.manager.lockWaitTimeout / 10000));
            }
        }
        throw new TxLockTimeoutError();
    }

    private _timeoutReached(fromTS?: number) {
        fromTS = fromTS || this.tx.createdAt.getTime();
        return (new Date().getTime() - fromTS > this.manager.lockWaitTimeout);
    }

    private _stepLock(collection: string, cond: any) {
        // TODO update locks object
        return this.manager.txModel.update({_id: this.getId()},
            {$push: {locks: {m: collection, c: this.manager.encode(cond)}}, updatedAt: new Date()});
    }
    private _step(cond: any, t: TransactionStepType, collection: string, upd?: any) {
        return this.manager.txModel.update(
            {_id: this.getId()}, {
                $push: {sq: {c: this.manager.encode(cond), t, m: collection, upd: this.manager.encode(upd) }},
                updatedAt: new Date(),
            });
    }
}
