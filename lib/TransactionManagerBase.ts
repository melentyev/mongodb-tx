import {EventEmitter} from "events";
import {delayAsync} from "./doc-locking/DelayDocLockingEngine";
import {ITransaction, ITxConfig} from "./Interfaces";
import {TransactionEngineBase} from "./TransactionEngineBase";
import * as _ from "lodash";

export class TransactionManagerBase<
        TId,
        TTransaction extends ITransaction<TId>,
        TEngineBase extends TransactionEngineBase<TId, TTransaction>
    > extends EventEmitter
{
    protected config: ITxConfig;
    protected engine: TEngineBase;
    protected regularRecoveryRun = false;

    public getConfig(): ITxConfig { return _.cloneDeep(this.config); }

    public transaction<TRes>(body: (t: TTransaction) => Promise<TRes>) {
        return this.engine.transaction(body);
    }

    public transactionPrepare<TRes>(xaId: string, body: (t: TTransaction) => Promise<TRes>) {
        return this.engine.transaction(body, xaId);
    }

    public commitPrepared(xaId: string) {
        return this.engine.commitPrepared(xaId);
    }

    public rollbackPrepared(xaId: string) {
        return this.engine.rollbackPrepared(xaId);
    }

    public async regularRecovery(run: boolean = true): Promise<void> {
        const isRunning = this.regularRecoveryRun;
        this.regularRecoveryRun = run;
        if (!isRunning && run) {
            if (this.config.appId) {
                try {
                    await this.engine.recovery(false);
                }
                catch (err) {
                    this.emit("error", err);
                }
            }
            (async () => {
                while (this.regularRecoveryRun) {
                    try {
                        await this.engine.recovery(true);
                    }
                    catch (err) {
                        this.emit("error", err);
                    }
                    await delayAsync(2000);
                }
            })();
        }
    }
}
