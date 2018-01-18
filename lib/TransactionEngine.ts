import * as _ from "lodash";
import * as mongoose from "mongoose";

import {IRowLockingEngine} from "./IRowLockingEngine";
import {Transaction, TxLockTimeoutError, TxPrepareFailedError} from "./Transaction";

export class TxUnknownModelError extends Error {
    constructor() { super("TX_UNKNOWN_MODEL_ERROR"); }
}

export class TxPreparedNotFound extends Error {
    constructor() { super("TX_PREPARED_NOT_FOUND"); }
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

export interface ITxConfig {
    txFieldName: string;
    verFieldName: string;
    encodePrefix: string;
    lockWaitTimeout: number;
    appId: string | null;
}

export interface ITransactionInstance extends mongoose.Document {
    state: TransactionState;
    sq: IStepDescription[];
    locks: ILockDefinition[];
    appId: string;
    xaId: string;
    createdAt: Date;
    updatedAt: Date;
    recoveryAt: Date;
}

export interface ITransactionModel extends mongoose.Model<ITransactionInstance> {}

export class TransactionEngine {
    public txFieldName: string;
    public encodePrefix: string;
    public lockWaitTimeout: number;
    public appId: string | null;

    private models: {[propName: string]: mongoose.Model<any>} = {};
    private verFieldName: string;

    constructor(public rle: IRowLockingEngine,
                public txModel: ITransactionModel,
                private config: ITxConfig)
    {
        this.txFieldName = config.txFieldName;
        this.verFieldName = config.verFieldName;
        this.encodePrefix = config.encodePrefix;
        this.lockWaitTimeout = config.lockWaitTimeout;
        this.appId = config.appId;
    }

    public async transaction<TRes>(body: (t: Transaction) => Promise<TRes>, xaId?: string) {
        const now = new Date();
        const tx = await this.txModel.create({
            state: TransactionState.CREATED,
            sq: [], locks: [],
            appId: this.appId,
            createdAt: now, updatedAt: now,
        });
        // TODO consider: failed to create transaction object
        const t = new Transaction(this, tx);
        try {
            await body(t);
            await this._pending(t);
            if (xaId) { await this._prepare(t, xaId); }
            else { await this._commit(t, [TransactionState.CREATED, TransactionState.COMMITED]); }
        }
        catch (err) {
            // TODO consider: what we can do if rollback failed?
            try { await this._rollback(t, [TransactionState.CREATED, TransactionState.FAILED]); }
            catch (rollbackErr) { console.error(rollbackErr); }
            throw err;
        }
    }
    public async commitPrepared(xaId: string) {
        const tx = await this.txModel.findOne({xaId, state: TransactionState.PREPARED});
        if (!tx) {
            throw new TxPreparedNotFound();
        }
        const t = new Transaction(this, tx);
        await this._commit(t, [TransactionState.PREPARED, TransactionState.COMMITED]);
    }
    public async rollbackPrepared(xaId: string) {
        const tx = await this.txModel.findOne({xaId, state: TransactionState.PREPARED});
        if (!tx) {
            throw new TxPreparedNotFound();
        }
        const t = new Transaction(this, tx);
        await this._rollback(t, [TransactionState.PREPARED, TransactionState.FAILED]);
    }
    // TODO finish helpers
    public encode(x) {
        if (x === null || typeof x === "number" || typeof x === "string") { return x; }
        if (Array.isArray(x)) { return _.map(x, (val) => this.encode(val)); }
        return _.mapValues(
            _.mapKeys(x, (val, key: string) => key.startsWith("$") ? `${this.encodePrefix}${key}` : key),
            (val) => this.encode(val));
    }
    public decode(x) {
        if (x === null || typeof x === "number" || typeof x === "string") { return x; }
        if (Array.isArray(x)) { return _.map(x, (val) => this.decode(val)); }
        return _.mapValues(
            _.mapKeys(x, (val, key: string) =>
                key.startsWith(`${this.encodePrefix}$`) ? key.substr(this.encodePrefix.length) : key),
            (val) => this.decode(val));
    }

