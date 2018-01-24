import * as _ from "lodash";
import {TransactionManager} from "../lib/native";

export async function transferFunds(userCol: string, mongoTx: TransactionManager,
                                    from: string, to: string, sum: number)
{
    await mongoTx.transaction(async (t) => {
        // preventing deadlock
        const users = [];
        for (const name of _.sortBy([from, to], (x) => x)) {
            users.push(await t.findOneForUpdate(userCol, {name}));
        }

        const userFrom = users.find((u) => _.get(u, "name") === from);
        const userTo = users.find((u) => _.get(u, "name") === to);

        if (!userFrom || !userTo) {
            throw new Error("USER_NOT_FOUND");
        }
        if (userFrom.balance < sum) {
            throw new Error("NOT_ENOUGH_BALANCE");
        }

        t.update(userCol, {name: from}, {$inc: {balance: -sum}});
        t.update(userTo, {$inc: {balance: +sum}});
    });
}
