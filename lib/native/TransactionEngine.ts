import {EventEmitter} from "events";
import {Db} from "mongodb";
import * as mongodb from "mongodb";

import {IDocLockingEngine} from "../doc-locking/IDocLockingEngine";
import {ITransactionDoc, ITxConfig} from "../Interfaces";
import {TransactionEngineBase} from "../TransactionEngineBase";
import {Transaction} from "./Transaction";

export class TransactionEngine extends TransactionEngineBase<mongodb.ObjectId, Transaction> {
    constructor(private db: Db, rle: IDocLockingEngine, config: ITxConfig, eventEmitter: EventEmitter) {
        super(rle, config, eventEmitter);
    }
    public makeTransaction(tx: ITransactionDoc<mongodb.ObjectId>) {
        return new Transaction(this, tx);
    }
    public async create<T>(col: string, vals): Promise<T> {
        const insertRes = await this.db.collection(col).insertOne(vals);
        return insertRes.ops[0];
    }
    public findOne<T>(col: string, cond): PromiseLike<T | null> {
        return this.db.collection<T>(col).findOne(cond);
    }
    public async updateOne<T>(col: string, cond, upd): Promise<boolean> {
        const updRes = await this.db.collection<T>(col).updateOne(cond, upd);
        return updRes.matchedCount === 1;
    }
    public async findOneAndUpdate<T>(col: string, cond, upd): Promise<T | null> {
        const res = await this.db.collection<T>(col).findOneAndUpdate(cond, upd,  {returnOriginal: false});
        return res.value || null;
    }
    public remove<T>(col: string, cond): PromiseLike<any> {
        return this.db.collection<T>(col).deleteOne(cond);
    }
}
