import * as mongoose from "mongoose";
import {IUpdateRemoveOptions} from "../Interfaces";
import {TransactionBase} from "../TransactionBase";
import {TransactionStepType} from "../TransactionStepType";
import {ITransactionInstance, TransactionEngine} from "./TransactionEngine";

export class Transaction extends TransactionBase<mongoose.Schema.Types.ObjectId, Transaction> {
    constructor(engine: TransactionEngine, tx: ITransactionInstance) {
        super(engine, tx);
    }

    public update(model: mongoose.Model<any>, cond, upd, opts?: IUpdateRemoveOptions): void;
    public update(doc: mongoose.Document, upd, opts?: IUpdateRemoveOptions): void;
    public update(modelOrDoc: mongoose.Model<any>|mongoose.Document, condOrUpd, updOrOpts?, opts?): void {
        if (modelOrDoc["modelName"]) {
            this._stepLocal(condOrUpd, TransactionStepType.UPDATE,
                (modelOrDoc as mongoose.Model<any>).modelName, updOrOpts, opts);
        }
        else {
            // TODO consider if not found
            const found = this.fetchedDocModels.find((x) => x.doc === modelOrDoc);
            this._stepLocal(found.cond, TransactionStepType.UPDATE, found.col, condOrUpd, updOrOpts);
        }
    }

    public create<T extends mongoose.Document>(model: mongoose.Model<any>, vals): T {
        const entity = new model({...vals, [this.engine.txFieldName]: this.tx._id});
        this._stepLocal({_id: `${entity._id}`}, TransactionStepType.INSERT, model.modelName, vals);
        return entity;
    }

    public remove(modelOrName: mongoose.Model<any>, cond, opts?: IUpdateRemoveOptions);
    public remove(doc: mongoose.Document, opts?: IUpdateRemoveOptions);
    public remove(modelOrDoc: mongoose.Model<any>|mongoose.Document, condOrOpts?, opts?) {
        if (modelOrDoc["modelName"]) {
            this._stepLocal(condOrOpts, TransactionStepType.REMOVE,
                (modelOrDoc as mongoose.Model<any>).modelName, undefined, opts);
        }
        else {
            // TODO consider if not found
            const found = this.fetchedDocModels.find((x) => x.doc === modelOrDoc);
            this._stepLocal(found.cond, TransactionStepType.REMOVE, found.col, undefined, condOrOpts);
        }
    }

    public findOneForUpdate<T extends mongoose.Document>(model: mongoose.Model<T>, cond): Promise<T> {
        return this._findOneForUpdate<T>(model.modelName, cond);
    }
}
