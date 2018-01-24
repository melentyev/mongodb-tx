import * as ava from "ava";
import * as _ from "lodash";
import * as mongoose from "mongoose";

import {delayAsync} from "../lib/doc-locking/DelayDocLockingEngine";
import {TransactionManager} from "../lib/index";
import {
    IModels, initTestDb, runTransactionFailedProcess, testFillDb, transferFunds,
} from "./utils";

const test = ava.test as ava.RegisterContextual<{
    models: IModels;
    mongoTx: TransactionManager;
    mongoTxLocalLock: TransactionManager;
    txMgr: TransactionManager;
    conn: mongoose.Connection;
    mongooseDefault: any;
}>;

test.beforeEach(async (t) => {
    const initRes = await initTestDb(`${process.env.DB_CONNECTION_STRING}/KMTESTTX-ACCOUNT`);
    t.context.models = initRes.models;
    t.context.mongoTx = initRes.mongoTx;
    t.context.mongoTxLocalLock = initRes.mongoTxLocalLock;
    t.context.conn = initRes.conn;
    await testFillDb(t.context.models, t.context.mongoTx);
});

test.afterEach(async (t) => {
    const txf = t.context.mongoTx.getConfig().txFieldName;
    t.falsy((await t.context.mongoTx.getTxModel().find({}).limit(1)).length);
    t.falsy((await t.context.models.User.find({[txf]: {$exists: true}}).limit(1)).length);
    t.falsy((await t.context.models.Product.find({[txf]: {$exists: true}}).limit(1)).length);
    t.falsy((await t.context.models.Order.find({[txf]: {$exists: true}}).limit(1)).length);
    await t.context.conn.close();
});

test.serial("test-account", async (t) => {
    try {
        await transferFunds(t.context.models, t.context.mongoTx, "user1", "user2", 30);
        const balance1 = (await t.context.models.User.findOne({name: "user2"})).balance;
        t.true((await t.context.models.User.findOne({name: "user1"})).balance === 470);
        t.true((await t.context.models.User.findOne({name: "user2"})).balance === 130);
    }
    catch (err) {
        console.error(err);
        return t.fail("transaction failed");
    }
});

test.serial("test-account-no-user", async (t) => {
    const error = await t.throws(transferFunds(t.context.models, t.context.mongoTx, "user1", "userNone", 30));
    t.is(error.message, "USER_NOT_FOUND");
});

async function testAccountConcurrent(t, getTxMgr, getModels) {
    const txMgr = getTxMgr(t);
    const testModels = getModels(t);
    try {
        await Promise.all([
            transferFunds(testModels, txMgr, "user1", "user2", 10),
            transferFunds(testModels, txMgr, "user2", "user3", 20),
            transferFunds(testModels, txMgr, "user2", "user1", 5),
            transferFunds(testModels, txMgr, "user3", "user2", 200),
        ]);
        t.true((await testModels.User.findOne({name: "user1"})).balance === 495);
        t.true((await testModels.User.findOne({name: "user2"})).balance === 285);
        t.true((await testModels.User.findOne({name: "user3"})).balance === 620);
    }
    catch (err) {
        console.error(err);
        return t.fail("transaction failed");
    }
    return t.pass();
}
// testAccountConcurrent.title = (providedTitle, input, expected) => `${providedTitle} ${input} = ${expected}`.trim();
test.serial("test-conc-4", testAccountConcurrent,
    (t) => t.context.mongoTx, (t) => t.context.models);
test.serial("test-conc-4-local-lock", testAccountConcurrent,
    (t) => t.context.mongoTxLocalLock, (t) => t.context.models);

test.serial("test-account-concurrent-3-error", async (t) => {
    await Promise.all([
        transferFunds(t.context.models, t.context.mongoTx, "user1", "user2", 600).catch((e) => {}),
        transferFunds(t.context.models, t.context.mongoTx, "user1", "user2", 300).catch((e) => {}),
        transferFunds(t.context.models, t.context.mongoTx, "user3", "user1", 5).catch((e) => {}),
    ]);
    try {
        t.true((await t.context.models.User.findOne({name: "user1"})).balance === 205);
        t.true((await t.context.models.User.findOne({name: "user2"})).balance === 400);
        t.true((await t.context.models.User.findOne({name: "user3"})).balance === 795);
    }
    catch (err) {
        console.error(err);
        return t.fail("transaction check failed");
    }
});

