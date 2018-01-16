import test from "ava";
import * as _ from "lodash";
import * as mongoose from "mongoose";
import {LocalRowLockingEngine} from "../lib/index";
import {TransactionManager} from "../lib/index";
import {initTestDb, testFillDb, transferFunds} from "./utils";

process.env.DB_CONNECTION_STRING = process.env.DB_CONNECTION_STRING || `mongodb://localhost:27019/KMTESTTX-ACCOUNT-C`;

test.serial("multiple-conc", async (t) => {
    // c/onsole.time("XX");
    const {models, conn} = await initTestDb(process.env.DB_CONNECTION_STRING);
    const mongoTxSmallLockWait = new TransactionManager(
        {mongoose, mongooseConn: conn, lockWaitTimeout: 19000, rowLockEngine: new LocalRowLockingEngine()});
    mongoTxSmallLockWait.addModels(_.values(models));
    await testFillDb(models, mongoTxSmallLockWait);

    await Promise.all([...new Array(260)]
        .map(() => transferFunds(models, mongoTxSmallLockWait, "user1", "user2", 1)));
    t.pass();
    // c/onsole.timeEnd("XX");
});
