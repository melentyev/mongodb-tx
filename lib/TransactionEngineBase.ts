import {EventEmitter} from "events";
import * as _ from "lodash";

import {IDocLockingEngine} from "./doc-locking/IDocLockingEngine";
import {
    ITransaction, ITransactionDoc, ITxConfig, TransactionState, TransactionStepType, TxLockTimeoutError,
    TxPreparedNotFound,
} from "./Interfaces";

export abstract class TransactionEngineBase<TId, TTransaction extends ITransaction<TId>> {
    public txFieldName: string;
    public encodePrefix: string;
    public lockWaitTimeout: number;
    public appId: string | null;
    public txColName;

    constructor(public rle: IDocLockingEngine, config: ITxConfig, private eventEmitter: EventEmitter) {
        _.assign(this, _.pick(config, "txFieldName", "encodePrefix", "lockWaitTimeout", "appId", "txColName"));
    }

    public abstract makeTransaction(tx: ITransactionDoc<TId>): TTransaction;
    public abstract create<T>(col: string, vals): PromiseLike<T>;
    public abstract findOne<T>(col: string, cond): PromiseLike<T | null>;
    public abstract updateOne<T>(col: string, cond, upd): PromiseLike<any>;
    public abstract findOneAndUpdate<T>(col: string, cond, upd): PromiseLike<T | null>;
    public abstract remove<T>(col: string, cond): PromiseLike<any>;

    public async transaction<TRes>(body: (t: TTransaction) => Promise<TRes>, xaId?: string) {
        const now = new Date();
        // TODO consider: failed to create transaction object
        const tx = await this.create<ITransactionDoc<TId>>(this.txColName, {
            state: TransactionState.CREATED,
            sq: [], locks: [],
            appId: this.appId,
            createdAt: now, updatedAt: now,
        });
        const t = this.makeTransaction(tx);
        try {
            await body(t);
            await this._pending(t);
            if (xaId) {
                await this._prepare(t, xaId);
            }
            else {
                await this._commit(t.tx._id, [TransactionState.CREATED, TransactionState.COMMITED]);
            }
        }
        catch (err) {
            // TODO consider: what we can do if rollback failed?
            try {
                await this._rollback(t.tx._id, [TransactionState.CREATED, TransactionState.FAILED]);
            }
            catch (rollbackErr) {
                this.eventEmitter.emit("error", rollbackErr);
            }
            throw err;
        }
    }

    public async commitPrepared(xaId: string) {
        const tx = await this.findOne<ITransactionDoc<TId>>(this.txColName, {xaId, state: TransactionState.PREPARED});
        if (!tx) {
            throw new TxPreparedNotFound();
        }
        await this._commit(tx._id, [TransactionState.PREPARED, TransactionState.COMMITED]);
    }

    public async rollbackPrepared(xaId: string) {
        const tx = await this.findOne<ITransactionDoc<TId>>(this.txColName, {xaId, state: TransactionState.PREPARED});
        if (!tx) {
            throw new TxPreparedNotFound();
        }
        await this._rollback(tx._id, [TransactionState.PREPARED, TransactionState.FAILED]);
    }

    public encode(x) {
        if (x === null || typeof x === "number" || typeof x === "string" ||
            _.get(x, "constructor.name") === "ObjectID")
        {
            return x;
        }
        if (Array.isArray(x)) {
            return _.map(x, (val) => this.encode(val));
        }
        return _.mapValues(
            _.mapKeys(x, (val, key: string) => key.startsWith("$") ? `${this.encodePrefix}${key}` : key),
            (val) => this.encode(val));
    }

    public decode(x) {
        if (x === null || typeof x === "number" || typeof x === "string" ||
            _.get(x, "constructor.name") === "ObjectID")
        {
            return x;
        }
        if (Array.isArray(x)) {
            return _.map(x, (val) => this.decode(val));
        }
        return _.mapValues(
            _.mapKeys(x, (val, key: string) =>
                key.startsWith(`${this.encodePrefix}$`) ? key.substr(this.encodePrefix.length) : key),
            (val) => this.decode(val));
    }

