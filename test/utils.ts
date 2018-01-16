import {execFile} from "child_process";
import * as _ from "lodash";
import * as mongoose from "mongoose";
import * as path from "path";
import {LocalRowLockingEngine} from "../lib/index";
import {TransactionManager} from "../lib/index";

export interface IUserDocument extends mongoose.Document {
    name: string;
    balance: number;
}

export interface IModels {
    User: mongoose.Model<IUserDocument>;
    Product: mongoose.Model<any>;
    Order: mongoose.Model<any>;
}

async function initModels(conn?) {
    const mongoTx = new TransactionManager({mongooseConn: conn, mongoose});
    const mongoTxLocalLock = new TransactionManager({
        mongooseConn: conn, mongoose, rowLockEngine: new LocalRowLockingEngine(),
    });

    await mongoTx.getTxModel().remove({});

    const User = (conn || mongoose).model("User", new mongoose.Schema({
        name: String,
        balance: Number,
    }).plugin(mongoTx.protect));

    const Product = (conn || mongoose).model("Product", new mongoose.Schema({
        name: String,
        qty: Number,
    }).plugin(mongoTx.protect, {optimisticLocking: false}));

    const Order = (conn || mongoose).model("Order", new mongoose.Schema({
        userId: mongoose.Schema.Types.ObjectId,
        productIds: [mongoose.Schema.Types.ObjectId],
    }).plugin(mongoTx.protect));

    mongoTx.addModels([User, Product, Order]);
    mongoTxLocalLock.addModels([User, Product, Order]);
    return {models: {User, Product, Order}, mongoTx, mongoTxLocalLock, conn};
}

export async function initMongooseDefault(dbConnectionString: string) {
    await mongoose.connect(dbConnectionString);
    return initModels();
}

export async function initTestDb(dbConnectionString: string) {
    // mongoose.set('debug', true);
    const conn = mongoose.createConnection(dbConnectionString);
    await new Promise((resolve) => conn.once("open", resolve));
    return initModels(conn);
}

export async function makeOrder({User, Product, Order}: IModels, mongoTx: TransactionManager,
                                userId: string, productIds: string[], sum: number)
{
    await mongoTx.transaction(async (t) => {
        t.locks.declare(User, {_id: userId, balance: {$gte: sum}});
        productIds.forEach((_id) => t.locks.declare(Product, {_id}));
        await t.locks.save();

        const user = await t.findOneForUpdate(User, {_id: userId, balance: {$gte: sum}});

        if (!user || user.balance < sum) {
            throw new Error("NOT_ENOUGH_BALANCE");
        }
        const products = await t.all(productIds.map((_id) => t.findOneForUpdate(Product, {_id})));
        if (_.some(products, (p) => p.qty < 1)) {
            throw new Error("NOT_ENOUGH_PRODUCT_QTY");
        }

        await t.all([
            t.update(User, {_id: userId}, {$inc: {balance: -sum}}),
            ...productIds.map((_id) => t.update(Product, {_id}, {$inc: {qty: -1}})),
            t.create(Order, {userId, productIds}),
        ]);
    });
}

export async function transferFunds({User}: IModels, mongoTx: TransactionManager,
                                    from: string, to: string, sum: number)
{
    await mongoTx.transaction(async (t) => {
        // preventing deadlock
        const orderedNames = _.sortBy([from, to], (x) => x);
        const users = await t.mapSeries(orderedNames, (name) => t.findOneForUpdate(User, {name}));

        const userFrom = users.find((u) => _.get(u, "name") === from);
        const userTo = users.find((u) => _.get(u, "name") === to);

        if (!userFrom || !userTo) {
            throw new Error("USER_NOT_FOUND");
        }
        if (userFrom.balance < sum) {
            throw new Error("NOT_ENOUGH_BALANCE");
        }

        await t.update(User, {name: from}, {$inc: {balance: -sum}});
        await t.update(User, {name: to}, {$inc: {balance: +sum}});
    });
}

export async function transferFundsPreLock({User}: IModels, mongoTx: TransactionManager,
                                           from: string, to: string, sum: number)
{
    await mongoTx.transaction(async (t) => {
        const orderedNames = _.sortBy([from, to], (x) => x);
        orderedNames.forEach((name) => t.locks.declare(User, {name}));
        await t.locks.save();

        // preventing deadlock
        const users = await t.mapSeries(orderedNames, (name) => t.findOneForUpdate(User, {name}));

        const userFrom = users.find((u) => u.name === from);
        const userTo = users.find((u) => u.name === to);

        if (!userFrom || !userTo) {
            throw new Error("USER_NOT_FOUND");
        }
        if (userFrom.balance < sum) {
            throw new Error("NOT_ENOUGH_BALANCE");
        }

        await t.update(User, {name: from}, {$inc: {balance: -sum}});
        await t.update(User, {name: to}, {$inc: {balance: +sum}});
    });
}

export function runTransactionFailedProcess(appId: string) {
    return new Promise((resolve) => {
        const scriptPath = path.resolve(__dirname, "failed-process.js");
        execFile("node", [scriptPath],
            {env: {TX_FAIL_APP_ID: appId}},
            (error, stdout, stderr) => {
                // console.log("execFile", error, stdout);
                resolve();
            });
    });
}

export async function testFillDb({User, Product, Order}: IModels, mongoTx: TransactionManager) {
    await Promise.all([User, Product, Order, mongoTx.getTxModel()]
        .map((m) => m.remove({}) as any));

    await User.create({name: "user1", balance: 500});
    await User.create({name: "user2", balance: 100});
    await User.create({name: "user3", balance: 800});

    await Product.create({name: "Apple", qty: 3});
    await Product.create({name: "Orange", qty: 4});
    await Product.create({name: "Banana", qty: 5});
}
