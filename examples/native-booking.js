require("source-map-support/register");

const {MongoClient} = require("mongodb");
const {TransactionManager} = require("../dist/lib").native;

const SEATS = "seats";
const USERS = "users";

async function reserveSeat(db, txMgr, seatNum, userId) {
    return txMgr.transaction(async (t) => {
        const seat = await t.findOneForUpdate(SEATS, {num: seatNum});
        if (seat.userId) {
            throw new Error("SEAT_ALREADY_RESERVED");
        }
        t.update(seat, {$set: {userId}});
    });
}

(async () => {
    const seat = "11B";

    const client = await MongoClient.connect(`${process.env.DB_CONNECTION_STRING}`);
    const db = client.db("TESTTX1-EXAMPLE-NAIVE-BOOKING");

    try {
        await db.dropDatabase();

        await db.collection(USERS).insertMany([{name: "a"}, {name: "b"}]);
        await db.collection(SEATS).insertMany([{num: "11A"}, {num: "11B"}, {num: "12C"}]);

        const txMgr = new TransactionManager({db});

        await Promise.all([
            reserveSeat(db, txMgr, seat, (await db.collection(USERS).findOne({name: "a"}))._id),
            reserveSeat(db, txMgr, seat, (await db.collection(USERS).findOne({name: "b"}))._id),
        ]);
    }
    catch (err) {
        const userId = (await db.collection(SEATS).findOne({num: seat})).userId;
        const user = await db.collection(USERS).findOne({_id: userId});
        console.log(`Seat ${seat} reserved for user: ${user.name}`);
    }
    process.exit(0);
})();
