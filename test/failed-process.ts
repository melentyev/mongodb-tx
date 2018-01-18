import * as _ from "lodash";
import * as mongoose from "mongoose";
import {TransactionManager} from "../lib/index";
import {initTestDb} from "./utils";

async function main() {
    const {models, conn} = await initTestDb(`${process.env.DB_CONNECTION_STRING}/KMTESTTX-ACCOUNT`);

    const mongoTxFailingApp = new TransactionManager(
        {mongoose, mongooseConn: conn, appId: process.env.TX_FAIL_APP_ID});
    mongoTxFailingApp.addModels(_.values(models));

    console.log("here0");
    await mongoTxFailingApp.transaction(async (tx) => {
        console.log("here1");
        await tx.findOneForUpdate(models.User, {name: "user2"});
        console.log("here2");
        await conn.close();
        process.exit(0);
    });
}
main();
