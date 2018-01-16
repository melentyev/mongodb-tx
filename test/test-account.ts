import test from "ava";
import * as _ from "lodash";
import * as mongoose from "mongoose";
import {delayAsync} from "../lib/DelayRowLockingEngine";
import {TransactionManager} from "../lib/index";
import {
    IModels, initMongooseDefault, initTestDb, runTransactionFailedProcess, testFillDb, transferFunds,
    transferFundsPreLock,
} from "./utils";

process.env.DB_CONNECTION_STRING = process.env.DB_CONNECTION_STRING || `mongodb://localhost:27019/KMTESTTX-ACCOUNT`;

let models: IModels;
let mongoTx: TransactionManager;
let mongoTxLocalLock: TransactionManager;
let conn: mongoose.Connection;
let mongooseDefault;

test.before(async (t) => {
    const initRes = await initTestDb(process.env.DB_CONNECTION_STRING);
    models = initRes.models;
    mongoTx = initRes.mongoTx;
    mongoTxLocalLock = initRes.mongoTxLocalLock;
    conn = initRes.conn;
    mongooseDefault = await initMongooseDefault(process.env.DB_CONNECTION_STRING);
});

test.beforeEach(async (t) => { await testFillDb(models, mongoTx); });

test.afterEach(async (t) => {
    const txf = mongoTx.getConfig().txFieldName;
    t.falsy((await mongoTx.getTxModel().find({}).limit(1)).length);
    t.falsy((await models.User.find({[txf]: {$exists: true}}).limit(1)).length);
    t.falsy((await models.Product.find({[txf]: {$exists: true}}).limit(1)).length);
    t.falsy((await models.Order.find({[txf]: {$exists: true}}).limit(1)).length);
});

test.serial("test-account", async (t) => {
    try {
        await transferFunds(models, mongoTx, "user1", "user2", 30);
        const balance1 = (await models.User.findOne({name: "user2"})).balance;
        t.true((await models.User.findOne({name: "user1"})).balance === 470);
        t.true((await models.User.findOne({name: "user2"})).balance === 130);
    }
    catch (err) {
        console.error(err);
        return t.fail("transaction failed");
    }
});

test.serial("test-account-no-user", async (t) => {
    const error = await t.throws(transferFunds(models, mongoTx, "user1", "userNone", 30));
    t.is(error.message, "USER_NOT_FOUND");
});

