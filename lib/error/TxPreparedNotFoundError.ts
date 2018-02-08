export class TxPreparedNotFoundError extends Error {
    constructor() {
        super("TX_PREPARED_NOT_FOUND");
    }
}
