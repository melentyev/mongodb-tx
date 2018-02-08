import {EventEmitter} from "events";
import * as _ from "lodash";
import * as mongoose from "mongoose";

import {IDocLockingEngine} from "../doc-locking/IDocLockingEngine";
import {TxUnknownModelError} from "../error/TxUnknownModelError";
import {ITransactionDoc} from "../Interfaces";
import {ITxConfig} from "../ITxConfig";
import {TransactionEngineBase} from "../TransactionEngineBase";
import {Transaction} from "./Transaction";

export interface ITransactionInstance extends mongoose.Document, ITransactionDoc<any> {}

export interface ITransactionModel extends mongoose.Model<ITransactionInstance> {}

export class TransactionEngine extends TransactionEngineBase<any, Transaction> {
    private models: {[propName: string]: mongoose.Model<any>} = {};
    constructor(public txModel: ITransactionModel, rle: IDocLockingEngine,
                config: ITxConfig, eventEmitter: EventEmitter)
    {
        super(rle, config, eventEmitter);
    }

    public makeTransaction(tx: ITransactionDoc<any>) {
        return new Transaction(this, tx as ITransactionInstance);
    }

    public create<T>(col: string, vals): Promise<T> {
        return this.getModel(col).create(vals) as any;
    }

    public findOne<T>(col: string, cond): PromiseLike<T | null> {
        return this.getModel(col).findOne(cond) as any;
    }

    public async updateOne<T>(col: string, cond, upd): Promise<boolean> {
        const updRes = await this.getModel(col).update(cond, upd, {multi: false});
        return _.get(updRes, "n") === 1;
    }

    public findOneAndUpdate<T>(col: string, cond, upd): PromiseLike<T | null> {
        return this.getModel(col).findOneAndUpdate(cond, upd, {"new": true}) as any;
    }

    public remove<T>(col: string, cond): PromiseLike<any> {
        return this.getModel(col).remove(cond);
    }

    public addModels(models: Array<mongoose.Model<any>>) {
        models.forEach((m) => this.models[m.modelName] = m);
    }

    public getModel<T extends mongoose.Document>(modelOrName: string|mongoose.Model<T>): mongoose.Model<T> {
        if (typeof modelOrName === "string") {
            if (this.txModel.modelName === modelOrName) {
                // TODO why any?
                return this.txModel as any;
            }
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
}
