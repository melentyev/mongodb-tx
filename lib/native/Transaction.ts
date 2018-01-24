import * as mongodb from "mongodb";

import {ITransactionDoc, IUpdateRemoveOptions, TransactionStepType} from "../Interfaces";
import {TransactionBase} from "../TransactionBase";
import {TransactionEngine} from "./TransactionEngine";

export class Transaction extends TransactionBase<any, Transaction> {
    constructor(engine: TransactionEngine, tx: ITransactionDoc<mongodb.ObjectId>) {
        super(engine, tx);
    }

    public update(col: string, cond, upd, opts?: IUpdateRemoveOptions): void;
    public update(doc: object, upd, opts?: IUpdateRemoveOptions): void;
    public update(colOrDoc: string|object, condOrUpd, updOrOpts?, opts?): void {
        if (typeof colOrDoc === "string") {
            this._stepLocal(condOrUpd, TransactionStepType.UPDATE, colOrDoc, updOrOpts, opts);
        }
        else {
            // TODO consider if not found
            const found = this.fetchedDocModels.find((x) => x.doc === colOrDoc);
            this._stepLocal(found.cond, TransactionStepType.UPDATE, found.col, condOrUpd, updOrOpts);
        }
    }

    public create<T>(col: string, vals): T {
        const entity = {...vals, [this.engine.txFieldName]: this.tx._id};
        if (typeof entity._id === "undefined") {
            entity._id = new mongodb.ObjectId();
        }
        this._stepLocal({_id: entity._id}, TransactionStepType.INSERT, col, vals);
        return entity;
    }

    public remove(col: string, cond, opts?: IUpdateRemoveOptions);
    public remove(doc: object, opts?: IUpdateRemoveOptions);
    public remove(colOrDoc: string|object, condOrOpts?, opts?) {
        if (typeof colOrDoc === "string") {
            this._stepLocal(condOrOpts, TransactionStepType.REMOVE, colOrDoc, undefined, opts);
        }
        else {
            // TODO consider if not found
            const found = this.fetchedDocModels.find((x) => x.doc === colOrDoc);
            this._stepLocal(found.cond, TransactionStepType.REMOVE, found.col, undefined, condOrOpts);
        }
    }

    public async findOneForUpdate<T>(col: string, cond): Promise<T> {
        return this._findOneForUpdate<T>(col, cond);
    }
}