    public async recoveryOne(considerTimeThreshold: boolean) {
        const now = new Date();
        const cond = {
            appId: this.appId || null,
            // can't recovery PREPARED transaction (violates externally managed 2pc)
            $or: [
                {state: TransactionState.CREATED},
                {state: TransactionState.FAILED},
                {state: TransactionState.COMMITED},
            ],
        };
        if (considerTimeThreshold) {
            const threshold = Math.ceil(now.getTime() - (this.lockWaitTimeout * 1.5));
            cond["updatedAt"] = {$lt: new Date(threshold)};
        }
        // c/onsole.log("recoveryOne", cond);
        const tx = await this.txModel.findOneAndUpdate(cond, {updatedAt: now, recoveryAt: now}, {new: true});
        if (!tx) {
            return null;
        }
        const t = new Transaction(this, tx);
        if (tx.state === TransactionState.COMMITED) {
            await this._commit(t, [TransactionState.CREATED, TransactionState.COMMITED]);
        }
        else {
            await this._rollback(t, [TransactionState.CREATED, TransactionState.FAILED]);
        }
        return true;
    }
    public addModels(models: Array<mongoose.Model<any>>) {
        models.forEach((m) => this.models[m.modelName] = m);
    }
    public getModel<T extends mongoose.Document>(modelOrName: string|mongoose.Model<T>): mongoose.Model<T> {
        if (typeof modelOrName === "string") {
            if (!this.models[modelOrName]) {
                throw new TxUnknownModelError();
            }
            return this.models[modelOrName];
        }
        const model = _.values(this.models).find((x) => x === modelOrName);
        if (!model) {
            throw new TxUnknownModelError();
        }
        return model;
    }
    /**
     *
     * @returns {Promise<number>}
     */
    public async recovery(considerTimeThreshold: boolean) {
        let cnt = 0;
        while (await this.recoveryOne(considerTimeThreshold)) { cnt++; }
        return cnt;
    }

    public async findOneForUpdate(tx: ITransactionInstance, model: mongoose.Model<any>,
                                  modelName: string, cond, {returnDoc = true} = {})
    {
        const startAtTimestamp = new Date().getTime();
        const updCond = {...cond, $or: [{[this.txFieldName]: null}, {[this.txFieldName]: tx._id}]};
        const upd = {[this.txFieldName]: tx._id};
        const createdTimestamp = tx.createdAt.getTime();
        while (!this._timeoutReached(createdTimestamp) && !this._timeoutReached(startAtTimestamp)) {
            if (returnDoc) {
                const updDoc = await model.findOneAndUpdate(updCond, upd, {new: true});
                if (updDoc) { return updDoc; }
            }
            else {
                const updRes = await model.update(updCond, upd, {multi: false});
                if (_.get(updRes, "n")) { return true; }
            }

            // Failed to acquire lock? Let's check if locked document exists
            const doc: any[] = await model.find(cond).select("_id").limit(1).lean(true) as any;
            if (!doc.length) {
                return null;
            }
            // Doc exists, therefore we must wait for unlock signal (some other transaction locked the doc)
            await this.rle.acquire(`${modelName}:${doc[0]._id}`, Math.ceil(this.lockWaitTimeout / 10000));
        }
        throw new TxLockTimeoutError();
    }

    private async _pending(t: Transaction) {
        await t.persistQueue();
        for (const step of t.tx.sq) {
            const model = this.getModel<any>(step.m);
            if (step.t === TransactionStepType.UPDATE || step.t === TransactionStepType.REMOVE) {
                const cond = this.decode(step.c);
                const updated = await this.findOneForUpdate(t.tx, model, step.m, cond, {returnDoc: false});
                if (step.e && !updated) { throw new Error("FAILED"); } // TODO error
            }
            else if (step.t === TransactionStepType.INSERT) {
                const cond = this.decode(step.c);
                const upd = this.decode(step.upd);
                await model.create({...cond, ...upd, [this.txFieldName]: t.getId()});
            }
        }
    }
    private _timeoutReached(fromTS: number) {
        return (new Date().getTime() - fromTS > this.lockWaitTimeout);
    }