async function testAccountConcurrent(t, getTxMgr, getModels) {
    const txMgr = getTxMgr();
    const testModels = getModels();
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
test.serial("test-conc-4", testAccountConcurrent, () => mongoTx, () => models);
test.serial("test-conc-4-local-lock", testAccountConcurrent, () => mongoTxLocalLock, () => models);
test.serial("test-conc-4-goose", testAccountConcurrent, () => mongooseDefault.mongoTx, () => mongooseDefault.models);

test.serial("test-account-concurrent-3-error", async (t) => {
    await Promise.all([
        transferFunds(models, mongoTx, "user1", "user2", 600).catch((e) => {}),
        transferFunds(models, mongoTx, "user1", "user2", 300).catch((e) => {}),
        transferFunds(models, mongoTx, "user3", "user1", 5).catch((e) => {}),
    ]);
    try {
        t.true((await models.User.findOne({name: "user1"})).balance === 205);
        t.true((await models.User.findOne({name: "user2"})).balance === 400);
        t.true((await models.User.findOne({name: "user3"})).balance === 795);
    }
    catch (err) {
        console.error(err);
        return t.fail("transaction check failed");
    }
});

test.serial("test-account-concurrent-pre-lock-3-error", async (t) => {
    await Promise.all([
        transferFundsPreLock(models, mongoTx, "user1", "user2", 600).catch((e) => {}),
        transferFundsPreLock(models, mongoTx, "user1", "user2", 300).catch((e) => {}),
        transferFundsPreLock(models, mongoTx, "user3", "user1", 5).catch((e) => {}),
    ]);
    try {
        t.true((await models.User.findOne({name: "user1"})).balance === 205);
        t.true((await models.User.findOne({name: "user2"})).balance === 400);
        t.true((await models.User.findOne({name: "user3"})).balance === 795);
    }
    catch (err) {
        console.error(err);
        return t.fail("transaction check failed");
    }
    return t.pass();
});

test.serial("test-remove-rollback-remove", async (t) => {
    const error = await t.throws(mongoTx.transaction(async (tx) => {
        await tx.findOneForUpdate(models.User, {name: "user2"});
        await tx.remove(models.User, {name: "user2"});
        const removedUser = await models.User.findOne({name: "user2"});
        t.is(`${removedUser[mongoTx.getConfig().txFieldName]}`, `${tx.getId()}`);
        throw new Error("ROLLBACK");
    }));
    await mongoTx.transaction(async (tx) => {
        await tx.findOneForUpdate(models.User, {name: "user3"});
        await tx.remove(models.User, {name: "user3"});
    });
});

test.serial("test-lock-wait-timeout", async (t) => {
    const mongoTxSmallLockWait = new TransactionManager(
        {mongoose, mongooseConn: conn, lockWaitTimeout: 800});
    mongoTxSmallLockWait.addModels(_.values(models));
    await mongoTxSmallLockWait.transaction(async (tx) => {
        await tx.findOneForUpdate(models.User, {name: "user1"});
        await t.throws(mongoTxSmallLockWait.transaction(async (txInner) => {
            await txInner.findOneForUpdate(models.User, {name: "user1"});
        }));
    });
});

async function testCreateOrder(t, doThrow, expected) {
    let orderId;
    try {
        await mongoTx.transaction(async (tx) => {
            orderId = (await tx.create(models.Order, {}))._id;
            t.truthy(await models.Order.findOne({_id: orderId}));
            if (doThrow) { throw new Error("ROLLBACK"); }
        });
    } catch (err) {}
    t.is((await models.Order.find({_id: orderId})).length, expected);
}

test.serial("test-create", testCreateOrder, false, 1);
test.serial("test-create-rollback", testCreateOrder, true, 0);

test.serial("test-recovery", async (t) => {
    const appId = "test-failing-app";
    await runTransactionFailedProcess(appId);
    t.truthy(await models.User.findOne({[mongoTx.getConfig().txFieldName]: {$exists: true}}));

    const mongoTxFailingApp = new TransactionManager(
        {mongoose, mongooseConn: conn, appId});
    mongoTxFailingApp.addModels(_.values(models));
    await mongoTxFailingApp.recovery(false);
});

test.serial("test-recovery-timeout", async (t) => {
    await runTransactionFailedProcess("");
    const mongoTxSmallLockWait = new TransactionManager(
        {mongoose, mongooseConn: conn, lockWaitTimeout: 500});
    mongoTxSmallLockWait.addModels(_.values(models));
    await delayAsync(1000);
    await mongoTxSmallLockWait.recovery();
    t.falsy(await models.User.findOne({[mongoTx.getConfig().txFieldName]: {$exists: true}}));
});

test.serial("test-prepared", async (t) => {
    await mongoTx.transactionPrepare("xa1", async (tx) => {
        await tx.findOneForUpdate(models.User, {name: "user1"});
        await tx.update(models.User, {name: "user1"}, {balance: 12345});
        t.truthy(await models.User.findOne({[mongoTx.getConfig().txFieldName]: {$exists: true}}));
    });
    t.truthy(await models.User.findOne({[mongoTx.getConfig().txFieldName]: {$exists: true}}));
    await mongoTx.commitPrepared("xa1");

    t.falsy(await models.User.findOne({[mongoTx.getConfig().txFieldName]: {$exists: true}}));
    t.truthy(await models.User.findOne({name: "user1", balance: 12345}));

    await t.throws(mongoTx.commitPrepared("xa1"));

    await mongoTx.transactionPrepare("xa2", async (tx) => {
        await tx.findOneForUpdate(models.User, {name: "user1"});
        await tx.update(models.User, {name: "user1"}, {balance: 1});
        t.truthy(await models.User.findOne({[mongoTx.getConfig().txFieldName]: {$exists: true}}));
    });
    await mongoTx.rollbackPrepared("xa2");
    await t.throws(mongoTx.rollbackPrepared("xa2"));
});

test.serial("test-unknow-model", async (t) => {
    await t.throws(mongoTx.transaction(async (tx) => {
        await tx.findOneForUpdate(mongooseDefault.models.User, {name: "user1"});
    }));
    await t.notThrows(mongoTx.transaction(async (tx) => {
        await tx.findOneForUpdate("User", {name: "user1"});
    }));
    await t.throws(mongoTx.transaction(async (tx) => {
        await tx.findOneForUpdate("UserX", {name: "user1"});
    }));
});

test.serial("test-unset", async (t) => {
    t.not((await models.User.findOne({name: "user1"})).balance, undefined);
    await mongoTx.transaction(async (tx) => {
        const u = await tx.findOneForUpdate(models.User, {name: "user1"});
        await tx.update(u, {$unset: {balance: ""}});
    });
    t.is((await models.User.findOne({name: "user1"})).balance, undefined);
});