test.serial("test-remove-rollback-remove", async (t) => {
    await t.context.mongoTx.transaction(async (tx) => {
        const u = await tx.findOneForUpdate(t.context.models.User, {name: "user1"});
        tx.remove(u);
    });
    await t.throws(t.context.mongoTx.transaction(async (tx) => {
        await tx.findOneForUpdate(t.context.models.User, {name: "user2"});
        tx.remove(t.context.models.User, {name: "user2"});
        throw new Error("ROLLBACK");
    }));
    t.truthy(await t.context.models.User.findOne({name: "user2"}));
    await t.context.mongoTx.transaction(async (tx) => {
        await tx.findOneForUpdate(t.context.models.User, {name: "user3"});
        tx.remove(t.context.models.User, {name: "user3"});
    });
});

test.serial("test-lock-wait-timeout", async (t) => {
    const mongoTxSmallLockWait = new TransactionManager(
        {mongoose, mongooseConn: t.context.conn, lockWaitTimeout: 800});
    mongoTxSmallLockWait.addModels(_.values(t.context.models));
    await mongoTxSmallLockWait.transaction(async (tx) => {
        await tx.findOneForUpdate(t.context.models.User, {name: "user1"});
        await t.throws(mongoTxSmallLockWait.transaction(async (txInner) => {
            await txInner.findOneForUpdate(t.context.models.User, {name: "user1"});
        }));
    });
});

async function testCreateOrder(t, doThrow, expected) {
    let orderId;
    try {
        await t.context.mongoTx.transaction(async (tx) => {
            orderId = tx.create(t.context.models.Order, {})._id;
            if (doThrow) { throw new Error("ROLLBACK"); }
        });
    } catch (err) {}
    t.is((await t.context.models.Order.find({_id: orderId})).length, expected);
}

test.serial("test-create", testCreateOrder, false, 1);
test.serial("test-create-rollback", testCreateOrder, true, 0);

test.serial("test-recovery", async (t) => {
    const {models, conn, mongoTx} = t.context;
    const appId = "test-failing-app";
    await runTransactionFailedProcess(appId);

    t.truthy(await models.User.findOne({[mongoTx.getConfig().txFieldName]: {$exists: true}}));

    const mongoTxFailingApp = new TransactionManager(
        {mongoose, mongooseConn: conn, appId});
    mongoTxFailingApp.addModels(_.values(models));
    await mongoTxFailingApp.regularRecovery();
    mongoTxFailingApp.regularRecovery(false);
});

test.serial("test-recovery-timeout", async (t) => {
    const {models, conn, mongoTx} = t.context;
    await runTransactionFailedProcess("");

    const mongoTxSmallLockWait = new TransactionManager(
        {mongoose, mongooseConn: conn, lockWaitTimeout: 500});
    mongoTxSmallLockWait.addModels(_.values(models));
    await delayAsync(1000);
    await mongoTxSmallLockWait.regularRecovery();
    await delayAsync(1000);
    mongoTxSmallLockWait.regularRecovery(false);
    t.falsy(await models.User.findOne({[mongoTx.getConfig().txFieldName]: {$exists: true}}));
});

test.serial("test-prepared", async (t) => {
    const {models, mongoTx} = t.context;
    await mongoTx.transactionPrepare("xa1", async (tx) => {
        await tx.findOneForUpdate(models.User, {name: "user1"});
        tx.update(models.User, {name: "user1"}, {balance: 12345});
        t.truthy(await models.User.findOne({[mongoTx.getConfig().txFieldName]: {$exists: true}}));
    });
    t.truthy(await models.User.findOne({[mongoTx.getConfig().txFieldName]: {$exists: true}}));
    await mongoTx.commitPrepared("xa1");

    t.falsy(await models.User.findOne({[mongoTx.getConfig().txFieldName]: {$exists: true}}));
    t.truthy(await models.User.findOne({name: "user1", balance: 12345}));

    await t.throws(mongoTx.commitPrepared("xa1"));

    await mongoTx.transactionPrepare("xa2", async (tx) => {
        await tx.findOneForUpdate(models.User, {name: "user1"});
        tx.update(models.User, {name: "user1"}, {balance: 1});
        t.truthy(await models.User.findOne({[mongoTx.getConfig().txFieldName]: {$exists: true}}));
    });
    await mongoTx.rollbackPrepared("xa2");
    await t.throws(mongoTx.rollbackPrepared("xa2"));
});

// test.only.serial("test-unknow-model", async (t) => {
//     await t.throws(mongoTx.transaction(async (tx) => {
//         await tx.findOneForUpdate(mongooseDefault.models.User, {name: "user1"});
//     }));
// });

test.serial("test-unset", async (t) => {
    const {models, mongoTx} = t.context;
    t.not((await models.User.findOne({name: "user1"})).balance, undefined);
    await mongoTx.transaction(async (tx) => {
        const u = await tx.findOneForUpdate(models.User, {name: "user1"});
        tx.update(u, {$unset: {balance: ""}});
    });
    t.is((await models.User.findOne({name: "user1"})).balance, undefined);
});