    private async _prepare(t: Transaction, xaId: string) {
        const txId = t.getId();
        await this.txModel.findOneAndUpdate(
            {_id: txId, state: TransactionState.CREATED, xaId: null},
            {state: TransactionState.PREPARED, xaId, updatedAt: new Date()}, {"new": true});
        // TODO consider fail
    }

    private async _commit(t: Transaction, expectedState: TransactionState[]) {
        const txId = t.getId();

        const tx = await this.txModel.findOneAndUpdate(
            {_id: txId, $or: expectedState.map((state) => ({state}))},
            {state: TransactionState.COMMITED, updatedAt: new Date()}, {"new": true});

        // TODO can't commit when state is FAILED, PREPARED or transaction is already handled

        for (const step of tx.sq) {
            const model = this.getModel<any>(step.m);
            if (step.t === TransactionStepType.UPDATE) {
                // TODO check upd res?
                const upd = this.decode(step.upd);
                const cond = this.decode(step.c);

                if (!upd.$unset) { upd.$unset = {}; }
                upd.$unset[this.txFieldName] = "";

                const updatedDoc = await model.findOneAndUpdate(
                    {...cond, [this.txFieldName]: txId}, upd, {new: true});
                await this.rle.release(`${model.modelName}:${updatedDoc["_id"]}`);
            }
            else if (step.t === TransactionStepType.INSERT) {
                const cond = this.decode(step.c);
                // TODO check upd res?
                const updatedDoc = await model.findOneAndUpdate(
                    {...cond, [this.txFieldName]: txId},
                    {$unset: {[this.txFieldName]: ""}}, {new: true});
                await this.rle.release(`${model.modelName}:${updatedDoc["_id"]}`);
            }
            else if (step.t === TransactionStepType.REMOVE) {
                const cond = this.decode(step.c);
                // TODO check remove res?
                await model.remove({...cond, [this.txFieldName]: txId});
                // TODO release lock
            }
        }
        for (const step of _.reverse(tx.locks)) {
            const model = this.getModel<any>(step.m);
            const cond = this.decode(step.c);
            const updatedDoc = await model.findOneAndUpdate(
                {...cond, [this.txFieldName]: txId},
                {$unset: {[this.txFieldName]: ""}},
                {new: true});
            if (updatedDoc) {
                await this.rle.release(`${model.modelName}:${updatedDoc["_id"]}`);
            }
        }
        await this.txModel.remove({_id: txId});
    }
    private async _rollback(t: Transaction, expectedState: TransactionState[]) {
        const txId = t.getId();
        const tx = await this.txModel.findOneAndUpdate(
            {_id: txId, $or: expectedState.map((state) => ({state}))},
            {state: TransactionState.FAILED, updatedAt: new Date()}, {"new": true});

        // TODO can't rollback when state is COMMITED or transaction is already handled

        for (const step of _.reverse(tx.sq)) {
            const model = this.getModel<any>(step.m);
            if (step.t === TransactionStepType.UPDATE) {
                const cond = this.decode(step.c);
                const updatedDoc = await model.findOneAndUpdate(
                    {...cond, [this.txFieldName]: txId},
                    {$unset: {[this.txFieldName]: ""}}, {new: true});
                await this.rle.release(`${model.modelName}:${updatedDoc["_id"]}`);
            }
            else if (step.t === TransactionStepType.INSERT) {
                const cond = this.decode(step.c);
                await model.remove({...cond, [this.txFieldName]: txId});
                // TODO release lock
            }
            else if (step.t === TransactionStepType.REMOVE) {
                const cond = this.decode(step.c);
                await model.update(
                    {...cond, [this.txFieldName]: txId}, {$unset: {[this.txFieldName]: ""}});
                // TODO release lock
            }
        }
        for (const step of _.reverse(tx.locks)) {
            const model = this.getModel<any>(step.m);
            const cond = this.decode(step.c);
            await model.update(
                {...cond, [this.txFieldName]: txId}, {$unset: {[this.txFieldName]: ""}});
        }
        await this.txModel.remove({_id: txId});
    }
}