    public async recoveryOne(considerTimeThreshold: boolean) {
        const now = new Date();
        const cond = {
            // can't recovery PREPARED transaction (violates externally managed 2pc)
            $or: [
                {state: TransactionState.CREATED},
                {state: TransactionState.FAILED},
                {state: TransactionState.COMMITED},
            ],
        };
        if (this.appId) {
            cond["appId"] = this.appId;
        }
        if (considerTimeThreshold) {
            const threshold = Math.ceil(now.getTime() - (this.lockWaitTimeout * 1.5));
            cond["updatedAt"] = {$lt: new Date(threshold)};
        }
        const tx = await this.findOneAndUpdate<ITransactionDoc<TId>>(
            this.txColName, cond, {updatedAt: now, recoveryAt: now});
        if (!tx) {
            return null;
        }
        if (tx.state === TransactionState.COMMITED) {
            await this._commit(tx._id, [TransactionState.CREATED, TransactionState.COMMITED]);
        }
        else {
            await this._rollback(tx._id, [TransactionState.CREATED, TransactionState.FAILED]);
        }
        return true;
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

    public async findOneForUpdate<T>(tx: ITransactionDoc<TId>, col: string, cond, {returnDoc = true} = {})
    {
        const startAtTimestamp = new Date().getTime();
        const updCond = {...cond, $or: [{[this.txFieldName]: null}, {[this.txFieldName]: tx._id}]};
        const upd = {$set: {[this.txFieldName]: tx._id}};
        const createdTimestamp = tx.createdAt.getTime();
        while (!this._timeoutReached(createdTimestamp) && !this._timeoutReached(startAtTimestamp)) {
            if (returnDoc) {
                const updDoc = await this.findOneAndUpdate<T>(col, updCond, upd);
                if (updDoc) { return updDoc; }
            }
            else {
                if (await this.updateOne(col, updCond, upd)) { return true; }
            }

            // Failed to acquire lock? Let's check if locked document exists
            // TODO performance
            const doc = await this.findOne<any>(col, cond);
            if (!doc) {
                return null;
            }
            // Doc exists, therefore we must wait for unlock signal (some other transaction locked the doc)
            await this.rle.acquire(`${col}:${doc._id}`, Math.ceil(this.lockWaitTimeout / 10000));
        }
        throw new TxLockTimeoutError();
    }

    private async _pending(t: TTransaction) {
        await t.persistQueue();
        for (const step of t.tx.sq) {
            if (step.t === TransactionStepType.UPDATE || step.t === TransactionStepType.REMOVE) {
                const cond = this.decode(step.c);
                const updated = await this.findOneForUpdate(t.tx, step.m, cond, {returnDoc: false});
                if (step.e && !updated) { throw new Error("FAILED"); } // TODO error
            }
            else if (step.t === TransactionStepType.INSERT) {
                const cond = this.decode(step.c);
                const upd = this.decode(step.upd);
                await this.create(step.m, {...cond, ...upd, [this.txFieldName]: t.tx._id});
            }
        }
    }

    private _timeoutReached(fromTS: number) {
        return (new Date().getTime() - fromTS > this.lockWaitTimeout);
    }

    private async _prepare(t: TTransaction, xaId: string) {
        const txId = t.tx._id;
        await this.findOneAndUpdate(this.txColName,
            {_id: txId, state: TransactionState.CREATED, xaId: null},
            {$set: {state: TransactionState.PREPARED, xaId, updatedAt: new Date()}});
        // TODO consider fail
    }

    private async _commit(txId: any, expectedState: TransactionState[]) {
        const tx = await this.findOneAndUpdate<ITransactionDoc<TId>>(this.txColName,
            {_id: txId, $or: expectedState.map((state) => ({state}))},
            {$set: {state: TransactionState.COMMITED, updatedAt: new Date()}});

        // TODO can't commit when state is FAILED, PREPARED or transaction is already handled

        for (const step of tx.sq) {
            if (step.t === TransactionStepType.UPDATE) {
                // TODO check upd res?
                const upd = this.decode(step.upd);
                const cond = this.decode(step.c);

                if (!upd.$unset) { upd.$unset = {}; }
                upd.$unset[this.txFieldName] = "";

                const updatedDoc = await this.findOneAndUpdate(step.m,
                    {...cond, [this.txFieldName]: txId}, upd);
                await this.rle.release(`${step.m}:${updatedDoc["_id"]}`);
            }
            else if (step.t === TransactionStepType.INSERT) {
                const cond = this.decode(step.c);
                // TODO check upd res?
                const updatedDoc = await this.findOneAndUpdate(step.m,
                    {...cond, [this.txFieldName]: txId},
                    {$unset: {[this.txFieldName]: ""}});
                await this.rle.release(`${step.m}:${updatedDoc["_id"]}`);
            }
            else if (step.t === TransactionStepType.REMOVE) {
                const cond = this.decode(step.c);
                // TODO check remove res?
                await this.remove(step.m, {...cond, [this.txFieldName]: txId});
                // TODO release lock
            }
        }
        for (const step of _.reverse(tx.locks)) {
            const cond = this.decode(step.c);
            const updatedDoc = await this.findOneAndUpdate(step.m,
                {...cond, [this.txFieldName]: txId},
                {$unset: {[this.txFieldName]: ""}});
            if (updatedDoc) {
                await this.rle.release(`${step.m}:${updatedDoc["_id"]}`);
            }
        }
        await this.remove(this.txColName, {_id: txId});
    }

    private async _rollback(txId: any, expectedState: TransactionState[]) {
        const tx = await this.findOneAndUpdate<ITransactionDoc<TId>>(this.txColName,
            {_id: txId, $or: expectedState.map((state) => ({state}))},
            {$set: {state: TransactionState.FAILED, updatedAt: new Date()}});

        // TODO can't rollback when state is COMMITED or transaction is already handled

        for (const step of _.reverse(tx.sq)) {
            switch (step.t) {
                case TransactionStepType.UPDATE: await this._rollbackUpdate(txId, step.m, step.c); break;
                case TransactionStepType.INSERT: await this._rollbackInsert(txId, step.m, step.c); break;
                case TransactionStepType.REMOVE: await this._rollbackRemove(txId, step.m, step.c); break;
            }
        }
        for (const step of _.reverse(tx.locks)) {
            const cond = this.decode(step.c);
            await this.updateOne(step.m,
                {...cond, [this.txFieldName]: txId}, {$unset: {[this.txFieldName]: ""}});
        }
        await this.remove(this.txColName, {_id: txId});
    }

    private async _rollbackUpdate(txId, col: string, cond) {
        cond = this.decode(cond);
        const updatedDoc = await this.findOneAndUpdate(col,
            {...cond, [this.txFieldName]: txId},
            {$unset: {[this.txFieldName]: ""}});
        await this.rle.release(`${col}:${updatedDoc["_id"]}`);
    }

    private async _rollbackInsert(txId, col: string, cond) {
        await this.remove(col, {...this.decode(cond), [this.txFieldName]: txId});
        // TODO release lock
    }

    private _rollbackRemove(txId, col: string, cond) {
        return this.updateOne(col,
            {...this.decode(cond), [this.txFieldName]: txId},
            {$unset: {[this.txFieldName]: ""}});
        // TODO release lock
    }
}
