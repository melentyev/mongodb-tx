import {IStepDescription, ITransaction, ITransactionDoc, IUpdateRemoveOptions, TransactionStepType} from "./Interfaces";
import {TransactionEngineBase} from "./TransactionEngineBase";

export class TransactionBase<TId, TTransaction extends ITransaction<TId>> {
    protected fetchedDocModels = [];
    private queue: IStepDescription[] = [];

    constructor(protected engine: TransactionEngineBase<TId, TTransaction>, public tx: ITransactionDoc<TId>) {}

    public async persistQueue() {
        this.tx = await this.engine.findOneAndUpdate<ITransactionDoc<TId>>(this.engine.txColName,
            {_id: this.tx._id},
            {$push: {sq: {$each: this.queue}}, $set: {updatedAt: new Date()}});
        this.queue.splice(0, this.queue.length);
    }
    protected _stepLock(col: string, cond: any) {
        // TODO update locks object
        return this.engine.findOneAndUpdate(this.engine.txColName,
            {_id: this.tx._id},
            {$push: {locks: {m: col, c: this.engine.encode(cond)}}, $set: {updatedAt: new Date()}});
    }
    protected _stepLocal(cond: any, t: TransactionStepType,
                         collection: string, upd?: any, opts?: IUpdateRemoveOptions)
    {
        return this.queue.push({
            t,
            m: collection,
            c: this.engine.encode(cond),
            upd: this.engine.encode(upd),
            e: opts,
        });
    }
    protected async _findOneForUpdate<T>(col: string, cond: any): Promise<T> {
        await this._stepLock(col, cond);
        const doc = await this.engine.findOneForUpdate<T>(this.tx, col, cond) as T;
        this.fetchedDocModels.push({doc, col, cond});
        return doc;
    }
}
