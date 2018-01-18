import test from "ava";
import * as _ from "lodash";
import * as mongoose from "mongoose";
import {DelayRowLockingEngine, LocalRowLockingEngine, RedisRowLockingEngine} from "../lib/index";
import {TransactionManager} from "../lib/index";
import {initTestDb, testFillDb, transferFunds} from "./utils";

async function multipleConcurrent(t, dbName, lockEngine, txCnt) {
    // c/onsole.time("XX");
    const {models, conn} = await initTestDb(`${process.env.DB_CONNECTION_STRING}/${dbName}`);
    const mongoTxSmallLockWait = new TransactionManager(
        {mongoose, mongooseConn: conn, lockWaitTimeout: 190 * txCnt, rowLockEngine: new lockEngine()});
    mongoTxSmallLockWait.addModels(_.values(models));
    await testFillDb(models, mongoTxSmallLockWait);

    // console.time(`XXX ${dbName}`);
    await Promise.all([...new Array(txCnt)]
        .map(() => transferFunds(models, mongoTxSmallLockWait, "user1", "user2", 1)));
    t.pass();
    // console.timeEnd(`XXX ${dbName}`);
    // c/onsole.timeEnd("XX");
}

test("multiple-conc", multipleConcurrent, "TESTTX1-CL", LocalRowLockingEngine, 60);
test("multiple-conc", multipleConcurrent, "TESTTX1-CR", RedisRowLockingEngine, 60);
test("multiple-conc", multipleConcurrent, "TESTTX1-CD", DelayRowLockingEngine, 60);
